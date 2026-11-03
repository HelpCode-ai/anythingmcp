import {
  isCodeMethod,
  parseCodeToolMapping,
  validateCodeToolMapping,
  buildCodeBridge,
  CodeToolAccessError,
  type CodeToolSpec,
  type BridgeResolvedTool,
  type CodeBridgeDeps,
} from './code-tool.util';

describe('code-tool.util', () => {
  describe('isCodeMethod / parse', () => {
    it('recognises a code mapping', () => {
      expect(isCodeMethod({ method: 'code' })).toBe(true);
      expect(isCodeMethod({ method: 'static' })).toBe(false);
      expect(isCodeMethod(null)).toBe(false);
    });

    it('parses and defaults safely', () => {
      const spec = parseCodeToolMapping({
        method: 'code',
        code: 'return 1;',
        uses: [{ connectorId: 'c1', tools: ['a', 'b'] }, { connectorId: 'c2' }, { bad: true }],
        runAs: 'definer',
        allowWrites: true,
      });
      expect(spec).toEqual({
        code: 'return 1;',
        uses: [{ connectorId: 'c1', tools: ['a', 'b'] }, { connectorId: 'c2' }],
        runAs: 'definer',
        allowWrites: true,
      });
    });

    it('defaults runAs=invoker and allowWrites=false for unknown values', () => {
      const spec = parseCodeToolMapping({ method: 'code', code: 'x', uses: [{ connectorId: 'c' }], runAs: 'root', allowWrites: 'yes' })!;
      expect(spec.runAs).toBe('invoker');
      expect(spec.allowWrites).toBe(false);
    });

    it('returns null for non-code mappings', () => {
      expect(parseCodeToolMapping({ method: 'GET' })).toBeNull();
    });
  });

  describe('validate', () => {
    const ok = { method: 'code', code: 'return 1;', uses: [{ connectorId: 'c1' }] };
    it('accepts a valid mapping', () => {
      expect(validateCodeToolMapping(ok)).toBeNull();
    });
    it('rejects empty code', () => {
      expect(validateCodeToolMapping({ ...ok, code: '  ' })).toMatch(/non-empty/);
    });
    it('rejects empty uses', () => {
      expect(validateCodeToolMapping({ ...ok, uses: [] })).toMatch(/at least one connector/);
    });
    it('rejects a uses entry without connectorId', () => {
      expect(validateCodeToolMapping({ ...ok, uses: [{ tools: ['a'] }] })).toMatch(/connectorId/);
    });
    it('rejects a bad runAs', () => {
      expect(validateCodeToolMapping({ ...ok, runAs: 'nope' })).toMatch(/runAs/);
    });
    it('ignores non-code mappings', () => {
      expect(validateCodeToolMapping({ method: 'GET' })).toBeNull();
    });
  });

  describe('buildCodeBridge enforcement', () => {
    const tools: Record<string, BridgeResolvedTool> = {
      read_a: { id: 't-read-a', name: 'read_a', connectorId: 'c1', readOnly: true, isCode: false },
      write_a: { id: 't-write-a', name: 'write_a', connectorId: 'c1', readOnly: false, isCode: false },
      read_b: { id: 't-read-b', name: 'read_b', connectorId: 'c2', readOnly: true, isCode: false },
      other: { id: 't-other', name: 'other', connectorId: 'c9', readOnly: true, isCode: false },
      nested: { id: 't-nested', name: 'nested', connectorId: 'c1', readOnly: true, isCode: true },
    };
    const ran: string[] = [];
    function deps(overrides: Partial<CodeBridgeDeps> = {}): CodeBridgeDeps {
      return {
        resolveTool: (name) => tools[name],
        allowedToolIds: null,
        runTool: async (name) => {
          ran.push(name);
          return { ran: name };
        },
        search: async () => [{ tool: 'read_a' }],
        describe: async (name) => ({ name }),
        ...overrides,
      };
    }
    const spec = (o: Partial<CodeToolSpec> = {}): CodeToolSpec => ({
      code: 'x',
      uses: [{ connectorId: 'c1' }],
      runAs: 'invoker',
      allowWrites: false,
      ...o,
    });
    beforeEach(() => (ran.length = 0));

    it('runs an allowed read tool', async () => {
      const b = buildCodeBridge(spec(), deps());
      await expect(b.run('read_a', {})).resolves.toEqual({ ran: 'read_a' });
      expect(ran).toEqual(['read_a']);
    });

    it('refuses a connector not in uses', async () => {
      const b = buildCodeBridge(spec(), deps());
      await expect(b.run('other', {})).rejects.toThrow(CodeToolAccessError);
    });

    it('refuses a tool not in the connector allow-list', async () => {
      const b = buildCodeBridge(spec({ uses: [{ connectorId: 'c1', tools: ['read_a'] }] }), deps());
      await expect(b.run('write_a', {})).rejects.toThrow(/not in the allowed tools/);
    });

    it('refuses a write tool when the code tool is read-only', async () => {
      const b = buildCodeBridge(spec({ allowWrites: false }), deps());
      await expect(b.run('write_a', {})).rejects.toThrow(/read-only/);
    });

    it('allows a write tool when allowWrites is set', async () => {
      const b = buildCodeBridge(spec({ allowWrites: true }), deps());
      await expect(b.run('write_a', {})).resolves.toEqual({ ran: 'write_a' });
    });

    it('refuses calling another code tool', async () => {
      const b = buildCodeBridge(spec(), deps());
      await expect(b.run('nested', {})).rejects.toThrow(/cannot call other code tools/);
    });

    it('invoker mode re-checks the caller role', async () => {
      const b = buildCodeBridge(spec({ runAs: 'invoker' }), deps({ allowedToolIds: ['t-read-b'] }));
      await expect(b.run('read_a', {})).rejects.toThrow(/Access denied/);
    });

    it('definer mode ignores the caller role but still honours uses and writes', async () => {
      const d = deps({ allowedToolIds: ['t-read-b'] }); // caller may NOT use read_a
      const b = buildCodeBridge(spec({ runAs: 'definer' }), d);
      await expect(b.run('read_a', {})).resolves.toEqual({ ran: 'read_a' });
      // but a write is still refused for a read-only code tool, even as definer
      await expect(b.run('write_a', {})).rejects.toThrow(/read-only/);
    });

    it('describe is scoped the same way as run', async () => {
      const b = buildCodeBridge(spec(), deps());
      await expect(b.describe('read_a')).resolves.toEqual({ name: 'read_a' });
      await expect(b.describe('other')).rejects.toThrow(CodeToolAccessError);
    });
  });
});
