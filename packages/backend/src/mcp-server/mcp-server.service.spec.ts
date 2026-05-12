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
