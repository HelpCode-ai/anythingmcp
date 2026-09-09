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
| **Provisioning (SCIM)** | Entra creates, updates and **deactivates** accounts with no sign-in required (Entra ID only) |
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

## 6. Provisioning (SCIM)

**Settings → Single sign-on → Provisioning (SCIM) → Enable provisioning.**
Entra ID only, self-hosted only.

Role sync (§3) runs at **sign-in**. That is enough to widen or narrow what
someone may do, but it never runs for a person who has stopped signing in — and
an MCP API key keeps working without a sign-in. SCIM is the missing push
channel: Entra tells AnythingMCP about the change when it happens, with no
sign-in required.

Enabling mints a **bearer token, shown once**. Copy it together with the Tenant
URL before leaving the page; rotating is the only way to get another one.

### Set it up in Entra

The click-by-click walkthrough — including the two traps that cost the most
time — lives in **[SCIM provisioning with Microsoft Entra ID, step by
step](scim-entra-setup.md)**. In outline:

1. Enable provisioning here and copy the **Tenant URL** and **Secret token**.
2. Create a **second, non-gallery application** in Entra
   (*Enterprise applications → New application → Create your own application*).
3. Assign your groups to it — assignment does not carry over from the sign-in
   app.
4. **Provisioning → Overview → Connect your application**: bearer
   authentication, the two values from step 1, **Test connection**, **Create**.
5. **Attribute mapping**: change `externalId` from `mailNickname` to
   **`objectId`**.
6. **Provision on demand** one person to check it, then **Start provisioning**.

> **It has to be a second application.** The app you registered in §1 came from
> *App registrations*; Entra does not offer automatic provisioning on those, and
> its Provisioning page shows "automatic provisioning … is not supported" with
> **Get started** greyed out.

> **`externalId` is the one mapping you must change.** Entra ships it as
> `mailNickname`; the identity anchor an SSO sign-in stores is the `oid`. Leave
> the default and the same person arrives twice — once from provisioning, once
> from sign-in. On an account that already exists AnythingMCP keeps its own
> anchor and applies the rest of the update rather than refusing it, recording
> `externalIdIgnored` on the audit event.

> **The first cycle creates every assigned user**, then Entra polls about every
> 40 minutes. And Entra's *Provision on demand* has been seen reporting every
> step as *Success* while the target answered an error — check
> `SCIM_USER_PROVISIONED` / `SCIM_USER_UPDATED` in the audit log instead.

> Group **object IDs are tenant-wide**, so groups pushed by SCIM land on the
> same mappings as the ones the sign-in token carries. Existing mappings keep
> the roles you gave them.

### What is synced, and what is not

| Synced | Not synced |
|---|---|
| Account creation for assigned users | Passwords — provisioned accounts sign in through SSO |
| Display name and email | Photos, phone numbers, manager, department |
| `active` → deactivate / reactivate | Workspace *ownership* or billing |
| Group membership → MCP roles, live | Nested group members (Entra does not expand them) |

Provisioned people appear under **Settings → Users**, and their groups appear
in **Role mappings** with a `from SCIM` badge. Those rows are filled in for you:
assign MCP roles to them as usual, but remove them by unassigning the group in
Entra rather than in AnythingMCP.

### Deprovisioning

When Entra reports a user as `active: false` — unassigned from the app, disabled
or deleted in the directory — AnythingMCP, in one step and without a sign-in:

- deactivates the workspace membership,
- **deactivates every MCP API key** the user holds,
- invalidates their existing sessions and dashboard tokens.

A `DELETE` (Entra sends one when a user is purged, roughly 30 days later) does
the same thing. The account row is **kept**: hard-deleting it would dissolve the
audit trail and tool-invocation attribution at exactly the moment an
investigation would want them, and a user restored in Entra would come back as a
second account. Re-enabling in Entra restores the membership; the old API keys
stay dead and must be reissued.

The last admin of a workspace is protected here as it is everywhere else: the
deactivation is refused, the attempt is audited as
`LAST_ADMIN_PROTECTION_TRIGGERED`, and Entra receives a `409` so the failure
appears in its provisioning log.

### Roles between sign-ins

With SCIM on and role sync reading **groups**, group membership arriving over
SCIM is what decides roles — the `groups` claim in a sign-in token is ignored
for users SCIM has described. That is deliberate: SCIM holds the whole
membership set, whereas a token can silently drop it (see *Tokens that carry too
many groups*), and letting the token win would let an absent claim revoke access
SCIM had just granted. A user SCIM has never described still falls back to the
claim.

A group change reaches the user's tools within seconds of Entra pushing it —
`tools/list` widens or narrows with no sign-in. **Resync roles now** in the
panel re-evaluates every SCIM-known member against the current mappings; use it
after editing mappings if you do not want to wait for the next directory change.

> **If role sync is off, or set to *app roles*, SCIM still provisions accounts
> but changes no roles.** The panel says so, and the Role mappings tab warns
> when the source is app roles.

### Turning it off

**Disable** discards the token and stops Entra reaching the endpoint; the SCIM
routes then answer `401`. Accounts, memberships, roles and group mappings are
left exactly as they are. **Rotate token** invalidates the old token
immediately — Entra provisioning fails until the new one is pasted in.

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
- Provisioning adds `SCIM_ENABLED`, `SCIM_DISABLED`, `SCIM_TOKEN_ROTATED`,
  `SCIM_AUTH_FAILED`, `SCIM_USER_PROVISIONED`, `SCIM_USER_UPDATED`,
  `SCIM_USER_DEPROVISIONED`, `SCIM_USER_REACTIVATED`, `SCIM_GROUP_CREATED`,
  `SCIM_GROUP_DELETED` and `SCIM_GROUP_MEMBERSHIP_CHANGED`. The SCIM bearer
  token is stored as a hash and never appears in an audit entry, including the
  one recording its own rotation.
- `ROLE_SYNC_APPLIED` is written only when a sync actually **changes**
  something. A re-run that finds the directory where it left it writes nothing
  and is counted as *unchanged* in the `ROLE_SYNC_BATCH_COMPLETED` summary, so
  the entries that remain are the ones that moved someone's access.
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
| Entra's **Get started** for provisioning is greyed out | The app came from *App registrations*. Provisioning needs a second, non-gallery app — see §6 |
| **Test connection** fails | The Tenant URL must end in `/api/scim/v2` and be reachable from Microsoft's network; the token must be the current one. A rotation invalidates the old token immediately |
| Provisioned, but the user has no tools | No mapped group matched, so the fallback applied. Assign MCP roles to the `from SCIM` row under *Role mappings*, or check role sync is on and reading **groups** |
| SCIM created a second account for someone who already signs in with SSO | `externalId` is mapped to `mailNickname`. Point it at `objectId`, then delete the duplicate |
| `externalIdIgnored` on a `SCIM_USER_UPDATED` event | Same cause. The update was applied anyway, but fix the mapping before more accounts are created |
| A group change in Entra does not reach AnythingMCP | The group is not assigned to the **provisioning** app (assignment does not carry over from the sign-in app), or the cycle has not run yet — use *Provision on demand* |
| A leaver still has access | Their key was issued outside AnythingMCP's knowledge, or `active` is not mapped in Entra's attribute mappings. Check for `SCIM_USER_DEPROVISIONED` in the audit log |
| `409` when Entra creates a user | An unlinked local account already uses that email, or the change would deactivate the last admin. Both are reported in Entra's provisioning log |
