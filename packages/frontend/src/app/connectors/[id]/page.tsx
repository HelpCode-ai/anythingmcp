'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { connectors, tools, withSecretsNotice, withImportNotice, isMachineGrant, type ToolTestResult, type CatalogDiff, type OAuthGrant } from '@/lib/api';
import { findDemoByTool } from '@/lib/demo-connectors';
import { ToolEditor } from '@/components/tool-editor';
import { McpAssignModal } from '@/components/mcp-assign-modal';
import { AppSelect } from '@/components/ui/select';
import { HeadersEditor, headerRowsToObject, objectToHeaderRows, type HeaderRow } from '@/components/headers-editor';
import { AppShell } from '@/components/app-shell';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge, StatusPill } from '@/components/ui/badge';
import { SetupStatusBanner, SetupStatusPill } from '@/components/setup-status';
import { AuthStatusBanner, AuthStatusPill } from '@/components/auth-status';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { useAuthTypeLabel } from '@/lib/use-auth-type-label';
import { ToolAnnotationsEditor } from '@/components/tool-annotations-editor';
import { UserCredentialsCard } from '@/components/user-credentials-card';
import {
  EMPTY_EMAIL_FORM,
  EmailSettingsFields,
  emailBaseUrl,
  emailFormFromConfig,
  emailFormToAuthConfig,
  emailFormToConfig,
  emailLoginEdited,
  type EmailFormState,
} from '@/components/email-settings-fields';

// Labels and the prose placeholders are in the connectorTools messages; the
// code examples below are the same in every language.
const IMPORT_SOURCES: { id: string; placeholder?: string }[] = [
  { id: 'openapi' },
  { id: 'postman' },
  { id: 'curl', placeholder: 'curl -X GET https://api.example.com/users -H "Authorization: Bearer {{token}}"' },
  { id: 'har', placeholder: '' },
  { id: 'graphql' },
  { id: 'wsdl' },
  { id: 'json', placeholder: '[\n  {\n    "name": "get_users",\n    "description": "Fetch users",\n    "parameters": { "type": "object", "properties": { "limit": { "type": "number" } } },\n    "endpointMapping": { "method": "GET", "path": "/users", "queryParams": { "limit": "$limit" } }\n  }\n]' },
  { id: 'mcp' },
  { id: 'odata' },
];

/** OData settings live under config.odata on ODATA connectors and OData-enabled REST connectors. */
function hasOData(connector: any): boolean {
  return connector?.type === 'ODATA' || (connector?.type === 'REST' && !!connector?.config?.odata);
}

const EDIT_DEFAULT_LOGIN_BODY = '{\n  "username": "${username}",\n  "password": "${password}"\n}';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Field names a HAR entry carries that hold a credential by themselves. */
const HAR_CREDENTIAL_HEADER_RE = /(token|secret|password|passwd|api[-_]?key|session|csrf|xsrf|auth|signature|sig)/i;
const HAR_EXPLICIT_CREDENTIAL_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);
const HAR_MAX_UPLOAD_BYTES = 7 * 1024 * 1024;

function isHarCredentialHeader(name: string): boolean {
  const n = name.toLowerCase();
  return HAR_EXPLICIT_CREDENTIAL_HEADERS.has(n) || n.startsWith(':') || HAR_CREDENTIAL_HEADER_RE.test(n);
}

function slimHarHeaders(headers: unknown): any[] {
  if (!Array.isArray(headers)) return [];
  return headers.filter((h: any) => h && typeof h.name === 'string' && !isHarCredentialHeader(h.name));
}

function slimHarQueryString(qs: unknown): any[] {
  if (!Array.isArray(qs)) return [];
  return qs.filter((q: any) => q && typeof q.name === 'string' && !HAR_CREDENTIAL_HEADER_RE.test(q.name));
}

/** `{"user":{"password":"…"}}` → the same shape with every credential-named key's value removed, at any depth. */
function scrubJsonCredentials(value: any, depth = 0): any {
  if (depth > 10 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubJsonCredentials(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = HAR_CREDENTIAL_HEADER_RE.test(key) ? '[removed before upload]' : scrubJsonCredentials(v, depth + 1);
  }
  return out;
}

function slimHarPostData(postData: unknown): any {
  if (!postData || typeof postData !== 'object') return postData;
  const pd = postData as any;
  if (Array.isArray(pd.params)) {
    return { ...pd, params: pd.params.filter((p: any) => !(p && typeof p.name === 'string' && HAR_CREDENTIAL_HEADER_RE.test(p.name))) };
  }
  if (typeof pd.text === 'string' && typeof pd.mimeType === 'string' && pd.mimeType.includes('application/json')) {
    try {
      const parsed = JSON.parse(pd.text);
      if (parsed && typeof parsed === 'object') {
        return { ...pd, text: JSON.stringify(scrubJsonCredentials(parsed)) };
      }
    } catch {
      // Not parseable JSON — leave it for the backend, which drops anything it can't scrub.
    }
  }
  return pd;
}

/** Same origin as the connector's base URL, treating `wss:`/`ws:` as `https:`/`http:` like the backend parser does. */
function matchesHarOrigin(urlStr: string, base: URL | null): boolean {
  if (!base) return true;
  try {
    const u = new URL(urlStr);
    const scheme = (p: string) => (p === 'wss:' ? 'https:' : p === 'ws:' ? 'http:' : p);
    return scheme(u.protocol) === scheme(base.protocol) && u.host === base.host;
  } catch {
    return false;
  }
}

/**
 * Strips response data, cookies and credential headers/query/body fields
 * from a HAR before it ever leaves the browser, and drops entries outside
 * the connector's own origin — a raw capture carries full response bodies,
 * session cookies and requests to other sites that must never be uploaded at
 * all, on top of the credential fields the backend parser also scrubs.
 */
function slimHarForUpload(rawText: string, baseUrl?: string): { json: string; byteLength: number; droppedOtherOrigin: number } {
  const har = JSON.parse(rawText);
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) {
    throw new Error('Not a valid HAR file (expected a log.entries array)');
  }
  let base: URL | null = null;
  try {
    base = baseUrl ? new URL(baseUrl) : null;
  } catch {
    base = null;
  }
  const inScope = entries.filter((entry: any) => matchesHarOrigin(entry?.request?.url ?? '', base));
  const slimmed = {
    log: {
      version: har.log.version,
      entries: inScope.map((entry: any) => ({
        _resourceType: entry?._resourceType,
        request: entry?.request
          ? {
              method: entry.request.method,
              url: entry.request.url,
              httpVersion: entry.request.httpVersion,
              headers: slimHarHeaders(entry.request.headers),
              queryString: slimHarQueryString(entry.request.queryString),
              postData: slimHarPostData(entry.request.postData),
            }
          : undefined,
        // The backend never reads response data — dropped entirely, not just its body.
      })),
    },
  };
  const json = JSON.stringify(slimmed);
  return {
    json,
    byteLength: new TextEncoder().encode(json).length,
    droppedOtherOrigin: entries.length - inScope.length,
  };
}

export default function ConnectorDetailPage() {
  const { token, user, deploymentMode } = useAuth();
  const t = useTranslations('connectorDetail');
  const te = useTranslations('emailSettings');
  const tt = useTranslations('connectorTools');
  const locale = useLocale();
  const authTypeLabel = useAuthTypeLabel();
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params.id as string;

  const [connector, setConnector] = useState<any>(null);
  const [toolList, setToolList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Whether CONNECTOR_PROXY_URL is configured on this instance — drives
  // visibility of the per-tool "Use proxy" checkbox.
  const [proxyAvailable, setProxyAvailable] = useState(false);
  // Tool whose MCP hints (annotations) panel is expanded, if any.
  const [hintsToolId, setHintsToolId] = useState<string | null>(null);

  // OAuth + MCP discovery
  const [authorizing, setAuthorizing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: 'connector' } | { kind: 'tool'; id: string; name: string } | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editHealthcheckPath, setEditHealthcheckPath] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editAuthType, setEditAuthType] = useState('NONE');
  const [editAuthKey, setEditAuthKey] = useState('');
  const [editAuthValue, setEditAuthValue] = useState('');
  // WS_SECURITY (SOAP only). The stored type is not sent back with the rest of
  // authConfig, so it is only written together with re-entered credentials.
  const [editWsPasswordType, setEditWsPasswordType] = useState('PasswordText');
  // OAuth2 only: how client credentials reach the token endpoint.
  const [editTokenAuthMethod, setEditTokenAuthMethod] = useState('client_secret_post');
  // OAuth2 only: PKCE on "Authorize with Provider". `loadedPkce` is what the
  // server reported, so saving sends the switch only when the user changed it
  // (an untouched form must not pin a catalog adapter's setting on the row).
  const [editPkce, setEditPkce] = useState(true);
  const [loadedPkce, setLoadedPkce] = useState(true);
  // OAuth2 endpoints. Editable because a connector switched to OAUTH2 after
  // creation has none, and could otherwise never be authorized
  // ("No authorization URL configured for this connector").
  const [editOauthAuthUrl, setEditOauthAuthUrl] = useState('');
  const [editOauthTokenUrl, setEditOauthTokenUrl] = useState('');
  const [editOauthScopes, setEditOauthScopes] = useState('');
  // OAuth2 grant. `loadedOauthGrant` is what is stored: it decides whether the
  // connector shows "Authorize with Provider" (a machine grant needs no
  // sign-in), and saving sends the grant only when the user changed it.
  const [editOauthGrant, setEditOauthGrant] = useState<OAuthGrant>('authorization_code');
  const [loadedOauthGrant, setLoadedOauthGrant] = useState<OAuthGrant>('authorization_code');
  // Password grant credentials (Datto RMM: API key and API secret). Never
  // pre-filled; an empty field keeps the stored value.
  const [editOauthUsername, setEditOauthUsername] = useState('');
  const [editOauthPassword, setEditOauthPassword] = useState('');
  const [oauthHasPasswordCreds, setOauthHasPasswordCreds] = useState(false);
  // OAuth 1.0a credentials. Never pre-filled (the server does not send them
  // back); an empty field keeps the stored value.
  const [editOauth1Key, setEditOauth1Key] = useState('');
  const [editOauth1Secret, setEditOauth1Secret] = useState('');
  const [editOauth1Token, setEditOauth1Token] = useState('');
  const [editOauth1TokenSecret, setEditOauth1TokenSecret] = useState('');
  // LOGIN_TOKEN (credentials → short-lived token, auto-refreshed) fields
  const [editLtLoginUrl, setEditLtLoginUrl] = useState('');
  const [editLtMethod, setEditLtMethod] = useState('POST');
  const [editLtUsername, setEditLtUsername] = useState('');
  const [editLtPassword, setEditLtPassword] = useState('');
  const [editLtLoginBody, setEditLtLoginBody] = useState(EDIT_DEFAULT_LOGIN_BODY);
  const [editLtTokenPath, setEditLtTokenPath] = useState('token');
  const [editLtTtl, setEditLtTtl] = useState('');
  const [editLtRefreshOn401, setEditLtRefreshOn401] = useState(true);
  const [editHeaderRows, setEditHeaderRows] = useState<HeaderRow[]>([]);
  const [editDbReadOnly, setEditDbReadOnly] = useState(true);
  const [editDbDeniedTables, setEditDbDeniedTables] = useState('');
  const [editOdataSap, setEditOdataSap] = useState(false);
  const [editOdataSapClient, setEditOdataSapClient] = useState('');
  const [editOdataSapLanguage, setEditOdataSapLanguage] = useState('');
  const [editOdataServices, setEditOdataServices] = useState('');
  // EMAIL: servers and sender from config.email; the login starts empty.
  const [editEmail, setEditEmail] = useState<EmailFormState>(EMPTY_EMAIL_FORM);
  const [importEntitySets, setImportEntitySets] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [msg, setMsg] = useState('');
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    kind?: 'ok' | 'auth_failed' | 'not_found' | 'unreachable' | 'unsupported' | 'error';
    httpStatus?: number;
    suggestedFix?: { action: string; hostname?: string; url?: string };
  } | null>(null);

  // Tool editor state
  const [showNewTool, setShowNewTool] = useState(false);
  const [editingToolId, setEditingToolId] = useState<string | null>(null);
  const [savingTool, setSavingTool] = useState(false);

  // Tool playground state
  const [testingToolId, setTestingToolId] = useState<string | null>(null);
  const [testParams, setTestParams] = useState('{}');
  const [testRunning, setTestRunning] = useState(false);
  const [toolTestResult, setToolTestResult] = useState<ToolTestResult | null>(null);
  // Which side of a mapped response the playground shows. Defaults to what an
  // AI client would actually receive.
  const [testResponseView, setTestResponseView] = useState<'mapped' | 'raw'>('mapped');

  // What the catalog has changed since this connector was installed.
  const [catalogDiff, setCatalogDiff] = useState<CatalogDiff | null>(null);
  const [applyingCatalog, setApplyingCatalog] = useState(false);
  // Opt-in, and separate from the rest: the base URL is the whole address of
  // the API, so it moves only when someone ticks this having read both values.
  const [applyBaseUrl, setApplyBaseUrl] = useState(false);

  // Import modal
  const [showImport, setShowImport] = useState(false);
  const [importSource, setImportSource] = useState('openapi');
  const [importContent, setImportContent] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);

  // HAR import: the file is slimmed (response bodies, cookies, credential
  // headers stripped) in the browser before its JSON lands in importContent.
  const [harFileName, setHarFileName] = useState('');
  const [harError, setHarError] = useState('');

  // MCP assign modal — shown when tools are added and connector is not yet assigned
  const [showMcpAssign, setShowMcpAssign] = useState(false);

  // Environment variables
  const [showEnvVars, setShowEnvVars] = useState(false);
  // `masked`: a stored secret. The server never sends its value, so the field
  // starts empty and is sent back empty unless retyped, which keeps it.
  const [envVarEntries, setEnvVarEntries] = useState<
    { key: string; value: string; masked?: boolean }[]
  >([]);
  const [savingEnvVars, setSavingEnvVars] = useState(false);

  const resetOauth1Fields = () => {
    setEditOauth1Key('');
    setEditOauth1Secret('');
    setEditOauth1Token('');
    setEditOauth1TokenSecret('');
  };

  const fetchConnector = async () => {
    if (!token) return;
    try {
      // Cheap, instance-wide flag — drives the per-tool proxy checkbox.
      connectors
        .proxyAvailability(token)
        .then((r) => setProxyAvailable(!!r.available))
        .catch(() => setProxyAvailable(false));
      const c = await connectors.get(id, token);
      setConnector(c);
      // Only catalog-installed connectors have anything to compare against;
      // the endpoint answers catalogManaged:false for the rest.
      connectors
        .catalogDiff(id, token)
        .then((d) => setCatalogDiff(d.catalogManaged && !d.isUpToDate ? d : null))
        .catch(() => setCatalogDiff(null));
      setEditName(c.name);
      setEditBaseUrl(c.baseUrl);
      setEditHealthcheckPath(c.healthcheckPath || '');
      setEditActive(c.isActive);
      setEditAuthType(c.authType || 'NONE');
      setEditInstructions(c.instructions || '');
      // Don't pre-fill credentials — they are encrypted on the server
      setEditAuthKey('');
      setEditAuthValue('');
      setEditWsPasswordType('PasswordText');
      resetOauth1Fields();
      setEditOauthUsername('');
      setEditOauthPassword('');
      // The auth method is not secret, so it can be shown. Without this the
      // select would always read "body" and saving any other field would
      // silently reset a connector configured for HTTP Basic.
      if (c.authType === 'OAUTH2' && c.type !== 'MCP') {
        connectors
          .getOAuthConfig(id, token)
          .then((r) => {
            setEditTokenAuthMethod(normalizeTokenAuthMethod(r.tokenAuthMethod));
            setEditPkce(r.pkce !== false);
            setLoadedPkce(r.pkce !== false);
            setEditOauthAuthUrl(r.authorizationUrl || '');
            setEditOauthTokenUrl(r.tokenUrl || '');
            setEditOauthScopes(r.scopes || '');
            setEditOauthGrant(r.grant || 'authorization_code');
            setLoadedOauthGrant(r.grant || 'authorization_code');
            setOauthHasPasswordCreds(r.hasUsername && r.hasPassword);
          })
          .catch(() => setEditTokenAuthMethod('client_secret_post'));
      }
      // authConfig is encrypted server-side, so LOGIN_TOKEN fields start empty;
      // headers are stored in the clear and can be pre-filled for editing.
      setEditLtPassword('');
      setEditHeaderRows(objectToHeaderRows(c.headers as Record<string, string> | null));
      setEditDbReadOnly((c.config as any)?.readOnly !== false);
      {
        const denied = (c.config as any)?.deniedTables;
        setEditDbDeniedTables(Array.isArray(denied) ? denied.join(', ') : '');
        const odata = (c.config as any)?.odata ?? {};
        setEditOdataSap(odata.sap === true || !!odata.sapClient);
        setEditOdataSapClient(odata.sapClient ?? '');
        setEditOdataSapLanguage(odata.sapLanguage ?? '');
        setEditOdataServices(Array.isArray(odata.services) ? odata.services.join('\n') : '');
        setEditEmail(emailFormFromConfig(c.config));
      }
      setToolList(c.tools || []);
      // Load env vars
      const ev = c.envVars as Record<string, string> | null;
      if (ev && typeof ev === 'object') {
        const masked = new Set<string>(c.maskedEnvVars || []);
        setEnvVarEntries(
          Object.entries(ev).map(([key, value]) => ({
            key,
            value: masked.has(key) ? '' : String(value ?? ''),
            masked: masked.has(key),
          })),
        );
      }
    } catch {
      router.push('/connectors');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // The new-connector form moved a secret typed into the URL or a header
    // into a variable; say so the first time the connector is opened.
    const noticeKey = `amcp:secretsNotice:${id}`;
    const notice = typeof window !== 'undefined' ? window.sessionStorage.getItem(noticeKey) : null;
    if (notice) {
      window.sessionStorage.removeItem(noticeKey);
      setMsg(notice);
    }
  }, [id]);

  useEffect(() => {
    // Handle OAuth callback query params
    const oauthStatus = searchParams.get('oauth');
    if (oauthStatus === 'success') {
      const toolsImported = searchParams.get('tools');
      setMsg(
        toolsImported && Number(toolsImported) > 0
          ? t('msg.oauthSuccessTools', { count: toolsImported })
          : t('msg.oauthSuccess'),
      );
      // Clean URL
      window.history.replaceState({}, '', `/connectors/${id}`);
    } else if (oauthStatus === 'error') {
      const message = searchParams.get('message') || t('msg.authFailedDefault');
      setMsg(t('msg.oauthError', { message }));
      window.history.replaceState({}, '', `/connectors/${id}`);
    }

    fetchConnector();
  }, [token, id]);

  const buildAuthConfig = () => {
    // Only send authConfig if the user filled in credential fields;
    // empty fields mean "keep existing credentials on the server".
    switch (editAuthType) {
      case 'API_KEY':
        if (!editAuthValue) return undefined;
        return { headerName: editAuthKey || 'X-API-Key', apiKey: editAuthValue };
      case 'BEARER_TOKEN':
        if (!editAuthValue) return undefined;
        return { token: editAuthValue };
      case 'BASIC_AUTH':
        if (!editAuthKey && !editAuthValue) return undefined;
        return { username: editAuthKey, password: editAuthValue };
      case 'WS_SECURITY': {
        // The header needs both, so a half-filled pair would break every call.
        if (!editAuthKey && !editAuthValue) {
          if (connector.authType === 'WS_SECURITY') return undefined;
          throw new Error(t('msg.wsSwitch'));
        }
        if (!editAuthKey || !editAuthValue) {
          throw new Error(t('msg.wsChange'));
        }
        return { username: editAuthKey, password: editAuthValue, passwordType: editWsPasswordType };
      }
      case 'OAUTH1': {
        // A connector that already signs with OAuth 1.0a is patched field by
        // field instead (see handleSave), so the stored secret
        // survives a corrected consumer key. Switching to OAuth 1.0a from
        // another scheme writes a complete config, so both halves are needed.
        if (connector.authType === 'OAUTH1') return undefined;
        const consumerKey = editOauth1Key.trim();
        const consumerSecret = editOauth1Secret.trim();
        if (!consumerKey || !consumerSecret) {
          throw new Error(t('msg.oauth1Switch'));
        }
        const token = editOauth1Token.trim();
        const tokenSecret = editOauth1TokenSecret.trim();
        return {
          consumerKey,
          consumerSecret,
          ...(token ? { token } : {}),
          ...(tokenSecret ? { tokenSecret } : {}),
        };
      }
      case 'LOGIN_TOKEN': {
        // Re-entering the password is required to (re)write the whole config;
        // leaving it empty keeps the existing encrypted credentials untouched.
        if (!editLtPassword) return undefined;
        let loginBody: unknown;
        const raw = editLtLoginBody.trim();
        if (raw) {
          try {
            loginBody = JSON.parse(raw);
          } catch {
            throw new Error(t('msg.loginJson'));
          }
        }
        return {
          loginUrl: editLtLoginUrl,
          loginMethod: editLtMethod || 'POST',
          ...(loginBody !== undefined ? { loginBody } : {}),
          username: editLtUsername,
          password: editLtPassword,
          tokenJsonPath: editLtTokenPath || 'token',
          ...(editLtTtl.trim() ? { tokenTTLSeconds: Number(editLtTtl) } : {}),
          refreshOn401: editLtRefreshOn401,
        };
      }
      default:
        return undefined;
    }
  };

  const handleSave = async () => {
    if (!token) return;
    try {
      if (
        editAuthType === 'OAUTH2' &&
        editOauthGrant === 'password' &&
        !oauthHasPasswordCreds &&
        (!editOauthUsername.trim() || !editOauthPassword)
      ) {
        throw new Error(t('msg.passwordGrant'));
      }
      const data: Record<string, unknown> = {
        name: editName,
        baseUrl: editBaseUrl,
        healthcheckPath: editHealthcheckPath.trim() || null,
        isActive: editActive,
        authType: editAuthType,
        instructions: editInstructions.trim() || null,
      };
      const authConfig = buildAuthConfig();
      if (authConfig) data.authConfig = authConfig;

      // OAuth 1.0a on a connector that already uses it: send only the fields
      // that were typed, merged server-side. Done before the main update so a
      // refused value (e.g. an e-mail address as consumer key) saves nothing.
      if (editAuthType === 'OAUTH1' && connector.authType === 'OAUTH1') {
        const oauth1Patch: Record<string, string> = {};
        if (editOauth1Key.trim()) oauth1Patch.consumerKey = editOauth1Key.trim();
        if (editOauth1Secret.trim()) oauth1Patch.consumerSecret = editOauth1Secret.trim();
        if (editOauth1Token.trim()) oauth1Patch.token = editOauth1Token.trim();
        if (editOauth1TokenSecret.trim()) oauth1Patch.tokenSecret = editOauth1TokenSecret.trim();
        if (Object.keys(oauth1Patch).length > 0) {
          await connectors.updateOAuth1Config(id, oauth1Patch, token);
        }
      }
      if (connector.type === 'EMAIL') {
        // A catalog install keeps its servers and login in variables.
        if (!(connector.config as any)?.adapterSlug) {
          data.baseUrl = emailBaseUrl(editEmail);
          data.config = { email: emailFormToConfig(editEmail, (connector.config as any)?.email) };
          if (emailLoginEdited(editEmail)) data.authConfig = emailFormToAuthConfig(editEmail);
        } else {
          delete data.baseUrl;
        }
      } else if (connector.type !== 'DATABASE' && connector.type !== 'MCP') {
        // Editor is pre-filled with current headers, so this round-trips
        // untouched headers and applies any edits/removals the user made.
        data.headers = headerRowsToObject(editHeaderRows);
      }
      if (hasOData(connector)) {
        const existing = (connector.config as any)?.odata ?? {};
        const services = editOdataServices
          .split(/[\s,]+/)
          .map((v) => v.trim())
          .filter(Boolean);
        data.config = {
          odata: {
            ...existing,
            sap: editOdataSap,
            sapClient: editOdataSap && editOdataSapClient.trim() ? editOdataSapClient.trim() : undefined,
            sapLanguage: editOdataSap && editOdataSapLanguage.trim() ? editOdataSapLanguage.trim() : undefined,
            services: services.length > 0 ? services : undefined,
          },
        };
      }
      if (connector.type === 'DATABASE') {
        const deniedTables = editDbDeniedTables
          .split(/[\s,]+/)
          .map((v) => v.trim())
          .filter(Boolean);
        // The server merges config, so a cleared list must be sent as null.
        data.config = {
          readOnly: editDbReadOnly,
          deniedTables: deniedTables.length > 0 ? deniedTables : null,
        };
      }
      const saved = await connectors.update(id, data, token);

      // OAuth2 credentials live in authConfig alongside the issued tokens, so
      // they are patched separately (a full write would discard the tokens and
      // the endpoints captured during authorization).
      if (editAuthType === 'OAUTH2' && connector.type !== 'MCP') {
        const oauthPatch: Record<string, string | boolean> = {
          // The default (body) is stored as ''. Anything else is sent as
          // chosen: a catalog adapter may use a method this form cannot set
          // up by itself (Revolut's private_key_jwt), and saving an unrelated
          // field must not switch it off.
          tokenAuthMethod:
            editTokenAuthMethod === 'client_secret_post' ? '' : editTokenAuthMethod,
        };
        if (editAuthKey) oauthPatch.clientId = editAuthKey;
        if (editAuthValue) oauthPatch.clientSecret = editAuthValue;
        if (editOauthGrant !== loadedOauthGrant) oauthPatch.grant = editOauthGrant;
        if (editOauthGrant === 'password') {
          if (editOauthUsername.trim()) oauthPatch.username = editOauthUsername.trim();
          if (editOauthPassword) oauthPatch.password = editOauthPassword;
        }
        // Endpoints are not secret, so the form always holds their current
        // value and can round-trip them.
        oauthPatch.authorizationUrl = editOauthAuthUrl.trim();
        oauthPatch.tokenUrl = editOauthTokenUrl.trim();
        oauthPatch.scopes = editOauthScopes.trim();
        if (editPkce !== loadedPkce) oauthPatch.pkce = editPkce;
        await connectors.updateOAuthConfig(id, oauthPatch, token);
      }

      setMsg(withSecretsNotice(t('msg.updated'), saved));
      setEditing(false);
      fetchConnector();
    } catch (err: any) {
      setMsg(t('msg.error', { message: err.message }));
    }
  };

  const handleExport = async (format: 'json' | 'yaml') => {
    if (!token) return;
    try {
      const file = await connectors.exportConnector(id, format, token);
      const url = URL.createObjectURL(new Blob([file.text], { type: file.contentType }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      // Revoke later: some browsers start the download after click() returns.
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setMsg(
        file.secretsIncluded
          ? t('msg.exportedSecrets', { format: format.toUpperCase() })
          : t('msg.exportedNoSecrets', { format: format.toUpperCase() }),
      );
    } catch (err: any) {
      setMsg(t('msg.exportFailed', { message: err.message }));
    }
  };

  const handleTest = async () => {
    if (!token) return;
    setTestResult(null);
    try {
      const result = await connectors.test(id, token);
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message });
    }
  };

  /** Check if connector is assigned to any MCP server; if not, show the assign modal */
  const promptMcpAssignIfNeeded = async () => {
    if (!token) return;
    try {
      const fresh = await connectors.get(id, token);
      const isAssigned = (fresh.mcpServers?.length || 0) > 0;
      const hasTools = (fresh.tools?.length || 0) > 0;
      if (!isAssigned && hasTools) {
        setShowMcpAssign(true);
      }
    } catch {}
  };

  const handleImportSpec = async () => {
    if (!token) return;
    setMsg(t('msg.importingSpec'));
    try {
      const result = await connectors.importSpec(id, token);
      setMsg(withImportNotice(result.message, result));
      fetchConnector();
      promptMcpAssignIfNeeded();
    } catch (err: any) {
      setMsg(t('msg.importFailed', { message: err.message }));
    }
  };

  const handleHarFileChange = async (file: File | null) => {
    setHarError('');
    setImportContent('');
    setHarFileName('');
    if (!file) return;
    setHarFileName(file.name);
    try {
      const text = await file.text();
      const { json, byteLength, droppedOtherOrigin } = slimHarForUpload(text, connector?.baseUrl);
      if (byteLength > HAR_MAX_UPLOAD_BYTES) {
        setHarError(
          tt('import.harTooBig', { size: formatBytes(byteLength) }),
        );
        return;
      }
      if (droppedOtherOrigin > 0 && JSON.parse(json).log.entries.length === 0) {
        setHarError(
          connector?.baseUrl
            ? tt('import.harOtherOrigin', { count: droppedOtherOrigin, url: connector.baseUrl })
            : tt('import.harOtherOriginNoUrl', { count: droppedOtherOrigin }),
        );
        return;
      }
      setImportContent(json);
    } catch (err: any) {
      setHarError(tt('import.harReadError', { message: err.message }));
    }
  };

  const handleImportTools = async () => {
    if (!token) return;
    setImporting(true);
    try {
      const data: { source: string; content?: string; url?: string; service?: string; entitySets?: string[] } = {
        source: importSource,
      };
      if (importSource === 'odata') {
        if (importUrl.trim()) data.service = importUrl.trim();
        if (importContent.trim()) data.content = importContent;
        const sets = importEntitySets.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
        if (sets.length) data.entitySets = sets;
      } else if (importSource === 'curl' || importSource === 'json' || importSource === 'har') {
        data.content = importContent;
      } else if (importUrl) {
        data.url = importUrl;
      } else if (importContent) {
        data.content = importContent;
      }
      const result = await connectors.importTools(id, data, token) as any;
      if (result.error) {
        setMsg(result.error);
      } else {
        setMsg(withImportNotice(result.message, result));
        setShowImport(false);
        setImportContent('');
        setImportUrl('');
        setHarFileName('');
        setHarError('');
        fetchConnector();
        promptMcpAssignIfNeeded();
      }
    } catch (err: any) {
      setMsg(t('msg.importFailed', { message: err.message }));
    } finally {
      setImporting(false);
    }
  };

  const handleApplyCatalog = async () => {
    if (!token) return;
    setApplyingCatalog(true);
    try {
      const res = await connectors.resyncCatalog(id, token, { applyBaseUrl });
      setMsg(
        res.applied
          ? applyBaseUrl && catalogDiff?.baseUrl
            ? t('msg.catalogUpdatedBaseUrl', { url: catalogDiff.baseUrl.to })
            : t('msg.catalogUpdated')
          : t('msg.nothingToUpdate'),
      );
      setApplyBaseUrl(false);
      await fetchConnector();
    } catch (err: any) {
      setMsg(t('msg.error', { message: err.message }));
    } finally {
      setApplyingCatalog(false);
    }
  };

  // Deleting is confirmed in the product's own dialog, the same one the
  // connectors list uses — a native confirm() looked like a different
  // application and is the easiest thing on a phone to mis-tap.
  const handleDelete = () => setDeleteTarget({ kind: 'connector' });
  const handleDeleteTool = (toolId: string, toolName: string) =>
    setDeleteTarget({ kind: 'tool', id: toolId, name: toolName });

  const confirmDelete = async () => {
    if (!token || !deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteTarget.kind === 'connector') {
        await connectors.delete(id, token);
        router.push('/connectors');
        return;
      }
      await tools.delete(id, deleteTarget.id, token);
      setToolList((prev) => prev.filter((x) => x.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err: any) {
      setMsg(t('msg.error', { message: err.message }));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleTool = async (toolId: string, isEnabled: boolean) => {
    if (!token) return;
    try {
      await tools.update(id, toolId, { isEnabled: !isEnabled }, token);
      setToolList((prev) =>
        prev.map((x) => (x.id === toolId ? { ...x, isEnabled: !isEnabled } : x)),
      );
    } catch (err: any) {
      setMsg(t('msg.error', { message: err.message }));
    }
  };

  const handleToggleProxy = async (toolId: string, useProxy: boolean) => {
    if (!token) return;
    // Optimistic flip; revert on error.
    setToolList((prev) =>
      prev.map((x) => (x.id === toolId ? { ...x, useProxy: !useProxy } : x)),
    );
    try {
      await tools.setProxy(id, toolId, !useProxy, token);
    } catch (err: any) {
      setToolList((prev) =>
        prev.map((x) => (x.id === toolId ? { ...x, useProxy } : x)),
      );
      setMsg(t('msg.error', { message: err.message }));
    }
  };

  const handleTestTool = async (toolId: string, paramsOverride?: unknown) => {
    if (!token) return;
    setTestRunning(true);
    setToolTestResult(null);
    setTestResponseView('mapped');
    try {
      const params =
        paramsOverride !== undefined ? paramsOverride : JSON.parse(testParams);
      const result = await tools.test(id, toolId, params, token);
      setToolTestResult(result);
    } catch (err: any) {
      setToolTestResult({ ok: false, durationMs: 0, error: err.message });
    } finally {
      setTestRunning(false);
    }
  };

  // Onboarding demo auto-run: arriving from /welcome with ?demoTool&autorun=1,
  // open that tool's playground and fire a real call immediately so the user's
  // very first action produces a successful result.
  const demoRan = useRef(false);
  useEffect(() => {
    if (demoRan.current) return;
    if (!token || !toolList.length) return;
    const demoTool = searchParams.get('demoTool');
    if (!demoTool || searchParams.get('autorun') !== '1') return;
    const tool = toolList.find((x: any) => x.name === demoTool);
    if (!tool) return;
    demoRan.current = true;
    const params = findDemoByTool(demoTool)?.params ?? {};
    setTestingToolId(tool.id);
    setTestParams(JSON.stringify(params, null, 2));
    setMsg(tt('msg.firstRun'));
    void handleTestTool(tool.id, params);
    window.history.replaceState({}, '', `/connectors/${id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolList, token, searchParams, id]);

  const handleCreateTool = async (data: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    endpointMapping: Record<string, unknown>;
    responseMapping?: Record<string, unknown>;
  }) => {
    if (!token) return;
    setSavingTool(true);
    try {
      const created = await tools.create(id, data, token);
      setShowNewTool(false);
      setMsg(withSecretsNotice(tt('msg.created'), created));
      fetchConnector();
      promptMcpAssignIfNeeded();
    } catch (err: any) {
      setMsg(t('msg.error', { message: err.message }));
    } finally {
      setSavingTool(false);
    }
  };

  const handleUpdateTool = async (
    toolId: string,
    data: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      endpointMapping: Record<string, unknown>;
      responseMapping?: Record<string, unknown>;
    },
  ) => {
    if (!token) return;
    setSavingTool(true);
    try {
      const updated = await tools.update(id, toolId, data, token);
      setEditingToolId(null);
      setMsg(withSecretsNotice(tt('msg.updated'), updated));
      fetchConnector();
    } catch (err: any) {
      setMsg(t('msg.error', { message: err.message }));
    } finally {
      setSavingTool(false);
    }
  };

  const handleSaveEnvVars = async () => {
    if (!token) return;
    setSavingEnvVars(true);
    try {
      const envVars: Record<string, string> = {};
      for (const entry of envVarEntries) {
        if (entry.key.trim()) {
          envVars[entry.key.trim()] = entry.value;
        }
      }
      // A masked secret nobody retyped goes out empty, which the server
      // reads as "keep the stored value". Its value is never in the browser.
      const result = await connectors.updateEnvVars(id, envVars, token);
      const warnings = result?.warnings ?? [];
      setMsg(
        warnings.length
          ? t('msg.envSavedWarnings', { warnings: warnings.join(' ') })
          : t('msg.envSaved'),
      );
      fetchConnector();
    } catch (err: any) {
      setMsg(t('msg.error', { message: err.message }));
    } finally {
      setSavingEnvVars(false);
    }
  };

  const handleOAuthAuthorize = async () => {
    if (!token) return;
    setAuthorizing(true);
    try {
      const result = await connectors.oauthAuthorize(id, token);
      if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl;
      } else if (result.error) {
        setMsg(result.error);
      }
    } catch (err: any) {
      setMsg(t('msg.authorizationFailed', { message: err.message }));
    } finally {
      setAuthorizing(false);
    }
  };

  // Shopee shops are authorized through Shopee's own signed link, not OAuth2.
  const handleShopeeAuthorize = async () => {
    if (!token) return;
    setAuthorizing(true);
    try {
      const result = await connectors.shopeeAuthorize(id, token);
      if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl;
      } else if (result.error) {
        setMsg(result.error);
      }
    } catch (err: any) {
      setMsg(t('msg.authorizationFailed', { message: err.message }));
    } finally {
      setAuthorizing(false);
    }
  };

  const handleDiscoverTools = async () => {
    if (!token) return;
    setDiscovering(true);
    try {
      const result = await connectors.discoverTools(id, token);
      if (result.error) {
        setMsg(result.error);
      } else {
        setMsg(withImportNotice(result.message, result));
        fetchConnector();
      }
    } catch (err: any) {
      setMsg(t('msg.discoveryFailed', { message: err.message }));
    } finally {
      setDiscovering(false);
    }
  };


  if (loading) {
    return (
      <AppShell backTo={{ label: t('back'), href: '/connectors' }} title={t('loadingTitle')}>
        <div className="flex items-center justify-center py-24">
          <div className="text-center">
            <div className="inline-block w-6 h-6 border-2 border-[var(--brand)] border-t-transparent rounded-full animate-spin mb-3"></div>
            <p className="text-[var(--text-3)]">{t('loading')}</p>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!connector) return null;

  const monoMethodTone = (method?: string): string => {
    switch ((method || '').toUpperCase()) {
      case 'GET':
        return 'bg-[var(--t-info-bg)] text-[var(--t-info-fg)]';
      case 'POST':
        return 'bg-[var(--t-success-bg)] text-[var(--t-success-fg)]';
      case 'PUT':
      case 'PATCH':
        return 'bg-[var(--t-warn-bg)] text-[var(--t-warn-fg)]';
      case 'DELETE':
        return 'bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]';
      default:
        return 'bg-[var(--t-neutral-bg)] text-[var(--t-neutral-fg)]';
    }
  };

  const strong = (chunks: ReactNode) => <strong className="text-[var(--text)]">{chunks}</strong>;

  const connectorInitials = (connector.name || '?')
    .split(/\s+/)
    .map((w: string) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <AppShell
      backTo={{ label: t('back'), href: '/connectors' }}
      title={connector.name}
      maxWidth={880}
      actions={
        <div className="flex gap-2 flex-wrap">
          <Button variant="secondary" size="md" onClick={handleTest}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
            {t('actions.test')}
          </Button>
          <Button variant="secondary" size="md" onClick={() => setEditing(!editing)}>
            {editing ? t('actions.cancel') : t('actions.edit')}
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button variant="secondary" size="md" title={t('actions.exportTitle')}>
                {t('actions.export')}
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                collisionPadding={8}
                className="z-50 min-w-[160px] overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow)]"
              >
                {(['json', 'yaml'] as const).map((format) => (
                  <DropdownMenu.Item
                    key={format}
                    onSelect={() => handleExport(format)}
                    className="flex cursor-pointer select-none items-center rounded-[7px] px-2.5 py-2 text-[13px] text-[var(--text-2)] outline-none data-[highlighted]:bg-[var(--surface-2)] data-[highlighted]:text-[var(--text)]"
                  >
                    {t('actions.exportAs', { format: format.toUpperCase() })}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <Button variant="outlineDanger" size="md" onClick={handleDelete}>
            {t('actions.delete')}
          </Button>
        </div>
      }
    >
      <Dialog.Root open={!!deleteTarget} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <Dialog.Title className="mb-2 text-lg font-semibold text-[var(--text)]">
              {deleteTarget?.kind === 'tool' ? t('deleteDialog.titleTool') : t('deleteDialog.titleConnector')}
            </Dialog.Title>
            <Dialog.Description className="mb-5 text-sm text-[var(--text-3)]">
              {deleteTarget?.kind === 'tool' ? (
                t.rich('deleteDialog.bodyTool', { name: deleteTarget.name, b: strong })
              ) : (
                t.rich('deleteDialog.bodyConnector', { name: connector.name, b: strong })
              )}
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Dialog.Close className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))} disabled={deleting}>
                {t('deleteDialog.cancel')}
              </Dialog.Close>
              <Button variant="danger" size="md" onClick={confirmDelete} disabled={deleting}>
                {deleting ? t('deleteDialog.deleting') : t('deleteDialog.delete')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="space-y-6">
        {/* Connector identity header */}
        <div className="flex items-start gap-3.5 sm:items-center">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-[12px] bg-[var(--surface-2)] text-[15px] font-semibold text-[var(--text-2)]">
            {connectorInitials}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-lg font-semibold tracking-[-0.02em]">{connector.name}</span>
              <Badge tone="info">{connector.type}</Badge>
              <StatusPill
                tone={connector.isActive ? 'success' : 'neutral'}
                dot={connector.isActive ? 'var(--ok)' : 'var(--text-3)'}
              >
                {connector.isActive ? t('active') : t('inactive')}
              </StatusPill>
              <SetupStatusPill status={connector.setupStatus} />
              <AuthStatusPill connector={connector} />
            </div>
            <div className="mt-0.5 break-all font-mono text-[12.5px] text-[var(--text-3)]">
              {connector.baseUrl}
            </div>
          </div>
        </div>

        <SetupStatusBanner connector={connector} />
        <AuthStatusBanner connector={connector} />

        {msg && (
          <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            {msg}
            <button onClick={() => setMsg('')} className="ml-2 underline">
              {t('dismiss')}
            </button>
          </div>
        )}
        {testResult && (
          <div
            className="rounded-[10px] border p-3 text-sm"
            style={
              testResult.ok
                ? { background: 'var(--t-success-bg)', color: 'var(--t-success-fg)', borderColor: 'var(--t-success-bg)' }
                : testResult.kind === 'auth_failed'
                  ? { background: 'var(--t-warn-bg)', color: 'var(--t-warn-fg)', borderColor: 'var(--t-warn-bg)' }
                  : { background: 'var(--t-danger-bg)', color: 'var(--t-danger-fg)', borderColor: 'var(--t-danger-bg)' }
            }
          >
            {testResult.kind && testResult.kind !== 'ok' && (
              <span className="font-semibold mr-1">
                {testResult.kind === 'auth_failed' && t('test.authRejected')}
                {testResult.kind === 'not_found' && t('test.notFound')}
                {testResult.kind === 'unreachable' && t('test.unreachable')}
                {testResult.kind === 'error' && t('test.error')}
              </span>
            )}
            {testResult.message}
            {testResult.suggestedFix?.action === 'add-to-ssrf-allowlist' &&
              testResult.suggestedFix.hostname && (
                <div className="mt-2 pt-2 border-t border-current/20">
                  <a
                    href={testResult.suggestedFix.url || '/admin/settings#ssrf'}
                    className="underline text-sm font-medium hover:no-underline"
                  >
                    {t.rich('test.ssrf', { host: testResult.suggestedFix.hostname, code: (chunks) => <code>{chunks}</code> })}
                  </a>
                </div>
              )}
          </div>
        )}

        {/* ── Catalog updates ─────────────────────────────────────
            Tool definitions are copied into the connector at install, so a
            later catalog fix never reaches it on its own. The base URL is
            listed apart from the rest and ticked separately: correcting a
            wrong hostname and overwriting a deliberate one look identical
            from here, and getting it wrong takes every tool down at once. */}
        {catalogDiff && (
          <Card className="p-[22px]">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <h3 className="text-sm font-semibold">{t('catalog.title')}</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  {t.rich('catalog.installedFrom', { slug: catalogDiff.slug ?? '', code: (chunks) => <code>{chunks}</code> })}
                </p>
              </div>
              <Badge tone="neutral">{catalogDiff.catalogVersion?.slice(0, 7)}</Badge>
            </div>

            {/* What "Apply update" will do, tool by tool, before it does it.
                The user's own tools are listed too, so it is plain they stay. */}
            <ul className="text-sm space-y-2 mb-4">
              {!!catalogDiff.updated?.length && (
                <li>
                  <span className="font-medium">{t('catalog.updated')}</span>
                  {catalogDiff.updated.some((u) => u.kind === 'structural') && (
                    <span className="text-muted-foreground">{t('catalog.structural')}</span>
                  )}
                  :{' '}
                  <span className="text-muted-foreground break-words">
                    {catalogDiff.updated
                      .map((u) => (u.kind === 'structural' ? `${u.name} ●` : u.name))
                      .join(', ')}
                  </span>
                </li>
              )}
              {!!catalogDiff.added?.length && (
                <li>
                  <span className="font-medium">{t('catalog.added')}</span>:{' '}
                  <span className="text-muted-foreground break-words">{catalogDiff.added.join(', ')}</span>
                </li>
              )}
              {!!catalogDiff.removed?.length && (
                <li>
                  <span className="font-medium">{t('catalog.removed')}</span>
                  {t('catalog.removedNote')}:{' '}
                  <span className="text-muted-foreground break-words">{catalogDiff.removed.join(', ')}</span>
                </li>
              )}
              {catalogDiff.instructionsRefreshable && <li>{t('catalog.instructions')}</li>}
              {!!catalogDiff.custom?.length && (
                <li className="rounded-md bg-[var(--surface-2)] px-2 py-1.5">
                  <span className="font-medium">{t('catalog.custom')}</span>:{' '}
                  <span className="text-muted-foreground break-words">{catalogDiff.custom.join(', ')}</span>
                </li>
              )}
            </ul>

            {catalogDiff.baseUrl && (
              <div className="rounded-md border border-border p-3 mb-4">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={applyBaseUrl}
                    onChange={(e) => setApplyBaseUrl(e.target.checked)}
                  />
                  <span className="text-sm">
                    <span className="font-medium">{t('catalog.baseUrl')}</span>
                    <span className="block text-xs text-muted-foreground mt-1 font-mono break-all">
                      {catalogDiff.baseUrl.from} → {catalogDiff.baseUrl.to}
                    </span>
                    <span className="block text-xs text-muted-foreground mt-2">
                      {catalogDiff.baseUrl.provenance === 'user-edited'
                        ? t('catalog.provenanceUser')
                        : catalogDiff.baseUrl.provenance === 'catalog-moved'
                          ? t('catalog.provenanceMoved')
                          : t('catalog.provenanceUnknown')}
                    </span>
                  </span>
                </label>
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button onClick={handleApplyCatalog} disabled={applyingCatalog}>
                {applyingCatalog ? t('catalog.applying') : t('catalog.apply')}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('catalog.preserved')}
              </span>
            </div>
          </Card>
        )}

        {/* Connector Details */}
        <Card className="p-[22px]">
          <h3 className="text-sm font-semibold mb-4">{t('details.title')}</h3>
          {editing ? (
            <div className="space-y-4 max-w-md">
              <div>
                <label className="block text-sm font-medium mb-1">{t('details.name')}</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                />
              </div>
              {connector.type === 'EMAIL' ? (
                (connector.config as any)?.adapterSlug ? (
                  <p className="text-xs text-[var(--text-3)]">{te('catalogManaged')}</p>
                ) : (
                  <EmailSettingsFields
                    value={editEmail}
                    onChange={setEditEmail}
                    isCloud={deploymentMode === 'cloud'}
                    existing
                  />
                )
              ) : (
              <div>
                <label className="block text-sm font-medium mb-1">{t('details.baseUrl')}</label>
                <input
                  type="text"
                  value={editBaseUrl}
                  onChange={(e) => setEditBaseUrl(e.target.value)}
                  className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                />
              </div>
              )}
              {connector.type === 'REST' && (
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t('details.healthcheck')}
                    <span className="ml-2 text-xs text-[var(--text-3)] font-normal">
                      {t('details.healthcheckOptional')}
                    </span>
                  </label>
                  <input
                    type="text"
                    value={editHealthcheckPath}
                    onChange={(e) => setEditHealthcheckPath(e.target.value)}
                    placeholder="/health"
                    className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]"
                  />
                  <p className="text-xs text-[var(--text-3)] mt-1">
                    {t.rich('details.healthcheckHint', { code: (chunks) => <code>{chunks}</code> })}
                  </p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                />
                <label htmlFor="isActive" className="text-sm">{t('active')}</label>
              </div>
              {connector.type === 'DATABASE' && (
                <div>
                  <label className="block text-sm font-medium mb-2">{t('details.accessMode')}</label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setEditDbReadOnly(true)}
                      className={`px-3 py-1.5 rounded-[9px] text-sm font-medium border transition-all ${
                        editDbReadOnly
                          ? 'bg-[var(--brand)] text-[var(--primary-foreground)] border-[var(--brand)]'
                          : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                      }`}
                    >
                      {t('details.readOnly')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditDbReadOnly(false)}
                      className={`px-3 py-1.5 rounded-[9px] text-sm font-medium border transition-all ${
                        !editDbReadOnly
                          ? 'bg-[var(--brand)] text-[var(--primary-foreground)] border-[var(--brand)]'
                          : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                      }`}
                    >
                      {t('details.readWrite')}
                    </button>
                  </div>
                  <p className="text-xs text-[var(--text-3)] mt-1.5">
                    {editDbReadOnly
                      ? t('details.readOnlyHint')
                      : t('details.readWriteHint')}
                  </p>
                  <label htmlFor="deniedTables" className="block text-sm font-medium mt-4 mb-1">
                    {t('details.deniedTables')}
                  </label>
                  <input
                    id="deniedTables"
                    type="text"
                    value={editDbDeniedTables}
                    onChange={(e) => setEditDbDeniedTables(e.target.value)}
                    placeholder={t('details.deniedPlaceholder')}
                    className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                  />
                  <p className="text-xs text-[var(--text-3)] mt-1.5">
                    {t.rich('details.deniedHint', { code: (chunks) => <code>{chunks}</code> })}
                  </p>
                </div>
              )}
              {hasOData(connector) && (
                <div className="space-y-3">
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={editOdataSap}
                      onChange={(e) => setEditOdataSap(e.target.checked)}
                    />
                    <span>
                      SAP Gateway
                      <span className="block text-xs text-[var(--text-3)]">
                        {t('details.sapHint')}
                      </span>
                    </span>
                  </label>
                  {editOdataSap && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium mb-1">{t('details.sapClient')}</label>
                        <input
                          type="text"
                          value={editOdataSapClient}
                          onChange={(e) => setEditOdataSapClient(e.target.value)}
                          maxLength={3}
                          placeholder="100"
                          className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">{t('details.sapLanguage')}</label>
                        <input
                          type="text"
                          value={editOdataSapLanguage}
                          onChange={(e) => setEditOdataSapLanguage(e.target.value)}
                          maxLength={2}
                          placeholder="EN"
                          className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                        />
                      </div>
                    </div>
                  )}
                  <div>
                    <label htmlFor="odataServices" className="block text-sm font-medium mb-1">
                      {t('details.allowedServices')}
                    </label>
                    <textarea
                      id="odataServices"
                      rows={3}
                      value={editOdataServices}
                      onChange={(e) => setEditOdataServices(e.target.value)}
                      placeholder={'/sap/opu/odata/sap/API_*\n/sap/opu/odata/sap/C_TRIALBALANCE_CDS'}
                      className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                    />
                    <p className="text-xs text-[var(--text-3)] mt-1.5">
                      {t.rich('details.servicesHint', { code: (chunks) => <code>{chunks}</code> })}
                    </p>
                  </div>
                </div>
              )}
              {connector.type !== 'EMAIL' && (
              <>
              <div>
                <label className="block text-sm font-medium mb-1">{t('details.auth')}</label>
                <AppSelect
                  value={editAuthType}
                  onValueChange={(v) => { setEditAuthType(v); setEditAuthKey(''); setEditAuthValue(''); setEditWsPasswordType('PasswordText'); setEditLtPassword(''); resetOauth1Fields(); }}
                  className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                  options={[
                    { value: 'NONE', label: t('details.authNone') },
                    { value: 'API_KEY', label: t('details.apiKey') },
                    { value: 'BEARER_TOKEN', label: 'Bearer Token' },
                    { value: 'BASIC_AUTH', label: 'Basic Auth' },
                    // A SOAP header: implemented by the SOAP engine only.
                    ...(connector.type === 'SOAP' || connector.authType === 'WS_SECURITY'
                      ? [{ value: 'WS_SECURITY', label: 'WS-Security (UsernameToken)' }]
                      : []),
                    { value: 'OAUTH2', label: 'OAuth 2.0' },
                    // Signing is implemented by the REST engine only.
                    ...(connector.type === 'REST' || connector.type === 'ODATA' || connector.authType === 'OAUTH1'
                      ? [{ value: 'OAUTH1', label: 'OAuth 1.0a' }]
                      : []),
                    { value: 'LOGIN_TOKEN', label: t('details.authLoginToken') },
                  ]}
                />
              </div>
              {editAuthType === 'API_KEY' && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('details.headerName')}</label>
                    <input type="text" autoComplete="off" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editAuthKey} onChange={(e) => setEditAuthKey(e.target.value)} placeholder="X-API-Key" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    {editAuthKey && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(editAuthKey) && (
                      <p className="mt-1 text-[12px]" style={{ color: 'var(--danger)' }}>
                        {t('details.headerInvalid')}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('details.apiKey')}</label>
                    <input type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editAuthValue} onChange={(e) => setEditAuthValue(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                  </div>
                </div>
              )}
              {editAuthType === 'BEARER_TOKEN' && (
                <div>
                  <label className="block text-sm font-medium mb-1">Bearer Token</label>
                  <input type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editAuthValue} onChange={(e) => setEditAuthValue(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                </div>
              )}
              {editAuthType === 'BASIC_AUTH' && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('details.username')}</label>
                    <input type="text" autoComplete="off" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editAuthKey} onChange={(e) => setEditAuthKey(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('details.password')}</label>
                    <input type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editAuthValue} onChange={(e) => setEditAuthValue(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                  </div>
                </div>
              )}
              {editAuthType === 'WS_SECURITY' && (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('details.username')}</label>
                      <input type="text" autoComplete="off" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editAuthKey} onChange={(e) => setEditAuthKey(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('details.password')}</label>
                      <input type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editAuthValue} onChange={(e) => setEditAuthValue(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('details.wsPasswordType')}</label>
                    <AppSelect
                      value={editWsPasswordType}
                      onValueChange={setEditWsPasswordType}
                      className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                      options={[
                        { value: 'PasswordText', label: t('details.wsPasswordTextDefault') },
                        { value: 'PasswordDigest', label: 'PasswordDigest' },
                      ]}
                    />
                    <p className="mt-1 text-xs text-[var(--text-3)]">
                      {t('details.wsHint')}
                    </p>
                  </div>
                </div>
              )}
              {editAuthType === 'OAUTH2' && connector.type !== 'MCP' && (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="edit-oauth-grant" className="block text-sm font-medium mb-1">{t('oauth.grant')}</label>
                    <select
                      id="edit-oauth-grant"
                      value={editOauthGrant}
                      onChange={(e) => setEditOauthGrant(e.target.value as OAuthGrant)}
                      className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                    >
                      <option value="authorization_code">{t('oauth.grantCode')}</option>
                      <option value="client_credentials">{t('oauth.grantClient')}</option>
                      <option value="password">{t('oauth.grantPassword')}</option>
                    </select>
                    <p className="mt-1 text-xs text-[var(--text-3)]">
                      {editOauthGrant === 'authorization_code'
                        ? t('oauth.grantCodeHint')
                        : editOauthGrant === 'password'
                          ? t('oauth.grantPasswordHint')
                          : t('oauth.grantClientHint')}
                    </p>
                  </div>
                  {editOauthGrant === 'password' && (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="edit-oauth-username" className="block text-sm font-medium mb-1">{t('details.username')}</label>
                        <input id="edit-oauth-username" type="text" autoComplete="off" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editOauthUsername} onChange={(e) => setEditOauthUsername(e.target.value)} placeholder={oauthHasPasswordCreds ? t('details.keepCurrent') : ''} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                      </div>
                      <div>
                        <label htmlFor="edit-oauth-password" className="block text-sm font-medium mb-1">{t('details.password')}</label>
                        <input id="edit-oauth-password" type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editOauthPassword} onChange={(e) => setEditOauthPassword(e.target.value)} placeholder={oauthHasPasswordCreds ? t('details.keepCurrent') : ''} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium mb-1">Client ID</label>
                      <input type="text" autoComplete="off" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editAuthKey} onChange={(e) => setEditAuthKey(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Client Secret</label>
                      <input type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editAuthValue} onChange={(e) => setEditAuthValue(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                  </div>
                  {!isMachineGrant(editOauthGrant) && (
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('oauth.authorizationUrl')}</label>
                    <input type="text" value={editOauthAuthUrl} onChange={(e) => setEditOauthAuthUrl(e.target.value)} placeholder="https://provider.com/oauth/authorize" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)] font-mono text-[13px]" />
                  </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium mb-1">Token URL</label>
                    <input type="text" value={editOauthTokenUrl} onChange={(e) => setEditOauthTokenUrl(e.target.value)} placeholder="https://provider.com/oauth/token" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)] font-mono text-[13px]" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Scopes</label>
                    <input type="text" value={editOauthScopes} onChange={(e) => setEditOauthScopes(e.target.value)} placeholder={t('oauth.scopesPlaceholder')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)] font-mono text-[13px]" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('oauth.tokenAuth')}</label>
                    <select
                      value={editTokenAuthMethod}
                      onChange={(e) => setEditTokenAuthMethod(e.target.value)}
                      className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                    >
                      <option value="client_secret_post">{t('oauth.secretInBodyDefault')}</option>
                      <option value="client_secret_basic">{t('oauth.basicHeader')}</option>
                      {editTokenAuthMethod === 'private_key_jwt' && (
                        <option value="private_key_jwt">{t('oauth.privateKeyJwt')}</option>
                      )}
                    </select>
                    <p className="mt-1 text-xs text-[var(--text-3)]">
                      {editTokenAuthMethod === 'private_key_jwt'
                        ? t('oauth.privateKeyJwtHint')
                        : isMachineGrant(editOauthGrant)
                          ? t('oauth.machineHint')
                          : t('oauth.basicHint')}
                    </p>
                  </div>
                  {!isMachineGrant(editOauthGrant) && (
                  <div>
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input type="checkbox" checked={editPkce} onChange={(e) => setEditPkce(e.target.checked)} />
                      {t('oauth.pkce')}
                    </label>
                    <p className="mt-1 text-xs text-[var(--text-3)]">
                      {t('oauth.pkceHint')}
                    </p>
                  </div>
                  )}
                  <p className="text-xs text-[var(--text-3)]">
                    {t('oauth.keepNote')}
                  </p>
                </div>
              )}
              {editAuthType === 'OAUTH1' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="edit-oauth1-consumer-key" className="block text-sm font-medium mb-1">{t('oauth1.consumerKey')}</label>
                      <input id="edit-oauth1-consumer-key" type="text" autoComplete="off" value={editOauth1Key} onChange={(e) => setEditOauth1Key(e.target.value)} placeholder={connector.authType === 'OAUTH1' ? t('details.keepCurrent') : ''} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                    <div>
                      <label htmlFor="edit-oauth1-consumer-secret" className="block text-sm font-medium mb-1">{t('oauth1.consumerSecret')}</label>
                      <input id="edit-oauth1-consumer-secret" type="password" autoComplete="new-password" value={editOauth1Secret} onChange={(e) => setEditOauth1Secret(e.target.value)} placeholder={connector.authType === 'OAUTH1' ? t('details.keepCurrent') : ''} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="edit-oauth1-token" className="block text-sm font-medium mb-1">{t('oauth1.accessToken')}</label>
                      <input id="edit-oauth1-token" type="password" autoComplete="new-password" value={editOauth1Token} onChange={(e) => setEditOauth1Token(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                    <div>
                      <label htmlFor="edit-oauth1-token-secret" className="block text-sm font-medium mb-1">{t('oauth1.tokenSecret')}</label>
                      <input id="edit-oauth1-token-secret" type="password" autoComplete="new-password" value={editOauth1TokenSecret} onChange={(e) => setEditOauth1TokenSecret(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                  </div>
                  <p className="text-xs text-[var(--text-3)]">
                    {connector.authType === 'OAUTH1' ? t('oauth1.noteStored') : t('oauth1.noteNew')}
                  </p>
                </div>
              )}
              {editAuthType === 'LOGIN_TOKEN' && (
                <div className="space-y-3">
                  <div className="rounded-[9px] border border-[var(--t-info-fg)]/20 bg-[var(--t-info-bg)] p-3 text-xs text-[var(--t-info-fg)]">
                    {t('loginToken.intro')}
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('loginToken.url')}</label>
                    <input type="text" value={editLtLoginUrl} onChange={(e) => setEditLtLoginUrl(e.target.value)} placeholder="https://api.hrworks.de/v2/authentication" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('loginToken.username')}</label>
                      <input type="text" autoComplete="off" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editLtUsername} onChange={(e) => setEditLtUsername(e.target.value)} placeholder={t('loginToken.usernamePlaceholder')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('loginToken.password')}</label>
                      <input type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" value={editLtPassword} onChange={(e) => setEditLtPassword(e.target.value)} placeholder={t('details.keepCurrent')} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('loginToken.body')}</label>
                    <textarea value={editLtLoginBody} onChange={(e) => setEditLtLoginBody(e.target.value)} rows={4} className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] resize-y focus:outline-none focus:border-[var(--border-strong)]" />
                    <p className="text-xs text-[var(--text-3)] mt-1">
                      {t.rich('loginToken.bodyHint', {
                        user: '${username}',
                        pass: '${password}',
                        example: '{ "accessKey": "${username}", "secretAccessKey": "${password}" }',
                        code: (chunks) => <code>{chunks}</code>,
                      })}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('loginToken.method')}</label>
                      <AppSelect
                        value={editLtMethod}
                        onValueChange={setEditLtMethod}
                        className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                        options={[{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }]}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('loginToken.tokenPath')}</label>
                      <input type="text" value={editLtTokenPath} onChange={(e) => setEditLtTokenPath(e.target.value)} placeholder="token" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('loginToken.ttl')}</label>
                      <input type="number" value={editLtTtl} onChange={(e) => setEditLtTtl(e.target.value)} placeholder="900" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-[var(--text-2)]">
                    <input type="checkbox" checked={editLtRefreshOn401} onChange={(e) => setEditLtRefreshOn401(e.target.checked)} />
                    {t('loginToken.refreshOn401')}
                  </label>
                </div>
              )}
              {editAuthType !== 'NONE' && editAuthType !== 'OAUTH2' && editAuthType !== 'OAUTH1' && editAuthType !== 'LOGIN_TOKEN' && (
                <p className="text-xs text-[var(--text-3)]">
                  {t('details.keepCredentials')}
                </p>
              )}
              </>
              )}
              {connector.type !== 'DATABASE' && connector.type !== 'MCP' && connector.type !== 'EMAIL' && (
                <HeadersEditor rows={editHeaderRows} onChange={setEditHeaderRows} maskedKeys={connector.maskedHeaders} />
              )}
              <div>
                <label className="block text-sm font-medium mb-1">{t('details.instructions')}</label>
                <textarea
                  value={editInstructions}
                  onChange={(e) => setEditInstructions(e.target.value)}
                  placeholder={t('details.instructionsPlaceholder')}
                  rows={4}
                  className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] resize-y focus:outline-none focus:border-[var(--border-strong)]"
                />
                <p className="text-xs text-[var(--text-3)] mt-1">
                  {t('details.instructionsHint')}
                </p>
              </div>
              <Button variant="primary" size="lg" onClick={handleSave}>
                {t('details.save')}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              {/* Name, base URL, type and status are already on the page — the
                  identity block above states all four. This card carries only
                  what that block does not. */}
              <div>
                <p className="text-[var(--text-3)]">{t('details.authType')}</p>
                <p className="font-medium">{authTypeLabel(connector.authType)}</p>
              </div>
              {connector.type === 'EMAIL' && (
                <div className="col-span-2 min-w-0">
                  <p className="text-[var(--text-3)]">{te('imapHost')} / {te('smtpHost')}</p>
                  <p className="font-medium font-mono text-xs break-all">
                    {(() => {
                      const email = (connector.config as any)?.email ?? {};
                      const server = (host: unknown, port: unknown, security: unknown) =>
                        host ? `${host}:${port ?? ''}${security ? ` (${security})` : ''}` : null;
                      return te('summary', {
                        imap: server(email.imapHost, email.imapPort, email.imapSecurity) ?? connector.baseUrl,
                        smtp: server(email.smtpHost, email.smtpPort, email.smtpSecurity) ?? te('noSmtp'),
                      });
                    })()}
                  </p>
                </div>
              )}
              {connector.type === 'DATABASE' && (
                <div>
                  <p className="text-[var(--text-3)]">{t('details.accessMode')}</p>
                  <p className="font-medium">
                    {(connector.config as any)?.readOnly === false ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                        {t('details.readWrite')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                        {t('details.readOnly')}
                      </span>
                    )}
                  </p>
                </div>
              )}
              <div>
                <p className="text-[var(--text-3)]">{t('details.created')}</p>
                <p className="font-medium">{new Date(connector.createdAt).toLocaleDateString(locale)}</p>
              </div>
              {connector.specUrl && (
                <div className="col-span-2">
                  <p className="text-[var(--text-3)]">{t('details.specUrl')}</p>
                  <p className="font-medium font-mono text-xs break-all">{connector.specUrl}</p>
                </div>
              )}
              {connector.instructions && (
                <div className="col-span-2 min-w-0">
                  <p className="text-[var(--text-3)]">{t('details.instructions')}</p>
                  {/* Adapters author this as Markdown — tables of codes,
                      headings, fenced examples — and it was printed raw,
                      pipes and all. Same renderer the marketplace uses. */}
                  <div className="prose prose-sm max-w-none text-[13px] leading-relaxed dark:prose-invert prose-pre:overflow-x-auto prose-table:block prose-table:overflow-x-auto">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {connector.instructions}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Who signs in: one shared authorization, or each user (Enterprise) */}
        {connector.authType === 'OAUTH2' && (connector.type === 'MCP' || !isMachineGrant(loadedOauthGrant)) && (
          <UserCredentialsCard
            connectorId={connector.id}
            credentialScope={connector.credentialScope === 'USER' ? 'USER' : 'SHARED'}
            canManage={
              user?.role === 'ADMIN' || (user?.role !== 'VIEWER' && user?.id === connector.userId)
            }
            isMcp={connector.type === 'MCP'}
            onScopeChanged={fetchConnector}
          />
        )}

        {/* OAuth2 Authorization (shared sign-in; per-user sign-in lives in the card above) */}
        {connector.authType === 'OAUTH2' && (connector.type === 'MCP' || !isMachineGrant(loadedOauthGrant)) && (
          <Card className="p-[22px]">
            <h3 className="text-sm font-semibold mb-2">{t('oauthCard.title')}</h3>
            <p className="text-sm text-[var(--text-3)] mb-4">
              {connector.credentialScope === 'USER'
                ? t('oauthCard.perUser')
                : connector.type === 'MCP'
                ? t('oauthCard.mcp')
                : t('oauthCard.provider')}
            </p>
            <div className="flex gap-3 flex-wrap">
              {connector.credentialScope !== 'USER' && (
                <Button variant="primary" size="lg" onClick={handleOAuthAuthorize} disabled={authorizing}>
                  {authorizing
                    ? t('oauthCard.redirecting')
                    : connector.type === 'MCP'
                      ? t('oauthCard.authorizeRemote')
                      : t('oauthCard.authorizeProvider')}
                </Button>
              )}
              {connector.type === 'MCP' && (
                <Button variant="secondary" size="lg" onClick={handleDiscoverTools} disabled={discovering}>
                  {discovering ? t('oauthCard.discovering') : t('oauthCard.rediscover')}
                </Button>
              )}
            </div>
          </Card>
        )}

        {/* Shopee shop authorization (HMAC-signed, Shopee's own flow) */}
        {connector.authType === 'HMAC' && (connector.config as any)?.adapterSlug === 'shopee' && (
          <Card className="p-[22px]">
            <h3 className="text-sm font-semibold mb-2">{t('shopee.title')}</h3>
            <p className="text-sm text-[var(--text-3)] mb-4">
              {t('shopee.body')}
            </p>
            <Button variant="primary" size="lg" onClick={handleShopeeAuthorize} disabled={authorizing}>
              {authorizing ? t('oauthCard.redirecting') : t('oauthCard.authorizeProvider')}
            </Button>
          </Card>
        )}

        {/* Environment Variables */}
        <Card className="p-[22px]">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold">{t('env.title')}</h3>
              <p className="text-xs text-[var(--text-3)] mt-1">
                {t('env.hint', { variable: '{{VAR_NAME}}' })}
                <strong className="block mt-1">{t('env.overrideTitle')}</strong>{' '}
                {t.rich('env.overrideBody', {
                  example: 'sContextTokenP',
                  code: (chunks) => <code className="bg-[var(--surface-2)] px-1 rounded">{chunks}</code>,
                })}
              </p>
            </div>
            <Button variant="secondary" size="md" onClick={() => setShowEnvVars(!showEnvVars)}>
              {showEnvVars ? t('env.hide') : t('env.edit', { count: envVarEntries.length })}
            </Button>
          </div>

          {showEnvVars && (
            <div className="space-y-3">
              {envVarEntries.map((entry, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={entry.key}
                    // Renaming a stored secret would save the new name empty and
                    // drop the old one; remove it and add a new one instead.
                    readOnly={entry.masked}
                    aria-label={t('env.name')}
                    onChange={(e) => {
                      const updated = [...envVarEntries];
                      updated[i] = { ...entry, key: e.target.value };
                      setEnvVarEntries(updated);
                    }}
                    placeholder="VAR_NAME"
                    className={cn(
                      'w-1/3 border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]',
                      entry.masked && 'text-[var(--text-2)]',
                    )}
                  />
                  <input
                    type={entry.masked ? 'password' : 'text'}
                    autoComplete={entry.masked ? 'new-password' : 'off'}
                    value={entry.value}
                    aria-label={entry.key.trim() ? t('env.valueOf', { name: entry.key.trim() }) : t('env.valueOfNew')}
                    onChange={(e) => {
                      const updated = [...envVarEntries];
                      updated[i] = { ...entry, value: e.target.value };
                      setEnvVarEntries(updated);
                    }}
                    placeholder={entry.masked ? t('env.stored') : t('env.value')}
                    className="flex-1 border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]"
                  />
                  <button
                    onClick={() => setEnvVarEntries(envVarEntries.filter((_, j) => j !== i))}
                    className="text-[var(--danger)] px-2 py-1 text-sm hover:underline"
                  >
                    {t('env.remove')}
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => setEnvVarEntries([...envVarEntries, { key: '', value: '' }])}
                >
                  {t('env.add')}
                </Button>
                <Button variant="primary" size="md" onClick={handleSaveEnvVars} disabled={savingEnvVars}>
                  {savingEnvVars ? t('env.saving') : t('env.save')}
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* Tools Section */}
        <Card className="p-[22px]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <h3 className="text-sm font-semibold">
              {tt('title', { count: toolList.length })}
            </h3>
            <div className="flex gap-2 flex-wrap">
              {/* An email connector's tools are its built-ins: nothing to import. */}
              {connector.type !== 'EMAIL' && (
                <Button variant="secondary" size="md" onClick={() => setShowImport(!showImport)}>
                  {showImport ? tt('cancelImport') : tt('importTools')}
                </Button>
              )}
              {(connector.type === 'REST' || connector.type === 'GRAPHQL' || connector.type === 'SOAP') && (
                <Button variant="secondary" size="md" onClick={handleImportSpec}>
                  {tt('autoImport')}
                </Button>
              )}
              {connector.type === 'MCP' && (
                <Button
                  variant="secondary"
                  size="md"
                  onClick={handleDiscoverTools}
                  disabled={discovering}
                  className="border-[var(--t-purple-fg)] text-[var(--t-purple-fg)] hover:bg-[var(--t-purple-bg)] hover:text-[var(--t-purple-fg)]"
                >
                  {discovering ? tt('discovering') : tt('discover')}
                </Button>
              )}
              <Button variant="primary" size="md" onClick={() => setShowNewTool(!showNewTool)}>
                {showNewTool ? tt('cancel') : tt('addTool')}
              </Button>
            </div>
          </div>

          {/* Import Panel */}
          {showImport && (
            <div className="border border-[var(--border)] rounded-[14px] bg-[var(--surface-2)] p-4 mb-4 space-y-3">
              <h4 className="text-sm font-semibold">{tt('import.title')}</h4>
              <div className="flex gap-2 flex-wrap">
                {IMPORT_SOURCES.filter((src) => src.id !== 'odata' || hasOData(connector)).map((src) => (
                  <button
                    key={src.id}
                    onClick={() => { setImportSource(src.id); setImportContent(''); setImportUrl(''); setHarFileName(''); setHarError(''); }}
                    className={`px-3 py-1.5 rounded-[8px] text-xs border transition-colors ${
                      importSource === src.id
                        ? 'border-[var(--brand)] bg-[var(--brand-tint)] text-[var(--brand)] font-semibold'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:border-[var(--brand)]'
                    }`}
                  >
                    {tt(`import.sources.${src.id}`)}
                  </button>
                ))}
              </div>

              {importSource === 'odata' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">{tt('import.servicePath')}</label>
                    <input
                      type="text"
                      value={importUrl}
                      onChange={(e) => setImportUrl(e.target.value)}
                      placeholder={
                        (connector.config as any)?.odata?.sap || (connector.config as any)?.odata?.sapClient
                          ? '/sap/opu/odata/sap/API_BUSINESS_PARTNER'
                          : tt('import.servicePathPlaceholder')
                      }
                      className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                    />
                    <p className="text-[11.5px] text-[var(--text-3)] mt-1">
                      {tt('import.servicePathHint')}
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">{tt('import.entitySets')}</label>
                    <input
                      type="text"
                      value={importEntitySets}
                      onChange={(e) => setImportEntitySets(e.target.value)}
                      placeholder={tt('import.entitySetsPlaceholder')}
                      className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm font-mono bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                    />
                  </div>
                </div>
              )}

              {importSource !== 'curl' && importSource !== 'json' && importSource !== 'odata' && importSource !== 'har' && (
                <div>
                  <label className="block text-xs font-medium mb-1">{tt('import.url')}</label>
                  <input
                    type="text"
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                  />
                </div>
              )}

              {importSource === 'har' ? (
                <div>
                  <label className="block text-xs font-medium mb-1">{tt('import.harFile')}</label>
                  <input
                    type="file"
                    accept=".har,application/json"
                    onChange={(e) => handleHarFileChange(e.target.files?.[0] ?? null)}
                    className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                  />
                  <p className="text-[11.5px] text-[var(--text-3)] mt-1">
                    {tt('import.harHint')}
                  </p>
                  {harFileName && !harError && (
                    <p className="text-[11.5px] text-[var(--text-3)] mt-1">
                      {importContent ? tt('import.harReady', { name: harFileName }) : tt('import.harReading', { name: harFileName })}
                    </p>
                  )}
                  {harError && <p className="text-[11.5px] text-[var(--danger)] mt-1">{harError}</p>}
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {importSource === 'curl' ? tt('import.contentCurl') : importSource === 'json' ? tt('import.contentJson') : tt('import.contentOther')}
                  </label>
                  <textarea
                    value={importContent}
                    onChange={(e) => setImportContent(e.target.value)}
                    rows={6}
                    placeholder={IMPORT_SOURCES.find((s) => s.id === importSource)?.placeholder ?? tt(`import.placeholders.${importSource}`)}
                    className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]"
                  />
                </div>
              )}

              <Button
                variant="primary"
                size="lg"
                onClick={handleImportTools}
                disabled={importing || (importSource !== 'odata' && !importContent && !importUrl)}
              >
                {importing ? tt('import.importing') : tt('import.import')}
              </Button>
            </div>
          )}

          {/* New Tool Editor */}
          {showNewTool && (
            <div className="mb-4">
              <ToolEditor
                connectorType={connector.type}
                envVarKeys={new Set(envVarEntries.map((e) => e.key.trim()).filter(Boolean))}
                onSave={handleCreateTool}
                onCancel={() => setShowNewTool(false)}
                saving={savingTool}
              />
            </div>
          )}

          {toolList.length === 0 ? (
            <p className="text-sm text-[var(--text-3)] py-4 text-center">
              {tt('empty')}
            </p>
          ) : (
            <div className="space-y-3">
              {toolList.map((tool) => (
                <div key={tool.id}>
                  {editingToolId === tool.id ? (
                    <ToolEditor
                      connectorType={connector.type}
                      envVarKeys={new Set(envVarEntries.map((e) => e.key.trim()).filter(Boolean))}
                      connectorId={id}
                      toolId={tool.id}
                      existingTool={{
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters || { type: 'object', properties: {} },
                        endpointMapping: tool.endpointMapping || { method: 'GET', path: '/' },
                        // Without this the editor starts from an empty mapping
                        // and wipes cacheTtl / followUp / transform on save.
                        responseMapping: tool.responseMapping || undefined,
                      }}
                      onSave={(data) => handleUpdateTool(tool.id, data)}
                      onCancel={() => setEditingToolId(null)}
                      saving={savingTool}
                    />
                  ) : (
                    <div className="border border-[var(--border)] bg-[var(--surface-2)] rounded-[12px] p-3 hover:border-[var(--border-strong)] transition-colors">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm font-mono break-all">{tool.name}</span>
                            {tool.endpointMapping?.method && (
                              <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold flex-shrink-0', monoMethodTone(tool.endpointMapping.method))}>
                                {tool.endpointMapping.method}
                              </span>
                            )}
                            <Badge tone={tool.isEnabled ? 'success' : 'neutral'} className="flex-shrink-0">
                              {tool.isEnabled ? tt('card.enabled') : tt('card.disabled')}
                            </Badge>
                            {tool.deprecatedAt && (
                              <Badge
                                tone="warn"
                                className="flex-shrink-0"
                                title={tt('card.deprecatedTitle', { date: new Date(tool.deprecatedAt).toLocaleString(locale) })}
                              >
                                {tt('card.deprecated')}
                              </Badge>
                            )}
                            {tool.responseMapping?.transform && (
                              <Badge
                                tone="info"
                                className="flex-shrink-0"
                                title={tt('card.mappedTitle')}
                              >
                                {tt('card.mapped')}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-[var(--text-3)] mt-0.5 line-clamp-2 sm:truncate">
                            {tool.description}
                          </p>
                          {/* Show mapping summary */}
                          <div className="flex gap-3 mt-1.5 text-[10px] text-[var(--text-3)] flex-wrap">
                            {tool.endpointMapping?.path && (
                              <ToolPathSummary path={tool.endpointMapping.path} />
                            )}
                            {tool.parameters?.properties && (() => {
                              const allParams = Object.keys(tool.parameters.properties);
                              const envKeys = new Set(envVarEntries.map((e) => e.key.trim()).filter(Boolean));
                              const envCovered = allParams.filter((k) => envKeys.has(k)).length;
                              return (
                                <span>
                                  {tt('card.params', { count: allParams.length })}{envCovered > 0 && (
                                    <span className="text-[var(--brand)]" title={tt('card.paramsFromEnvTitle', { count: envCovered })}>{tt('card.paramsFromEnv', { count: envCovered })}</span>
                                  )}
                                </span>
                              );
                            })()}
                            {tool.endpointMapping?.queryParams && (
                              <span>{tt('card.query', { count: Object.keys(tool.endpointMapping.queryParams).length })}</span>
                            )}
                            {tool.endpointMapping?.bodyMapping && (
                              <span>{tt('card.body', { count: Object.keys(tool.endpointMapping.bodyMapping).length })}</span>
                            )}
                            {tool.endpointMapping?.headers && (
                              <span>{tt('card.headers', { count: Object.keys(tool.endpointMapping.headers).length })}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2 flex-wrap sm:flex-nowrap sm:ml-4 flex-shrink-0">
                          <button
                            onClick={() => {
                              if (testingToolId === tool.id) {
                                setTestingToolId(null);
                              } else {
                                setTestingToolId(tool.id);
                                setToolTestResult(null);
                                // Pre-fill params from tool's parameter schema,
                                // excluding params covered by environment variables
                                const props = tool.parameters?.properties || {};
                                const envKeys = new Set(envVarEntries.map((e) => e.key.trim()).filter(Boolean));
                                const example: Record<string, unknown> = {};
                                for (const [k, v] of Object.entries(props)) {
                                  if (envKeys.has(k)) continue; // skip env-var-covered params
                                  const prop = v as any;
                                  if (prop.type === 'string') example[k] = '';
                                  else if (prop.type === 'number' || prop.type === 'integer') example[k] = 0;
                                  else if (prop.type === 'boolean') example[k] = false;
                                }
                                setTestParams(JSON.stringify(example, null, 2));
                              }
                            }}
                            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--brand)] bg-[var(--brand-tint)] text-[var(--brand)] px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                          >
                            {testingToolId === tool.id ? tt('card.close') : tt('card.test')}
                          </button>
                          <button
                            onClick={() => {
                              setEditingToolId(tool.id);
                              setShowNewTool(false);
                            }}
                            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] px-2.5 py-1 text-xs font-medium transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                          >
                            {tt('card.edit')}
                          </button>
                          <button
                            onClick={() =>
                              setHintsToolId(hintsToolId === tool.id ? null : tool.id)
                            }
                            title={tt('card.hintsTitle')}
                            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] px-2.5 py-1 text-xs font-medium transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                          >
                            {hintsToolId === tool.id ? tt('card.closeHints') : tt('card.hints')}
                          </button>
                          <button
                            onClick={() => handleToggleTool(tool.id, tool.isEnabled)}
                            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] px-2.5 py-1 text-xs font-medium transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                          >
                            {tool.isEnabled ? tt('card.disable') : tt('card.enable')}
                          </button>
                          {proxyAvailable && (
                            <label
                              className="flex items-center gap-1 rounded-[7px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] px-2.5 py-1 text-xs cursor-pointer transition-colors hover:border-[var(--border-strong)]"
                              title={tt('card.proxyTitle')}
                            >
                              <input
                                type="checkbox"
                                checked={!!tool.useProxy}
                                onChange={() => handleToggleProxy(tool.id, !!tool.useProxy)}
                                className="accent-[var(--brand)]"
                              />
                              {tt('card.proxy')}
                            </label>
                          )}
                          <button
                            onClick={() => handleDeleteTool(tool.id, tool.name)}
                            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--danger)] bg-transparent text-[var(--danger)] px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--t-danger-bg)]"
                          >
                            {tt('card.delete')}
                          </button>
                        </div>
                      </div>

                      {/* MCP annotations (hints) */}
                      {hintsToolId === tool.id && (
                        <div className="mt-3 pt-3 border-t border-[var(--border)]">
                          <ToolAnnotationsEditor
                            connectorId={id}
                            toolId={tool.id}
                          />
                        </div>
                      )}

                      {/* Tool Playground */}
                      {testingToolId === tool.id && (() => {
                        const envKeys = new Set(envVarEntries.map((e) => e.key.trim()).filter(Boolean));
                        const allParamNames = Object.keys(tool.parameters?.properties || {});
                        const envCoveredParams = allParamNames.filter((k) => envKeys.has(k));
                        return (
                        <div className="mt-3 pt-3 border-t border-[var(--border)]">
                          {envCoveredParams.length > 0 && (
                            <div className="flex items-start gap-2 px-3 py-2 mb-3 rounded-[9px] bg-[var(--brand-tint)] border border-[var(--brand)] text-xs text-[var(--text-2)]">
                              <span className="text-sm leading-none mt-0.5">&#9889;</span>
                              <span>
                                <strong>{tt('playground.autoFilled')}</strong>{' '}
                                {envCoveredParams.map((p) => (
                                  <code key={p} className="mx-0.5 px-1 py-0.5 rounded bg-[var(--surface-2)] font-mono text-[11px]">{p}</code>
                                ))}
                                <span className="text-[var(--text-3)]">{tt('playground.autoFilledNote')}</span>
                              </span>
                            </div>
                          )}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium mb-1">{tt('playground.input')}</label>
                              <textarea
                                value={testParams}
                                onChange={(e) => setTestParams(e.target.value)}
                                rows={5}
                                className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-xs bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]"
                                placeholder='{ "param": "value" }'
                              />
                              <Button variant="primary" size="sm" className="mt-2" onClick={() => handleTestTool(tool.id)} disabled={testRunning}>
                                {testRunning ? tt('playground.running') : tt('playground.runTest')}
                              </Button>
                            </div>
                            <div>
                              <label className="block text-xs font-medium mb-1">
                                {tt('playground.response')}
                                {toolTestResult && (
                                  <span className={`ml-2 ${toolTestResult.ok ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}`}>
                                    {tt(toolTestResult.ok ? 'playground.success' : 'playground.error', { ms: toolTestResult.durationMs })}
                                  </span>
                                )}
                              </label>
                              {/* Raw vs mapped, so the effect of a response
                                  mapping (and its token saving) is visible
                                  right where the tool is exercised. */}
                              {toolTestResult?.ok && toolTestResult.mappingApplied === true && (
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  {(['mapped', 'raw'] as const).map((view) => (
                                    <button
                                      key={view}
                                      onClick={() => setTestResponseView(view)}
                                      className={cn(
                                        'rounded-[7px] border px-2 py-0.5 text-[11px] font-medium transition-colors',
                                        testResponseView === view
                                          ? 'border-[var(--brand)] bg-[var(--brand-tint)] text-[var(--brand)]'
                                          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)]',
                                      )}
                                    >
                                      {view === 'mapped' ? tt('playground.viewMapped') : tt('playground.viewRaw')}
                                    </button>
                                  ))}
                                  <span className="text-[11px] text-[var(--text-3)]">
                                    {formatBytes(Number(toolTestResult.rawBytes) || 0)} →{' '}
                                    {formatBytes(Number(toolTestResult.mappedBytes) || 0)} (
                                    {Number(toolTestResult.bytesSavedPct) > 0 ? '−' : ''}
                                    {Math.abs(Number(toolTestResult.bytesSavedPct) || 0)}%)
                                  </span>
                                </div>
                              )}
                              {toolTestResult?.ok && typeof toolTestResult.mappingError === 'string' && (
                                <div className="mb-2 rounded-[9px] border border-[var(--t-warn-bg)] bg-[var(--t-warn-bg)] px-3 py-2 text-xs text-[var(--t-warn-fg)]">
                                  {tt('playground.mappingFailed', { error: String(toolTestResult.mappingError) })}
                                </div>
                              )}
                              {toolTestResult && typeof toolTestResult.note === 'string' && (
                                <div className="mt-2 rounded-[9px] border border-[var(--t-info-fg)]/20 bg-[var(--t-info-bg)] px-3 py-2 text-xs text-[var(--t-info-fg)]">
                                  {toolTestResult.note}
                                </div>
                              )}
                              {toolTestResult && !toolTestResult.ok && typeof toolTestResult.hint === 'string' && (
                                <div
                                  className="mb-2 p-2 rounded-[9px] text-xs border"
                                  style={
                                    toolTestResult.kind === 'auth_failed'
                                      ? { background: 'var(--t-warn-bg)', color: 'var(--t-warn-fg)', borderColor: 'var(--t-warn-bg)' }
                                      : { background: 'var(--t-danger-bg)', color: 'var(--t-danger-fg)', borderColor: 'var(--t-danger-bg)' }
                                  }
                                >
                                  <span className="font-semibold mr-1">
                                    {toolTestResult.kind === 'auth_failed' && tt('playground.kind.authFailed')}
                                    {toolTestResult.kind === 'bad_request' && tt('playground.kind.badRequest')}
                                    {toolTestResult.kind === 'not_found' && tt('playground.kind.notFound')}
                                    {toolTestResult.kind === 'rate_limited' && tt('playground.kind.rateLimited')}
                                    {toolTestResult.kind === 'upstream_error' && tt('playground.kind.upstreamError')}
                                    {toolTestResult.kind === 'unreachable' && tt('playground.kind.unreachable')}
                                    {toolTestResult.kind === 'error' && tt('playground.kind.error')}
                                  </span>
                                  {String(toolTestResult.hint)}
                                </div>
                              )}
                              <pre className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-xs bg-[var(--surface-2)] font-mono overflow-auto max-h-40 min-h-[8rem]">
                                {toolTestResult
                                  ? toolTestResult.ok
                                    ? JSON.stringify(
                                        toolTestResult.mappingApplied === true &&
                                          testResponseView === 'mapped'
                                          ? toolTestResult.mapped
                                          : toolTestResult.result,
                                        null,
                                        2,
                                      )
                                    : JSON.stringify(toolTestResult, null, 2)
                                  : tt('playground.empty')}
                              </pre>
                            </div>
                          </div>
                        </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Danger zone */}
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border p-[18px]"
          style={{ borderColor: 'var(--t-danger-bg)', background: 'color-mix(in srgb, var(--danger) 5%, transparent)' }}
        >
          <div>
            <div className="text-[13.5px] font-semibold text-[var(--danger)]">{t('danger.title')}</div>
            <div className="text-[12.5px] text-[var(--text-3)]">
              {t('danger.body')}
            </div>
          </div>
          <button
            onClick={handleDelete}
            className="inline-flex h-9 items-center rounded-[9px] border border-[var(--danger)] bg-transparent px-3.5 text-[13px] font-semibold text-[var(--danger)] transition-colors hover:bg-[var(--t-danger-bg)]"
          >
            {t('danger.delete')}
          </button>
        </div>
      </div>

      {/* MCP Server Assignment Modal — shown after tools are added and connector is unassigned */}
      {showMcpAssign && connector && token && (
        <McpAssignModal
          connectorId={id}
          connectorName={connector.name}
          token={token}
          onDone={() => setShowMcpAssign(false)}
          onClose={() => setShowMcpAssign(false)}
        />
      )}
    </AppShell>
  );
}

/**
 * The select's value for a stored token-endpoint auth method. Older rows and
 * catalog adapters store the short aliases (DATEV's `basic`); shown as-is they
 * matched no option and saving the form turned them back into the default.
 */
function normalizeTokenAuthMethod(method: string | undefined): string {
  if (method === 'basic') return 'client_secret_basic';
  if (!method || method === 'post') return 'client_secret_post';
  return method;
}

/**
 * The endpoint line on a tool card. For REST it is a short path; for database
 * tools it is the whole SQL statement, which printed in full, wrapped mid-word
 * at `break-all`, made one card as tall as the screen (the SAP HANA tools run
 * to 40 lines). Long ones show their first line and open on request.
 */
function ToolPathSummary({ path }: { path: string }) {
  const tt = useTranslations('connectorTools');
  const [open, setOpen] = useState(false);
  const oneLine = path.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 120 && !path.includes('\n')) {
    return <span className="font-mono break-all">{path}</span>;
  }
  return (
    <span className="flex min-w-0 max-w-full basis-full flex-col gap-1">
      {open ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[var(--surface)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-2)]">
          {path.trim()}
        </pre>
      ) : (
        <span className="truncate font-mono" title={oneLine}>
          {oneLine}
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="self-start text-[var(--brand)] hover:underline"
        aria-expanded={open}
      >
        {/^\s*(select|with)\b/i.test(path)
          ? tt(open ? 'card.hideSql' : 'card.showSql')
          : tt(open ? 'card.hidePath' : 'card.showPath')}
      </button>
    </span>
  );
}
