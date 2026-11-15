#!/usr/bin/env node
// Retailer marketplace adapters, generated from one seller adapter and a table.
//
// scripts/retailer-marketplaces.json has one row per retailer marketplace.
// For each row this script writes
//   packages/backend/src/adapters/<region>/<slug>.json
//   packages/backend/src/adapters/<region>/<slug>.live.spec.ts
//   packages/frontend/public/logos/connectors/<slug>.svg
// with the tools of the source adapter (the table's `source`), renamed to the
// retailer's own prefix, and the retailer's own name, countries, access rule,
// key location and setup guide. A change to the source adapter therefore
// reaches every retailer adapter: run this script and commit the result.
//
//   node scripts/generate-retailer-adapters.mjs           write the files
//   node scripts/generate-retailer-adapters.mjs --check   exit 1 and name the files that differ
//
// To the user each adapter is the retailer's own connector. The name of the
// software the seller back offices run on may appear only in `aliases` (people
// search for it) and in one sentence of `instructions`; the script fails when
// a text taken from the source adapter still carries it.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TABLE = 'scripts/retailer-marketplaces.json';
const ADAPTERS = 'packages/backend/src/adapters';
const LOGOS = 'packages/frontend/public/logos/connectors';
const SELF = 'scripts/generate-retailer-adapters.mjs';

/** The software the seller back offices run on. */
const PLATFORM = 'Mirakl';
/** The usage notes of the source instructions start here; the setup before it is written per retailer below. */
const USAGE_MARKER = '**Order workflow**';
/**
 * Fingerprint of the source texts that are rewritten by hand in this file
 * (the setup part of the instructions, description, prerequisites, variable
 * help and verify hints). When one of them changes in the source adapter the
 * script stops, so the wording below is read again before it is regenerated.
 */
const REVIEWED_SOURCE_SHA256 = '8ae9e1768b91778be3242db871ef003391a5b6445980d62f23ea0428e60ee72d';

const COUNTRY = {
  AT: 'Austria', BE: 'Belgium', CA: 'Canada', CH: 'Switzerland', CZ: 'the Czech Republic', DE: 'Germany',
  DK: 'Denmark', ES: 'Spain', FR: 'France', GB: 'the United Kingdom', HU: 'Hungary', IE: 'Ireland', IT: 'Italy',
  LU: 'Luxembourg', NL: 'the Netherlands', NO: 'Norway', PL: 'Poland', PT: 'Portugal', RO: 'Romania',
  SE: 'Sweden', SK: 'Slovakia', US: 'the United States',
};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const andList = (items) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const orList = (items) => (items.length < 3 ? items.join(' or ') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Wording of the source adapter that names the platform or its "operator"
 * (the retailer), and how it reads for one retailer. `in` is where the text
 * lives: a tool or parameter description ("tools") or the usage notes of the
 * instructions ("usage"). Every rule must still match the source, and no text
 * may carry the platform's name after the rules ran: both are checked, so a
 * reworded source sentence is noticed here instead of leaking into 21 adapters.
 */
const REWORDINGS = [
  // Tool and parameter descriptions.
  {
    in: 'tools',
    from: 'The quickest check that MIRAKL_URL and the key belong together. Mirakl recommends calling it about once a day.',
    to: (c) =>
      c.multi
        ? `The quickest check that the country chosen in ${c.URL} and the key belong together. Meant to be called about once a day, not on every question.`
        : 'The quickest check that the key works. Meant to be called about once a day, not on every question.',
  },
  { in: 'tools', from: 'by its Mirakl offer id (OF22)', to: () => 'by its offer id (OF22)' },
  { in: 'tools', from: 'Mirakl offer id (offer_id in', to: () => 'Offer id on the marketplace (offer_id in' },
  { in: 'tools', from: 'Without it Mirakl returns every product import.', to: () => 'Without it every product import is returned.' },
  { in: 'tools', from: "The types are the operator's product references (EAN, UPC...)", to: (c) => `The types are the product references ${c.R} uses (EAN, UPC...)` },
  { in: 'tools', from: 'Mirakl allows about 5 calls a minute.', to: () => 'The limit is about 5 calls a minute.' },
  { in: 'tools', from: 'with customers and the operator:', to: (c) => `with customers and ${c.R}:` },
  { in: 'tools', from: 'SELLER_OPERATOR (with the operator)', to: (c) => `SELLER_OPERATOR (with ${c.R})` },
  { in: 'tools', from: "List the operator's accounting documents for the shop (IV01)", to: (c) => `List the accounting documents ${c.R} issues to the shop (IV01)` },
  { in: 'tools', from: "Mirakl's default is AUTO_INVOICE", to: () => 'The default is AUTO_INVOICE' },
  {
    in: 'tools',
    from: 'used on marketplaces with Enhanced Seller Invoicing: invoices and credit notes the operator or the shop issues',
    to: (c) => `used when ${c.R} runs Enhanced Seller Invoicing: invoices and credit notes that ${c.R} or the shop issues`,
  },
  { in: 'tools', from: 'Only documents issued by the operator, or by the shop.', to: (c) => `Only documents issued by ${c.R} (OPERATOR), or by the shop (SHOP).` },
  { in: 'tools', from: 'to the customer or the operator.', to: (c) => `to the customer or ${c.R}.` },
  { in: 'tools', from: 'type is CUSTOMER, OPERATOR or SHOP;', to: (c) => `type is CUSTOMER, OPERATOR (${c.R}) or SHOP;` },
  { in: 'tools', from: 'with the customer, the operator or both.', to: (c) => `with the customer, ${c.R} or both.` },
  { in: 'tools', from: 'Recipients: CUSTOMER, OPERATOR or both.', to: (c) => `Recipients: CUSTOMER, OPERATOR (${c.R}) or both.` },
  {
    in: 'tools',
    from: 'Only on marketplaces that use Mirakl returns and leave the decision to the shop.',
    to: (c) => `Only when ${c.R} handles returns in the seller back office and leaves the decision to the shop.`,
  },
  { in: 'tools', from: "in the operator's product format; the connector", to: (c) => `in the product file format ${c.R} asks for; the connector` },
  { in: 'tools', from: 'Mirakl allows one import every 15 minutes.', to: () => 'The limit is one import every 15 minutes.' },
  { in: 'tools', from: "true when the file already uses the operator's product format.", to: (c) => `true when the file is already in the product format ${c.R} defines.` },
  { in: 'tools', from: "in Mirakl's offer format; the connector", to: (c) => `in the offer file format ${c.R} asks for; the connector` },
  // Usage notes of the instructions.
  {
    in: 'usage',
    from: "in the operator's format; the connector downloads it and uploads it to Mirakl.",
    to: (c) => `in the file format ${c.R} asks for; the connector downloads it and uploads it to ${c.R}.`,
  },
  { in: 'usage', from: 'Where the operator lets the shop decide,', to: (c) => `Where ${c.R} lets the shop decide,` },
  { in: 'usage', from: 'Mirakl refuses `entity_id` without `entity_type`', to: () => '`entity_id` without `entity_type` is refused' },
  { in: 'usage', from: '(recipient `CUSTOMER` or `OPERATOR`)', to: (c) => `(recipient \`CUSTOMER\` or \`OPERATOR\`, which is ${c.R})` },
  { in: 'usage', from: "lists the operator's accounting documents", to: (c) => `lists the accounting documents ${c.R} issues to the shop` },
  {
    in: 'usage',
    from: 'On marketplaces with Enhanced Seller Invoicing IV01 returns no new documents;',
    to: (c) => `If ${c.R} uses Enhanced Seller Invoicing, IV01 returns no new documents;`,
  },
  { in: 'usage', from: '; Mirakl answers in UTC.', to: () => '; answers are in UTC.' },
  {
    in: 'usage',
    from: 'Mirakl limits each API separately and the operator can tighten them.',
    to: (c) => `Each API has its own limit and ${c.R} can tighten them.`,
  },
  {
    in: 'usage',
    from: '401 means the key is wrong or belongs to another marketplace,',
    to: (c) =>
      c.multi
        ? `401 means the key is wrong or belongs to another country (check \`${c.URL}\`),`
        : '401 means the key is wrong or was replaced by a newer one,',
  },
  { in: 'usage', from: ' (or that `MIRAKL_URL` is not a Mirakl instance)', to: () => '' },
];

function fail(message) {
  throw new Error(message);
}

/** Names derived from a row: tool prefix, variables, hosts. */
function context(row, source) {
  const prefix = row.slug.replace(/-/g, '_');
  const upper = prefix.toUpperCase();
  const hosts = row.hosts.map((h) => h.value);
  return {
    R: row.retailer,
    prefix,
    KEY: `${upper}_API_KEY`,
    SHOP: `${upper}_SHOP_ID`,
    URL: `${upper}_URL`,
    LIVE: `RUN_${upper}_LIVE`,
    multi: hosts.length > 1,
    hosts,
    sourcePrefix: source.slug.replace(/-/g, '_'),
    sourceUpper: source.slug.replace(/-/g, '_').toUpperCase(),
    toolNames: new Set(source.tools.map((t) => t.name)),
  };
}

function validateTable(table) {
  if (!table || typeof table.source !== 'string' || !Array.isArray(table.retailers) || table.retailers.length === 0) {
    fail(`${TABLE} needs "source" (the adapter to generate from) and a non-empty "retailers" array.`);
  }
  const slugs = new Set();
  const regions = new Set(
    readdirSync(join(ROOT, ADAPTERS)).filter((name) => statSync(join(ROOT, ADAPTERS, name)).isDirectory()),
  );
  for (const row of table.retailers) {
    const at = `${TABLE}: ${row?.slug ?? '(row without slug)'}`;
    if (typeof row.slug !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(row.slug)) fail(`${at}: slug must be kebab-case.`);
    if (slugs.has(row.slug)) fail(`${at}: slug is listed twice.`);
    slugs.add(row.slug);
    for (const key of ['name', 'retailer', 'region', 'brandColor', 'monogram', 'access', 'keyPath']) {
      if (typeof row[key] !== 'string' || !row[key].trim()) fail(`${at}: "${key}" must be a non-empty string.`);
    }
    if (!regions.has(row.region)) fail(`${at}: region "${row.region}" is not a folder of ${ADAPTERS}.`);
    for (const key of ['brandColor', 'letterColor']) {
      if (row[key] !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(row[key])) fail(`${at}: ${key} must be a hex colour like #0082C3.`);
    }
    if ([...row.monogram].length > 2) fail(`${at}: monogram is one or two letters.`);
    if (!Array.isArray(row.hosts) || row.hosts.length === 0 || row.hosts.length > 20) fail(`${at}: hosts must list 1 to 20 seller platform addresses.`);
    for (const host of row.hosts) {
      if (!/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(String(host?.value)) || typeof host.label !== 'string' || !host.label.trim()) {
        fail(`${at}: each host needs a label and a value like https://seller.example.com (no path, no trailing slash).`);
      }
    }
    if (new Set(row.hosts.map((h) => h.value)).size !== row.hosts.length) fail(`${at}: a host is listed twice.`);
    if (!Array.isArray(row.countries) || row.countries.length === 0) fail(`${at}: countries must be a non-empty array of ISO codes.`);
    for (const code of row.countries) if (!COUNTRY[code]) fail(`${at}: country "${code}" is not in the COUNTRY list of ${SELF}.`);
    if (typeof row.shopIdNeeded !== 'boolean') fail(`${at}: shopIdNeeded must be true or false.`);
    if (row.shopIdNeeded && (typeof row.shopIdNote !== 'string' || !row.shopIdNote.trim())) fail(`${at}: shopIdNote says why the shop id is needed.`);
    if (row.sellerHelpUrl !== null && !/^https:\/\/\S+$/.test(String(row.sellerHelpUrl))) fail(`${at}: sellerHelpUrl must be an https URL or null.`);
    if (!Array.isArray(row.aliases) || !Array.isArray(row.notes) || !Array.isArray(row.sources)) fail(`${at}: aliases, notes and sources must be arrays.`);
    // What the user reads must not name the platform: only aliases may.
    const shown = [row.name, row.retailer, row.nameInSentence, row.access, row.keyPath, row.keyButton, row.countriesNote, row.shopIdNote, ...row.notes, ...row.hosts.map((h) => h.label)];
    for (const text of shown) if (typeof text === 'string' && new RegExp(PLATFORM, 'i').test(text)) fail(`${at}: "${text}" names ${PLATFORM}; only aliases may.`);
    // Another adapter with this slug, in any region, is not ours to overwrite.
    for (const region of regions) {
      if (region !== row.region && existsSync(join(ROOT, ADAPTERS, region, `${row.slug}.json`))) fail(`${at}: ${ADAPTERS}/${region}/${row.slug}.json already exists.`);
    }
  }
}

/** Stops when the hand-rewritten source texts changed, or a rewording no longer matches. */
function reviewSource(source) {
  const at = source.instructions.indexOf(USAGE_MARKER);
  if (at < 0) fail(`The instructions of ${source.slug} no longer contain "${USAGE_MARKER}", where the usage notes start. Update USAGE_MARKER in ${SELF}.`);
  const head = source.instructions.slice(0, at);
  const usage = source.instructions.slice(at);
  const reviewed = sha256(JSON.stringify([head, source.description, source.prerequisites, source.envVarMeta, source.verifyHints]));
  if (reviewed !== REVIEWED_SOURCE_SHA256) {
    fail(
      `The setup texts of the ${source.slug} adapter changed (setup part of the instructions, description, prerequisites, envVarMeta or verifyHints). ` +
        `Compare them with the retailer wording in ${SELF} (instructionsFor, descriptionFor, envVarMetaFor, verifyHintsFor), adjust it where needed, ` +
        `then set REVIEWED_SOURCE_SHA256 to "${reviewed}".`,
    );
  }
  const toolText = [];
  for (const tool of source.tools) walkDescriptions(tool, (text) => (toolText.push(text), text));
  const corpus = { tools: toolText.join('\n'), usage };
  for (const rule of REWORDINGS) {
    if (!corpus[rule.in].includes(rule.from)) {
      fail(`A rewording in ${SELF} no longer matches the ${source.slug} adapter (${rule.in}): "${rule.from}". Update or remove it in REWORDINGS.`);
    }
  }
  return { usage };
}

/** Calls `change` on every `description` string of a tool, in place. */
function walkDescriptions(node, change) {
  if (Array.isArray(node)) return node.forEach((item) => walkDescriptions(item, change));
  if (!node || typeof node !== 'object') return undefined;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') node[key] = change(value);
    else walkDescriptions(value, change);
  }
  return undefined;
}

/** One text of the source adapter, worded for the retailer. */
function reword(text, scope, c, where) {
  let out = text;
  for (const rule of REWORDINGS) if (rule.in === scope) out = out.split(rule.from).join(rule.to(c));
  out = renameReferences(out, c, where);
  if (new RegExp(PLATFORM, 'i').test(out)) {
    fail(`${where} still names ${PLATFORM} after the rewordings: "${out}". Add a rule to REWORDINGS in ${SELF}.`);
  }
  if (/\boperator\b/.test(out)) {
    fail(`${where} still says "operator" (the retailer) after the rewordings: "${out}". Add a rule to REWORDINGS in ${SELF}.`);
  }
  return out;
}

/** Tool names and variable names of the source adapter, as this retailer's. */
function renameReferences(text, c, where) {
  let out = text.replace(new RegExp(`\\b${c.sourcePrefix}_([a-z0-9_]+)`, 'g'), (match) => {
    if (!c.toolNames.has(match)) fail(`${where} names "${match}", which is not a tool of the source adapter.`);
    return `${c.prefix}_${match.slice(c.sourcePrefix.length + 1)}`;
  });
  out = out.split(`${c.sourceUpper}_API_KEY`).join(c.KEY).split(`${c.sourceUpper}_SHOP_ID`).join(c.SHOP);
  if (c.multi) out = out.split(`${c.sourceUpper}_URL`).join(c.URL);
  return out;
}

function toolsFor(source, c) {
  return source.tools.map((sourceTool) => {
    if (!sourceTool.name.startsWith(`${c.sourcePrefix}_`)) fail(`Tool "${sourceTool.name}" of the source adapter does not start with "${c.sourcePrefix}_".`);
    const tool = structuredClone(sourceTool);
    const name = `${c.prefix}_${tool.name.slice(c.sourcePrefix.length + 1)}`;
    tool.name = name;
    walkDescriptions(tool, (text) => reword(text, 'tools', c, `${name}: a description`));
    // Variables used outside descriptions: the optional shop id on every call.
    tool.endpointMapping = JSON.parse(JSON.stringify(tool.endpointMapping).split(`${c.sourceUpper}_SHOP_ID`).join(c.SHOP));
    if (new RegExp(PLATFORM, 'i').test(JSON.stringify(tool))) fail(`${name} still carries "${PLATFORM}" outside its descriptions.`);
    return tool;
  });
}

const countryNames = (row) => row.countries.map((code) => COUNTRY[code]);
const inSentence = (row) => row.nameInSentence ?? `the ${row.retailer} marketplace`;
const keyButton = (row) => row.keyButton ?? 'Generate a new key';
const loginUrl = (host) => `${host}/login`;
/** "your user name (top right) > **My user settings** > **API key**" */
const keyPathMarkdown = (row) =>
  row.keyPath
    .split(' > ')
    .map((part, i) => (i === 0 ? part : `**${part}**`))
    .join(' > ');
const SHOP_ID_WHERE = 'shown on the dashboard of the back office next to **Identifier** or **Shop ID**';

function descriptionFor(row, c) {
  const names = countryNames(row);
  // A long list is cut after eight names; the instructions name every country.
  const where = names.length > 9 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more countries` : andList(names);
  const install = c.multi ? ' (one install per country)' : '';
  return (
    `Run your shop on ${inSentence(row)} from an AI agent: orders, acceptance, tracking and shipping, incidents, offers with prices and stock, ` +
    `imports, messages, returns, invoices and transactions. The marketplace sells in ${where}${install}; ` +
    `sign in with the shop API key from your ${c.R} seller back office.`
  );
}

function shopIdStep(row, c) {
  const how = `set \`${c.SHOP}\` to the numeric id of the shop this connector should work on (${SHOP_ID_WHERE}, and returned as \`shop_id\` by \`${c.prefix}_get_account\`)`;
  if (row.shopIdNeeded) {
    return `${sentence(row.shopIdNote)} If your user has more than one shop, ${how}; to work on several shops, install the connector once per shop. Without it your default shop is used.`;
  }
  return `Leave \`${c.SHOP}\` empty. Only if your user manages several shops on ${c.R}, ${how}. Without it your default shop is used.`;
}

function instructionsFor(row, c, usage) {
  const names = countryNames(row);
  const lines = [];
  lines.push(`## ${row.name}`);
  lines.push(
    `Run your shop on ${inSentence(row)} from an AI agent: orders, acceptance, tracking and shipping, incidents, offers with prices and stock, ` +
      `offer and product imports, messages with customers and ${c.R}, returns, order documents, invoices and transactions. ` +
      `The connector calls the ${c.R} seller platform ${c.multi ? 'of the country you choose' : `at \`${c.hosts[0]}\``} with the API key of your shop, ` +
      'so it can see and do what your seller user can.',
  );
  lines.push('');
  lines.push(`**Countries**: ${andList(names)}.${row.countriesNote ? ` ${sentence(row.countriesNote)}` : ''}`);
  lines.push('');
  lines.push(`**Who can sell**: ${sentence(row.access)} The connector needs a seller account that ${c.R} has already opened.`);
  for (const note of row.notes) {
    lines.push('');
    lines.push(sentence(note));
  }
  lines.push('');
  lines.push(`**Setup (about 5 minutes${c.multi ? ' per country' : ''})**`);
  const steps = [];
  if (c.multi) {
    const choices = row.hosts.map((h) => `${h.label} is \`${h.value}\``);
    steps.push(
      `Choose your country in \`${c.URL}\`: ${choices.join(', ')}. ${c.R} runs one seller platform per country, each with its own account and key; ` +
        'if you sell in several, install the connector once per country.',
    );
    steps.push(`Sign in to the ${c.R} seller back office of that country: the address above followed by \`/login\`.`);
  } else {
    steps.push(`Sign in to the ${c.R} seller back office: \`${loginUrl(c.hosts[0])}\`.`);
  }
  steps.push(
    `In the back office open ${keyPathMarkdown(row)} and click **${keyButton(row)}** (or copy the existing key). Paste it into \`${c.KEY}\`. ` +
      'The key is sent as is in the `Authorization` header, without `Bearer`. Generating a new key invalidates the old one, so any other tool using it stops working.',
  );
  steps.push(shopIdStep(row, c));
  steps.push(`Install and run \`${c.prefix}_get_account\`: it returns the shop the key belongs to.`);
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push('');
  // The one sentence that names the platform, so the AI recognises its codes and error formats.
  lines.push(
    `**Platform**: the ${c.R} seller back office runs on ${PLATFORM} software, so the operation codes in the tool descriptions (OR11, OF24 and so on) and the error names are those of that software.`,
  );
  lines.push('');
  lines.push(
    `**Where to start**: \`${c.prefix}_get_account\` shows the shop behind the key (id, name, state, currency and channels). ` +
      `For the daily work use \`${c.prefix}_list_orders\` with \`order_state_codes=WAITING_ACCEPTANCE\`, \`${c.prefix}_list_offers\` for prices and stock ` +
      `and \`${c.prefix}_list_threads\` for messages that wait for a reply.`,
  );
  lines.push('');
  lines.push(
    `**Products and competing offers**: \`${c.prefix}_get_products\` looks products up in the ${c.R} catalog by EAN or another reference and returns the marketplace product SKU; ` +
      `\`${c.prefix}_list_product_offers\` lists the offers of every shop for given products, best price first, at about 5 calls a minute.`,
  );
  lines.push('');
  lines.push(reword(usage, 'usage', c, `${row.slug}: the usage notes`));
  return lines.join('\n');
}

function envVarMetaFor(row, c, source) {
  const sourceKey = source.envVarMeta[`${c.sourceUpper}_API_KEY`];
  const sourceShop = source.envVarMeta[`${c.sourceUpper}_SHOP_ID`];
  if (!sourceKey || !sourceShop) fail(`The source adapter no longer describes ${c.sourceUpper}_API_KEY and ${c.sourceUpper}_SHOP_ID in envVarMeta.`);
  const meta = {};
  if (c.multi) {
    meta[c.URL] = {
      label: 'Country',
      kind: 'address',
      help: `${c.R} runs one seller platform per country, each with its own account and key. Choose the country of the seller account whose key you enter.`,
      example: c.hosts[0],
      // Starts with ^https: so the setup guide may open {{<SLUG>_URL}}/login (validate-adapters.mjs, setup-guide-action).
      pattern: `^https://(?:${c.hosts.map((host) => escapeRegExp(host.replace(/^https:\/\//, ''))).join('|')})$`,
      patternMessage: `Choose ${orList(row.hosts.map((h) => `${h.label} (${h.value})`))}.`,
      options: row.hosts.map((h) => ({ value: h.value, label: h.label })),
    };
  }
  meta[c.KEY] = {
    label: sourceKey.label,
    kind: sourceKey.kind,
    secret: sourceKey.secret,
    help: `${c.R} seller back office: ${row.keyPath} > ${keyButton(row)}. Generating a new key invalidates the previous one.`,
    ...(c.multi ? {} : { link: loginUrl(c.hosts[0]) }),
    pattern: sourceKey.pattern,
    patternMessage: sourceKey.patternMessage,
  };
  meta[c.SHOP] = {
    label: sourceShop.label,
    kind: sourceShop.kind,
    help: row.shopIdNeeded
      ? `${sentence(row.shopIdNote)} With more than one shop, enter the numeric id of the shop to use (on the back office dashboard, next to Identifier or Shop ID). Leave empty to use your default shop.`
      : `Only when your user manages several shops on ${c.R}: the numeric id of the shop to use. Leave empty to use your default shop.`,
    example: sourceShop.example,
    pattern: sourceShop.pattern,
    patternMessage: sourceShop.patternMessage,
  };
  return meta;
}

function verifyHintsFor(row, c, source) {
  const hints = {
    401: c.multi
      ? `${c.R} refused the API key. Check that ${c.KEY} is the shop key from the seller back office of the country chosen in ${c.URL} (each country has its own key) and that it was not replaced by a newer key there.`
      : `${c.R} refused the API key. Check that ${c.KEY} is the shop key from your ${c.R} seller back office, under ${row.keyPath}, and that it was not replaced by a newer key there.`,
    403: `The key works, but your user is not allowed to do this on the shop. Ask the shop administrator for the role, or set ${c.SHOP} to a shop you manage.`,
    404: c.multi
      ? `The ${c.R} seller platform did not find this. Check that the country chosen in ${c.URL} is the one your seller account is in.`
      : `The ${c.R} seller platform did not find this for your shop. If every call answers this way, compare the address you sign in at with ${c.hosts[0]}: ${c.R} may have moved its seller back office.`,
    rate_limited: `${c.R} is rate limiting this API for your shop. Wait for the seconds in the Retry-After header before trying again.`,
  };
  const expected = Object.keys(source.verifyHints).sort().join(',');
  if (Object.keys(hints).sort().join(',') !== expected) fail(`The source adapter's verifyHints are now keyed ${expected}; write the same set in verifyHintsFor of ${SELF}.`);
  // Same key order as the source.
  return Object.fromEntries(Object.keys(source.verifyHints).map((key) => [key, hints[key]]));
}

function setupGuideFor(row, c, docsUrl) {
  const openStep = {
    id: 'open-account',
    title: `Open your ${c.R} seller account`,
    body: `Sign in to the ${c.R} seller back office. Then open the menu below and create a key, or copy the one that is already there.`,
    action: { label: `Open the ${c.R} seller back office`, url: c.multi ? `{{${c.URL}}}/login` : loginUrl(c.hosts[0]) },
    values: [
      { label: 'Menu', value: capitalize(row.keyPath), pick: true },
      { label: 'Button', value: keyButton(row), pick: true, note: 'Replaces the previous key: anything else that uses the old key stops working.' },
    ],
    problems: [
      {
        q: 'I do not see an API key tab',
        a: `API access is switched on per shop. Ask ${c.R} (your marketplace contact or the seller support) to enable it for your user.`,
      },
      {
        q: 'I manage several shops',
        a: 'The key belongs to your user, not to one shop. Note the id of the shop to use, shown on the dashboard next to **Identifier** or **Shop ID**: you enter it in the next step.',
      },
      {
        q: 'I do not have a seller account yet',
        a: `${sentence(row.access)}${row.sellerHelpUrl ? ` See [the ${c.R} seller page](${docsUrl}).` : ''}`,
      },
    ],
  };
  const keyStep = {
    id: 'api-key',
    title: 'Paste the key',
    body:
      'Paste the key alone, without `Bearer`, quotes or spaces. ' +
      (row.shopIdNeeded
        ? `${sentence(row.shopIdNote)} If your user has more than one shop, also enter the id of the shop to use.`
        : 'Leave the shop ID empty unless your user manages several shops.'),
    fields: [c.KEY, c.SHOP],
    problems: [
      {
        q: `${c.R} refused the key`,
        a: c.multi
          ? 'Copy it again from the back office and check the country you chose: each country has its own key. If a newer key was generated, only the newest one works.'
          : 'Copy it again from the back office. If a newer key was generated, only the newest one works.',
      },
      {
        q: 'Which shop ID do I enter?',
        a: 'The numeric id on the dashboard of the back office, next to **Identifier** or **Shop ID**. With a single shop, leave the field empty. To work on several shops, set the connector up once per shop.',
      },
    ],
  };
  const steps = c.multi
    ? [
        {
          id: 'country',
          title: 'Choose your country',
          body: `${c.R} runs one seller platform per country, each with its own account and key. Pick the country of the account to connect; to connect several, set the connector up once per country.`,
          fields: [c.URL],
        },
        openStep,
        keyStep,
      ]
    : [openStep, keyStep];
  return {
    effort: 'api_key',
    minutes: 5,
    examples: ['Which orders are waiting for my acceptance?', 'Which customer messages still need a reply?', 'Show the price and stock of my offer for SKU 4711'],
    needs: [`A ${c.R} seller account that is already open`, 'A user who can open **My user settings** in the seller back office'],
    steps,
  };
}

function adapterFor(row, source, usage) {
  const c = context(row, source);
  const tools = toolsFor(source, c);
  const docsUrl = row.sellerHelpUrl ?? loginUrl(c.hosts[0]);
  const instructions = instructionsFor(row, c, usage);
  // Brief for every catalog adapter: each tool is named in the instructions, and only real tools are.
  for (const tool of tools) {
    if (!instructions.includes(`\`${tool.name}\``)) {
      fail(`${tool.name} is not named in the instructions. Name the tool in the instructions of the source adapter, or in instructionsFor of ${SELF}.`);
    }
  }
  // Host names may contain the platform's name; the prose names it once.
  const prose = c.hosts.reduce((text, host) => text.split(host).join(''), instructions);
  const mentions = prose.match(new RegExp(PLATFORM, 'gi')) ?? [];
  if (mentions.length !== 1) fail(`${row.slug}: the instructions must name ${PLATFORM} exactly once outside the host names (found ${mentions.length}).`);
  const aliases = row.aliases.filter((alias) => ![row.slug, row.name].map((v) => v.toLowerCase()).includes(alias.toLowerCase()));
  const probeTool = `${c.prefix}_${source.probe.tool.slice(c.sourcePrefix.length + 1)}`;
  return {
    slug: row.slug,
    name: row.name,
    aliases,
    description: descriptionFor(row, c),
    instructions,
    region: row.region,
    category: source.category,
    icon: row.slug,
    docsUrl,
    requiredEnvVars: c.multi ? [c.URL, c.KEY] : [c.KEY],
    optionalEnvVars: [c.SHOP],
    prerequisites: `An open seller account with ${c.R} and access to its seller back office to generate the shop API key. ${sentence(row.access)}`,
    envVarMeta: envVarMetaFor(row, c, source),
    verifyHints: verifyHintsFor(row, c, source),
    probe: { ...source.probe, tool: probeTool },
    setupGuide: setupGuideFor(row, c, docsUrl),
    connector: {
      ...source.connector,
      name: row.name,
      baseUrl: c.multi ? `{{${c.URL}}}/api` : `${c.hosts[0]}/api`,
      authConfig: JSON.parse(JSON.stringify(source.connector.authConfig).split(`${c.sourceUpper}_API_KEY`).join(c.KEY)),
    },
    tools,
  };
}

function specFor(row, source) {
  const c = context(row, source);
  const hosts = c.hosts.map((h) => `'${h.replace(/^https:\/\//, '')}'`).join(', ');
  return [
    `import * as adapter from './${row.slug}.json';`,
    "import { describeRetailerAdapter } from '../retailer-adapter.spec-helper';",
    '',
    `// Generated by ${SELF} from ${TABLE}: do not edit by hand.`,
    `// Static checks always run. Live, reads only: ${c.LIVE}=1 (GET /api/version needs no key; the shop reads need ${c.KEY}${c.multi ? ` and ${c.URL}` : ''}).`,
    `describeRetailerAdapter(adapter, { slug: '${row.slug}', hosts: [${hosts}] });`,
    '',
  ].join('\n');
}

function logoFor(row) {
  const letters = [...row.monogram].length;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${escapeXml(row.name)} connector">`,
    `  <rect width="128" height="128" rx="24" fill="${row.brandColor}"/>`,
    `  <text x="64" y="64" text-anchor="middle" dominant-baseline="central" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${letters === 1 ? 80 : 54}" fill="${row.letterColor ?? '#fff'}">${escapeXml(row.monogram)}</text>`,
    '</svg>',
    '',
  ].join('\n');
}

/** Every generated file: repository path → content. */
export function generate() {
  const table = readJson(TABLE);
  validateTable(table);
  const source = readJson(table.source);
  const { usage } = reviewSource(source);
  const files = new Map();
  for (const row of table.retailers) {
    files.set(`${ADAPTERS}/${row.region}/${row.slug}.json`, json(adapterFor(row, source, usage)));
    files.set(`${ADAPTERS}/${row.region}/${row.slug}.live.spec.ts`, specFor(row, source));
    files.set(`${LOGOS}/${row.slug}.svg`, logoFor(row));
  }
  return { files, retailers: table.retailers.length };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--check')) fail(`Usage: node ${SELF} [--check]`);
    const check = process.argv.includes('--check');
    const { files, retailers } = generate();
    let written = 0;
    for (const [path, content] of files) {
      const absolute = join(ROOT, path);
      const current = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
      if (current === content) continue;
      if (check) {
        console.error(`${path} is ${current === null ? 'missing' : 'stale'}. Run node ${SELF} and commit the result.`);
        process.exitCode = 1;
      } else {
        writeFileSync(absolute, content, 'utf8');
        written += 1;
        console.log(`Generated ${path}`);
      }
    }
    if (check && !process.exitCode) console.log(`${files.size} generated files for ${retailers} retailer adapters are up to date.`);
    if (!check) console.log(`${retailers} retailer adapters: ${written} of ${files.size} files written, ${files.size - written} unchanged.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
