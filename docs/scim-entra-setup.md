# SCIM provisioning with Microsoft Entra ID — step by step

Click-by-click setup for **automatic user and group provisioning** from Entra ID
into AnythingMCP. For what provisioning *does* — what is synced, how leavers are
handled, how roles behave between sign-ins — read
[§6 of the SSO guide](sso.md#6-provisioning-scim) first; this page is the
mechanics.

> **Self-hosted only.** Every SCIM route answers **404** on AnythingMCP Cloud.
> See [deployment.md](deployment.md) to run your own instance.

**Time:** about 15 minutes. **Reversible:** yes, at every step.

---

## Before you start

| You need | Notes |
|---|---|
| SSO already working | Provisioning attaches to an existing Entra provider — set it up with [§1–§3 of the SSO guide](sso.md) first |
| **Microsoft Entra ID P1** (or P2) | Automatic provisioning is a paid feature on Microsoft's side |
| **Application Administrator** (or Global Administrator) in Entra | Needed to create the app and its provisioning configuration |
| A **public HTTPS URL** for AnythingMCP | Microsoft calls you from the internet. `localhost` will not do — for a trial run, a tunnel (ngrok, Cloudflare Tunnel) is enough |
| **Admin** in the AnythingMCP workspace | To mint the token |

> **Two applications, not one.** The app you registered for sign-in came from
> *App registrations*. Entra does **not** offer automatic provisioning on those:
> its Provisioning page says *"automatic provisioning … is not supported"* and
> leaves **Get started** greyed out. Provisioning needs a second, **non-gallery**
> application, created from *Enterprise applications → New application*. The two
> share nothing but the directory, so groups have to be assigned to **both**.

---

## Step 1 — Mint the token in AnythingMCP

**Settings → Single sign-on → your Entra provider → Provisioning (SCIM) →
Enable provisioning.**

You get two values:

| Value | Looks like |
|---|---|
| **Tenant URL** | `https://<your-anythingmcp-host>/api/scim/v2` |
| **Secret token** | `scim_…`, 48 characters |

**The token is shown once.** Copy both now — *Rotate token* is the only way to
get another one, and rotating breaks the Entra side until you paste the new one.

> Copying the token from a terminal? `cat` prints it without a trailing
> newline, so zsh appends a `%` to the display. That `%` is **not** part of the
> token — pasting it produces `401 Authentication required` and Entra reports
> `CredentialValidationUnavailable`. Use `pbcopy < file` or select carefully.

---

## Step 2 — Create the provisioning application in Entra

**Entra admin center → Enterprise applications → New application → Create your
own application.**

1. Name it something recognisable — `AnythingMCP provisioning`.
2. Choose **Integrate any other application you don't find in the gallery
   (Non-gallery)**.
3. **Create.**

---

## Step 3 — Assign the users and groups

**Your new app → Users and groups → Add user/group.**

Assign the same groups you assigned to the sign-in app. Only assigned objects
are provisioned, and **assignment does not carry over between the two apps** —
sign-in reads the assignment of the first app, provisioning the assignment of
the second.

| | |
|---|---|
| Assign **groups**, not individual users, where you can | The group is what carries the role mapping |
| Only **Security** and **Microsoft 365** groups can be assigned | Distribution lists cannot |
| Nested groups are **not** expanded | Members of a child group are not provisioned |

---

## Step 4 — Create the provisioning configuration

**Your app → Provisioning → Overview → Connect your application.**

Fill in the *New provisioning configuration* blade:

| Field | Value |
|---|---|
| Select authentication method | **Bearer authentication** |
| Tenant URL | the URL from step 1, ending in `/api/scim/v2` |
| Secret token | the token from step 1 |

Then **Test connection** → **Create**.

> **Test connection alone saves nothing.** Newer tenants show a separate
> *Connectivity* blade where you can enter and save the same two fields; doing
> that stores the credentials but does **not** create the provisioning job —
> *Attribute mapping*, *Scoping filters* and *Start provisioning* all stay
> greyed out and *Provisioning Mode* keeps reading *Manual*. The configuration
> only exists after **Create** on this blade.

A successful Create takes you to the configuration overview, showing a **Job
ID** and *Current cycle status: Initial sync paused*. That is the expected
state — nothing has been provisioned yet.

**What Test connection does on the wire:** a single
`GET /api/scim/v2/Users?filter=userName eq "<a random guid>"`. AnythingMCP
answers `200` with an empty `ListResponse`, which is what Entra wants to see.

---

## Step 5 — Fix the `externalId` mapping ⚠️

**Your app → Provisioning → Attribute mapping → Provision Microsoft Entra ID
Users.**

| Target attribute | Must come from | Entra's default |
|---|---|---|
| `userName` | `userPrincipalName` | ✅ already right |
| `active` | `Switch([IsSoftDeleted]…)` | ✅ already right — **do not unmap it**, it is what deprovisions leavers |
| **`externalId`** | **`objectId`** | ❌ ships as `mailNickname` — **change it** |

Click the `externalId` row, set **Source attribute** to `objectId`, **Ok**,
**Save**.

> **Why this one matters more than the rest.** `externalId` is the identity
> anchor. An SSO sign-in stores the user's `oid`; if SCIM sends `mailNickname`
> instead, the same human arrives as two different people — one account created
> by provisioning, another by sign-in, each with their own roles. On an account
> that already exists AnythingMCP keeps its own anchor and applies the rest of
> the update rather than refusing it, recording `externalIdIgnored` on the
> `SCIM_USER_UPDATED` audit event so you can find the misconfiguration. Fix the
> mapping before you let a full cycle run.

Everything else can stay as it is. AnythingMCP stores the display name and the
email and ignores the rest (addresses, phone numbers, department) — harmless.

---

## Step 6 — Scope

**Provisioning → Settings → Scope: *Sync only assigned users and groups*.**

This is the default and it is the one you want: it mirrors the rule the groups
claim already follows. *Sync all users and groups* would push your entire
directory.

---

## Step 7 — Test one person before letting it loose

**Provisioning → Provision on demand.** Search for a user, **Provision**.

Then check the result **in AnythingMCP**, not only in Entra:

- **Settings → Users** — the person is listed
- **Audit Log** — a `SCIM_USER_PROVISIONED` (new account) or
  `SCIM_USER_UPDATED` (existing one adopted) event
- **Settings → Single sign-on → Provisioning (SCIM)** — *Users provisioned*
  goes up, *Last request from Entra* is recent

> **Do not trust the four green ticks.** Entra's *Provision on demand* view has
> been observed reporting **Success** on all four steps while the target
> answered an HTTP error and changed nothing. The audit log is the source of
> truth.

To test a group the same way, select the group instead of a user; Entra lets
you pick up to five members per run.

---

## Step 8 — Start provisioning

**Provisioning → Overview → Start provisioning.**

> **The first cycle creates every assigned user.** Check who is in scope before
> you press it. Later cycles run about every 40 minutes and only carry changes.

---

## Verifying it end to end

A healthy provision-on-demand of one user in one group looks like this on the
wire — useful when you need to prove where a problem is:

```
GET   /api/scim/v2/Users?filter=userName eq "…"              -> 200
GET   /api/scim/v2/Groups?excludedAttributes=members&filter=… -> 200
GET   /api/scim/v2/Users/<id>                                 -> 200
PATCH /api/scim/v2/Users/<id>                                 -> 200
GET   /api/scim/v2/Groups/<id>?excludedAttributes=members     -> 200
PATCH /api/scim/v2/Groups/<id>                                -> 200
```

and this in the AnythingMCP audit log:

```
SCIM_USER_UPDATED
SCIM_GROUP_MEMBERSHIP_CHANGED   { added: 1 }
ROLE_SYNC_APPLIED               { trigger: 'scim', matched: 1 }
ROLE_SYNC_BATCH_COMPLETED       { applied: 1, unchanged: 0 }
```

`ROLE_SYNC_APPLIED` appears only when the sync actually changed something; a
re-run over an unchanged directory reports `applied: 0, unchanged: N` and
writes no per-user event.

---

## Day-two operations

| Task | Where |
|---|---|
| Give a provisioned group its MCP roles | **Role mappings** — SCIM groups appear automatically with a `from SCIM` badge |
| Remove a group | Unassign it in Entra, not in AnythingMCP |
| Re-evaluate everyone after editing mappings | **Resync roles now** in the provisioning panel |
| Rotate the token | **Rotate token**, then paste the new one in Entra — the old one dies immediately |
| Stop provisioning | **Disable** in AnythingMCP (SCIM routes then answer `401`), or *Pause provisioning* in Entra. Accounts, roles and mappings are left untouched |

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **Get started** greyed out, *"automatic provisioning … is not supported"* | The app came from *App registrations*. Create the second, non-gallery app (step 2) |
| Test connection fails, `CredentialValidationUnavailable` + `Unauthorized` | Wrong or mistyped token — check for a stray `%` or whitespace. A rotation invalidates the old token instantly |
| Test connection fails, timeout or DNS error | The Tenant URL is not reachable from the internet, or does not end in `/api/scim/v2` |
| Test connection passes, but nothing else lights up | You saved on the *Connectivity* blade instead of pressing **Create** in *New provisioning configuration* (step 4) |
| A person has two accounts | `externalId` is mapped to `mailNickname`. Fix step 5, then delete the duplicate |
| `externalIdIgnored` on a `SCIM_USER_UPDATED` event | Same cause. The update went through anyway; fix the mapping before more accounts appear |
| Provisioned, but the user gets no tools | No mapped group matched, so the fallback applied. Give the `from SCIM` row its MCP roles, and check role sync is on and reading **groups** |
| A group change never arrives | The group is not assigned to the **provisioning** app (assignment does not carry over), or the cycle has not run — use *Provision on demand* |
| `409` when Entra creates a user | An unlinked local account already uses that email, or the change would deactivate the last admin. Both are reported in Entra's provisioning log |
| A leaver still has access | `active` is unmapped in step 5, or their key was issued outside AnythingMCP. Look for `SCIM_USER_DEPROVISIONED` in the audit log |
| Every SCIM route returns 404 | You are on AnythingMCP Cloud. Provisioning is self-hosted only |

---

## See also

- [Single sign-on](sso.md) — providers, role mappings, enforcement, recovery codes
- [Deployment](deployment.md) — running your own instance
