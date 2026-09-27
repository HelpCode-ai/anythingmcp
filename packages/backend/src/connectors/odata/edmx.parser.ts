import { XMLParser } from 'fast-xml-parser';

/**
 * One normalised view of an OData service's `$metadata`, whether the service
 * speaks V2 (SAP Gateway's `sap:*` attributes) or V4 (vocabulary annotations).
 * Only what an agent needs to write a correct request survives: entity sets,
 * keys, properties with their human labels, the currency / unit / text field
 * that belongs to a property, and which properties are dimensions or measures.
 */
export interface ODataProperty {
  name: string;
  type: string;
  label?: string;
  key?: boolean;
  nullable?: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
  /** Property holding the currency or unit of this amount / quantity. */
  unit?: string;
  /** Property holding the readable text for this code. */
  text?: string;
  filterable?: boolean;
  sortable?: boolean;
  /** `dimension` or `measure` in analytical services. */
  aggregationRole?: string;
}

export interface ODataNavigation {
  name: string;
  target?: string;
  many?: boolean;
}

export interface ODataEntityType {
  name: string;
  qualifiedName: string;
  label?: string;
  keys: string[];
  properties: ODataProperty[];
  navigation: ODataNavigation[];
  /** SAP V2 `sap:semantics` of the type: `aggregate` (analytical result), `parameters` (input parameters of a parameterised view). */
  semantics?: string;
}

export interface ODataEntitySet {
  name: string;
  entityType: string;
  label?: string;
  /** SAP analytical set: select dimensions and measures, the server aggregates. */
  analytical?: boolean;
  /**
   * SAP V2 parameterised view: this set holds the parameters, and the data is
   * read through its navigation property, e.g.
   * `C_Revenue(P_Currency='EUR')/Results`.
   */
  parameters?: { names: string[]; resultsNavigation?: string };
  creatable?: boolean;
  updatable?: boolean;
  deletable?: boolean;
  /** V2 SAP: `$filter` must set these properties (sap:required-in-filter). */
  requiredInFilter?: string[];
}

export interface ODataServiceModel {
  version: 'v2' | 'v4';
  namespaces: string[];
  entitySets: ODataEntitySet[];
  entityTypes: Record<string, ODataEntityType>;
  functions: string[];
}

const ARRAY_TAGS = new Set([
  'Schema',
  'EntityType',
  'ComplexType',
  'EntityContainer',
  'EntitySet',
  'Singleton',
  'Property',
  'PropertyRef',
  'NavigationProperty',
  'FunctionImport',
  'ActionImport',
  'Function',
  'Action',
  'Annotations',
  'Annotation',
  'Association',
  'AssociationSet',
  'End',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // `sap:label` → `label`, `edmx:Edmx` → `Edmx`. EDM itself never uses these
  // attribute names without a prefix, so nothing collides.
  removeNSPrefix: true,
  parseAttributeValue: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const bool = (v: unknown): boolean | undefined =>
  v === undefined ? undefined : String(v).toLowerCase() !== 'false';
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return v === undefined || !Number.isFinite(n) ? undefined : n;
};

/**
 * Vocabulary terms appear as `Common.Label`, `SAP__common.Label` or
 * `com.sap.vocabularies.Common.v1.Label` depending on the alias a service
 * declares. Match on vocabulary and term, ignoring the alias.
 */
function termIs(term: string | undefined, vocabulary: string, name: string): boolean {
  if (!term) return false;
  const parts = term.split('.');
  if (parts[parts.length - 1] !== name) return false;
  return parts.slice(0, -1).some((p) => p.toLowerCase().includes(vocabulary.toLowerCase()));
}

function annotationValue(a: Record<string, any>): string | undefined {
  for (const k of ['String', 'Path', 'PropertyPath', 'EnumMember', 'Bool']) {
    if (a[k] !== undefined) return String(a[k]);
  }
  if (typeof a.String === 'object' && a.String?.['#text']) return String(a.String['#text']);
  return undefined;
}

export function parseEdmx(xml: string): ODataServiceModel {
  const doc = parser.parse(xml);
  const edmx = doc?.Edmx;
  if (!edmx) {
    throw new Error('Not an OData $metadata document (no edmx:Edmx root).');
  }
  const version: 'v2' | 'v4' = String(edmx.Version || '').startsWith('4') ? 'v4' : 'v2';
  const schemas: any[] = arr(edmx.DataServices?.Schema);

  // Annotations held apart from their target (V4 style, also used by SAP V2
  // services that publish vocabulary annotations): target → term → value.
  const external = new Map<string, Record<string, any>[]>();
  const aliasToNs = new Map<string, string>();
  for (const schema of schemas) {
    if (schema.Alias) aliasToNs.set(schema.Alias, schema.Namespace);
    for (const block of arr<any>(schema.Annotations)) {
      const target = String(block.Target || '');
      const list = external.get(target) ?? [];
      list.push(...arr<any>(block.Annotation));
      external.set(target, list);
    }
  }
  const qualify = (name: string): string => {
    const dot = name.lastIndexOf('.');
    if (dot === -1) return name;
    const ns = name.slice(0, dot);
    return `${aliasToNs.get(ns) ?? ns}.${name.slice(dot + 1)}`;
  };
  // Keyed by the fully qualified target, so a lookup is one map hit however
  // large the service (SAP's run to thousands of annotated properties).
  const externalByTarget = new Map<string, Record<string, any>[]>();
  for (const [t, list] of external) {
    const q = qualifyTarget(t);
    externalByTarget.set(q, [...(externalByTarget.get(q) ?? []), ...list]);
  }
  function qualifyTarget(t: string): string {
    const slash = t.indexOf('/');
    return slash === -1 ? qualify(t) : `${qualify(t.slice(0, slash))}${t.slice(slash)}`;
  }
  const annotationsFor = (target: string, inline: any[]): Record<string, any>[] => [
    ...inline,
    ...(externalByTarget.get(target) ?? []),
  ];
  const labelFrom = (annos: Record<string, any>[]): string | undefined =>
    annotationValue(annos.find((a) => termIs(a.Term, 'common', 'Label')) ?? {});

  const entityTypes: Record<string, ODataEntityType> = {};
  const byShortName: Record<string, ODataEntityType> = {};
  for (const schema of schemas) {
    const ns = String(schema.Namespace || '');
    for (const et of arr<any>(schema.EntityType)) {
      const qualifiedName = `${ns}.${et.Name}`;
      const keys = arr<any>(et.Key?.PropertyRef).map((r) => String(r.Name));
      const properties: ODataProperty[] = arr<any>(et.Property).map((p) => {
        const target = `${qualifiedName}/${p.Name}`;
        const annos = annotationsFor(target, arr(p.Annotation));
        const unitAnno = annos.find(
          (a) => termIs(a.Term, 'measures', 'ISOCurrency') || termIs(a.Term, 'measures', 'Unit'),
        );
        const textAnno = annos.find((a) => termIs(a.Term, 'common', 'Text'));
        const dimension = annos.find((a) => termIs(a.Term, 'analytics', 'Dimension'));
        const measure = annos.find((a) => termIs(a.Term, 'analytics', 'Measure'));
        const prop: ODataProperty = {
          name: String(p.Name),
          type: String(p.Type),
          label: p.label ?? labelFrom(annos),
          key: keys.includes(String(p.Name)) || undefined,
          nullable: p.Nullable === undefined ? undefined : bool(p.Nullable),
          maxLength: num(p.MaxLength),
          precision: num(p.Precision),
          scale: num(p.Scale),
          unit: p.unit ?? (unitAnno ? annotationValue(unitAnno) : undefined),
          text: p.text ?? (textAnno ? annotationValue(textAnno) : undefined),
          filterable: bool(p.filterable),
          sortable: bool(p.sortable),
          aggregationRole:
            p['aggregation-role'] ?? (measure ? 'measure' : dimension ? 'dimension' : undefined),
        };
        return stripUndefined(prop);
      });
      const navigation: ODataNavigation[] = arr<any>(et.NavigationProperty).map((n) => {
        if (n.Type) {
          const t = String(n.Type);
          const many = t.startsWith('Collection(');
          return { name: String(n.Name), target: qualify(many ? t.slice(11, -1) : t), many };
        }
        return stripUndefined({ name: String(n.Name), target: n.ToRole ? String(n.ToRole) : undefined });
      });
      const type: ODataEntityType = stripUndefined({
        name: String(et.Name),
        qualifiedName,
        label: et.label ?? labelFrom(annotationsFor(qualifiedName, arr(et.Annotation))),
        keys,
        properties,
        navigation,
        semantics: et.semantics ? String(et.semantics) : undefined,
      });
      entityTypes[qualifiedName] = type;
      byShortName[String(et.Name)] = type;
    }
  }

  const entitySets: ODataEntitySet[] = [];
  const functions: string[] = [];
  for (const schema of schemas) {
    for (const container of arr<any>(schema.EntityContainer)) {
      for (const set of arr<any>(container.EntitySet)) {
        const typeName = qualify(String(set.EntityType));
        const type = entityTypes[typeName] ?? byShortName[typeName.split('.').pop()!];
        const containerTarget = `${schema.Namespace}.${container.Name}/${set.Name}`;
        const annos = annotationsFor(containerTarget, arr(set.Annotation));
        entitySets.push(
          stripUndefined({
            name: String(set.Name),
            entityType: type?.qualifiedName ?? typeName,
            label: set.label ?? labelFrom(annos) ?? type?.label,
            analytical:
              set.semantics === 'aggregate' ||
              type?.semantics === 'aggregate' ||
              annos.some((a) => termIs(a.Term, 'aggregation', 'ApplySupported')) ||
              undefined,
            parameters:
              type?.semantics === 'parameters'
                ? stripUndefined({ names: type.keys, resultsNavigation: type.navigation[0]?.name })
                : undefined,
            creatable: bool(set.creatable),
            updatable: bool(set.updatable),
            deletable: bool(set.deletable),
          }),
        );
      }
      for (const f of [...arr<any>(container.FunctionImport), ...arr<any>(container.ActionImport)]) {
        functions.push(String(f.Name));
      }
    }
  }

  // sap:required-in-filter sits on the property; surface it on the set.
  for (const set of entitySets) {
    const type = entityTypes[set.entityType];
    if (!type) continue;
    const xmlProps = findRawProperties(schemas, type.qualifiedName);
    const required = xmlProps
      .filter((p) => String(p['required-in-filter']).toLowerCase() === 'true')
      .map((p) => String(p.Name));
    if (required.length) set.requiredInFilter = required;
  }

  return {
    version,
    namespaces: schemas.map((s) => String(s.Namespace)),
    entitySets,
    entityTypes,
    functions,
  };
}

function findRawProperties(schemas: any[], qualifiedName: string): any[] {
  for (const schema of schemas) {
    for (const et of arr<any>(schema.EntityType)) {
      if (`${schema.Namespace}.${et.Name}` === qualifiedName) return arr(et.Property);
    }
  }
  return [];
}

function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] === undefined) delete o[k];
  }
  return o;
}
