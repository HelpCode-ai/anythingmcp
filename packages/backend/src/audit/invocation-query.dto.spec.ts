import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ExportInvocationsQueryDto, ListInvocationsQueryDto } from './invocation-query.dto';

async function check<T extends object>(cls: new () => T, query: Record<string, string>) {
  const dto = plainToInstance(cls, query);
  const errors = await validate(dto);
  return { dto, fields: errors.map((e) => e.property) };
}

describe('invocation query DTOs', () => {
  it('accepts the list filters, a date and a date-time', async () => {
    const { dto, fields } = await check(ListInvocationsQueryDto, {
      limit: '50',
      offset: '100',
      status: 'ERROR',
      search: 'get_',
      connectorId: 'c1',
      mcpServerId: 's1',
      toolId: 't1',
      from: '2026-10-01',
      to: '2026-10-08T12:30:00.000Z',
    });
    expect(fields).toEqual([]);
    expect(dto.limit).toBe(50);
    expect(dto.offset).toBe(100);
  });

  it('rejects an unknown status and a date that is not ISO 8601', async () => {
    const { fields } = await check(ListInvocationsQueryDto, {
      status: 'PENDING',
      from: 'yesterday',
      to: '2026-02-30',
    });
    expect(fields.sort()).toEqual(['from', 'status', 'to']);
  });

  it('requires a known export format', async () => {
    expect((await check(ExportInvocationsQueryDto, {})).fields).toEqual(['format']);
    expect((await check(ExportInvocationsQueryDto, { format: 'xlsx' })).fields).toEqual(['format']);
    expect((await check(ExportInvocationsQueryDto, { format: 'csv' })).fields).toEqual([]);
  });

  it('reads payloads=true/false as a boolean and rejects anything else', async () => {
    expect((await check(ExportInvocationsQueryDto, { format: 'json', payloads: 'true' })).dto.payloads).toBe(true);
    expect((await check(ExportInvocationsQueryDto, { format: 'json', payloads: 'false' })).dto.payloads).toBe(false);
    expect((await check(ExportInvocationsQueryDto, { format: 'json', payloads: 'yes' })).fields).toEqual([
      'payloads',
    ]);
  });
});
