import { getAdapter } from '../adapters/catalog';

/**
 * The `errorWhen` rules that apply to a connector (see
 * engines/response-error.util.ts).
 *
 * The connector's own `config.errorWhen` wins, an empty list included, so an
 * operator can switch the check off. A catalog connector without one follows
 * its adapter: the rules describe the vendor's API, not the workspace, and
 * reading them from the catalog means a connector installed before its
 * adapter gained rules gets them too.
 */
export function connectorErrorWhen(config: unknown): unknown {
  if (!config || typeof config !== 'object') return undefined;
  const cfg = config as { errorWhen?: unknown; adapterSlug?: unknown };
  if (cfg.errorWhen !== undefined) return cfg.errorWhen;
  if (typeof cfg.adapterSlug !== 'string' || !cfg.adapterSlug) return undefined;
  const catalogConfig = getAdapter(cfg.adapterSlug)?.connector.config as
    | { errorWhen?: unknown }
    | undefined;
  return catalogConfig?.errorWhen;
}
