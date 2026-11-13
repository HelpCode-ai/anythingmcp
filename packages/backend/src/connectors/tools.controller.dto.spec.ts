import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { BulkCreateToolsDto, CreateToolDto, UpdateToolDto } from './tools.controller';
import { trimToolName } from './parsers/tool-name.util';

// The same global pipe as main.ts.
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const run = <T>(metatype: new () => T, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype }) as Promise<T>;

const tool = (name: unknown) => ({
  name,
  description: 'List droplets',
  parameters: { type: 'object', properties: {} },
  endpointMapping: { method: 'GET', path: '/droplets' },
});

describe('trimToolName', () => {
  it('trims whitespace around a string', () => {
    expect(trimToolName('\tdigitalocean_list \n')).toBe('digitalocean_list');
  });

  it('passes other values through for the validators', () => {
    expect(trimToolName(42)).toBe(42);
    expect(trimToolName(undefined)).toBeUndefined();
  });
});

describe('tool DTO names', () => {
  it('stores a pasted name with a leading tab without the tab (create)', async () => {
    const dto = await run(CreateToolDto, tool('\tdigitalocean_destroy_droplet'));
    expect(dto.name).toBe('digitalocean_destroy_droplet');
  });

  it('trims the name on update and leaves an absent name absent', async () => {
    expect((await run(UpdateToolDto, { name: ' list_invoices ' })).name).toBe('list_invoices');
    expect((await run(UpdateToolDto, { description: 'x' })).name).toBeUndefined();
  });

  it('trims every name in a bulk create', async () => {
    const dto = await run(BulkCreateToolsDto, { tools: [tool(' a_tool'), tool('b_tool\t')] });
    expect(dto.tools.map((t) => t.name)).toEqual(['a_tool', 'b_tool']);
  });

  it('still refuses a name that is not a string', async () => {
    await expect(run(CreateToolDto, tool(42))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checks the length after trimming', async () => {
    const name = 'a'.repeat(64);
    expect((await run(CreateToolDto, tool(`  ${name}  `))).name).toBe(name);
    await expect(run(CreateToolDto, tool('a'.repeat(65)))).rejects.toBeInstanceOf(BadRequestException);
  });
});
