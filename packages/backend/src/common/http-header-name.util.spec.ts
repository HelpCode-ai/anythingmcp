import {
  describeInvalidHeaderNames,
  invalidConnectorHeaderNames,
  isValidHeaderName,
} from './http-header-name.util';

describe('http-header-name.util', () => {
  it('accepts header names the catalog uses', () => {
    for (const name of ['X-API-Key', 'Authorization', 'X-Odoo-Database', 'x-api-key', 'Api-Token', 'X_Custom']) {
      expect(isValidHeaderName(name)).toBe(true);
    }
  });

  it('refuses names Node would refuse at send time', () => {
    for (const name of ['API Odoo', 'Valentino API Key', 'X-Key:', '', 'Clé']) {
      expect(isValidHeaderName(name)).toBe(false);
    }
  });

  it('checks plain headers, the API-key header and the signature header', () => {
    expect(
      invalidConnectorHeaderNames(
        { 'Content-Type': 'application/json', 'My Header': 'x' },
        { headerName: 'API Odoo', signature: { headerName: 'Signature' } },
      ),
    ).toEqual(['My Header', 'API Odoo']);
    expect(invalidConnectorHeaderNames(undefined, { token: 'abc' })).toEqual([]);
  });

  it('explains what Header Name means', () => {
    expect(describeInvalidHeaderNames(['API Odoo'])).toMatch(
      /"API Odoo" is not a valid HTTP header name.*not the name you gave the key/,
    );
  });
});
