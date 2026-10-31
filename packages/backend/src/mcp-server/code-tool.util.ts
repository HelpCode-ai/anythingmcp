import type { CodeBridge } from './code-executor.service';

/**
 * Saved code tools: an `McpTool` whose `endpointMapping.method === 'code'` runs a
 * stored program through the code-runner instead of calling one upstream
 * endpoint. The program may call only the tools the author declared in `uses`,
 * and only within the limits this module enforces. Nothing here runs code — it
 * parses/validates the stored shape and builds the bridge the sandbox is given,
 * with every access rule in one tested place.
 *
 * The bridge is where a code run's authority is decided:
 *   - `uses` — the only connectors/tools a run may touch.
 *   - read vs write — a run may call a write tool only when the tool is
 *     `allowWrites` (and that is itself admin/Enterprise-gated at save time).
 *   - invoker vs definer — `invoker` re-checks the caller's own role on every
 *     call (a code tool never lets a user reach a tool their role forbids);
 *     `definer` runs with the author's curation instead (stored-procedure
 *     semantics), still bounded by `uses` and `allowWrites`.
 *   - no nested code tools — a code tool cannot call another, so there is no
 *     recursion to bound.
 */

export const CODE_METHOD = 'code';

export interface CodeToolUse {
  connectorId: string;
  /** Tool names allowed from this connector; omitted/empty = all of its tools. */
  tools?: string[];
}

export interface CodeToolSpec {
  code: string;
  uses: CodeToolUse[];
  runAs: 'invoker' | 'definer';
  allowWrites: boolean;
}

/** True when an endpointMapping is a code tool. Cheap check for the hot path. */
export function isCodeMethod(endpointMapping: unknown): boolean {
  return (
    !!endpointMapping &&
    typeof endpointMapping === 'object' &&
    (endpointMapping as { method?: unknown }).method === CODE_METHOD
  );
}

/**
 * Parse a stored code endpointMapping into a spec, or null when it is not a code
 * tool. Unknown/invalid fields fall back to the safe default (no writes,
 * invoker rights), so a malformed row can never widen authority.
 */
export function parseCodeToolMapping(endpointMapping: unknown): CodeToolSpec | null {
  if (!isCodeMethod(endpointMapping)) return null;
  const em = endpointMapping as Record<string, unknown>;
  const code = typeof em.code === 'string' ? em.code : '';
  const uses = Array.isArray(em.uses)
    ? em.uses
        .map((u): CodeToolUse | null => {
          if (!u || typeof u !== 'object') return null;
          const connectorId = (u as { connectorId?: unknown }).connectorId;
          if (typeof connectorId !== 'string' || !connectorId) return null;
          const rawTools = (u as { tools?: unknown }).tools;
          const tools = Array.isArray(rawTools)
            ? rawTools.filter((t): t is string => typeof t === 'string')
            : undefined;
          return { connectorId, ...(tools && tools.length > 0 ? { tools } : {}) };
        })
        .filter((u): u is CodeToolUse => u !== null)
    : [];
  const runAs = em.runAs === 'definer' ? 'definer' : 'invoker';
  const allowWrites = em.allowWrites === true;
  return { code, uses, runAs, allowWrites };
}

/**
 * Validate a code endpointMapping at save time. Returns an error string or null.
 * Shape only — authority gates (definer ⇒ admin, allowWrites ⇒ Enterprise) are
 * enforced in the controller, which knows the caller and the edition.
 */
export function validateCodeToolMapping(endpointMapping: unknown): string | null {
  if (!isCodeMethod(endpointMapping)) return null;
  const em = endpointMapping as Record<string, unknown>;
  if (typeof em.code !== 'string' || em.code.trim().length === 0) {
    return 'A code tool needs a non-empty "code" program.';
  }
  if (em.code.length > 100_000) {
    return 'The code program is too large (max 100000 characters).';
  }
  if (!Array.isArray(em.uses) || em.uses.length === 0) {
    return 'A code tool must declare at least one connector in "uses".';
  }
  for (const u of em.uses) {
    if (!u || typeof u !== 'object' || typeof (u as { connectorId?: unknown }).connectorId !== 'string') {
      return 'Each entry in "uses" must have a connectorId.';
    }
    const tools = (u as { tools?: unknown }).tools;
    if (tools !== undefined && !(Array.isArray(tools) && tools.every((t) => typeof t === 'string'))) {
      return 'Each "uses" entry\'s tools must be an array of tool names.';
    }
  }
  if (em.runAs !== undefined && em.runAs !== 'invoker' && em.runAs !== 'definer') {
    return 'runAs must be "invoker" or "definer".';
  }
  if (em.allowWrites !== undefined && typeof em.allowWrites !== 'boolean') {
    return 'allowWrites must be a boolean.';
  }
  return null;
}

/** A tool the bridge can resolve: enough to enforce uses, role and read/write. */
export interface BridgeResolvedTool {
  id: string;
  name: string;
  connectorId: string;
  readOnly: boolean;
  /** True for another code tool — never callable from inside a code run. */
  isCode: boolean;
}

export interface CodeBridgeDeps {
  /** The tool registry, already narrowed to the caller's reachable set. */
  resolveTool(name: string): BridgeResolvedTool | undefined;
  /** The caller's allowed tool ids for this org, or null = unrestricted. */
  allowedToolIds: string[] | null;
  /** Run a resolved tool (delegates to executeTool); returns its value or throws. */
  runTool(name: string, args: Record<string, unknown>, connectorId: string): Promise<unknown>;
  /** Discovery over the allowed set. */
  search(query: string, options: Record<string, unknown>): Promise<unknown>;
  describe(name: string): Promise<unknown>;
}

/** Thrown when a code run asks for something its authority does not allow. */
export class CodeToolAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeToolAccessError';
  }
}

/**
 * The set of {connectorId -> allowed tool names (or all)} a spec permits, for
 * quick membership checks.
 */
function usesIndex(spec: CodeToolSpec): Map<string, Set<string> | null> {
  const index = new Map<string, Set<string> | null>();
  for (const u of spec.uses) {
    if (u.tools && u.tools.length > 0) index.set(u.connectorId, new Set(u.tools));
    else index.set(u.connectorId, null); // all tools of this connector
  }
  return index;
}

/**
 * Build the bridge handed to a code run. Every rule a run must obey is enforced
 * here, before `runTool` ever reaches the engine.
 */
export function buildCodeBridge(spec: CodeToolSpec, deps: CodeBridgeDeps): CodeBridge {
  const allowed = usesIndex(spec);

  const assertAllowed = (name: string): BridgeResolvedTool => {
    const tool = deps.resolveTool(name);
    if (!tool) {
      throw new CodeToolAccessError(`'${name}' is not a tool this code tool can use.`);
    }
    if (tool.isCode) {
      throw new CodeToolAccessError(`'${name}' is a code tool; code tools cannot call other code tools.`);
    }
    const connectorAllows = allowed.get(tool.connectorId);
    if (connectorAllows === undefined) {
      throw new CodeToolAccessError(`'${name}' belongs to a connector not declared in this code tool's uses.`);
    }
    if (connectorAllows !== null && !connectorAllows.has(tool.name)) {
      throw new CodeToolAccessError(`'${name}' is not in the allowed tools for its connector.`);
    }
    // Writes: only when the code tool is allowed to write.
    if (!tool.readOnly && !spec.allowWrites) {
      throw new CodeToolAccessError(`'${name}' can change data, and this code tool is read-only.`);
    }
    // Invoker rights: re-check the caller's own role, exactly like a direct call.
    // Definer rights skip this (the author curated `uses`), but never skip the
    // uses/write checks above.
    if (spec.runAs === 'invoker' && deps.allowedToolIds !== null && !deps.allowedToolIds.includes(tool.id)) {
      throw new CodeToolAccessError(`Access denied: you do not have permission to use '${name}'.`);
    }
    return tool;
  };

  return {
    search: (query, options) => deps.search(String(query ?? ''), options ?? {}),
    describe: async (name) => {
      assertAllowed(String(name));
      return deps.describe(String(name));
    },
    run: async (name, args) => {
      const tool = assertAllowed(String(name));
      return deps.runTool(tool.name, (args as Record<string, unknown>) ?? {}, tool.connectorId);
    },
  };
}
