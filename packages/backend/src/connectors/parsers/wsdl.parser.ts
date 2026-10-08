import { Injectable, Logger } from '@nestjs/common';
import { ParsedTool } from './openapi.parser';
import * as soap from 'soap';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { outboundAxios } from '../../common/outbound-http';
import { XMLParser } from 'fast-xml-parser';

/** Keys describe() adds to a complex type's shape that are not elements. */
const DESCRIBE_METADATA_KEYS = new Set(['targetNSAlias', 'targetNamespace']);
/** Limits for complex input parameters (depth below the parameter, fields per type, ordered types). */
const MAX_INPUT_DEPTH = 6;
const MAX_INPUT_FIELDS = 200;
const MAX_ELEMENT_ORDER_PATHS = 200;

/** JSON Schema `format` of XSD date and time types. */
const XSD_FORMATS = new Map([
  ['dateTime', 'date-time'],
  ['date', 'date'],
  ['time', 'time'],
]);

/** A describe() shape: a plain object, not one of node-soap's raw schema elements. */
function isDescribeShape(node: unknown): node is Record<string, unknown> {
  return (
    node !== null &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    !('allowedChildren' in (node as object))
  );
}

/** What a SOAP call to one operation needs from the parsed WSDL. */
export interface WsdlOperationInfo {
  soapAction: string;
  endpoint: string;
  /**
   * Document style only: the element that wraps the parameters in the body,
   * taken from the operation's input message part. WCF and JAX-WS name it
   * after the operation, but a WSDL may declare any element
   * (`GetItemRequest` for operation `GetItem`).
   */
  inputElement?: string;
  /** Namespace of `inputElement` (its schema's targetNamespace). */
  inputNamespace?: string;
}

/**
 * A WSDL URL as it may be logged: without user info and query string, which
 * may carry credentials (`?wsdl&token=…`). Anything that is not a URL (a
 * local path in tests) is not logged at all.
 */
export function wsdlUrlForLog(wsdlUrl: string): string {
  try {
    const url = new URL(wsdlUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(not a URL)';
  }
}

/** The targetNamespace of the WSDL definitions element. */
export function wsdlTargetNamespace(wsdl: any): string {
  return (
    wsdl?.definitions?.$targetNamespace ||
    wsdl?.definitions?.$?.targetNamespace ||
    wsdl?.xml?.match(/targetNamespace="([^"]+)"/)?.[1] ||
    ''
  );
}

/**
 * The binding operation of a port in a WSDL parsed by the `soap` library
 * (style, soapAction, input), and the port's address.
 */
function findWsdlMethod(
  wsdl: any,
  portName: string,
  operationName: string,
): { method: any; endpoint: string } {
  const definitions = wsdl?.definitions;
  let endpoint = '';
  let method: any;
  for (const service of Object.values(definitions?.services || {}) as any[]) {
    const port = service?.ports?.[portName];
    if (!port) continue;
    endpoint = port.location || '';
    method = port.binding?.methods?.[operationName];
    break;
  }
  method ??= definitions?.bindings?.[portName]?.methods?.[operationName];
  return { method, endpoint };
}

/** A child element of an operation's input element, as its schema declares it. */
export interface InputElementDecl {
  name: string;
  /** minOccurs absent or at least 1, and not one branch of a choice. */
  required: boolean;
  /** Namespace-qualified in the message: `form`, else the declaring schema's elementFormDefault; always for a `ref`. */
  qualified: boolean;
  /** The xs:enumeration values of its simple type. */
  enum?: string[];
}

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';
/** node-soap's key for a default / target namespace in its prefix maps. */
const TNS_PREFIX = '__tns__';
/** Guards the schema walk against recursive base types and group references. */
const MAX_SCHEMA_WALK_DEPTH = 20;

/** Resolve a QName (`tns:Item`) as node-soap does, through the prefix maps in scope. */
function resolveQName(
  qname: string,
  node: any,
  schema: any,
  definitions: any,
): { ns?: string; name: string } {
  const colon = qname.indexOf(':');
  const prefix = colon > 0 ? qname.slice(0, colon) : TNS_PREFIX;
  const name = qname.slice(colon + 1);
  for (const map of [
    node?.xmlns,
    node?.schemaXmlns,
    schema?.xmlns,
    node?.definitionsXmlns,
    definitions?.xmlns,
  ]) {
    if (map?.[prefix]) return { ns: map[prefix], name };
  }
  return { name };
}

/**
 * The direct child elements of a document-style operation's input element,
 * read from the schema (node-soap's describe() drops minOccurs, form and
 * enumerations). Undefined when the input is not a schema element (RPC) or
 * part of its content model cannot be resolved; callers then keep their
 * defaults.
 */
export function inputElementDecls(
  wsdl: any,
  portName: string,
  operationName: string,
): InputElementDecl[] | undefined {
  const definitions = wsdl?.definitions;
  const { method } = findWsdlMethod(wsdl, portName, operationName);
  const input = method?.input;
  if (!definitions?.schemas || method?.style === 'rpc' || input?.name !== 'element') {
    return undefined;
  }
  const schema = definitions.schemas[input.targetNamespace];
  if (!schema) return undefined;
  try {
    return elementContentDecls(input, schema, definitions, 0);
  } catch {
    // An unexpected shape of node-soap's internals: keep the defaults.
    return undefined;
  }
}

function elementContentDecls(
  element: any,
  schema: any,
  definitions: any,
  depth: number,
): InputElementDecl[] | undefined {
  if (depth > MAX_SCHEMA_WALK_DEPTH) return undefined;
  if (element.$type) {
    const type = resolveQName(element.$type, element, schema, definitions);
    if (type.ns === XSD_NS) return [];
    const typeSchema = type.ns ? definitions.schemas[type.ns] : undefined;
    const complexType = typeSchema?.complexTypes?.[type.name];
    if (complexType) return complexTypeDecls(complexType, typeSchema, definitions, depth + 1);
    // A simple type has no child elements.
    return typeSchema?.types?.[type.name] ? [] : undefined;
  }
  const inline = (element.children || []).find((c: any) => c?.name === 'complexType');
  return inline ? complexTypeDecls(inline, schema, definitions, depth + 1) : [];
}

function complexTypeDecls(
  complexType: any,
  schema: any,
  definitions: any,
  depth: number,
): InputElementDecl[] | undefined {
  if (depth > MAX_SCHEMA_WALK_DEPTH) return undefined;
  const decls: InputElementDecl[] = [];
  for (const child of complexType.children || []) {
    if (['sequence', 'all', 'choice', 'group'].includes(child?.name)) {
      const particle = particleDecls(child, schema, definitions, false, depth + 1);
      if (!particle) return undefined;
      decls.push(...particle);
    } else if (child?.name === 'complexContent') {
      const derivation = (child.children || []).find(
        (c: any) => c?.name === 'extension' || c?.name === 'restriction',
      );
      if (!derivation) continue;
      // An extension's content follows its base type's.
      if (derivation.name === 'extension' && derivation.$base) {
        const base = resolveQName(derivation.$base, derivation, schema, definitions);
        if (base.ns !== XSD_NS) {
          const baseSchema = base.ns ? definitions.schemas[base.ns] : undefined;
          const baseType = baseSchema?.complexTypes?.[base.name];
          if (!baseType) return undefined;
          const inherited = complexTypeDecls(baseType, baseSchema, definitions, depth + 1);
          if (!inherited) return undefined;
          decls.push(...inherited);
        }
      }
      for (const particle of derivation.children || []) {
        if (!['sequence', 'all', 'choice', 'group'].includes(particle?.name)) continue;
        const own = particleDecls(particle, schema, definitions, false, depth + 1);
        if (!own) return undefined;
        decls.push(...own);
      }
    }
    // simpleContent (text), attributes and annotations declare no elements.
  }
  return decls;
}

function particleDecls(
  particle: any,
  schema: any,
  definitions: any,
  optional: boolean,
  depth: number,
): InputElementDecl[] | undefined {
  if (depth > MAX_SCHEMA_WALK_DEPTH) return undefined;
  // Every element of a choice, or of a particle that may be absent, is optional.
  const childrenOptional =
    optional || particle.name === 'choice' || particle.$minOccurs === '0';
  if (particle.name === 'group' && particle.$ref) {
    const ref = resolveQName(particle.$ref, particle, schema, definitions);
    const groupSchema = ref.ns ? definitions.schemas[ref.ns] : undefined;
    const group = groupSchema?.groups?.[ref.name];
    return group
      ? particleDecls(group, groupSchema, definitions, childrenOptional, depth + 1)
      : undefined;
  }

  const decls: InputElementDecl[] = [];
  for (const child of particle.children || []) {
    if (child?.name === 'element') {
      const decl = elementDecl(child, schema, definitions, childrenOptional);
      if (!decl) return undefined;
      decls.push(decl);
    } else if (['sequence', 'all', 'choice', 'group'].includes(child?.name)) {
      const nested = particleDecls(child, schema, definitions, childrenOptional, depth + 1);
      if (!nested) return undefined;
      decls.push(...nested);
    }
    // xs:any carries no named element.
  }
  return decls;
}

function elementDecl(
  element: any,
  schema: any,
  definitions: any,
  optional: boolean,
): InputElementDecl | undefined {
  let name: string | undefined = element.$name;
  // A reference to a global element: always qualified, typed by that element.
  let typed = element;
  let typedSchema = schema;
  let qualified: boolean;
  if (element.$ref) {
    const ref = resolveQName(element.$ref, element, schema, definitions);
    name = ref.name;
    qualified = true;
    typedSchema = ref.ns ? definitions.schemas[ref.ns] : undefined;
    typed = typedSchema?.elements?.[ref.name];
  } else if (element.$form === 'qualified' || element.$form === 'unqualified') {
    qualified = element.$form === 'qualified';
  } else {
    qualified = schema?.$elementFormDefault === 'qualified';
  }
  if (!name) return undefined;

  const minOccurs = element.$minOccurs === undefined ? 1 : parseInt(element.$minOccurs, 10);
  const decl: InputElementDecl = {
    name,
    required: !optional && !(minOccurs < 1),
    qualified,
  };
  const values = typed ? enumerationValues(typed, typedSchema, definitions) : undefined;
  if (values?.length) decl.enum = values;
  return decl;
}

/** The xs:enumeration values of an element's simple type (named or inline), if any. */
function enumerationValues(element: any, schema: any, definitions: any): string[] | undefined {
  let simpleType = (element.children || []).find((c: any) => c?.name === 'simpleType');
  if (!simpleType && element.$type) {
    const type = resolveQName(element.$type, element, schema, definitions);
    simpleType = type.ns ? definitions.schemas[type.ns]?.types?.[type.name] : undefined;
  }
  const restriction = (simpleType?.children || []).find((c: any) => c?.name === 'restriction');
  const values = (restriction?.children || [])
    .filter((c: any) => c?.name === 'enumeration')
    .map((c: any) => c.$value)
    .filter((v: unknown): v is string => typeof v === 'string');
  return values.length > 0 ? values : undefined;
}

/** WSDL 1.1 SOAP 1.2 binding extension namespace (`soap12:binding`). */
const SOAP12_BINDING_NS = 'http://schemas.xmlsoap.org/wsdl/soap12/';

/**
 * Ports that use SOAP 1.2, keyed by `${service}\n${port}`. node-soap reads
 * SOAP 1.2 bindings like SOAP 1.1 ones and keeps no trace of the binding
 * extension's namespace, so it is read from the WSDL documents themselves
 * (the root and every imported WSDL): a binding is SOAP 1.2 when its
 * `binding` child element is in the soap12 namespace, whatever its prefix.
 */
export function soap12Ports(wsdl: any): Set<string> {
  const bindingNames = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (doc: any, depth: number) => {
    if (!doc || seen.has(doc) || depth > 20) return;
    seen.add(doc);
    if (typeof doc.xml === 'string') collectSoap12Bindings(doc.xml, bindingNames);
    for (const included of doc._includesWsdl || []) visit(included, depth + 1);
  };
  visit(wsdl, 0);

  const ports = new Set<string>();
  if (bindingNames.size === 0) return ports;
  const definitions = wsdl?.definitions;
  // A port refers to its binding object; bindings are keyed by name.
  const nameOf = new Map<unknown, string>();
  for (const [name, binding] of Object.entries(definitions?.bindings || {})) {
    nameOf.set(binding, name);
  }
  for (const [serviceName, service] of Object.entries(definitions?.services || {}) as [string, any][]) {
    for (const [portName, port] of Object.entries(service?.ports || {}) as [string, any][]) {
      const bindingName = nameOf.get(port?.binding);
      if (bindingName && bindingNames.has(bindingName)) ports.add(`${serviceName}\n${portName}`);
    }
  }
  return ports;
}

function localName(qname: string): string {
  return qname.slice(qname.indexOf(':') + 1);
}

/** Namespace declarations (prefix → URI, '' for the default) on a parsed element. */
function namespaceDeclarations(node: unknown): Record<string, string> {
  const declarations: Record<string, string> = {};
  if (!node || typeof node !== 'object') return declarations;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (key === '@_xmlns') declarations[''] = value;
    else if (key.startsWith('@_xmlns:')) declarations[key.slice('@_xmlns:'.length)] = value;
  }
  return declarations;
}

function collectSoap12Bindings(xml: string, names: Set<string>): void {
  let document: Record<string, unknown>;
  try {
    document = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => localName(name) === 'binding',
    }).parse(xml);
  } catch {
    return;
  }
  for (const [rootKey, root] of Object.entries(document)) {
    if (localName(rootKey) !== 'definitions' || !root || typeof root !== 'object') continue;
    const rootScope = namespaceDeclarations(root);
    for (const [key, bindings] of Object.entries(root as Record<string, unknown>)) {
      if (key.startsWith('@_') || localName(key) !== 'binding' || !Array.isArray(bindings)) continue;
      for (const binding of bindings) {
        if (!binding || typeof binding !== 'object' || typeof binding['@_name'] !== 'string') continue;
        const scope = { ...rootScope, ...namespaceDeclarations(binding) };
        for (const [childKey, children] of Object.entries(binding as Record<string, unknown>)) {
          if (childKey.startsWith('@_') || localName(childKey) !== 'binding') continue;
          const colon = childKey.indexOf(':');
          const prefix = colon > 0 ? childKey.slice(0, colon) : '';
          for (const child of Array.isArray(children) ? children : [children]) {
            const namespace = { ...scope, ...namespaceDeclarations(child) }[prefix];
            if (namespace === SOAP12_BINDING_NS) names.add(binding['@_name']);
          }
        }
      }
    }
  }
}

/**
 * Whether the parameter elements of an operation are namespace-qualified:
 * false for RPC style (message parts are unqualified) and for a document
 * whose input element's children are all unqualified (elementFormDefault
 * "unqualified", the XSD default, or form="unqualified"). Undefined when
 * they are qualified, mixed or unknown: the engine's default, qualified.
 */
export function childElementsQualified(
  wsdl: any,
  portName: string,
  operationName: string,
  decls: InputElementDecl[] | undefined,
): false | undefined {
  const { method } = findWsdlMethod(wsdl, portName, operationName);
  if (method?.style === 'rpc') return false;
  if (decls && decls.length > 0 && decls.every((d) => !d.qualified)) return false;
  return undefined;
}

/**
 * Find an operation of a port in a WSDL parsed by the `soap` library.
 *
 * The port is followed to its binding: bindings are keyed by their own name,
 * which only matches the port name in WCF WSDLs (`BasicHttpBinding_IService`
 * for both); JAX-WS names them `ItemPort` and `ItemBinding`.
 */
export function resolveWsdlOperation(
  wsdl: any,
  portName: string,
  operationName: string,
): WsdlOperationInfo {
  const { method, endpoint } = findWsdlMethod(wsdl, portName, operationName);

  const info: WsdlOperationInfo = {
    soapAction: method?.soapAction || '',
    endpoint,
  };
  // Document style with an element part: the soap library resolves the
  // input to that schema element. RPC style keeps the message and its typed
  // parts, and the body wrapper stays the operation name.
  const input = method?.input;
  if (
    method?.style !== 'rpc' &&
    input?.name === 'element' &&
    typeof input.$name === 'string' &&
    input.$name
  ) {
    info.inputElement = input.$name;
    if (typeof input.targetNamespace === 'string' && input.targetNamespace) {
      info.inputNamespace = input.targetNamespace;
    }
  }
  return info;
}

@Injectable()
export class WsdlParser {
  private readonly logger = new Logger(WsdlParser.name);

  async parse(wsdlUrl: string): Promise<ParsedTool[]> {
    this.logger.debug(`Parsing WSDL from: ${wsdlUrlForLog(wsdlUrl)}`);

    // The URL comes from the user: check it, and keep checking WSDL/XSD
    // imports and redirects through the guarded client.
    await assertSafeOutboundUrl(wsdlUrl);
    const client = await soap.createClientAsync(wsdlUrl, {
      request: outboundAxios() as any,
      // Without this the library answers a re-import from a process-wide
      // cache that never expires, so a changed WSDL was only seen after a
      // restart (and every WSDL ever imported stayed in memory).
      disableCache: true,
    });
    const description = client.describe();
    const wsdl = client.wsdl;
    const tools: ParsedTool[] = [];

    const targetNamespace = wsdlTargetNamespace(wsdl) || undefined;
    const soap12 = soap12Ports(wsdl);

    for (const [serviceName, service] of Object.entries(description)) {
      for (const [portName, port] of Object.entries(service as any)) {
        const soapVersion = soap12.has(`${serviceName}\n${portName}`) ? '1.2' : undefined;
        for (const [operationName, operation] of Object.entries(port as any)) {
          const info = resolveWsdlOperation(wsdl, portName, operationName);
          const decls = inputElementDecls(wsdl, portName, operationName);

          const tool = this.operationToTool(
            serviceName,
            portName,
            operationName,
            operation as any,
            info,
            targetNamespace,
            {
              childElementsQualified: childElementsQualified(
                wsdl,
                portName,
                operationName,
                decls,
              ),
              soapVersion,
              decls,
            },
          );
          tools.push(tool);
        }
      }
    }

    const unique = this.withoutSoap12Duplicates(tools);
    this.logger.log(
      `Extracted ${unique.length} tools from WSDL` +
        (unique.length < tools.length
          ? ` (${tools.length - unique.length} SOAP 1.2 duplicates of SOAP 1.1 operations skipped)`
          : ''),
    );
    return unique;
  }

  /**
   * A tool is named after its service and operation, not its port, so an
   * operation offered on a SOAP 1.1 and a SOAP 1.2 port (WCF's
   * BasicHttpBinding next to a SOAP 1.2 binding) gave two tools with one
   * name: the import kept whichever came first and a re-import overwrote it
   * with the last. The SOAP 1.1 one is kept, whatever the port order: it is
   * what such tools always sent, and the simpler binding. An operation only
   * offered over SOAP 1.2 keeps its tool.
   */
  private withoutSoap12Duplicates(tools: ParsedTool[]): ParsedTool[] {
    const soap11Names = new Set(
      tools
        .filter((t) => (t.endpointMapping as { soapVersion?: string }).soapVersion !== '1.2')
        .map((t) => t.name),
    );
    return tools.filter(
      (t) =>
        (t.endpointMapping as { soapVersion?: string }).soapVersion !== '1.2' ||
        !soap11Names.has(t.name),
    );
  }

  private operationToTool(
    serviceName: string,
    portName: string,
    operationName: string,
    operation: any,
    info: WsdlOperationInfo,
    targetNamespace: string | undefined,
    facts: {
      childElementsQualified?: false;
      soapVersion?: '1.2';
      /** The input element's children from the schema; undefined when unresolved. */
      decls?: InputElementDecl[];
    },
  ): ParsedTool {
    const { soapAction, endpoint } = info;
    // Stored only where they differ from what the engine assumes (the
    // operation name, the WSDL targetNamespace), so the usual WCF/JAX-WS tool
    // stays as small as before.
    const inputElement =
      info.inputElement && info.inputElement !== operationName
        ? info.inputElement
        : undefined;
    const inputNamespace =
      info.inputNamespace && info.inputNamespace !== targetNamespace
        ? info.inputNamespace
        : undefined;
    const properties: Record<string, any> = {};
    const required: string[] = [];
    const bodyMapping: Record<string, string> = {};
    const paramOrder: string[] = [];
    const elementOrder: Record<string, string[]> = {};

    const declByName = new Map((facts.decls ?? []).map((d) => [d.name, d]));

    if (operation.input) {
      for (const [key, paramType] of Object.entries(operation.input)) {
        // describe() adds the namespace of a named complex type to its
        // shape; they are not elements (unless the schema says so).
        if (DESCRIBE_METADATA_KEYS.has(key) && !declByName.has(key)) continue;
        // describe() names a repeated element (maxOccurs > 1) `name[]`.
        const repeated = key.endsWith('[]');
        const paramName = repeated ? key.slice(0, -2) : key;
        const decl = declByName.get(paramName);
        let schema: Record<string, unknown>;
        if (typeof paramType === 'string') {
          schema = {
            ...this.scalarJsonSchema(paramType, decl?.enum),
            description: `SOAP parameter: ${paramName} (${paramType})`,
          };
        } else {
          // A complex type: the engine writes its fields as child elements.
          schema = {
            ...this.inputShapeToJsonSchema(paramType, 1, paramName, elementOrder),
            description: `SOAP parameter: ${paramName} (complex type)`,
          };
        }
        if (repeated) {
          const { description, ...items } = schema;
          schema = {
            type: 'array',
            items,
            description: `${String(description)}, repeated: pass a list`,
          };
        }
        properties[paramName] = schema;
        bodyMapping[paramName] = `$${paramName}`;
        // minOccurs="0" (WCF writes it on almost every element) makes a
        // parameter optional. Without the schema, or for RPC parts, every
        // parameter stays required, as before.
        if (!decl || decl.required) required.push(paramName);
        paramOrder.push(paramName);
      }
    }

    const name = `${serviceName}_${operationName}`
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .toLowerCase();

    const tool: ParsedTool = {
      name,
      description: `SOAP operation: ${operationName} on ${serviceName}/${portName}`,
      parameters: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
      endpointMapping: {
        method: operationName,
        path: portName,
        ...(Object.keys(bodyMapping).length > 0 ? { bodyMapping } : {}),
        ...(paramOrder.length > 0 ? { paramOrder } : {}),
        ...(soapAction ? { soapAction } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(targetNamespace ? { targetNamespace } : {}),
        ...(inputElement ? { inputElement } : {}),
        ...(inputNamespace ? { inputNamespace } : {}),
        ...(Object.keys(elementOrder).length > 0 ? { elementOrder } : {}),
        // Only written when false: tools without it keep qualified elements.
        ...(facts.childElementsQualified === false ? { childElementsQualified: false } : {}),
        // Only for SOAP 1.2 ports: tools without it are sent as SOAP 1.1.
        ...(facts.soapVersion ? { soapVersion: facts.soapVersion } : {}),
      },
    };

    const outputSchema = this.soapShapeToJsonSchema(operation.output, 0);
    if (outputSchema?.type === 'object' && outputSchema.properties &&
        Object.keys(outputSchema.properties as object).length) {
      tool.outputSchema = outputSchema;
    }
    return tool;
  }

  /**
   * Convert a soap `describe()` output shape into a JSON Schema. The library
   * represents complex types as nested objects (field → type-string or nested
   * object); scalars are type strings.
   */
  private soapShapeToJsonSchema(
    node: any,
    depth: number,
  ): Record<string, unknown> | undefined {
    if (node == null || depth > 6) return undefined;
    if (typeof node === 'string') {
      return { type: this.soapTypeToJsonType(node) };
    }
    if (typeof node !== 'object') return undefined;

    const properties: Record<string, unknown> = {};
    let count = 0;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'targetNSAlias' || key === 'targetNamespace') continue;
      if (count++ >= 200) break;
      properties[key] = this.soapShapeToJsonSchema(value, depth + 1) ?? {
        type: 'string',
      };
    }
    return { type: 'object', properties, additionalProperties: true };
  }

  /**
   * JSON Schema of a complex input parameter, from its describe() shape, and
   * the order of its child elements into `elementOrder` (keyed by path:
   * `address`, `order/lines`), which the engine needs because a stored tool
   * does not keep object key order. Repeated elements become arrays.
   */
  private inputShapeToJsonSchema(
    node: unknown,
    depth: number,
    path: string,
    elementOrder: Record<string, string[]>,
  ): Record<string, unknown> {
    if (typeof node === 'string') return this.scalarJsonSchema(node);
    // Deep or recursive types (describe() shares one object per type, so a
    // recursive type is a cycle) and node-soap's raw elements (RPC parts of
    // a complex type) stay an open object.
    if (!isDescribeShape(node) || depth > MAX_INPUT_DEPTH) {
      return { type: 'object', additionalProperties: true };
    }

    const properties: Record<string, unknown> = {};
    const names: string[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (DESCRIBE_METADATA_KEYS.has(key)) continue;
      if (names.length >= MAX_INPUT_FIELDS) break;
      const repeated = key.endsWith('[]');
      const name = repeated ? key.slice(0, -2) : key;
      const child = this.inputShapeToJsonSchema(value, depth + 1, `${path}/${name}`, elementOrder);
      properties[name] = repeated ? { type: 'array', items: child } : child;
      names.push(name);
    }
    if (names.length > 1 && Object.keys(elementOrder).length < MAX_ELEMENT_ORDER_PATHS) {
      elementOrder[path] = names;
    }
    return { type: 'object', properties, additionalProperties: true };
  }

  /**
   * JSON Schema of a scalar input type as describe() writes it: `xs:int`, or
   * for a simple type `name|base|enumerations` (`orderStatus|xs:string|NEW,SHIPPED`),
   * typed by its base. xs:dateTime, xs:date and xs:time get their JSON
   * Schema format, and the schema's enumeration values (read from the
   * schema, not from this string) become `enum`.
   */
  private scalarJsonSchema(soapType: string, enumValues?: string[]): Record<string, unknown> {
    const segments = soapType.split('|');
    const base = segments.length > 1 ? segments[1] : segments[0];
    const type = this.soapTypeToJsonType(base);
    const schema: Record<string, unknown> = { type };
    const format = XSD_FORMATS.get(base.slice(base.indexOf(':') + 1));
    if (format && type === 'string') schema.format = format;
    if (enumValues?.length) {
      if (type === 'string') {
        schema.enum = enumValues;
      } else if (type === 'number') {
        const numbers = enumValues.map(Number);
        if (numbers.every(Number.isFinite)) schema.enum = numbers;
      }
    }
    return schema;
  }

  private soapTypeToJsonType(soapType: string): string {
    const typeStr = String(soapType).toLowerCase();
    if (
      typeStr.includes('int') ||
      typeStr.includes('long') ||
      typeStr.includes('float') ||
      typeStr.includes('double') ||
      typeStr.includes('decimal')
    ) {
      return 'number';
    }
    if (typeStr.includes('bool')) return 'boolean';
    return 'string';
  }
}
