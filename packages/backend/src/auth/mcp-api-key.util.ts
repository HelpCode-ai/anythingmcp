/**
 * The per-user MCP API key (`mcp_…`) a request carries, if any.
 *
 * `X-API-Key` is the documented header. `Authorization: Bearer mcp_…` is
 * accepted as well, because some clients can only send a bearer token: the
 * MCP connector of Anthropic's Messages API (`authorization_token`), the
 * OpenAI Responses API `mcp` tool (`authorization`) and several automation
 * tools. The prefix keeps the two apart: OAuth access tokens are JWTs and
 * never start with `mcp_`.
 *
 * A self-hosted operator's static `MCP_BEARER_TOKEN` is not an API key, even
 * if it happens to start with `mcp_`; it stays with the static-token check.
 */
export function presentedMcpApiKey(
  headers: Record<string, string | string[] | undefined>,
  staticBearerToken?: string,
): string | undefined {
  const xApiKey = headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.startsWith('mcp_')) {
    return xApiKey;
  }

  const authorization = headers['authorization'];
  if (typeof authorization === 'string' && /^bearer /i.test(authorization)) {
    const token = authorization.slice('bearer '.length).trim();
    if (token.startsWith('mcp_') && token !== staticBearerToken) {
      return token;
    }
  }

  return undefined;
}
