import { describe, it, expect } from '@jest/globals';
import * as adapter from './baserow.json';

const a = adapter as unknown as {
  connector: { 
    baseUrl: string; 
    authType: string; 
    authConfig: Record<string, string>;
  };
};
describe('baserow adapter — static spec conformance', () => {
  it('uses BASEROW_URL', () => 
    expect(a.connector.baseUrl).toBe('{{BASEROW_URL}}'));
  it('Token auth', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
    expect(a.connector.authConfig.apiKey).toBe('Token {{BASEROW_API_TOKEN}}');
  });
});
