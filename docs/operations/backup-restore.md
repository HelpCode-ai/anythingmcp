# Backup & restore

AnythingMCP stores all state in PostgreSQL. Encrypted secrets, audit logs, MCP server configs, role assignments — all of it is in one database. Lose the database and you lose the deployment, so this document is the procedure operators are expected to follow.

## What needs to be backed up

| Where | What | How often |
|---|---|---|
| PostgreSQL | every table including `Connector.authConfig` (encrypted blob), audit log, OAuth state | continuously / nightly |
| `ENCRYPTION_KEY` | the AES-256-GCM key that decrypts `authConfig` | once, immutably |
| `JWT_SECRET` | rotate-able, but losing it logs every user out | once, immutably |
| `.env` (or your secret manager) | DB connection string, SMTP creds, OAuth IDs | on change |

The encryption key is **the** thing to protect: a database backup without it is unrecoverable for connector credentials. Store it separately from the database backup (different cloud provider, different vault, hardware token, ideally all three).

## Self-hosted (docker-compose)

### Logical backup with `pg_dump`

```bash
# Full logical dump, gzip'd, into a timestamped file
docker exec amcp-postgres \
  pg_dump --format=custom --no-owner --no-acl -U amcp anythingmcp \
  | gzip > "anythingmcp-$(date -u +%Y%m%dT%H%M%SZ).pgdump.gz"
```

Schedule it from the host's crontab so the dump file lands outside the container:

```
0 3 * * *  /usr/local/bin/anythingmcp-backup.sh
```

`anythingmcp-backup.sh` should:

1. Run the `pg_dump` above.
2. Encrypt the dump (`gpg --symmetric --cipher-algo AES256` or `age`).
3. Upload to off-host storage (S3, B2, restic, rsync.net — anything you can verify is in a different failure domain than the docker host).
4. Prune dumps older than your retention (typically 14 daily + 8 weekly + 6 monthly).

### Restore

```bash
# Stop the app so it can't write while we restore
docker compose stop app

# Drop and recreate the database
docker exec -i amcp-postgres psql -U amcp -d postgres -c "DROP DATABASE anythingmcp;"
docker exec -i amcp-postgres psql -U amcp -d postgres -c "CREATE DATABASE anythingmcp;"

# Restore the dump (the dump file must already be decompressed + decrypted)
gunzip -c anythingmcp-…pgdump.gz | docker exec -i amcp-postgres \
  pg_restore --no-owner --no-acl -U amcp -d anythingmcp

docker compose start app
```

Verify before declaring success:
- Login still works → JWT_SECRET unchanged
- Open a connector that uses encrypted credentials and click "Test connection" → ENCRYPTION_KEY decrypts correctly
- The dashboard counts of connectors, MCP servers, audit invocations are within the expected window

## Managed Postgres (Railway / Supabase / RDS / Cloud SQL)

Use the platform's native point-in-time recovery (PITR). Don't rely on manual `pg_dump` cron when PITR is one switch away — and configure WAL retention to cover at least 7 days so you can roll back a destructive admin action.

What you still need to back up yourself:
- `ENCRYPTION_KEY` and `JWT_SECRET` — they're not in the database
- `.env` (without the database password — that should come from the platform)

## Restoring to a different host

If the new host has a different `ENCRYPTION_KEY`, every encrypted `authConfig` blob in the database becomes unreadable. The connectors will continue to exist as rows, but every API call that needs a credential will fail with a decryption error.

Always migrate the encryption key together with the database. If you've lost the original key, the connectors must be re-created with fresh credentials.

## Testing the backup

A backup that has never been restored is not a backup. Once a quarter:

1. Spin up a throwaway compose stack with the same `ENCRYPTION_KEY`.
2. Restore the most recent backup into it.
3. Log in as an admin, run "Test connection" against three different connectors, verify the audit log is intact.
4. Tear it down.

This is also the cheapest way to discover that retention has silently been broken for two months.
