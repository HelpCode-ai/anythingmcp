#!/usr/bin/env bash
# =============================================================================
# Exercises deploy/cloud/stuck-users-report.sh end to end against a throwaway
# Postgres (every Prisma migration applied, then seeded with FAKE data) and a
# throwaway SMTP server (Mailpit, STARTTLS with a self-signed certificate).
# Needs Docker and openssl.
#
#   bash deploy/cloud/stuck-users-report.test.sh
#   KEEP_MAIL=1 bash deploy/cloud/stuck-users-report.test.sh   # print the mail
#
# Scenarios:
#   1. --print renders all three sections, marks every org NEW on a first run,
#      scrubs error texts, and touches neither the state nor the mailbox;
#   2. with no recipient configured the report goes to stdout and the state
#      file records the stuck orgs;
#   3. the next run calls them STILL STUCK, and counts the one that has since
#      had a successful call as unstuck;
#   4. with REPORT_TO and SMTP_* set, the mail arrives over STARTTLS with the
#      summary in the subject.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SCRIPT="$HERE/stuck-users-report.sh"
WORK="$(mktemp -d)"
PG="amcpsr$$-pg"
SMTP="amcpsr$$-smtp"

cleanup() {
  docker rm -f "$PG" "$SMTP" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fails=0
ok()   { echo "  ok    $1"; }
bad()  { echo "  FAIL  $1"; fails=$((fails + 1)); }
has()  { if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3 (missing: $2)"; fi; }
hasnt(){ if grep -qF -- "$2" "$1"; then bad "$3 (found: $2)"; else ok "$3"; fi; }

psql_in() { docker exec -i "$PG" psql -U amcp -d anythingmcp -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "── starting Postgres and applying migrations"
docker run -d --name "$PG" -e POSTGRES_USER=amcp -e POSTGRES_PASSWORD=amcp -e POSTGRES_DB=anythingmcp \
  postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U amcp -d anythingmcp >/dev/null 2>&1 && break; sleep 1
done
# The init script restarts the server once; wait for a real query to succeed.
for _ in $(seq 1 30); do psql_in -c 'select 1' >/dev/null 2>&1 && break; sleep 1; done
for m in "$ROOT"/packages/backend/prisma/migrations/*/migration.sql; do
  psql_in < "$m" >/dev/null
done

echo "── seeding fake data"
# Every name, address and error below is invented. Times are relative to now;
# the window is the last 7 days.
psql_in >/dev/null <<'SQL'
create temp table t0 as select (now() at time zone 'UTC') as now;

insert into organizations (id, name, created_at, updated_at)
select v.id, v.id, t0.now - v.age, t0.now from t0, (values
  ('org_stuck_a', interval '3 days'),   -- signed up this week, every call fails
  ('org_stuck_b', interval '40 days'),  -- older, every call fails
  ('org_happy',   interval '90 days'),  -- mostly fine, but uses two broken adapters
  ('org_old',     interval '60 days'),  -- stuck, but quiet this week
  ('org_lapsed',  interval '120 days'), -- only errors now, but succeeded once
  ('org_new1',    interval '1 day'),    -- signed up, no connector
  ('org_new2',    interval '2 days')    -- signed up, connector, no call
) v(id, age);

insert into users (id, email, organization_id, email_marketing_opt_out, created_at, updated_at)
select 'u_' || v.org, v.email, v.org, v.optout, o.created_at, o.created_at
from (values
  ('org_stuck_a', 'alice@example.com', true),
  ('org_stuck_b', 'bob@example.org', false),
  ('org_happy',   'carol@example.net', false),
  ('org_old',     'dave@example.com', false),
  ('org_lapsed',  'erin@example.com', false),
  ('org_new1',    'frank@example.com', false),
  ('org_new2',    'grace@example.com', false)
) v(org, email, optout) join organizations o on o.id = v.org;

insert into organization_members (id, user_id, organization_id, role)
select 'm_' || organization_id, id, organization_id, 'ADMIN' from users;

insert into connectors (id, user_id, organization_id, name, type, base_url, config, auth_config, updated_at)
select v.id, 'u_' || v.org, v.org, v.name, 'REST', 'https://api.example.test',
       case when v.slug is null then null else jsonb_build_object('adapterSlug', v.slug) end,
       'AUTHCONFIG-SECRET', t0.now
from t0, (values
  ('c_a_reddit', 'org_stuck_a', 'Reddit', 'reddit'),
  ('c_b_erp',    'org_stuck_b', 'My ERP', null),
  ('c_h_github', 'org_happy',   'GitHub', 'github'),
  ('c_h_reddit', 'org_happy',   'Reddit', 'reddit'),
  ('c_h_buffer', 'org_happy',   'Buffer', 'buffer'),
  ('c_o_vinted', 'org_old',     'Vinted', 'vinted'),
  ('c_l_github', 'org_lapsed',  'GitHub', 'github'),
  ('c_g_notion', 'org_new2',    'Notion', 'notion')
) v(id, org, name, slug);

insert into mcp_tools (id, connector_id, name, description, parameters, endpoint_mapping, updated_at)
select 't_' || id, id, 'do_something', 'fake tool', '{}', '{}', t0.now from connectors, t0;

-- n calls on connector c with status s and error e, one an hour from h0 back.
create temp table plan (c text, n int, s text, e text, h0 int);
insert into plan values
  ('c_a_reddit', 10, 'ERROR', 'Request failed with status 403: GET https://oauth.reddit.com/r/test/search?q=alice%40example.com&token=SEEKRIT-QUERY failed for alice@example.com with bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD', 1),
  ('c_a_reddit',  2, 'TIMEOUT', 'Timed out after 30000 ms', 20),
  ('c_b_erp',     3, 'ERROR', 'Upstream said:' || E'\n' || repeat('lorem ipsum dolor ', 20), 48),
  ('c_h_github', 20, 'SUCCESS', null, 2),
  ('c_h_github',  2, 'ERROR', 'Request failed with status 404: Not Found', 30),
  ('c_h_reddit',  5, 'ERROR', 'Request failed with status 403: Blocked', 5),
  ('c_h_buffer',  1, 'SUCCESS', null, 6),
  ('c_h_buffer',  9, 'ERROR', 'Request failed with status 401: Unauthorized', 7),
  ('c_h_buffer',  1, 'SUCCESS', null, 240),   -- 10 days ago
  ('c_o_vinted',  4, 'ERROR', 'Request failed with status 429', 480),  -- 20 days ago
  ('c_l_github',  1, 'SUCCESS', null, 2400),  -- 100 days ago
  ('c_l_github',  2, 'ERROR', 'Bad credentials', 3);

insert into tool_invocations (id, tool_id, user_id, organization_id, connector_id, input, output, status, error, created_at)
select 'ti_' || p.c || '_' || p.h0 || '_' || g, 't_' || p.c, c.user_id, c.organization_id, p.c,
       '{"query":"INPUT-SECRET"}', '{"data":"OUTPUT-SECRET"}', p.s::"InvocationStatus", p.e,
       t0.now - make_interval(hours => p.h0 + g)
from plan p join connectors c on c.id = p.c cross join t0 cross join generate_series(0, p.n - 1) g;
SQL

ENVF="$WORK/.env"
STATE="$WORK/state"
run() { ENV_FILE="$ENVF" STATE_DIR="$STATE" PG_CONTAINER="$PG" bash "$SCRIPT" "$@"; }

echo "1. --print on a first run"
printf 'DOMAIN=cloud.example.test\n' > "$ENVF"
run --print > "$WORK/r1.txt" 2>/dev/null
R="$WORK/r1.txt"
has   "$R" "SUMMARY: 2 new stuck orgs (0 still stuck), 1 connector failing for everyone (+1 under 20 %), 1 of 3 signups without a connector." "summary line"
has   "$R" "[NEW] alice@example.com [opt-out]" "stuck org A, NEW, opt-out flagged"
has   "$R" "[NEW] bob@example.org" "stuck org B, NEW"
has   "$R" "Active this week: 2 (2 new, 0 still stuck). Active in the last 30 days: 3. All time: 3." "30-day and all-time context"
has   "$R" "12 calls this week, 12 in 30 days: Reddit ×12" "calls and connector per org"
has   "$R" "most frequent error (10×): Request failed with status 403: GET https://oauth.reddit.com/r/test/search?… failed for <email> with bearer <token>" "error scrubbed: query string, e-mail, token"
hasnt "$R" "SEEKRIT" "no query-string secret"
hasnt "$R" "INPUT-SECRET" "no tool input"
hasnt "$R" "OUTPUT-SECRET" "no tool output"
hasnt "$R" "AUTHCONFIG-SECRET" "no auth config"
# The ellipsis is one character but three bytes, and awk counts bytes on macOS.
long=$(grep 'most frequent error' "$R" | sed -e 's/.*): //' -e 's/…/./g' | awk '{ print length($0) }' | sort -n | tail -1)
[ "$long" -le 150 ] && ok "error texts at most 150 characters ($long)" || bad "error text of $long characters"
has   "$R" "Upstream said: lorem ipsum" "multi-line error folded into one line"
has   "$R" "Reddit (reddit)" "Reddit failing for everyone"
has   "$R" "this week: 0 of 17 calls succeeded (0 %), 2 org(s)" "Reddit numbers across orgs"
has   "$R" "Buffer (buffer)" "Buffer under the threshold"
has   "$R" "this week: 1 of 10 calls succeeded (10 %), 1 org(s); 30 days: 2 of 11 (18 %)" "Buffer numbers"
has   "$R" "My ERP ×3" "custom connector shown in section 1 ..."
if sed -n '/^2\. /,/^3\. /p' "$R" | grep -q "My ERP"; then bad "... but a single org's custom connector is not in section 2"; else ok "... but a single org's custom connector is not in section 2"; fi
hasnt "$R" "GitHub (github)" "healthy connector not listed"
hasnt "$R" "Vinted" "connector quiet this week not listed"
hasnt "$R" "erin@" "org that once succeeded is not stuck"
has   "$R" "3 signed up [3]" "signup count"
has   "$R" "frank@example.com" "signup without connector listed"
has   "$R" "grace@example.com" "signup without calls listed"
has   "$R" "First report: nothing to compare with" "first-run note"
[ ! -e "$STATE/stuck-orgs" ] && ok "--print writes no state" || bad "--print wrote state"

echo "2. no recipient: report on stdout, state written"
run > "$WORK/r2.txt" 2>/dev/null
has "$WORK/r2.txt" "[NEW] alice@example.com" "report on stdout (the journal under systemd)"
[ "$(sort "$STATE/stuck-orgs" | tr '\n' ' ')" = "org_stuck_a org_stuck_b " ] && ok "state lists the two stuck orgs" || bad "state: $(cat "$STATE/stuck-orgs" 2>/dev/null)"

echo "3. next week: still stuck, and one unstuck"
psql_in -c "insert into tool_invocations (id, tool_id, organization_id, connector_id, input, status, created_at)
            values ('ti_fixed', 't_c_b_erp', 'org_stuck_b', 'c_b_erp', '{}', 'SUCCESS', now() at time zone 'UTC')" >/dev/null
run --print > "$WORK/r3.txt" 2>/dev/null
R="$WORK/r3.txt"
has   "$R" "[STILL STUCK] alice@example.com" "org A now STILL STUCK"
hasnt "$R" "bob@example.org" "org B, now working, gone"
has   "$R" "Since the last report: 1 of the 2 orgs listed then have had a successful call." "unstuck count"
has   "$R" "SUMMARY: 0 new stuck orgs (1 still stuck)" "summary counts still-stuck"
[ "${KEEP_MAIL:-0}" = 1 ] && { echo "──── second-week report ────"; cat "$R"; echo "────────────────────────────"; }

echo "4. mail over STARTTLS"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" >/dev/null 2>&1
chmod 644 "$WORK/key.pem"
docker run -d --name "$SMTP" -v "$WORK:/certs:ro" \
  -e MP_SMTP_TLS_CERT=/certs/cert.pem -e MP_SMTP_TLS_KEY=/certs/key.pem -e MP_SMTP_REQUIRE_STARTTLS=true \
  -e MP_SMTP_AUTH_ACCEPT_ANY=true \
  -p 127.0.0.1::1025 -p 127.0.0.1::8025 axllent/mailpit >/dev/null
SMTP_PORT=$(docker port "$SMTP" 1025/tcp | head -1 | sed 's/.*://')
WEB_PORT=$(docker port "$SMTP" 8025/tcp | head -1 | sed 's/.*://')
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$WEB_PORT/api/v1/info" >/dev/null 2>&1 && break; sleep 1; done
cat > "$ENVF" <<ENV
DOMAIN=cloud.example.test
SMTP_HOST=127.0.0.1
SMTP_PORT=$SMTP_PORT
SMTP_USER=report
SMTP_PASS=not-a-real-password
SMTP_FROM="AnythingMCP <noreply@example.test>"
UPTIME_ALERT_TO=ops-fallback@example.test
REPORT_TO=ops@example.test, second@example.test
ENV
rm -f "$STATE/stuck-orgs"
if CURL_CA_BUNDLE="$WORK/cert.pem" run > "$WORK/r4.log" 2>&1; then ok "script exits 0 after sending"; else bad "script failed: $(cat "$WORK/r4.log")"; fi
curl -s "http://127.0.0.1:$WEB_PORT/api/v1/message/latest/raw" > "$WORK/mail.eml"
has "$WORK/mail.eml" "Subject: [AnythingMCP] Weekly stuck users: 1 new stuck org (0 still stuck)" "mail arrived with the summary as subject"
has "$WORK/mail.eml" "To: ops@example.test, second@example.test" "REPORT_TO wins over UPTIME_ALERT_TO, two recipients"
has "$WORK/mail.eml" "[NEW] alice@example.com [opt-out]" "report in the body"
[ -s "$STATE/stuck-orgs" ] && ok "state written after a successful send" || bad "no state after sending"
[ "${KEEP_MAIL:-0}" = 1 ] && { echo "──── the mail as received ────"; tr -d '\r' < "$WORK/mail.eml"; echo "──────────────────────────────"; }

echo "5. a failed send leaves the state alone"
docker rm -f "$SMTP" >/dev/null
rm -f "$STATE/stuck-orgs"
if CURL_CA_BUNDLE="$WORK/cert.pem" run > "$WORK/r5.log" 2>&1; then bad "script exited 0 with no SMTP server"; else ok "script exits non-zero when the mail cannot be sent"; fi
[ ! -e "$STATE/stuck-orgs" ] && ok "no state after a failed send" || bad "state written after a failed send"

echo
if [ "$fails" = 0 ]; then echo "all checks passed"; else echo "$fails check(s) failed"; exit 1; fi
