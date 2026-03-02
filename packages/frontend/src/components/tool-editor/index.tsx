'use client';

import { useState, useEffect, useCallback } from 'react';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface ToolParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'integer' | 'array' | 'object';
  description: string;
  required: boolean;
  /** Where this param is injected into the API request */
  target: 'path' | 'query' | 'body' | 'header' | 'graphql_var' | 'sql' | 'soap';
  /** For headers: override the header name (defaults to param name) */
  headerName?: string;
  /** For query params: override the query key (defaults to param name, e.g. $skip vs skip) */
  queryKey?: string;
}

export interface ToolEditorData {
  name: string;
  description: string;
  method: string;
  path: string;
  params: ToolParam[];
  /** Raw GraphQL query (when connector type is GRAPHQL) */
  graphqlQuery?: string;
  /** SOAP operation name override */
  soapOperation?: string;
  /** SQL template (when connector type is DATABASE) */
  sqlTemplate?: string;
  /** Extra static headers for this endpoint */
  extraHeaders?: Record<string, string>;
  /** Response cache TTL in seconds (0 = no caching) */
  cacheTtl?: number;
  /** Raw JSON body template with ${param} placeholders */
  bodyTemplate?: string;
  /** When true, use bodyTemplate instead of per-field bodyMapping */
  useBodyTemplate?: boolean;
  /** Body encoding: 'json' (default), 'form-urlencoded', or 'form-data' */
  bodyEncoding?: string;
}

interface ToolEditorProps {
  connectorType: string;
  /** Initial data for editing existing tools */
  initialData?: Partial<ToolEditorData>;
  /** Existing tool data from the backend (raw format) */
  existingTool?: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    endpointMapping: Record<string, unknown>;
    responseMapping?: Record<string, unknown>;
  };
  /** Environment variable keys — parameters matching these names are auto-filled at runtime */
  envVarKeys?: Set<string>;
  onSave: (data: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    endpointMapping: Record<string, unknown>;
    responseMapping?: Record<string, unknown>;
  }) => void;
  onCancel: () => void;
  saving?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Target options per connector type                                 */
/* ------------------------------------------------------------------ */

const TARGET_OPTIONS: Record<string, { value: string; label: string }[]> = {
  REST: [
    { value: 'path', label: 'Path Parameter' },
    { value: 'query', label: 'Query Parameter' },
    { value: 'body', label: 'Body Field' },
    { value: 'header', label: 'Header Value' },
  ],
  GRAPHQL: [
    { value: 'graphql_var', label: 'GraphQL Variable' },
    { value: 'header', label: 'Header Value' },
  ],
  SOAP: [
    { value: 'soap', label: 'SOAP Parameter' },
    { value: 'header', label: 'Header Value' },
  ],
  DATABASE: [
    { value: 'sql', label: 'SQL Parameter' },
  ],
  WEBHOOK: [
    { value: 'body', label: 'Body Field' },
    { value: 'query', label: 'Query Parameter' },
    { value: 'header', label: 'Header Value' },
  ],
  MCP: [
    { value: 'body', label: 'Pass-through Parameter' },
  ],
};

const DEFAULT_TARGET: Record<string, string> = {
  REST: 'query',
  GRAPHQL: 'graphql_var',
  SOAP: 'soap',
  DATABASE: 'sql',
  WEBHOOK: 'body',
  MCP: 'body',
};

const METHODS_BY_TYPE: Record<string, string[]> = {
  REST: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  GRAPHQL: ['query', 'mutation'],
  SOAP: ['SOAP'],
  DATABASE: ['query'],
  WEBHOOK: ['GET', 'POST', 'PUT', 'DELETE'],
  MCP: ['invoke'],
};

/* ------------------------------------------------------------------ */
/*  Helpers: parse existing backend tool → editor state               */
/* ------------------------------------------------------------------ */

function parseExistingTool(
  tool: NonNullable<ToolEditorProps['existingTool']>,
  connectorType: string,
): ToolEditorData {
  const em = tool.endpointMapping as any;
  const schema = tool.parameters as any;

  const params: ToolParam[] = [];
  const properties = schema?.properties || {};
  const required: string[] = schema?.required || [];

  // Build a reverse map: which params go where
  const queryMapped = new Set<string>();
  const queryKeyMap: Record<string, string> = {}; // paramName → actual query key
  const bodyMapped = new Set<string>();
  const headerMapped = new Set<string>();
  const pathMapped = new Set<string>();

  // Detect path params from {param} in path
  const pathMatches = (em.path || '').match(/\{(\w+)\}/g) || [];
  for (const m of pathMatches) {
    pathMapped.add(m.slice(1, -1));
  }

  // Parse queryParams
  if (em.queryParams) {
    for (const [key, value] of Object.entries(em.queryParams)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        const paramName = value.substring(1);
        queryMapped.add(paramName);
        if (key !== paramName) {
          queryKeyMap[paramName] = key;
        }
      }
    }
  }

  // Parse bodyMapping
  if (em.bodyMapping) {
    for (const [, value] of Object.entries(em.bodyMapping)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        bodyMapped.add(value.substring(1));
      }
    }
  }

  // Detect bodyTemplate mode
  const detectedBodyTemplate: string | undefined = em.bodyTemplate as string | undefined;
  const detectedUseBodyTemplate = !!detectedBodyTemplate;
  if (detectedBodyTemplate) {
    const templateParamMatches = detectedBodyTemplate.match(/\$\{([^}]+)\}/g) || [];
    for (const match of templateParamMatches) {
      bodyMapped.add(match.slice(2, -1));
    }
  }

  // Parse headers
  if (em.headers) {
    for (const [, value] of Object.entries(em.headers)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        headerMapped.add(value.substring(1));
      }
    }
  }

  for (const [name, prop] of Object.entries(properties)) {
    const p = prop as any;
    let target: ToolParam['target'] = DEFAULT_TARGET[connectorType] as ToolParam['target'] || 'query';
    let headerName: string | undefined;
    let queryKey: string | undefined;

    if (pathMapped.has(name)) {
      target = 'path';
    } else if (headerMapped.has(name)) {
      target = 'header';
      // Find header name
      if (em.headers) {
        for (const [hk, hv] of Object.entries(em.headers)) {
          if (typeof hv === 'string' && hv === `$${name}`) {
            headerName = hk;
          }
        }
      }
    } else if (queryMapped.has(name)) {
      target = connectorType === 'GRAPHQL' ? 'graphql_var' : 'query';
      queryKey = queryKeyMap[name];
    } else if (bodyMapped.has(name)) {
      target = connectorType === 'SOAP' ? 'soap' : 'body';
    } else if (connectorType === 'DATABASE') {
      target = 'sql';
    }

    params.push({
      name,
      type: p.type || 'string',
      description: p.description || '',
      required: required.includes(name),
      target,
      headerName,
      queryKey,
    });
  }

  const rm = tool.responseMapping as any;

  return {
    name: tool.name,
    description: tool.description,
    method: em.method || 'GET',
    path: em.path || '',
    params,
    graphqlQuery: connectorType === 'GRAPHQL' ? em.path : undefined,
    soapOperation: connectorType === 'SOAP' ? em.method : undefined,
    sqlTemplate: connectorType === 'DATABASE' ? em.path : undefined,
    cacheTtl: rm?.cacheTtl || 0,
    bodyTemplate: detectedBodyTemplate,
    useBodyTemplate: detectedUseBodyTemplate,
    bodyEncoding: (em.bodyEncoding as string) || 'json',
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers: editor state → backend format                            */
/* ------------------------------------------------------------------ */

function buildToolPayload(data: ToolEditorData, connectorType: string) {
  // Build JSON Schema for parameters
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of data.params) {
    properties[p.name] = {
      type: p.type,
      ...(p.description ? { description: p.description } : {}),
    };
    if (p.required) {
      required.push(p.name);
    }
  }

  const parameters: Record<string, unknown> = {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };

  // Build endpointMapping based on connector type
  const queryParams: Record<string, string> = {};
  const bodyMapping: Record<string, string> = {};
  const headers: Record<string, string> = {};

  for (const p of data.params) {
    switch (p.target) {
      case 'query':
      case 'graphql_var':
        queryParams[p.queryKey || p.name] = `$${p.name}`;
        break;
      case 'body':
      case 'soap':
        if (!(data.useBodyTemplate && data.bodyTemplate)) {
          bodyMapping[p.name] = `$${p.name}`;
        }
        break;
      case 'header':
        headers[p.headerName || p.name] = `$${p.name}`;
        break;
      case 'path':
        // Path params are handled via {param} in path string
        break;
      case 'sql':
        // SQL params are interpolated via $param in the SQL template
        break;
    }
  }

  let method = data.method;
  let path = data.path;

  if (connectorType === 'GRAPHQL') {
    method = data.method || 'query';
    path = data.graphqlQuery || data.path;
  } else if (connectorType === 'SOAP') {
    method = data.soapOperation || data.method;
  } else if (connectorType === 'DATABASE') {
    method = 'query';
    path = data.sqlTemplate || data.path;
  }

  const endpointMapping: Record<string, unknown> = { method, path };
  if (Object.keys(queryParams).length > 0) endpointMapping.queryParams = queryParams;
  if (data.useBodyTemplate && data.bodyTemplate) {
    endpointMapping.bodyTemplate = data.bodyTemplate;
  } else if (Object.keys(bodyMapping).length > 0) {
    endpointMapping.bodyMapping = bodyMapping;
    if (data.bodyEncoding && data.bodyEncoding !== 'json') {
      endpointMapping.bodyEncoding = data.bodyEncoding;
    }
  }
  if (Object.keys(headers).length > 0) endpointMapping.headers = headers;

  const result: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    endpointMapping: Record<string, unknown>;
    responseMapping?: Record<string, unknown>;
  } = {
    name: data.name,
    description: data.description,
    parameters,
    endpointMapping,
  };

  if (data.cacheTtl && data.cacheTtl > 0) {
    result.responseMapping = { cacheTtl: data.cacheTtl };
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function ToolEditor({
  connectorType,
  existingTool,
  envVarKeys,
  onSave,
  onCancel,
  saving = false,
}: ToolEditorProps) {
  const type = connectorType || 'REST';
  const targets = TARGET_OPTIONS[type] || TARGET_OPTIONS.REST;
  const methods = METHODS_BY_TYPE[type] || METHODS_BY_TYPE.REST;

  // Core state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [method, setMethod] = useState(methods[0]);
  const [path, setPath] = useState('');
  const [params, setParams] = useState<ToolParam[]>([]);
  const [graphqlQuery, setGraphqlQuery] = useState('');
  const [sqlTemplate, setSqlTemplate] = useState('');
  const [cacheTtl, setCacheTtl] = useState(0);
  const [bodyTemplate, setBodyTemplate] = useState('');
  const [useBodyTemplate, setUseBodyTemplate] = useState(false);
  const [bodyEncoding, setBodyEncoding] = useState('json');

  // Initialize from existing tool
  useEffect(() => {
    if (existingTool) {
      const parsed = parseExistingTool(existingTool, type);
      setName(parsed.name);
      setDescription(parsed.description);
      setMethod(parsed.method);
      setPath(parsed.path);
      setParams(parsed.params);
      if (parsed.graphqlQuery) setGraphqlQuery(parsed.graphqlQuery);
      if (parsed.sqlTemplate) setSqlTemplate(parsed.sqlTemplate);
      if (parsed.cacheTtl) setCacheTtl(parsed.cacheTtl);
      if (parsed.bodyTemplate) setBodyTemplate(parsed.bodyTemplate);
      if (parsed.useBodyTemplate) setUseBodyTemplate(true);
      if (parsed.bodyEncoding) setBodyEncoding(parsed.bodyEncoding);
    }
  }, [existingTool, type]);

  // Auto-detect path params from {param} patterns
  const detectPathParams = useCallback((pathStr: string) => {
    const matches = pathStr.match(/\{(\w+)\}/g) || [];
    const pathParamNames = matches.map(m => m.slice(1, -1));

    setParams(prev => {
      const updated = [...prev];
      // Add missing path params
      for (const pName of pathParamNames) {
        if (!updated.find(p => p.name === pName)) {
          updated.push({
            name: pName,
            type: 'string',
            description: `Path parameter: ${pName}`,
            required: true,
            target: 'path',
          });
        }
      }
      // Update existing params that are in path
      return updated.map(p => {
        if (pathParamNames.includes(p.name) && p.target !== 'path') {
          return { ...p, target: 'path' as const };
        }
        return p;
      });
    });
  }, []);

  // Auto-extract params from body template ${param} patterns
  const extractTemplateParams = useCallback((template: string) => {
    const matches = template.match(/\$\{([^}]+)\}/g) || [];
    const paramNames = [...new Set(matches.map(m => m.slice(2, -1)))];
    setParams(prev => {
      // Keep non-body params, and body params that are still in the template
      const updated = prev.filter(p => p.target !== 'body' || paramNames.includes(p.name));
      // Add new template params
      for (const pName of paramNames) {
        if (!updated.find(p => p.name === pName)) {
          updated.push({
            name: pName,
            type: 'string',
            description: '',
            required: true,
            target: 'body',
          });
        }
      }
      return updated;
    });
  }, []);

  const handlePathChange = (newPath: string) => {
    setPath(newPath);
    if (type === 'REST' || type === 'WEBHOOK') {
      detectPathParams(newPath);
    }
  };

  const addParam = () => {
    setParams([
      ...params,
      {
        name: '',
        type: 'string',
        description: '',
        required: false,
        target: (DEFAULT_TARGET[type] || 'query') as ToolParam['target'],
      },
    ]);
  };

  const updateParam = (index: number, updates: Partial<ToolParam>) => {
    setParams(prev => prev.map((p, i) => (i === index ? { ...p, ...updates } : p)));
  };

  const removeParam = (index: number) => {
    setParams(prev => prev.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    const data: ToolEditorData = {
      name,
      description,
      method,
      path,
      params,
      graphqlQuery: type === 'GRAPHQL' ? graphqlQuery : undefined,
      sqlTemplate: type === 'DATABASE' ? sqlTemplate : undefined,
      cacheTtl,
      bodyTemplate: useBodyTemplate ? bodyTemplate : undefined,
      useBodyTemplate,
      bodyEncoding: !useBodyTemplate ? bodyEncoding : undefined,
    };
    onSave(buildToolPayload(data, type));
  };

  const isValid = name.trim() && description.trim() && params.every(p => p.name.trim());

  return (
    <div className="border border-[var(--border)] rounded-lg p-5 space-y-5 bg-[var(--card)]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">
          {existingTool ? 'Edit Tool' : 'Create Tool'}
          <span className="ml-2 text-xs font-normal text-[var(--muted-foreground)]">
            ({type})
          </span>
        </h4>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="border border-[var(--border)] px-3 py-1.5 rounded text-xs hover:bg-[var(--accent)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isValid || saving}
            className="bg-[var(--primary)] text-[var(--primary-foreground)] px-4 py-1.5 rounded text-xs font-medium hover:brightness-90 disabled:opacity-50"
          >
            {saving ? 'Saving...' : existingTool ? 'Update Tool' : 'Create Tool'}
          </button>
        </div>
      </div>

      {/* Basic Info */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Tool Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="get_users"
            className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
          />
          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
            snake_case, shown to the AI model
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Description</label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Fetch a list of users with optional filtering"
            className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
          />
          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
            Clear description helps the AI decide when to use this tool
          </p>
        </div>
      </div>

      {/* Endpoint Configuration - varies by connector type */}
      {type === 'GRAPHQL' ? (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Operation Type</label>
            <select
              value={method}
              onChange={e => setMethod(e.target.value)}
              className="w-48 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
            >
              {methods.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">GraphQL Query / Mutation</label>
            <textarea
              value={graphqlQuery}
              onChange={e => setGraphqlQuery(e.target.value)}
              rows={5}
              placeholder={`query GetUsers($limit: Int, $offset: Int) {\n  users(limit: $limit, offset: $offset) {\n    id\n    name\n    email\n  }\n}`}
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
            />
            <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
              Use $variables in the query — map them to parameters below as &quot;GraphQL Variable&quot;
            </p>
          </div>
        </div>
      ) : type === 'DATABASE' ? (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">SQL Query Template</label>
            <textarea
              value={sqlTemplate}
              onChange={e => setSqlTemplate(e.target.value)}
              rows={4}
              placeholder="SELECT * FROM users WHERE name LIKE $search_term LIMIT $limit"
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
            />
            <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
              Use $param_name to reference parameters. Only SELECT queries are allowed.
            </p>
          </div>
        </div>
      ) : type === 'SOAP' ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">SOAP Operation</label>
            <input
              type="text"
              value={method}
              onChange={e => setMethod(e.target.value)}
              placeholder="GetWeather"
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
            />
            <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
              The SOAP operation/method name from the WSDL
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Port / Path</label>
            <input
              type="text"
              value={path}
              onChange={e => setPath(e.target.value)}
              placeholder="WeatherServicePort"
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
            />
          </div>
        </div>
      ) : (
        /* REST / WEBHOOK / MCP */
        <div className="grid grid-cols-[120px_1fr] gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Method</label>
            <select
              value={method}
              onChange={e => setMethod(e.target.value)}
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
            >
              {methods.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Path</label>
            <input
              type="text"
              value={path}
              onChange={e => handlePathChange(e.target.value)}
              placeholder="/users/{id}/posts"
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
            />
            <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
              Use {'{param}'} for path parameters — they auto-create parameters below
            </p>
          </div>
        </div>
      )}

      {/* Body Mode — only for REST/WEBHOOK write methods */}
      {(type === 'REST' || type === 'WEBHOOK') && ['POST', 'PUT', 'PATCH'].includes(method) && (
        <div className="border border-[var(--border)] rounded-md p-3 space-y-2">
          <div className="flex items-center gap-4">
            <label className="text-xs font-semibold">Request Body</label>
            <div className="flex gap-3 text-xs">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="bodyMode"
                  checked={!useBodyTemplate}
                  onChange={() => setUseBodyTemplate(false)}
                />
                Body Fields
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="bodyMode"
                  checked={useBodyTemplate}
                  onChange={() => setUseBodyTemplate(true)}
                />
                Body Template (JSON)
              </label>
            </div>
          </div>

          {!useBodyTemplate && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-[var(--muted-foreground)]">Encoding:</label>
              <select
                value={bodyEncoding}
                onChange={e => setBodyEncoding(e.target.value)}
                className="border border-[var(--input)] rounded px-2 py-1 text-xs bg-[var(--background)]"
              >
                <option value="json">application/json</option>
                <option value="form-urlencoded">application/x-www-form-urlencoded</option>
                <option value="form-data">multipart/form-data</option>
              </select>
            </div>
          )}

          {useBodyTemplate && (
            <div>
              <textarea
                value={bodyTemplate}
                onChange={e => {
                  setBodyTemplate(e.target.value);
                  extractTemplateParams(e.target.value);
                }}
                rows={8}
                placeholder={'{\n  "Name": "Static value",\n  "Description": "${description}",\n  "Count": ${count}\n}'}
                className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
              />
              <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                Use <code className="bg-[var(--muted)] px-1 rounded">${'{param_name}'}</code> for dynamic values.
                All other fields are sent as-is. Parameters are auto-extracted below.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Parameters */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <label className="block text-xs font-semibold">Input Parameters</label>
            <p className="text-[10px] text-[var(--muted-foreground)]">
              Define what the AI model can pass to this tool, and where each value goes in the API request
            </p>
          </div>
          <button
            onClick={addParam}
            className="border border-[var(--border)] px-3 py-1 rounded text-xs hover:bg-[var(--accent)]"
          >
            + Add Parameter
          </button>
        </div>

        {/* Env var override banner */}
        {envVarKeys && envVarKeys.size > 0 && params.some(p => p.name && envVarKeys.has(p.name)) && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-[var(--brand-light,var(--info-bg))] border border-[var(--brand,var(--info-text))] border-opacity-30 text-xs text-[var(--foreground)]">
            <span className="text-sm leading-none mt-0.5">&#9889;</span>
            <div>
              <span className="font-medium">Auto-filled from env:</span>{' '}
              {params.filter(p => p.name && envVarKeys.has(p.name)).map(p => (
                <code key={p.name} className="mx-0.5 px-1 py-0.5 rounded bg-[var(--muted)] font-mono text-[11px]">{p.name}</code>
              ))}
              <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                These parameters are injected from environment variables at runtime and hidden from the AI.
              </p>
            </div>
          </div>
        )}

        {params.length === 0 ? (
          <p className="text-xs text-[var(--muted-foreground)] py-3 text-center border border-dashed border-[var(--border)] rounded-md">
            No parameters defined. Click &quot;Add Parameter&quot; to define tool inputs.
          </p>
        ) : (
          <div className="space-y-2">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_100px_1fr_140px_50px_30px] gap-2 text-[10px] font-medium text-[var(--muted-foreground)] px-1">
              <span>Name</span>
              <span>Type</span>
              <span>Description</span>
              <span>Maps To</span>
              <span>Req</span>
              <span></span>
            </div>

            {params.map((param, i) => {
              const isEnvOverridden = !!(envVarKeys && param.name && envVarKeys.has(param.name));
              return (
              <div
                key={i}
                className={`grid grid-cols-[1fr_100px_1fr_140px_50px_30px] gap-2 items-center${isEnvOverridden ? ' opacity-60' : ''}`}
              >
                <div className="relative">
                  <input
                    type="text"
                    value={param.name}
                    onChange={e => updateParam(i, { name: e.target.value })}
                    placeholder="param_name"
                    className={`w-full border rounded px-2 py-1.5 text-xs bg-[var(--background)] font-mono ${isEnvOverridden ? 'border-[var(--brand)] border-dashed' : 'border-[var(--input)]'}`}
                  />
                  {isEnvOverridden && (
                    <span
                      className="absolute -top-2 right-1 text-[9px] px-1 rounded bg-[var(--brand)] text-white leading-tight"
                      title="This parameter is auto-filled from an environment variable and hidden from the AI"
                    >
                      env
                    </span>
                  )}
                </div>
                <select
                  value={param.type}
                  onChange={e => updateParam(i, { type: e.target.value as ToolParam['type'] })}
                  className="border border-[var(--input)] rounded px-2 py-1.5 text-xs bg-[var(--background)]"
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="integer">integer</option>
                  <option value="boolean">boolean</option>
                  <option value="array">array</option>
                  <option value="object">object</option>
                </select>
                <input
                  type="text"
                  value={param.description}
                  onChange={e => updateParam(i, { description: e.target.value })}
                  placeholder="Describe this parameter..."
                  className="border border-[var(--input)] rounded px-2 py-1.5 text-xs bg-[var(--background)]"
                />
                <select
                  value={param.target}
                  onChange={e => updateParam(i, { target: e.target.value as ToolParam['target'] })}
                  className="border border-[var(--input)] rounded px-2 py-1.5 text-xs bg-[var(--background)]"
                >
                  {targets.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <div className="flex justify-center">
                  <input
                    type="checkbox"
                    checked={param.required}
                    onChange={e => updateParam(i, { required: e.target.checked })}
                    title="Required"
                  />
                </div>
                <button
                  onClick={() => removeParam(i)}
                  className="text-[var(--destructive)] text-xs hover:underline"
                  title="Remove parameter"
                >
                  &times;
                </button>
              </div>
              );
            })}

            {/* Query key override for query-targeted params */}
            {params.some(p => (p.target === 'query' || p.target === 'graphql_var') && p.queryKey) && (
              <div className="mt-2 space-y-1">
                <p className="text-[10px] font-medium text-[var(--muted-foreground)]">Query Key Overrides</p>
                {params.filter(p => (p.target === 'query' || p.target === 'graphql_var') && p.queryKey).map((param) => {
                  const idx = params.indexOf(param);
                  return (
                    <div key={idx} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-[var(--muted-foreground)] w-32">{param.name}</span>
                      <span className="text-[var(--muted-foreground)]">&rarr;</span>
                      <input
                        type="text"
                        value={param.queryKey || ''}
                        onChange={e => updateParam(idx, { queryKey: e.target.value || undefined })}
                        placeholder={param.name}
                        className="border border-[var(--input)] rounded px-2 py-1 text-xs bg-[var(--background)] font-mono w-48"
                      />
                      <span className="text-[var(--muted-foreground)] text-[10px]">query key</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Header name input for header-targeted params */}
            {params.some(p => p.target === 'header') && (
              <div className="mt-2 space-y-1">
                <p className="text-[10px] font-medium text-[var(--muted-foreground)]">Header Name Overrides</p>
                {params.filter(p => p.target === 'header').map((param, _) => {
                  const idx = params.indexOf(param);
                  return (
                    <div key={idx} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-[var(--muted-foreground)] w-32">{param.name}</span>
                      <span className="text-[var(--muted-foreground)]">&rarr;</span>
                      <input
                        type="text"
                        value={param.headerName || ''}
                        onChange={e => updateParam(idx, { headerName: e.target.value })}
                        placeholder={param.name}
                        className="border border-[var(--input)] rounded px-2 py-1 text-xs bg-[var(--background)] font-mono w-48"
                      />
                      <span className="text-[var(--muted-foreground)] text-[10px]">header name</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Response Caching */}
      <div>
        <label className="block text-xs font-semibold mb-1">Response Cache TTL</label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            value={cacheTtl}
            onChange={e => setCacheTtl(Math.max(0, parseInt(e.target.value) || 0))}
            className="w-32 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
            placeholder="0"
          />
          <span className="text-xs text-[var(--muted-foreground)]">seconds (0 = no caching)</span>
        </div>
        <p className="text-[10px] text-[var(--muted-foreground)] mt-1">
          Cache identical requests in Redis to reduce API calls. Common values: 60 (1 min), 300 (5 min), 3600 (1 hour).
        </p>
      </div>

      {/* Preview */}
      <div>
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            Preview generated mapping (JSON)
          </summary>
          <pre className="mt-2 p-3 bg-[var(--muted)] rounded text-[10px] font-mono overflow-x-auto max-h-48 overflow-y-auto">
            {JSON.stringify(
              buildToolPayload({ name, description, method, path, params, graphqlQuery, sqlTemplate, cacheTtl, bodyTemplate: useBodyTemplate ? bodyTemplate : undefined, useBodyTemplate, bodyEncoding: !useBodyTemplate ? bodyEncoding : undefined }, type),
              null,
              2,
            )}
          </pre>
        </details>
      </div>
    </div>
  );
}
