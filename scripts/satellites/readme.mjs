/**
 * README templates for satellite repositories (SEO-GITHUB-PLAN §3.8).
 *
 * The section order is fixed: a direct answer first (what it is, how many
 * tools, how to install), then setup, then the tool reference generated from
 * the adapter JSON, then the hand-written parts (prompts, FAQ) from
 * content/<repo>/. Nothing here states a number that is not computed from the
 * adapter JSON.
 */
import { renderToolsTable, access } from './templates/render-tools.mjs';

const MAIN = 'https://github.com/HelpCode-ai/anythingmcp';
const CLOUD = 'https://cloud.anythingmcp.com';

const T = {
  en: {
    tagline: (s, objects) => `Connect ${s} to Claude, ChatGPT and Copilot: ${objects} as MCP tools.`,
    powered: `Powered by [AnythingMCP](${MAIN}).`,
    intro: (repoTitle, n, name, objects, writes) =>
      `${repoTitle} gives Claude, ChatGPT, Copilot and Cursor ${n} tools for ${name}: ${objects}. ` +
      `${writes === 0 ? 'Every tool only reads. ' : `${n - writes} tools read and ${writes} can change data. `}` +
      'It runs on AnythingMCP: one click on AnythingMCP Cloud, or self-hosted with Docker. Credentials are stored encrypted and every call is audited.',
    verified: (v) => `**Last verified:** ${v.date} against ${v.against} (${v.how}).`,
    unverified:
      '**Status:** not yet verified against a live system. The adapter follows the vendor\'s API documentation; please report what you find.',
    synced: 'Adapter synced',
    cloud: 'Quick start (AnythingMCP Cloud)',
    cloudSteps: (slug, vars) => [
      `Sign in at [cloud.anythingmcp.com](${CLOUD}) and open the [install link](${CLOUD}/connectors/store?install=${slug}).`,
      vars.length ? `Enter ${vars.map((v) => `\`${v}\``).join(', ')} (see [Authentication](#authentication)).` : 'No credentials are needed.',
      'Copy the URL of your MCP server under **MCP Servers** and add it to your AI client ([below](#connect-claude-chatgpt-copilot-or-cursor)).',
    ],
    cloudNote: 'AnythingMCP Cloud is the same open-source code, operated by helpcode.ai in Frankfurt, Germany.',
    self: 'Self-hosted (Docker)',
    selfIntro: 'Needs Docker 24+, openssl and Node 18+.',
    selfAfter: (vars, slug) =>
      `\`install.sh\` writes \`.env\` with fresh secrets, starts AnythingMCP, creates the first admin, installs the connector${vars.length ? ` if ${vars.map((v) => `\`${v}\``).join(' and ')} are set in \`.env\`` : ''} and creates an MCP API key. ` +
      `Without credentials it prints the install link instead: \`http://localhost:3000/connectors/store?install=${slug}\`. Then check the whole chain:`,
    connect: 'Connect Claude, ChatGPT, Copilot or Cursor',
    connectItems: (repo) => [
      `**Claude (claude.ai, Desktop, mobile):** *Customize → Connectors → Add custom connector*, paste your MCP server URL and sign in. Claude connects from Anthropic's cloud, so the URL must be public HTTPS: your AnythingMCP Cloud URL, or your own instance behind TLS.`,
      `**Claude Code:**\n\n  \`\`\`bash\n  claude mcp add --transport http ${repo} http://localhost:4000/mcp --header "X-API-Key: <MCP_API_KEY>"\n  \`\`\``,
      `**Cursor** (\`.cursor/mcp.json\`) and **VS Code / GitHub Copilot** (\`.vscode/mcp.json\`, key \`servers\` instead of \`mcpServers\`, plus \`"type": "http"\`):\n\n  \`\`\`json\n  { "mcpServers": { "${repo}": { "url": "http://localhost:4000/mcp", "headers": { "X-API-Key": "<MCP_API_KEY>" } } } }\n  \`\`\``,
      '**ChatGPT:** add the public HTTPS URL as a connector (app) in ChatGPT\'s settings. A `localhost` URL does not work there.',
    ],
    tools: 'Tools',
    toolsIntro: (n, files) => `${n} tools, generated from ${files}. **read** tools cannot change anything in the source system.`,
    prompts: 'Example prompts',
    morePrompts: 'More in [examples/prompts.md](examples/prompts.md).',
    auth: 'Authentication',
    authFallback: (vars, docs) =>
      `The connector needs ${vars.map((v) => `\`${v}\``).join(', ')}. See the vendor's API documentation: ${docs}`,
    security: 'Security',
    securityItems: (reads, writes) => [
      `**Read or write is your choice.** ${writes.length ? `${reads} of the tools only read` : `All ${reads} tools only read`}${writes.length ? `; ${writes.map((w) => `\`${w}\``).join(', ')} can change data` : ''}. Assign the connector to an MCP server whose role whitelists only the tools you want, and the rest are invisible to that client.`,
      '**Credentials** are encrypted with AES-256-GCM and never shown to the model.',
      '**Response mapping** drops or reshapes fields per tool before they reach the model, e.g. bank details or personal data.',
      '**Audit log:** every call is recorded with input, output, duration and status, in your own database when self-hosted.',
      '**SSO, RBAC and SCIM** are included in the self-hosted build.',
    ],
    faq: 'FAQ',
    trouble: 'Troubleshooting',
    troubleRows: [
      ['`401` / `403` from the vendor', 'The credentials are wrong or lack rights. Re-enter them on the connector page; the import runs a test call and shows the result.'],
      ['Tools missing in the AI client', 'The connector is not assigned to the MCP server the client uses. Check **MCP Servers**, then run `node scripts/smoke.mjs`.'],
      ['The host is on your internal network', 'Self-host AnythingMCP on that network and add the hostname to `SSRF_ALLOWED_HOSTS`, or the outbound guard blocks the call.'],
      ['Works locally, fails on AnythingMCP Cloud', 'The system must be reachable from the internet with a valid TLS certificate.'],
    ],
    related: 'Related',
    relatedMain: 'the open-source MCP server and gateway this repository is built on',
    license: 'License',
    licenseText: (l) =>
      l ? `${l}. The adapter definition in \`adapter/\` comes from AnythingMCP (AGPL-3.0).` : 'Not decided yet.',
  },
  de: {
    tagline: (s, objects) => `Verbinde ${s} mit Claude, ChatGPT und Copilot: ${objects} als MCP-Tools.`,
    powered: `Basiert auf [AnythingMCP](${MAIN}).`,
    intro: (repoTitle, n, name, objects, writes) =>
      `${repoTitle} gibt Claude, ChatGPT, Copilot und Cursor ${n} Tools für ${name}: ${objects}. ` +
      `${writes === 0 ? 'Alle Tools lesen nur. ' : `${n - writes} Tools lesen, ${writes} können Daten ändern. `}` +
      'Es läuft auf AnythingMCP: mit einem Klick in AnythingMCP Cloud oder selbst gehostet mit Docker. Zugangsdaten werden verschlüsselt gespeichert, jeder Aufruf landet im Audit-Log.',
    verified: (v) => `**Zuletzt geprüft:** ${v.date} gegen ${v.againstDe ?? v.against} (${v.howDe ?? v.how}).`,
    unverified:
      '**Status:** noch nicht gegen ein Live-System geprüft. Der Adapter folgt der API-Dokumentation des Herstellers; Rückmeldungen sind willkommen.',
    synced: 'Adapter synchronisiert',
    cloud: 'Schnellstart (AnythingMCP Cloud)',
    cloudSteps: (slug, vars) => [
      `Melde dich bei [cloud.anythingmcp.com](${CLOUD}) an und öffne den [Installationslink](${CLOUD}/connectors/store?install=${slug}).`,
      vars.length ? `Trage ${vars.map((v) => `\`${v}\``).join(', ')} ein (siehe [Authentifizierung](#authentifizierung)).` : 'Es sind keine Zugangsdaten nötig.',
      'Kopiere die URL deines MCP-Servers unter **MCP Servers** und füge sie in deinen KI-Client ein ([siehe unten](#claude-chatgpt-copilot-oder-cursor-verbinden)).',
    ],
    cloudNote: 'AnythingMCP Cloud ist derselbe Open-Source-Code, betrieben von helpcode.ai in Frankfurt.',
    self: 'Selbst gehostet (Docker)',
    selfIntro: 'Benötigt Docker 24+, openssl und Node 18+.',
    selfAfter: (vars, slug) =>
      `\`install.sh\` schreibt \`.env\` mit neuen Secrets, startet AnythingMCP, legt den ersten Admin an, installiert den Connector${vars.length ? `, sofern ${vars.map((v) => `\`${v}\``).join(' und ')} in \`.env\` gesetzt sind,` : ''} und erzeugt einen MCP-API-Key. ` +
      `Ohne Zugangsdaten gibt es stattdessen den Installationslink aus: \`http://localhost:3000/connectors/store?install=${slug}\`. Danach die ganze Kette prüfen:`,
    connect: 'Claude, ChatGPT, Copilot oder Cursor verbinden',
    connectItems: (repo) => [
      `**Claude (claude.ai, Desktop, Mobil):** *Customize → Connectors → Add custom connector*, MCP-Server-URL einfügen und anmelden. Claude verbindet sich aus der Cloud von Anthropic, die URL muss also öffentlich per HTTPS erreichbar sein: deine AnythingMCP-Cloud-URL oder deine eigene Instanz mit TLS.`,
      `**Claude Code:**\n\n  \`\`\`bash\n  claude mcp add --transport http ${repo} http://localhost:4000/mcp --header "X-API-Key: <MCP_API_KEY>"\n  \`\`\``,
      `**Cursor** (\`.cursor/mcp.json\`) und **VS Code / GitHub Copilot** (\`.vscode/mcp.json\`, Schlüssel \`servers\` statt \`mcpServers\`, dazu \`"type": "http"\`):\n\n  \`\`\`json\n  { "mcpServers": { "${repo}": { "url": "http://localhost:4000/mcp", "headers": { "X-API-Key": "<MCP_API_KEY>" } } } }\n  \`\`\``,
      '**ChatGPT:** die öffentliche HTTPS-URL in den ChatGPT-Einstellungen als Connector (App) hinzufügen. Eine `localhost`-URL funktioniert dort nicht.',
    ],
    tools: 'Tools',
    toolsIntro: (n, files) => `${n} Tools, erzeugt aus ${files}. Tools mit **lesen** können im Quellsystem nichts ändern.`,
    prompts: 'Beispiel-Prompts',
    morePrompts: 'Weitere (auf Englisch) in [examples/prompts.md](../examples/prompts.md).',
    auth: 'Authentifizierung',
    authFallback: (vars, docs) => `Der Connector braucht ${vars.map((v) => `\`${v}\``).join(', ')}. Siehe die API-Dokumentation des Herstellers: ${docs}`,
    security: 'Sicherheit',
    securityItems: (reads, writes) => [
      `**Lesen oder schreiben entscheidest du.** ${writes.length ? `${reads} der Tools lesen nur` : `Alle ${reads} Tools lesen nur`}${writes.length ? `; ${writes.map((w) => `\`${w}\``).join(', ')} können Daten ändern` : ''}. Weise den Connector einem MCP-Server zu, dessen Rolle nur die gewünschten Tools freigibt; die anderen sieht dieser Client gar nicht.`,
      '**Zugangsdaten** werden mit AES-256-GCM verschlüsselt und nie an das Modell gegeben.',
      '**Response-Mapping** entfernt oder formt Felder pro Tool, bevor sie das Modell erreichen, etwa Bankdaten oder personenbezogene Daten.',
      '**Audit-Log:** Jeder Aufruf wird mit Eingabe, Ausgabe, Dauer und Status protokolliert, selbst gehostet in deiner eigenen Datenbank.',
      '**SSO, RBAC und SCIM** sind in der selbst gehosteten Version enthalten.',
    ],
    faq: 'FAQ',
    trouble: 'Fehlerbehebung',
    troubleRows: [
      ['`401` / `403` vom Hersteller', 'Zugangsdaten falsch oder ohne Rechte. Auf der Connector-Seite neu eintragen; der Import macht einen Testaufruf und zeigt das Ergebnis.'],
      ['Tools fehlen im KI-Client', 'Der Connector ist nicht dem MCP-Server zugewiesen, den der Client nutzt. **MCP Servers** prüfen, dann `node scripts/smoke.mjs` ausführen.'],
      ['Das System steht im internen Netz', 'AnythingMCP in diesem Netz selbst hosten und den Hostnamen in `SSRF_ALLOWED_HOSTS` eintragen, sonst blockiert der Outbound-Guard den Aufruf.'],
      ['Lokal ok, in AnythingMCP Cloud nicht', 'Das System muss aus dem Internet mit gültigem TLS-Zertifikat erreichbar sein.'],
    ],
    related: 'Verwandte Repositories',
    relatedMain: 'der Open-Source-MCP-Server und -Gateway, auf dem dieses Repository aufbaut',
    license: 'Lizenz',
    licenseText: (l) =>
      l ? `${l}. Die Adapter-Definition in \`adapter/\` stammt aus AnythingMCP (AGPL-3.0).` : 'Noch nicht entschieden.',
  },
};

function repoLink(config, repo) {
  const s = config.satellites.find((x) => x.repo === repo);
  return `[${repo}](https://github.com/${s.owner}/${s.repo})`;
}

function relatedList(sat, config, t) {
  const items = [];
  if (sat.umbrella) {
    const u = config.satellites.find((x) => x.repo === sat.umbrella);
    items.push(`${repoLink(config, u.repo)}: ${u.about}`);
  }
  for (const r of sat.related ?? []) {
    if (r === sat.umbrella) continue;
    const s = config.satellites.find((x) => x.repo === r);
    items.push(`${repoLink(config, s.repo)}: ${s.about}`);
  }
  items.push(`[AnythingMCP](${MAIN}): ${t.relatedMain}.`);
  return items.map((i) => `- ${i}`).join('\n');
}

function header(sat, ctx, t, title, taglineText) {
  const { config, date, lang } = ctx;
  const langs = sat.languages ?? ['en'];
  const switcher =
    langs.length > 1
      ? `\n${langs
          .map((l) => {
            const label = { en: 'English', de: 'Deutsch', it: 'Italiano', nl: 'Nederlands' }[l];
            if (l === lang) return `**${label}**`;
            const href = l === 'en' ? (lang === 'en' ? 'README.md' : '../README.md') : lang === 'en' ? `docs/README.${l}.md` : `README.${l}.md`;
            return `[${label}](${href})`;
          })
          .join(' · ')}\n`
      : '';
  return [
    `# ${title}`,
    switcher,
    `**${taglineText}** ${t.powered}`,
    '',
    ctx.introText,
    '',
    `${sat.lastVerified ? t.verified(sat.lastVerified) : t.unverified}  \n**${t.synced}:** <!-- synced -->${date}`,
    '',
    config.owners[sat.owner].maintainedBy,
    '',
  ].join('\n');
}

function connectorReadme(sat, ctx) {
  const { adapters, content, lang, config } = ctx;
  const t = T[lang];
  const a = adapters[0];
  const vars = a.requiredEnvVars ?? [];
  const writes = a.tools.filter((x) => access(x, a.connector?.type) === 'write').map((x) => x.name);
  const objects = sat.objects?.[lang] ?? sat.objects?.en ?? sat.about.split('. ').pop().replace(/\.$/, '');
  const title = `${sat.system} MCP Server`;
  const introText = t.intro(title, a.tools.length, sat.system, lcFirst(objects), writes.length);
  const c = content[lang] ?? {};
  const cEn = content.en ?? {};
  const prompts = (c.prompts ?? cEn.prompts ?? '').split('\n').filter((l) => l.startsWith('- ')).slice(0, 6).join('\n');
  const auth = c.auth ?? (lang === 'en' ? a.instructions : null) ?? cEn.auth ?? a.instructions ?? t.authFallback(vars, a.docsUrl);
  const faq = c.faq ?? cEn.faq ?? '';
  const trouble = [...t.troubleRows, ...parseRows(c.troubleshooting ?? cEn.troubleshooting)];
  const repo = sat.repo;
  const selfBlock = [
    `## ${t.self}`,
    '',
    t.selfIntro,
    '',
    '```bash',
    `git clone https://github.com/${sat.owner}/${repo}.git`,
    `cd ${repo}`,
    './scripts/install.sh',
    '```',
    '',
    t.selfAfter(vars, a.slug),
    '',
    '```bash',
    'npm install && node scripts/smoke.mjs',
    '```',
  ].join('\n');
  return [
    header(sat, { ...ctx, introText }, t, title, t.tagline(sat.system, lcFirst(objects))),
    `## ${t.cloud}`,
    '',
    t.cloudSteps(a.slug, vars).map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    t.cloudNote,
    '',
    selfBlock,
    '',
    `## ${t.connect}`,
    '',
    t.connectItems(repo).map((s) => `- ${s}`).join('\n'),
    '',
    `## ${t.tools}`,
    '',
    t.toolsIntro(a.tools.length, `[\`adapter/${a.slug}.json\`](${lang === 'en' ? '' : '../'}adapter/${a.slug}.json)`),
    '',
    renderToolsTable([a], lang),
    '',
    `## ${t.prompts}`,
    '',
    prompts,
    '',
    t.morePrompts,
    '',
    `## ${t.auth}`,
    '',
    auth,
    '',
    `## ${t.security}`,
    '',
    t.securityItems(a.tools.length - writes.length, writes).map((s) => `- ${s}`).join('\n'),
    '',
    `## ${t.faq}`,
    '',
    faq,
    '',
    `## ${t.trouble}`,
    '',
    `| ${lang === 'de' ? 'Problem | Lösung' : 'Problem | Fix'} |`,
    '|---|---|',
    ...trouble.map(([p, f]) => `| ${p} | ${f} |`),
    '',
    `## ${t.related}`,
    '',
    relatedList(sat, config, t),
    '',
    `## ${t.license}`,
    '',
    t.licenseText(config.license),
    '',
  ].join('\n');
}

function umbrellaReadme(sat, ctx) {
  const { adapters, content, config, catalog } = ctx;
  const t = T.en;
  const title = `${sat.system} MCP Server`;
  const total = adapters.reduce((n, a) => n + a.tools.length, 0);
  const introText =
    `${title} connects ${adapters.length} ${sat.system === 'SAP' ? 'SAP products' : `${sat.system === 'ERP' ? 'ERP' : 'e-commerce'} systems`} to Claude, ChatGPT, Copilot and Cursor through one MCP endpoint: ${total} tools in total. ` +
    'Pick the systems you run, add their credentials, and each becomes a set of MCP tools. It runs on AnythingMCP Cloud or self-hosted with Docker, with encrypted credentials and an audit log.';
  const dedicated = (slug) => config.satellites.find((s) => s.type === 'connector' && s.adapters.length === 1 && s.adapters[0] === slug);
  const rows = adapters.map((a) => {
    const d = dedicated(a.slug);
    const flag = /\*\*Unverified/.test(a.instructions ?? '') ? ' †' : '';
    const region = (catalog.get(a.slug)?.region ?? '').toUpperCase().replace('INTL', 'Global');
    return `| ${a.name}${flag} | ${region} | ${a.tools.length} | ${a.connector?.authType ?? ''} | [install](${CLOUD}/connectors/store?install=${a.slug}) | ${d ? repoLink(config, d.repo) : '–'} |`;
  });
  const bridge =
    sat.system === 'E-commerce'
      ? ''
      : [
          `## Your ${sat.system === 'SAP' ? 'SAP system' : 'ERP'} isn't listed?`,
          '',
          `Connect it through what it already exposes: its REST/OData API (${repoLink(config, 'openapi-to-mcp')}), its SOAP services (${repoLink(config, 'soap-to-mcp')}) or its SQL database, read-only (${repoLink(config, 'sql-to-mcp')}). That covers custom and on-premises builds that no catalog adapter will ever know.`,
          '',
        ].join('\n');
  return [
    header(sat, { ...ctx, introText }, t, title, `Connect ${adapters.length} ${sat.system === 'E-commerce' ? 'shops and marketplaces' : sat.system === 'SAP' ? 'SAP products' : 'ERPs'} to Claude, ChatGPT and Copilot through one MCP server.`),
    '## Systems',
    '',
    '| System | Region | Tools | Auth | Cloud | Dedicated repo |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    adapters.some((a) => /\*\*Unverified/.test(a.instructions ?? ''))
      ? "† Built from the vendor's published API documentation and not yet exercised against a live system. Reports and fixes are welcome.\n"
      : '',
    bridge,
    '## Self-hosted (Docker)',
    '',
    '```bash',
    `git clone https://github.com/${sat.owner}/${sat.repo}.git && cd ${sat.repo}`,
    './scripts/install.sh   # installs every system whose credentials are set in .env',
    '```',
    '',
    `## ${t.connect}`,
    '',
    t.connectItems(sat.repo).map((s) => `- ${s}`).join('\n'),
    '',
    '## Tools',
    '',
    renderToolsTable(adapters, 'en'),
    '',
    ...(content.en?.faq ? ['## FAQ', '', content.en.faq, ''] : []),
    '## Related',
    '',
    relatedList(sat, config, t),
    '',
    '## License',
    '',
    t.licenseText(config.license),
    '',
  ].join('\n');
}

function soapReadme(sat, ctx) {
  const { content, config, manifest, date } = ctx;
  const t = T.en;
  const c = content.en ?? {};
  const introText =
    'SOAP to MCP turns any SOAP/WSDL web service into MCP tools that Claude, ChatGPT, Copilot and Cursor can call, without code. ' +
    'Point AnythingMCP at a WSDL and every operation becomes a tool; it builds the envelopes and parses the replies. ' +
    'This repository runs the whole chain locally against a demo inventory service in five minutes.';
  const prompts = (c.prompts ?? '').split('\n').filter((l) => l.startsWith('- ')).slice(0, 6).join('\n');
  return [
    header(sat, { ...ctx, introText }, t, 'SOAP to MCP', 'Turn any SOAP/WSDL web service into MCP tools for Claude, ChatGPT and Copilot.'),
    '## Try it in five minutes',
    '',
    'Needs Docker 24+, openssl and Node 18+.',
    '',
    '```bash',
    `git clone https://github.com/${sat.owner}/${sat.repo}.git`,
    `cd ${sat.repo}`,
    './scripts/install.sh',
    'npm install && node scripts/smoke.mjs',
    '```',
    '',
    '`install.sh` starts AnythingMCP and a small SOAP service ([`examples/soap-demo`](examples/soap-demo): a warehouse inventory with three operations), creates the first admin, creates a SOAP connector from the demo WSDL and an MCP API key. `smoke.mjs` then connects as an MCP client, lists the tools and calls one:',
    '',
    '| WSDL operation | MCP tool | What it answers |',
    '|---|---|---|',
    '| `GetItem` | `inventoryservice_getitem` | One article by SKU: stock on hand, reorder level, price |',
    '| `ListLowStock` | `inventoryservice_listlowstock` | Articles at or below their reorder level |',
    '| `GetOrderStatus` | `inventoryservice_getorderstatus` | Status and promised date of a sales order |',
    '',
    'Tool names are `<service>_<operation>` in lower case. Rename them and rewrite their descriptions in the visual editor so the model picks the right one; the WSDL only gives it the operation name.',
    '',
    '## Use your own SOAP service',
    '',
    '1. Open **Connectors → New connector → SOAP** in the AnythingMCP UI (`http://localhost:3000`, or [AnythingMCP Cloud](https://cloud.anythingmcp.com) for a service reachable from the internet).',
    '2. Set the base URL to the service endpoint and import the WSDL (`https://…/Service.svc?wsdl`). Every operation becomes a tool.',
    '3. Pick the auth: HTTP Basic, a bearer token or an API-key header. WS-Security SOAP headers and TLS client certificates are not implemented yet.',
    '4. Assign the connector to an MCP server, ideally with a role that whitelists only the read operations.',
    '',
    'The same through the API:',
    '',
    '```bash',
    'curl -s http://localhost:4000/api/connectors -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\',
    `  -d '{"name":"CRM","type":"SOAP","baseUrl":"https://crm.example.com/CustomerService.svc"}'`,
    'curl -s http://localhost:4000/api/connectors/$ID/import -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\',
    `  -d '{"source":"wsdl","url":"https://crm.example.com/CustomerService.svc?wsdl"}'`,
    '```',
    '',
    `A service on your internal network needs a self-hosted AnythingMCP that can reach it, with its hostname in \`SSRF_ALLOWED_HOSTS\` (the [\`docker-compose.yml\`](docker-compose.yml) here does that for \`${manifest.setup.baseUrl.split('/')[2].split(':')[0]}\`).`,
    '',
    `## ${t.connect}`,
    '',
    t.connectItems(sat.repo).map((s) => `- ${s}`).join('\n'),
    '',
    `## ${t.prompts}`,
    '',
    prompts,
    '',
    t.morePrompts,
    '',
    '## Security',
    '',
    '- **Only the operations you allow.** A role on the MCP server whitelists tools; an AI client never sees the rest.',
    '- **Credentials** are encrypted with AES-256-GCM and never shown to the model.',
    '- **Response mapping** drops or reshapes fields of a SOAP reply before they reach the model.',
    '- **Audit log:** every call is recorded with input, output, duration and status in your own database.',
    '',
    '## FAQ',
    '',
    c.faq ?? '',
    '',
    '## Troubleshooting',
    '',
    '| Problem | Fix |',
    '|---|---|',
    '| The import finds no operations | Open the WSDL URL in a browser. `?wsdl` vs `?singleWsdl` matters for WCF services that split their schema across files. |',
    '| Calls go to the wrong host | The WSDL advertises an address AnythingMCP cannot reach. AnythingMCP replaces its host with the connector\'s base URL, so set the base URL to the address you can reach. |',
    '| "SSRF" or "blocked host" errors | The service is on a private network. Add its hostname to `SSRF_ALLOWED_HOSTS` on a self-hosted instance. |',
    '| The service rejects the call with a security fault | It expects WS-Security headers or a client certificate, which are not implemented yet. |',
    '| The service answers "unknown operation" or a schema fault | AnythingMCP sends document/literal *wrapped* requests: the body element is named after the operation (`<GetItem>`), which is what WCF and JAX-WS generate. A WSDL whose input element has a different name (`<GetItemRequest>`), or whose parameters are nested complex types, is not supported yet. |',
    '| The model sends the wrong parameters | Rewrite the tool description and parameter descriptions in the editor; the WSDL types are all the model has to go on. |',
    '',
    '## Related',
    '',
    relatedList(sat, config, t),
    '',
    '## License',
    '',
    config.license ? `${config.license}.` : 'Not decided yet.',
    '',
  ].join('\n');
}

function parseRows(md) {
  if (!md) return [];
  return md
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l) && !/^\|\s*Problem/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((x) => x.trim()));
}

const lcFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/** Word count of the paragraph right after the tagline: the "direct answer". */
export function introWordCount(readme) {
  const paras = readme.split('\n\n');
  const i = paras.findIndex((p) => p.startsWith('**') && p.includes('AnythingMCP]('));
  const para = i === -1 ? '' : paras[i + 1] ?? '';
  return para.split(/\s+/).filter(Boolean).length;
}

export function renderReadme(sat, ctx) {
  if (sat.type === 'connector') return T[ctx.lang] ? connectorReadme(sat, ctx) : null;
  if (ctx.lang !== 'en') return null;
  if (sat.type === 'umbrella') return umbrellaReadme(sat, ctx);
  if (sat.kind === 'soap') return soapReadme(sat, ctx);
  return null;
}
