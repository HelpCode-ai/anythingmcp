import { HttpException, UnprocessableEntityException } from '@nestjs/common';

/**
 * Turns a failure to read a user-supplied API specification into a 422 the
 * dashboard can show, instead of a 500.
 *
 * The document lives on the customer's side: a WSDL URL that answers with a
 * login page, an OpenAPI file that is not valid, a GraphQL endpoint that
 * refuses introspection. None of that is a bug in this server, and as a 500 it
 * told the user nothing while being reported to Sentry as one
 * (ANYTHINGMCP-CLOUD-BACKEND-3: "Root element of WSDL was <html>").
 */
export async function readRemoteSpec<T>(kind: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof HttpException) throw err;
    throw new UnprocessableEntityException(
      `Could not read the ${kind}: ${describeSpecError(err)}`,
      { cause: err },
    );
  }
}

const MAX_REASON = 300;

/** A short, actionable reason. Never the document itself, never a URL. */
export function describeSpecError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/Root element of WSDL was <html>/i.test(raw)) {
    return (
      'the URL returned an HTML page instead of a WSDL document. This is usually a ' +
      'login or error page: check the address (it often ends in ?wsdl) and whether ' +
      'the server needs authentication to serve it.'
    );
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(raw)) return 'the host name could not be resolved.';
  if (/ECONNREFUSED/.test(raw)) return 'the server refused the connection.';
  if (/ETIMEDOUT|timeout/i.test(raw)) return 'the server did not answer in time.';
  if (/certificate|SSL|TLS/i.test(raw)) return `the TLS connection failed (${firstLine(raw)}).`;

  return firstLine(raw) || 'unknown error.';
}

function firstLine(text: string): string {
  // Strip URLs: they can carry credentials in their query string.
  const line = text.split('\n')[0].replace(/\b\w+:\/\/\S+/g, '<url>').trim();
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON)}…` : line;
}
