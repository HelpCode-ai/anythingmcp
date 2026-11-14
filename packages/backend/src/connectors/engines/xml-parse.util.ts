import { XMLParser } from 'fast-xml-parser';

/**
 * The one parser every XML answer goes through: a tool's response in the REST
 * engine (`parseXmlBody`) and, with `loginResponseFormat: "xml"`, a LOGIN_TOKEN
 * login answer. Attributes are hoisted next to child elements without a
 * prefix, namespace prefixes are dropped and values stay strings, so a
 * `tokenJsonPath` or a JMESPath mapping addresses the document like JSON:
 * `<auth_response status="OK"><token>abc</token></auth_response>` reads as
 * `{ auth_response: { status: "OK", token: "abc" } }`.
 */
export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

/** Whether a Content-Type header value declares XML (`text/xml`, `application/xml`, `…+xml`). */
export function isXmlContentType(value: unknown): boolean {
  return /(^|[/+])xml([;\s]|$)/.test(String(value ?? '').toLowerCase());
}
