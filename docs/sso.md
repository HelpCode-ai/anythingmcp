# Single Sign-On (Microsoft Entra ID, Google, Okta, Auth0, OIDC)

Let members sign in with your organization's identity provider instead of a
password, and keep their AnythingMCP roles in step with your directory groups.

> **Self-hosted only.** SSO is not available on AnythingMCP Cloud
> (`cloud.anythingmcp.com`) and every route below answers **404** there. The
> feature assumes the workspace owns its own directory, tenant and operator;
> in a shared, multi-tenant deployment it would let any customer point a
> workspace at an arbitrary directory and provision accounts from it. Run your
> own instance (Docker) to use it — see [deployment.md](deployment.md).

---

## What you get

| | |
|---|---|
| **Sign-in** | Members authenticate at your IdP; no AnythingMCP password |
| **Account linking** | An existing password account can attach an IdP identity |
| **Role sync** | Directory groups (or app roles) grant AnythingMCP roles at every sign-in |
| **Require SSO** | Turn off password sign-in for the whole workspace |
| **Recovery codes** | Single-use break-glass credentials for when the IdP is unreachable |

Supported types: **Entra ID**, **Google**, **GitHub**, **Okta**, **Auth0**, and
any spec-compliant **OIDC** provider.

---

## 1. Register the application at your provider

The steps below are for **Microsoft Entra ID**; other providers follow the same
shape.

1. **Entra admin center → App registrations → New registration.**
   - Supported account types: *Accounts in this organizational directory only*
     unless you deliberately want guests.
   - Redirect URI (**Web**): `https://<your-anythingmcp-host>/auth/sso/callback`
2. Note the **Application (client) ID** and the **Directory (tenant) ID** from
   the Overview page.
3. **Certificates & secrets → New client secret.** Copy the *Value* (not the
   Secret ID) — it is shown only once. Note the expiry date; Microsoft caps
   secrets at 24 months.
4. **Token configuration → Add groups claim** if you want role sync:
   - Select **Groups assigned to the application**. This emits only the groups
     a user belongs to *that are also assigned to this app*, which keeps the
     token small and avoids the overage described below.
   - Format: **Group ID**.
5. **Enterprise applications → your app → Users and groups → Add user/group.**
   Assign the groups you intend to map. Nothing appears in the token until a
   group is assigned here.

> **Only Security and Microsoft 365 groups can be assigned to an application.**
> Mail-enabled *distribution lists* cannot, so a directory that organises people
> into distribution lists needs security groups adding before role sync can use
> them.

> **Group assignment does not cascade to nested groups.** A user in a child
> group of an assigned parent will not receive the claim.

## 2. Configure the provider in AnythingMCP

**Settings → Single sign-on → Add provider** (workspace ADMIN only).

| Field | Value |
|---|---|
| Provider | Microsoft Entra ID |
| Display name | Shown on the sign-in button, e.g. "Sign in with Microsoft" |
| Directory (tenant) ID | The tenant GUID. A domain like `contoso.onmicrosoft.com` is **not** accepted |
| Client ID | Application (client) ID |
| Client secret | The secret *Value* |
| Secret expires on | Optional, but recording it turns a silent expiry into a warning |
| Create accounts on first sign-in | **Off by default** — see below |
| Active | Leave on |

Use **Test** to fetch the provider's discovery document and confirm the issuer
matches before anyone tries to sign in.

### Just-in-time provisioning

`Create accounts on first sign-in` is **off** by default and should stay off
unless you mean it: with it on, anyone who can authenticate at your directory —
including B2B guests invited for unrelated reasons — joins the workspace as a
Viewer. With it off, a user must already exist in AnythingMCP.

### The sign-in link

Providers are **not** listed on a shared sign-in page in cloud-style
deployments, so each provider has an opaque entry point:

```
https://<your-host>/sso/<initiateId>
```

The Single sign-on settings page shows it with a **Copy** button. Distribute it
to members; it is the entry point for this workspace. The id is deliberately
opaque rather than a readable slug — a guessable one would allow workspace
enumeration and typosquatting on the very URL you ask people to trust.

## 3. Map directory groups to roles

**Settings → Single sign-on → Role mappings.**

Turn on **Sync roles from the directory on every sign-in** under *Edit* first,
then add one row per group:

| Field | Notes |
|---|---|
| Group object ID | The group's **object ID**, not its name |
| Name (for humans) | Display-only label for the table |
| Workspace role | Viewer / Editor / Admin, or leave unchanged |
| MCP roles | Which tool-access roles the group grants |

> **Why object IDs and not names.** Microsoft does not make group display names
> unique. If mappings matched on names, anyone able to create a group could
> create one called `GB_Fuehrungskreis` and grant themselves whatever that
> mapping grants. Find the object ID in **Entra → Groups → *the group* →
> Overview → Object Id**, or by typing the group name into the Azure portal's
> global search box and opening the result.

Resolution rules:

- A user in several mapped groups receives the **union** of their MCP roles and
  the **most privileged** workspace role.
- Roles an admin assigned by hand are **never** removed by a sync, and vice
  versa.
- A sync will **not** demote the last remaining admin of a workspace. The
  attempt is refused and audited as `LAST_ADMIN_PROTECTION_TRIGGERED`.

### When nothing matches

| Fallback | Behaviour |
|---|---|
| **Grant no tools** (default) | Assign a `No access (SSO)` role that whitelists nothing |
| Leave existing roles alone | Write nothing at all |
| Grant a default role | Assign the configured default MCP roles |

**Grant no tools is the default deliberately.** A user holding *no* MCP role at
all is treated as **unrestricted** — that is inherited behaviour, and it means
"revoke everything" written the obvious way would grant full access. The
fallback therefore assigns a real role with an empty whitelist instead. You will
see `No access (SSO)` appear under **Settings → Roles**; do not add tool access
to it.

### Tokens that carry too many groups

Past roughly 150 groups, Entra stops sending the list and sends a Microsoft
Graph pointer instead. AnythingMCP **does not** act on such a token: it changes
no roles and records `ROLE_SYNC_SKIPPED`. Treating the absent list as "member of
nothing" would strip the roles of exactly the people who belong to the most
groups. Selecting *Groups assigned to the application* (step 1.4) is what keeps
tokens under the limit.

---

## 4. Require single sign-on

**Settings → Single sign-on → Require single sign-on.**

Turning this on stops password sign-in for **every member of the workspace**.
Enabling is refused unless both of these hold:

1. **Someone has completed a dashboard sign-in through this provider.** Until
   that succeeds there is no evidence the configuration works.
2. **You hold unused recovery codes.** Without them, a directory outage would
   leave the workspace with no way in.

Disabling is never gated — undoing a lockout risk should not need permission.

Enforcement covers **every organization you belong to**, not just the active
one, because sessions can be switched between workspaces.

## 5. Recovery codes

**Settings → Single sign-on → Recovery codes → Generate.**

Ten single-use codes, shown **once**. The server stores only bcrypt hashes, so
they cannot be displayed again — copy or download them and keep them somewhere
reachable *without* single sign-on, which is the situation they exist for.

To use one: on the sign-in page choose **Use a recovery code**, enter your email
address and the code. Case and dashes are ignored. Regenerating invalidates the
whole previous set.

---

## Turning SSO off

| Goal | How |
|---|---|
| Restore password sign-in | Untick **Require single sign-on** |
| Stop a provider being usable | Untick **Active** under *Edit* |
| Remove it entirely | **Delete** the provider |

Deleting a provider removes its role mappings and unlinks the identities that
pointed at it. Members keep their accounts and any roles an admin assigned by
hand; roles that came from a sync go with it. **Make sure at least one admin can
still sign in with a password before deleting a provider that has enforcement
on** — or turn enforcement off first.

---

## How tool restriction is enforced

Role sync decides which **MCP roles** a user holds; those roles decide which
tools they may use. Where that restriction is applied depends on the endpoint:

Both endpoints filter `tools/list` to the tools the caller's roles allow, and
refuse `tools/call` for anything else:

| Endpoint | `tools/list` | `tools/call` |
|---|---|---|
| `/mcp/<serverId>` (per server) | Filtered to the user's tools | Denied if not allowed |
| `/mcp` (global) | Filtered to the user's tools, within their organization | Denied if not allowed |

A tool that has **no** role assigned to it at all is visible only to users whose
access is unrestricted — an admin, or someone holding no MCP role. Once a user
holds any MCP role, they see exactly what their roles grant.

---

## Security notes

- Identities are keyed on the provider's **immutable subject** (`oid` for
  Entra), never on email. Email addresses are mutable, unverified and not
  unique; keying authorization on one is the *nOAuth* vulnerability.
- Client secrets are encrypted with AES-256-GCM, bound to the provider and
  organization, and never returned by the API.
- Okta, Auth0 and generic OIDC require an admin-supplied issuer and are
  therefore self-hosted only even among self-hosted features' own gating.
- Every configuration change and sign-in outcome is written to the security
  audit trail: `IDP_CREATED`, `IDP_UPDATED`, `IDP_SECRET_ROTATED`,
  `IDP_ROLE_MAPPING_CHANGED`, `SSO_ENFORCEMENT_CHANGED`, `SSO_LOGIN_SUCCESS`,
  `SSO_LOGIN_FAILED`, `ROLE_SYNC_APPLIED`, `ROLE_SYNC_SKIPPED`,
  `LAST_ADMIN_PROTECTION_TRIGGERED`, `RECOVERY_CODES_GENERATED`,
  `RECOVERY_CODE_USED`.
- Group object ids are **not** written to the audit trail. Sign-in events record
  the *count* of groups presented, which answers "did the directory send
  anything at all?" without persisting directory structure.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Sign-in works, roles never change | Role sync is off, or no mapping matches. Check `groupCount` on the `SSO_LOGIN_SUCCESS` audit event — `0` means the token carried no groups |
| `groupCount` is 0 | The group is not **assigned to the application** in Entra, or the user is not a member of an assigned group, or the groups claim is missing from *Token configuration* |
| Everyone lands on `No access (SSO)` | Mappings use group *names* instead of object IDs, or the wrong tenant |
| `ROLE_SYNC_SKIPPED` with `reason: overage` | The user is in too many groups; switch the claim to *Groups assigned to the application* |
| Cannot enable **Require single sign-on** | Complete one dashboard sign-in through the provider, and generate recovery codes |
| Every SSO route returns 404 | You are on AnythingMCP Cloud. SSO is self-hosted only |
