import { ToolRegistry, RegisteredTool } from './tool-registry';

const makeTool = (overrides: Partial<RegisteredTool> = {}): RegisteredTool => ({
  id: 'tool-1',
  connectorId: 'conn-1',
  name: 'test_tool',
  description: 'A test tool',
  parameters: {},
  connectorType: 'REST',
  connectorConfig: { baseUrl: 'http://example.com', authType: 'NONE' },
  endpointMapping: { method: 'GET', path: '/' },
  ...overrides,
});

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('registerTool', () => {
    it('should register a tool and retrieve it by name', () => {
      const tool = makeTool();
      registry.registerTool(tool);
      expect(registry.getTool('test_tool')).toBe(tool);
    });

    it('should keep both tools when names collide but ids differ (multi-org)', () => {
      const tool1 = makeTool({ id: 'tool-1' });
      const tool2 = makeTool({ id: 'tool-2' });
      registry.registerTool(tool1);
      registry.registerTool(tool2);
      // Either is acceptable — getTool() without scope returns one of the two
      expect([tool1, tool2]).toContain(registry.getTool('test_tool'));
      expect(registry.getToolCount()).toBe(2);
    });

    it('should keep a single entry when the same id is re-registered', () => {
      const tool1 = makeTool({ id: 'tool-1', description: 'first' });
      const tool2 = makeTool({ id: 'tool-1', description: 'second' });
      registry.registerTool(tool1);
      registry.registerTool(tool2);
      expect(registry.getToolCount()).toBe(1);
    });
  });

  describe('getTool', () => {
    it('should return undefined for unregistered tool name', () => {
      expect(registry.getTool('nonexistent')).toBeUndefined();
    });
  });

  describe('unregisterConnectorTools', () => {
    it('should remove all tools for a given connectorId', () => {
      registry.registerTool(makeTool({ id: 't-a', name: 'a', connectorId: 'conn-1' }));
      registry.registerTool(makeTool({ id: 't-b', name: 'b', connectorId: 'conn-1' }));
      registry.registerTool(makeTool({ id: 't-c', name: 'c', connectorId: 'conn-2' }));

      registry.unregisterConnectorTools('conn-1');

      expect(registry.getTool('a')).toBeUndefined();
      expect(registry.getTool('b')).toBeUndefined();
      expect(registry.getToolCount()).toBe(1);
    });

    it('should not remove tools from other connectors', () => {
      registry.registerTool(makeTool({ id: 't-x', name: 'x', connectorId: 'conn-2' }));
      registry.unregisterConnectorTools('conn-1');
      expect(registry.getTool('x')).toBeDefined();
    });

    it('should handle unregister when no tools match', () => {
      registry.registerTool(makeTool({ id: 't-a', name: 'a', connectorId: 'conn-1' }));
      registry.unregisterConnectorTools('conn-999');
      expect(registry.getToolCount()).toBe(1);
    });
  });

  describe('getAllTools', () => {
    it('should return all registered tools as an array', () => {
      registry.registerTool(makeTool({ id: 'tool-a', name: 'a' }));
      registry.registerTool(makeTool({ id: 'tool-b', name: 'b' }));
      const tools = registry.getAllTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(['a', 'b']);
    });

    it('should return empty array when no tools registered', () => {
      expect(registry.getAllTools()).toEqual([]);
    });
  });

  describe('getToolCount', () => {
    it('should return the current number of registered tools', () => {
      expect(registry.getToolCount()).toBe(0);
      registry.registerTool(makeTool({ id: 'tool-a', name: 'a' }));
      expect(registry.getToolCount()).toBe(1);
      registry.registerTool(makeTool({ id: 'tool-b', name: 'b' }));
      expect(registry.getToolCount()).toBe(2);
    });
  });
});
