import { probeResultFailure, probeResultText } from './probe.util';

describe('probe results that answered but cannot count', () => {
  const rules = {
    probe: {
      failWhen: [
        { matches: '"searchableProducts"\\s*:\\s*\\[\\s*\\]', hint: 'No scopes.', field: 'TOKEN' },
      ],
    },
  };
  const mcp = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

  it("reads an MCP tool result's text, where its JSON is", () => {
    expect(probeResultText(mcp('{"a":1}'))).toBe('{"a":1}');
    expect(probeResultText({ content: [{ type: 'text', text: 'x' }], structuredContent: { b: 2 } })).toBe('x\n{"b":2}');
    expect(probeResultText({ a: 1 })).toBe('{"a":1}');
  });

  it("fails with the rule's hint and field when the answer matches", () => {
    expect(probeResultFailure(rules, mcp('{"results":[],"searchableProducts":[]}'))).toEqual({
      kind: 'auth_failed',
      message: 'No scopes. ({"results":[],"searchableProducts":[]})',
      field: 'TOKEN',
    });
  });

  it('passes an answer no rule matches', () => {
    expect(probeResultFailure(rules, mcp('{"searchableProducts":["jira"]}'))).toBeNull();
    expect(probeResultFailure({}, { companyName: 'Acme' })).toBeNull();
  });

  it('fails an MCP result with isError, with the server words', () => {
    expect(probeResultFailure({}, mcp('Input validation error', true))).toEqual({
      kind: 'upstream_error',
      message: 'The server refused the check call: Input validation error',
    });
  });

  it('takes an isError field in a REST body as data', () => {
    expect(probeResultFailure({}, { isError: true, value: 1 })).toBeNull();
  });

  it('skips a rule whose expression does not compile', () => {
    expect(probeResultFailure({ probe: { failWhen: [{ matches: '(', hint: 'x' }] } }, mcp('('))).toBeNull();
  });
});
