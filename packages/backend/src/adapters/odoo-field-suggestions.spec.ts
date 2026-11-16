import {
  isOdooModelName,
  odooFieldAdvice,
  odooFieldsFromFieldsGet,
  parseOdooInvalidField,
  rankOdooFieldSuggestions,
  type OdooField,
} from './odoo-field-suggestions';

describe('parseOdooInvalidField', () => {
  it('reads the JSON-2 wording', () => {
    const body =
      '{"name":"builtins.ValueError","message":"Invalid field \'tax_id\' on \'sale.order.line\'","arguments":["Invalid field \'tax_id\' on \'sale.order.line\'"]}';
    expect(parseOdooInvalidField(body)).toEqual({ field: 'tax_id', model: 'sale.order.line' });
  });

  it('reads the JSON-RPC wording', () => {
    expect(
      parseOdooInvalidField("JSON-RPC error 200: Odoo Server Error: Invalid field 'analytic_account_id' on model 'sale.order'"),
    ).toEqual({ field: 'analytic_account_id', model: 'sale.order' });
  });

  it('reads a domain leaf', () => {
    expect(
      parseOdooInvalidField("Invalid field account.account.account_type in leaf ('account_type', '=', 'asset_receivable')"),
    ).toEqual({ field: 'account_type', model: 'account.account' });
  });

  it('keeps the field when no model is named', () => {
    expect(parseOdooInvalidField("Invalid field 'x_custom'")).toEqual({ field: 'x_custom' });
  });

  it('ignores other errors', () => {
    expect(parseOdooInvalidField('Cannot convert product.product.qty_available to SQL because it is not stored')).toBeUndefined();
    expect(parseOdooInvalidField('Access Denied')).toBeUndefined();
    expect(parseOdooInvalidField('')).toBeUndefined();
  });
});

describe('isOdooModelName', () => {
  it('accepts technical model names only', () => {
    expect(isOdooModelName('res.partner')).toBe(true);
    expect(isOdooModelName('sale.order.line')).toBe(true);
    expect(isOdooModelName('x_studio.model_1')).toBe(true);
    expect(isOdooModelName('partner')).toBe(false);
    expect(isOdooModelName('res.partner/../x')).toBe(false);
    expect(isOdooModelName('res.partner","search_read')).toBe(false);
    expect(isOdooModelName(undefined)).toBe(false);
    expect(isOdooModelName(`res.${'a'.repeat(200)}`)).toBe(false);
  });
});

describe('odooFieldsFromFieldsGet', () => {
  const map = {
    name: { string: 'Name', type: 'char' },
    tax_ids: { string: 'Taxes', type: 'many2many' },
    odd: 'not an object',
  };

  it('reads the JSON-2 map', () => {
    expect(odooFieldsFromFieldsGet(map)).toEqual([
      { name: 'name', label: 'Name', type: 'char' },
      { name: 'tax_ids', label: 'Taxes', type: 'many2many' },
    ]);
  });

  it('reads the JSON-RPC envelope', () => {
    expect(odooFieldsFromFieldsGet({ jsonrpc: '2.0', id: 1, result: map })).toHaveLength(2);
  });

  it('keeps a model field that happens to be called result', () => {
    expect(odooFieldsFromFieldsGet({ result: { string: 'Result', type: 'char' } })).toEqual([
      { name: 'result', label: 'Result', type: 'char' },
    ]);
  });

  it('returns nothing for anything else', () => {
    expect(odooFieldsFromFieldsGet(null)).toEqual([]);
    expect(odooFieldsFromFieldsGet([])).toEqual([]);
    expect(odooFieldsFromFieldsGet('fields')).toEqual([]);
  });
});

describe('rankOdooFieldSuggestions', () => {
  const names = (wanted: string, fields: OdooField[]) => rankOdooFieldSuggestions(wanted, fields).map((f) => f.name);

  // The renames that failed most in the week of 8-15 Nov 2026.
  const saleLine: OdooField[] = [
    { name: 'tax_ids', label: 'Taxes', type: 'many2many' },
    { name: 'price_tax', label: 'Total Tax', type: 'float' },
    { name: 'product_uom_id', label: 'Unit', type: 'many2one' },
    { name: 'product_uom_qty', label: 'Quantity', type: 'float' },
    { name: 'name', label: 'Description', type: 'text' },
    { name: 'order_id', label: 'Order Reference', type: 'many2one' },
    { name: 'state', label: 'Order Status', type: 'selection' },
  ];

  it('finds a renamed field first', () => {
    expect(names('tax_id', saleLine)[0]).toBe('tax_ids');
    expect(names('taxes_id', saleLine)[0]).toBe('tax_ids');
    expect(names('product_uom', saleLine)[0]).toBe('product_uom_id');
  });

  it('finds a plural that moved', () => {
    const menu: OdooField[] = [
      { name: 'group_ids', label: 'Groups', type: 'many2many' },
      { name: 'name', label: 'Menu', type: 'char' },
      { name: 'parent_id', label: 'Parent Menu', type: 'many2one' },
    ];
    expect(names('groups_id', menu)).toEqual(['group_ids']);
  });

  it('uses the label when the name says nothing', () => {
    const partner: OdooField[] = [
      { name: 'phone', label: 'Mobile', type: 'char' },
      { name: 'email', label: 'Email', type: 'char' },
      { name: 'vat', label: 'Tax ID', type: 'char' },
    ];
    expect(names('mobile', partner)).toEqual(['phone']);
  });

  it('names nothing when nothing is close', () => {
    expect(names('lot_producing_id', saleLine)).toEqual([]);
  });

  it('never suggests the refused name itself and caps the list', () => {
    const many: OdooField[] = Array.from({ length: 12 }, (_, i) => ({ name: `tax_id_${i}` }));
    const out = names('tax_id', [{ name: 'tax_id' }, ...many]);
    expect(out).not.toContain('tax_id');
    expect(out).toHaveLength(5);
  });
});

describe('odooFieldAdvice', () => {
  const fields: OdooField[] = [
    { name: 'tax_ids', label: 'Taxes', type: 'many2many' },
    { name: 'price_unit', label: 'Unit Price', type: 'float' },
  ];

  it('names the close fields and what to do', () => {
    const advice = odooFieldAdvice('tax_id', 'sale.order.line', fields)!;
    expect(advice).toMatch(/`tax_id` is not a field of sale\.order\.line/);
    expect(advice).toMatch(/`tax_ids` \(many2many, "Taxes"\)/);
    expect(advice).toMatch(/odoo_fields_get lists all 2 fields/);
  });

  it('says so when no field is close', () => {
    const advice = odooFieldAdvice('lot_producing_id', 'sale.order.line', fields)!;
    expect(advice).toMatch(/None of its 2 fields has a similar name/);
    expect(advice).toMatch(/Do not try another spelling/);
  });

  it('stays silent without a field list, or when the field does exist', () => {
    expect(odooFieldAdvice('tax_id', 'sale.order.line', [])).toBeUndefined();
    expect(odooFieldAdvice('tax_ids', 'sale.order.line', fields)).toBeUndefined();
  });

  it('never repeats a label that could break out of the hint', () => {
    const advice = odooFieldAdvice('tax_id', 'x.model', [{ name: 'tax_ids', label: 'Ta"x`es', type: 'char' }])!;
    expect(advice).toContain('"Taxes"');
  });
});
