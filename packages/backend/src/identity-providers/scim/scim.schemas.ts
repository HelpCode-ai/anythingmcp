/**
 * Static SCIM 2.0 discovery documents (RFC 7643 §5–§7).
 *
 * Kept minimal on purpose: they describe only the attributes this server
 * honours. Entra reads /Schemas when the provisioning configuration is saved
 * and surfaces whatever it finds as mappable target attributes — advertising
 * `title` or `department` here would invite mappings we silently drop.
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_ENTERPRISE_USER_SCHEMA =
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

export function serviceProviderConfig(baseUrl: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://github.com/HelpCode-ai/anythingmcp/blob/main/docs/sso.md',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description:
          'Long-lived bearer token issued from Settings → Single sign-on → Provisioning (SCIM).',
        specUri: 'https://www.rfc-editor.org/info/rfc6750',
        primary: true,
      },
    ],
    meta: {
      resourceType: 'ServiceProviderConfig',
      location: `${baseUrl}/ServiceProviderConfig`,
    },
  };
}

export function resourceTypes(baseUrl: string) {
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      description: 'A member of the workspace',
      schema: SCIM_USER_SCHEMA,
      schemaExtensions: [{ schema: SCIM_ENTERPRISE_USER_SCHEMA, required: false }],
      meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/User` },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      description: 'A directory group whose membership is mapped to roles',
      schema: SCIM_GROUP_SCHEMA,
      meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/Group` },
    },
  ];
}

const attr = (
  name: string,
  type: string,
  extra: Record<string, unknown> = {},
) => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

export function schemas(baseUrl: string) {
  return [
    {
      id: SCIM_USER_SCHEMA,
      name: 'User',
      description: 'User Account',
      attributes: [
        attr('userName', 'string', { required: true, uniqueness: 'server' }),
        attr('externalId', 'string', { required: true, mutability: 'immutable', caseExact: true }),
        attr('active', 'boolean'),
        attr('displayName', 'string'),
        {
          ...attr('name', 'complex'),
          subAttributes: [
            attr('formatted', 'string'),
            attr('givenName', 'string'),
            attr('familyName', 'string'),
          ],
        },
        {
          ...attr('emails', 'complex', { multiValued: true }),
          subAttributes: [
            attr('value', 'string'),
            attr('type', 'string'),
            attr('primary', 'boolean'),
          ],
        },
        {
          ...attr('groups', 'complex', { multiValued: true, mutability: 'readOnly' }),
          subAttributes: [attr('value', 'string'), attr('display', 'string')],
        },
      ],
      meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${SCIM_USER_SCHEMA}` },
    },
    {
      id: SCIM_GROUP_SCHEMA,
      name: 'Group',
      description: 'Group',
      attributes: [
        attr('displayName', 'string', { required: true }),
        attr('externalId', 'string', { mutability: 'immutable', caseExact: true }),
        {
          ...attr('members', 'complex', { multiValued: true }),
          subAttributes: [attr('value', 'string'), attr('display', 'string')],
        },
      ],
      meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${SCIM_GROUP_SCHEMA}` },
    },
  ];
}
