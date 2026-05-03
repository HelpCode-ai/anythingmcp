# Disaster recovery

Targets we hold ourselves to for AnythingMCP-the-managed-product. Self-hosters should treat these as a starting point and tighten them where their own SLA requires.

| Metric | Target |
|---|---|
| RPO (recovery point objective) | ≤ 1 hour of writes lost in the worst case |
| RTO (recovery time objective) | ≤ 4 hours from incident declaration to a working instance |
| Time-to-detect | ≤ 5 minutes for a hard outage (uptime monitor) |

## Failure modes and the response

### 1. Backend container crashes, DB is fine

Symptom: `/health` returns 5xx or times out, Postgres is reachable.

Action:
- `docker compose restart app`
- If the crash repeats, pull the most recent logs (`docker compose logs --since=10m app`), look for the structured error line carrying the panic + the request id (`X-Request-Id`).
- `enableShutdownHooks` should already drain in-flight requests, but check the audit log for `status=ERROR` rows in the crash window so you know which tool invocations need to be re-run by the user.

### 2. Database is unreachable

Symptom: `/health` returns `database: { status: 'down' }`, the app is up.

Action:
- Verify the Postgres container/managed instance is reachable (`pg_isready`).
- If managed (Railway/Supabase/RDS): check the provider's status page first.
- If self-hosted: `docker compose logs postgres` — usually disk full, OOM, or a corrupted WAL.
- Failover to standby if you have one. Otherwise, the app is unavailable until the DB returns.
- Backend will reconnect automatically when Postgres comes back; no app restart needed.

### 3. Database is corrupted / data loss

Symptom: query errors on previously-working tables, or admin reports "all my connectors are gone".

Action:
- Stop the app (`docker compose stop app`) — do not let the broken state get worse.
- Restore the most recent good backup per `backup-restore.md`.
- If the corruption window is small and PITR is available (managed instances), prefer point-in-time restore over the latest dump.
- Bring the app back up. Verify per the checklist in `backup-restore.md`.
- File an incident note with: time of corruption, last good backup, what was lost between the two, root cause if known.

### 4. ENCRYPTION_KEY is lost

Symptom: app boots, login works, but every connector test returns "decrypt failed".

There is no recovery for the encrypted credentials. Process:
- Mark every connector as inactive (mass UPDATE if needed).
- Notify every customer/admin that their stored credentials are unrecoverable and need to be re-entered.
- Provision a new `ENCRYPTION_KEY` (`openssl rand -base64 48`).
- Store the new key per `backup-restore.md` immediately.

This is exactly the failure mode we tell operators to design around in advance — so the right time to read this section is *before* the key is lost.

### 5. Compromised secret (JWT_SECRET, OAuth client secret, SMTP creds)

Symptom: external indicator (suspicious login, leaked credential in CI logs).

Action:
- Rotate the secret first, investigate after.
- Rotating `JWT_SECRET` invalidates every active session — every user logs out. Communicate before doing it on prod.
- Rotating an OAuth client secret invalidates pending authorization codes; users mid-flow may need to retry.
- Update audit log expectations: assume every action since the suspected compromise time was attacker-controlled until proven otherwise.

### 6. Region-wide outage (cloud provider)

Symptom: the host platform is down (Railway / AWS / GCP region issue).

Action:
- We do not currently maintain a hot standby in a second region. This is on the roadmap.
- If the outage exceeds RTO, restore the most recent backup into a new instance in a different region and update DNS.
- This requires that the encryption key, env vars, and DB backup all live somewhere outside the primary region — see `backup-restore.md`.

## Runbook drill

Once a quarter, on a throwaway environment:
1. Restore yesterday's backup (per `backup-restore.md`).
2. Verify a known connector decrypts and "Test connection" works.
3. Rotate `JWT_SECRET` (just on the throwaway).
4. Confirm every active session was logged out.
5. Time the whole exercise — that's your real RTO. If it's > 4 h, fix what slowed you down.

If the drill is uncomfortable, run it more often, not less.
