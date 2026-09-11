import { z } from 'zod';
import { McpServerService } from './mcp-server.service';

/**
 * Direct unit coverage for the private `jsonSchemaToZod` helper. We bypass the
 * Nest DI by instantiating with `Object.create` and reaching into the method
 * — full controller-level tests would need Prisma, ConfigService, and the
 * @rekog/mcp-nest registry, which is overkill for a pure transformer.
 */
function makeSchema(jsonSchema: Record<string, unknown>): z.ZodTypeAny {
  const svc = Object.create(McpServerService.prototype);
  return (svc as any).jsonSchemaToZod(jsonSchema);
}

describe('McpServerService.jsonSchemaToZod', () => {
  it('accepts a numeric integer arg sent as a string ("5") and returns a number', () => {
    const schema = makeSchema({
      type: 'object',
      properties: { top_k: { type: 'integer', description: 'how many' } },
      required: ['top_k'],
    });
    const parsed = schema.parse({ top_k: '5' });
    expect(parsed).toEqual({ top_k: 5 });
    expect(typeof (parsed as any).top_k).toBe('number');
  });

  it('still rejects a non-numeric string for an integer field', () => {
    const schema = makeSchema({
      type: 'object',
      properties: { top_k: { type: 'integer' } },
      required: ['top_k'],
    });
    expect(() => schema.parse({ top_k: 'abc' })).toThrow();
  });

  it('accepts "1.5" for a number type', () => {
    const schema = makeSchema({
      type: 'object',
      properties: { score: { type: 'number' } },
      required: ['score'],
    });
    expect(schema.parse({ score: '1.5' })).toEqual({ score: 1.5 });
  });

  it('rejects a float "1.5" for an integer type', () => {
    const schema = makeSchema({
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    });
    expect(() => schema.parse({ count: '1.5' })).toThrow();
  });

  it('coerces "true" / "false" strings to boolean (well, anything truthy → true)', () => {
    const schema = makeSchema({
      type: 'object',
      properties: { active: { type: 'boolean' } },
      required: ['active'],
    });
    // z.coerce.boolean treats any non-empty string as true. That matches how
    // most MCP clients render checkbox state, but the consumer should be
    // aware that "false" coerces to true.
    expect(schema.parse({ active: 'true' })).toEqual({ active: true });
    expect(schema.parse({ active: true })).toEqual({ active: true });
    expect(schema.parse({ active: false })).toEqual({ active: false });
    expect(schema.parse({ active: 0 })).toEqual({ active: false });
  });

  it('keeps an enum string field strict (no coercion)', () => {
    const schema = makeSchema({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast', 'slow'] } },
      required: ['mode'],
    });
    expect(schema.parse({ mode: 'fast' })).toEqual({ mode: 'fast' });
    expect(() => schema.parse({ mode: 'unknown' })).toThrow();
  });

  it('coerces date-time strings to Date instances', () => {
    const schema = makeSchema({
      type: 'object',
      properties: { from: { type: 'string', format: 'date-time' } },
      required: ['from'],
    });
    const parsed: any = schema.parse({ from: '2026-05-12T09:00:00Z' });
    expect(parsed.from).toBeInstanceOf(Date);
  });

  it('marks non-required fields as optional', () => {
    const schema = makeSchema({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'integer' },
      },
      required: ['a'],
    });
    expect(schema.parse({ a: 'x' })).toEqual({ a: 'x' });
    expect(schema.parse({ a: 'x', b: '7' })).toEqual({ a: 'x', b: 7 });
  });

  it('passes plain strings through unchanged', () => {
    const schema = makeSchema({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
    expect(schema.parse({ q: 'Domoferm' })).toEqual({ q: 'Domoferm' });
  });
});

/**
 * `loadAllTools` pages through the connector table instead of pulling every
 * tenant's connectors in one query — the single query materialised the whole
 * result set alongside the registry it was filling, roughly doubling peak heap
 * at boot. These lock in that the paging actually terminates, covers every
 * connector exactly once, and never holds more than one page.
 */
describe('McpServerService.loadAllTools paging', () => {
  const PAGE = (McpServerService as any).LOAD_PAGE_SIZE as number;

  /** A service with just enough wired up to run the paging loop. */
  function makeService(connectorIds: string[]) {
    const svc: any = Object.create(McpServerService.prototype);
    const calls: Array<Record<string, any>> = [];
    const registered: string[] = [];

    svc.prisma = {
      connector: {
        findMany: jest.fn(async (args: Record<string, any>) => {
          calls.push(args);
          const start = args.cursor
            ? connectorIds.indexOf(args.cursor.id) + (args.skip ?? 0)
            : 0;
          return connectorIds
            .slice(start, start + args.take)
            .map((id) => ({ id, tools: [] }));
        }),
      },
    };
    svc.registerConnectorTools = (c: { id: string }) => registered.push(c.id);

    return { svc, calls, registered };
  }

  it('visits every connector exactly once, in order', async () => {
    const ids = Array.from({ length: PAGE * 2 + 7 }, (_, i) => `c${i}`);
    const { svc, registered } = makeService(ids);

    await svc.loadAllTools();

    expect(registered).toEqual(ids);
  });

  it('never asks for more than one page at a time', async () => {
    const ids = Array.from({ length: PAGE * 3 }, (_, i) => `c${i}`);
    const { svc, calls } = makeService(ids);

    await svc.loadAllTools();

    expect(calls.every((c) => c.take === PAGE)).toBe(true);
    // First page has no cursor; every later one skips past the previous last id.
    expect(calls[0].cursor).toBeUndefined();
    expect(calls.slice(1).every((c) => c.skip === 1 && c.cursor)).toBe(true);
  });

  it('stops on an exact multiple of the page size instead of looping forever', async () => {
    const ids = Array.from({ length: PAGE * 2 }, (_, i) => `c${i}`);
    const { svc, calls, registered } = makeService(ids);

    await svc.loadAllTools();

    expect(registered).toHaveLength(PAGE * 2);
    // Two full pages, then one more that comes back empty and ends the loop.
    expect(calls).toHaveLength(3);
  });

  it('does nothing when there are no active connectors', async () => {
    const { svc, calls, registered } = makeService([]);

    await svc.loadAllTools();

    expect(registered).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
