import * as dhlTracking from './de/dhl-tracking.json';
import * as bundesbank from './de/bundesbank.json';
import * as destatisGenesis from './de/destatis-genesis.json';
import * as ninaWarnung from './de/nina-warnung.json';
import * as teamviewer from './de/teamviewer.json';
import * as n26OpenBanking from './de/n26-openbanking.json';
import * as payone from './de/payone.json';
import * as weclapp from './de/weclapp.json';
import * as immobilienscout24 from './de/immobilienscout24.json';
import * as mfrFieldservice from './de/mfr-fieldservice.json';
import * as fastbill from './de/fastbill.json';
import * as billomat from './de/billomat.json';
import * as datev from './de/datev.json';
import * as scopevisio from './de/scopevisio.json';
import * as kenjo from './de/kenjo.json';
import * as planradar from './de/planradar.json';
import * as viesVat from './de/vies-vat.json';
import * as handelsregister from './de/handelsregister.json';
import * as deutscheBahn from './de/deutsche-bahn.json';
import * as openplz from './de/openplz.json';
import * as oxomi from './de/oxomi.json';
import * as dpdGermany from './de/dpd-germany.json';
import * as glsTracking from './de/gls-tracking.json';
import * as shipcloud from './de/shipcloud.json';
import * as sendcloud from './de/sendcloud.json';
import * as xentral from './de/xentral.json';
import * as shopware6 from './de/shopware-6.json';
import * as hereGeocoding from './de/here-geocoding.json';
import * as personio from './de/personio.json';
import * as hrworks from './de/hrworks.json';
import * as companiesHouse from './gb/companies-house.json';
import * as wise from './gb/wise.json';
import * as razorpay from './in/razorpay.json';
import * as mercadoLibre from './br/mercado-libre.json';
import * as paystack from './ng/paystack.json';
import * as lineMessaging from './jp/line-messaging.json';
import * as sorare from './intl/sorare.json';

export interface AdapterMeta {
  slug: string;
  name: string;
  description: string;
  instructions?: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  toolCount: number;
  /** When true, surfaced in the marketing site's "Featured" rail. */
  featured?: boolean;
  /** Higher = ranked earlier in catalog listings. Default 0. */
  priority?: number;
}

export interface AdapterDefinition extends AdapterMeta {
  instructions?: string;
  connector: {
    name: string;
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
  };
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    endpointMapping: Record<string, unknown>;
    responseMapping?: Record<string, unknown>;
  }>;
}

/**
 * Auto-inject four generic GraphQL helper tools onto any GRAPHQL adapter:
 *   - `<slug>_graphql_schema_url`   — returns the URL of the SDL schema (or the value of
 *                                     `connector.schemaUrl` if the adapter overrides it)
 *   - `<slug>_graphql_query`        — execute an arbitrary `query` document
 *   - `<slug>_graphql_mutation`     — execute an arbitrary `mutation` document
 *   - `<slug>_graphql_subscription` — execute an arbitrary `subscription` document
 *                                     (transport availability depends on the upstream API)
 *
 * These give an MCP agent a fallback path when no purpose-built tool covers a
 * needed operation — the agent fetches the schema, composes the operation,
 * and runs it. Adapter authors don't need to declare them.
 */
function withGraphqlBuiltins(adapter: AdapterDefinition): AdapterDefinition {
  if (adapter.connector.type !== 'GRAPHQL') return adapter;
  const slug = adapter.slug;
  const schemaUrl =
    (adapter.connector as { schemaUrl?: string }).schemaUrl ||
    `${adapter.connector.baseUrl.replace(/\/+$/, '')}/schema`;

  const variablesSchema = {
    type: 'object',
    description: 'GraphQL variables map (optional). Keys must match $variables declared in the operation.',
    additionalProperties: true,
  };

  const buildOpTool = (
    op: 'query' | 'mutation' | 'subscription',
  ): AdapterDefinition['tools'][number] => ({
    name: `${slug}_graphql_${op}`,
    description:
      `Execute an arbitrary GraphQL ${op} against ${adapter.name}. ` +
      `Use only when no purpose-built tool covers the operation. ` +
      `Authentication is injected automatically.` +
      (op === 'subscription'
        ? ' Note: subscriptions over the default HTTP transport may not be supported by the upstream API.'
        : ''),
    parameters: {
      type: 'object',
      properties: {
        [op]: {
          type: 'string',
          description: `GraphQL ${op} document. Example: \`${op} Name($a: ID!) { … }\`.`,
        },
        variables: variablesSchema,
      },
      required: [op],
      additionalProperties: false,
    },
    endpointMapping: {
      method: op,
      path: `$${op}`,
      variablesFromParam: 'variables',
    },
  });

  const builtins: AdapterDefinition['tools'] = [
    {
      name: `${slug}_graphql_schema_url`,
      description:
        `Returns the URL of the GraphQL SDL schema for ${adapter.name}. ` +
        `Fetch it with a web tool (e.g. \`web_fetch\`) to discover available types and fields before composing a custom query.`,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      endpointMapping: {
        method: 'static',
        path: schemaUrl,
      },
    },
    buildOpTool('query'),
    buildOpTool('mutation'),
    buildOpTool('subscription'),
  ];

  return { ...adapter, tools: [...builtins, ...adapter.tools] };
}

// Register all adapters here. To add a new adapter:
// 1. Create the JSON file in the appropriate region folder
// 2. Import it above
// 3. Add it to this array
const RAW_ADAPTERS: AdapterDefinition[] = [
  dhlTracking as unknown as AdapterDefinition,
  bundesbank as unknown as AdapterDefinition,
  destatisGenesis as unknown as AdapterDefinition,
  ninaWarnung as unknown as AdapterDefinition,
  teamviewer as unknown as AdapterDefinition,
  n26OpenBanking as unknown as AdapterDefinition,
  payone as unknown as AdapterDefinition,
  weclapp as unknown as AdapterDefinition,
  immobilienscout24 as unknown as AdapterDefinition,
  mfrFieldservice as unknown as AdapterDefinition,
  fastbill as unknown as AdapterDefinition,
  billomat as unknown as AdapterDefinition,
  datev as unknown as AdapterDefinition,
  scopevisio as unknown as AdapterDefinition,
  kenjo as unknown as AdapterDefinition,
  planradar as unknown as AdapterDefinition,
  viesVat as unknown as AdapterDefinition,
  handelsregister as unknown as AdapterDefinition,
  deutscheBahn as unknown as AdapterDefinition,
  openplz as unknown as AdapterDefinition,
  oxomi as unknown as AdapterDefinition,
  dpdGermany as unknown as AdapterDefinition,
  glsTracking as unknown as AdapterDefinition,
  shipcloud as unknown as AdapterDefinition,
  sendcloud as unknown as AdapterDefinition,
  xentral as unknown as AdapterDefinition,
  shopware6 as unknown as AdapterDefinition,
  hereGeocoding as unknown as AdapterDefinition,
  personio as unknown as AdapterDefinition,
  hrworks as unknown as AdapterDefinition,
  companiesHouse as unknown as AdapterDefinition,
  wise as unknown as AdapterDefinition,
  razorpay as unknown as AdapterDefinition,
  mercadoLibre as unknown as AdapterDefinition,
  paystack as unknown as AdapterDefinition,
  lineMessaging as unknown as AdapterDefinition,
  sorare as unknown as AdapterDefinition,
];

const ALL_ADAPTERS: AdapterDefinition[] = RAW_ADAPTERS.map(withGraphqlBuiltins);

export function listAdapters(): AdapterMeta[] {
  return ALL_ADAPTERS.map((adapter) => ({
    slug: adapter.slug,
    name: adapter.name,
    description: adapter.description,
    instructions: adapter.instructions,
    region: adapter.region,
    category: adapter.category,
    icon: adapter.icon,
    docsUrl: adapter.docsUrl,
    requiredEnvVars: adapter.requiredEnvVars,
    toolCount: adapter.tools.length,
    featured: adapter.featured,
    priority: adapter.priority,
  }));
}

export function getAdapter(slug: string): AdapterDefinition | null {
  return ALL_ADAPTERS.find((a) => a.slug === slug) || null;
}
