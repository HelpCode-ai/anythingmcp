import { AxiosError } from 'axios';
import { Logger } from '@nestjs/common';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { TELEGRAM_NO_UPDATES_HINT } from './result-hints';
import { ODOO_FIELD_HINT } from './error-hints';

/**
 * Two answers the assistant could not act on: an empty Telegram read (a
 * success that explained nothing) and an Odoo field that does not exist (an
 * error that sent it to list several hundred fields first).
 */
describe('DynamicMcpTools: advice on an empty read and on an unknown Odoo field', () => {
  function build(tools: RegisteredTool[], rest: jest.Mock) {
    const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() };
    const unexpected = { execute: jest.fn().mockRejectedValue(new Error('unexpected engine')) };
    const byName = (name: string) => tools.find((t) => t.name === name);
    const executor = new DynamicMcpTools(
      {
        getTool: byName,
        getToolForOrg: byName,
        getToolsForConnectors: (ids: Iterable<string>) => {
          const wanted = new Set(ids);
          return tools.filter((t) => wanted.has(t.connectorId));
        },
      } as any,
      audit as any,
      redis as any,
      { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
      { isCloud: () => false } as any,
      {} as any,
      { execute: rest } as any,
      unexpected as any,
      unexpected as any,
      unexpected as any,
      unexpected as any,
      { scheduleObservationalIngest: jest.fn() } as any,
      { recentEvents: jest.fn().mockResolvedValue([]) } as any,
    );
    return { executor, audit };
  }

  const textOf = (res: any): string => res.content[0].text;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('Telegram: no messages', () => {
    const getUpdates = {
      id: 'tool-tg',
      connectorId: 'conn-tg',
      organizationId: 'org-1',
      name: 'telegram_bot_get_updates',
      description: 'Read messages',
      parameters: { type: 'object', properties: { offset: { type: 'integer' }, timeout: { type: 'integer' } } },
      connectorType: 'REST',
      connectorConfig: {
        baseUrl: 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}',
        authType: 'NONE',
        envVars: { TELEGRAM_BOT_TOKEN: '123456789:AAtesttoken' },
        config: { adapterSlug: 'telegram-bot' },
      },
      endpointMapping: { method: 'POST', path: '/getUpdates', bodyMapping: { offset: '$offset', timeout: '$timeout' } },
    } as unknown as RegisteredTool;

    it('tells the assistant why the list is empty and what the user must do', async () => {
      const rest = jest.fn().mockResolvedValue({ ok: true, result: [] });
      const { executor, audit } = build([getUpdates], rest);
      const res: any = await executor.executeTool('telegram_bot_get_updates', {});
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      // The API's own answer first, untouched; the advice after it.
      expect(JSON.parse(text.split('\n\n---\n')[0])).toEqual({ ok: true, result: [] });
      expect(text).toContain('WORKFLOW HINT (guidance for the assistant, not part of the API response)');
      expect(text).toContain(TELEGRAM_NO_UPDATES_HINT);
      // The call log keeps the API's answer only.
      expect(audit.logInvocation.mock.calls[0][0]).toMatchObject({ status: 'SUCCESS', output: { ok: true, result: [] } });
    });

    it('adds nothing when there are messages, or when a loop confirms with offset', async () => {
      const rest = jest.fn().mockResolvedValue({ ok: true, result: [{ update_id: 7, message: { text: 'hi' } }] });
      const { executor } = build([getUpdates], rest);
      expect(textOf(await executor.executeTool('telegram_bot_get_updates', {}))).not.toContain('WORKFLOW HINT');

      rest.mockResolvedValue({ ok: true, result: [] });
      expect(textOf(await executor.executeTool('telegram_bot_get_updates', { offset: 8, timeout: 20 }))).not.toContain(
        'WORKFLOW HINT',
      );
    });
  });

  describe('Odoo: a field that does not exist', () => {
    const connectorConfig = {
      baseUrl: '{{ODOO_URL}}/json/2',
      authType: 'BEARER_TOKEN',
      authConfig: JSON.stringify({ token: '{{ODOO_API_KEY}}' }),
      envVars: { ODOO_URL: 'https://acme.odoo.example', ODOO_API_KEY: 'key-123' },
      config: { adapterSlug: 'odoo' },
    };
    const odooTool = (name: string, path: string, bodyMapping: Record<string, string>): RegisteredTool =>
      ({
        id: `tool-${name}`,
        connectorId: 'conn-odoo',
        organizationId: 'org-1',
        name,
        description: name,
        parameters: {
          type: 'object',
          properties: { model: { type: 'string' }, fields: { type: 'array' }, attributes: { type: 'array' } },
          required: ['model'],
        },
        connectorType: 'REST',
        connectorConfig,
        endpointMapping: { method: 'POST', path, bodyMapping },
      }) as unknown as RegisteredTool;
    const searchRead = odooTool('odoo_search_read', '/{model}/search_read', { fields: '$fields' });
    const fieldsGet = odooTool('odoo_fields_get', '/{model}/fields_get', { attributes: '$attributes' });

    const invalidField = (field: string, model: string) =>
      new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: 500,
        statusText: 'INTERNAL SERVER ERROR',
        headers: {},
        config: {} as any,
        data: { name: 'builtins.ValueError', message: `Invalid field '${field}' on '${model}'` },
      });

    const modelFields = {
      tax_ids: { string: 'Taxes', type: 'many2many' },
      price_unit: { string: 'Unit Price', type: 'float' },
      name: { string: 'Description', type: 'text' },
    };

    /** search_read fails on the field; fields_get answers `fields`. */
    function odooRest(fields: unknown) {
      return jest.fn().mockImplementation(async (_config: unknown, mapping: { path: string }) => {
        if (mapping.path.endsWith('/fields_get')) {
          if (fields instanceof Error) throw fields;
          return fields;
        }
        throw invalidField('tax_id', 'sale.order.line');
      });
    }
    const fieldListCalls = (rest: jest.Mock) => rest.mock.calls.filter(([, m]) => m.path.endsWith('/fields_get'));
    const hintOf = (res: any): string => JSON.parse(textOf(res)).hint;

    it('names the close fields of the model Odoo complained about', async () => {
      const rest = odooRest(modelFields);
      const { executor, audit } = build([searchRead, fieldsGet], rest);
      const res: any = await executor.executeTool('odoo_search_read', { model: 'sale.order.line', fields: ['tax_id'] });
      expect(res.isError).toBe(true);
      const hint = hintOf(res);
      expect(hint).toMatch(/`tax_id` is not a field of sale\.order\.line/);
      expect(hint).toMatch(/`tax_ids` \(many2many, "Taxes"\)/);
      expect(hint).not.toContain(ODOO_FIELD_HINT);

      // One read of the field list, with the label and type only, on the model Odoo named.
      const [[config, mapping, args]] = fieldListCalls(rest);
      expect(mapping.path).toBe('/{model}/fields_get');
      expect(args).toMatchObject({ model: 'sale.order.line', attributes: ['string', 'type'] });
      expect(config.baseUrl).toBe('https://acme.odoo.example/json/2');
      // Only the customer's own call is in the call log.
      expect(audit.logInvocation).toHaveBeenCalledTimes(1);
      expect(audit.logInvocation.mock.calls[0][0]).toMatchObject({ status: 'ERROR' });
    });

    it('reads the field list once per model and reuses it', async () => {
      const rest = odooRest(modelFields);
      const { executor } = build([searchRead, fieldsGet], rest);
      await executor.executeTool('odoo_search_read', { model: 'sale.order.line', fields: ['tax_id'] });
      await executor.executeTool('odoo_search_read', { model: 'sale.order.line', fields: ['tax_id'] });
      expect(fieldListCalls(rest)).toHaveLength(1);
    });

    it('keeps the general hint when the field list cannot be read', async () => {
      const rest = odooRest(new Error('boom'));
      const { executor } = build([searchRead, fieldsGet], rest);
      const res = await executor.executeTool('odoo_search_read', { model: 'sale.order.line', fields: ['tax_id'] });
      expect(hintOf(res)).toBe(ODOO_FIELD_HINT);
    });

    it('keeps the general hint when the connector has no field-list tool', async () => {
      const rest = odooRest(modelFields);
      const { executor } = build([searchRead], rest);
      const res = await executor.executeTool('odoo_search_read', { model: 'sale.order.line', fields: ['tax_id'] });
      expect(hintOf(res)).toBe(ODOO_FIELD_HINT);
      expect(fieldListCalls(rest)).toHaveLength(0);
    });

    it('does not wait for a field list that never comes', async () => {
      jest.useFakeTimers();
      const rest = jest.fn().mockImplementation((_config: unknown, mapping: { path: string }) => {
        if (mapping.path.endsWith('/fields_get')) return new Promise(() => undefined);
        return Promise.reject(invalidField('tax_id', 'sale.order.line'));
      });
      const { executor } = build([searchRead, fieldsGet], rest);
      const pending = executor.executeTool('odoo_search_read', { model: 'sale.order.line', fields: ['tax_id'] });
      await jest.advanceTimersByTimeAsync(8_100);
      expect(hintOf(await pending)).toBe(ODOO_FIELD_HINT);
    });

    it('leaves other Odoo errors and other connectors alone', async () => {
      const rest = jest.fn().mockRejectedValue(invalidField('tax_id', 'sale.order.line'));
      const handMade = { ...searchRead, connectorConfig: { ...connectorConfig, config: {} } } as RegisteredTool;
      const { executor } = build([handMade, fieldsGet], rest);
      const res = await executor.executeTool('odoo_search_read', { model: 'sale.order.line', fields: ['tax_id'] });
      expect(hintOf(res)).toBe(ODOO_FIELD_HINT);
      expect(rest).toHaveBeenCalledTimes(1);
    });
  });
});
