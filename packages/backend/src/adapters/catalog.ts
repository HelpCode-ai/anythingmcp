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

// Register all adapters here. To add a new adapter:
// 1. Create the JSON file in the appropriate region folder
// 2. Import it above
// 3. Add it to this array
const ALL_ADAPTERS: AdapterDefinition[] = [
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
];

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
  }));
}

export function getAdapter(slug: string): AdapterDefinition | null {
  return ALL_ADAPTERS.find((a) => a.slug === slug) || null;
}
