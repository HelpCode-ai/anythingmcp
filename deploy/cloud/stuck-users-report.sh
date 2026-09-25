#!/usr/bin/env bash
# =============================================================================
# AnythingMCP Cloud — weekly "stuck users" report, run by a systemd timer on
# the droplet (deploy/cloud/systemd/anythingmcp-stuck-report.{service,timer}).
#
# Why: on 2026-09-25 a query run by hand found 71 organizations whose tool
# calls had never once succeeded — 21 of them active in the previous 30 days —
# and several catalog connectors (Reddit, Vinted, Buffer, ImmobilienScout24…)
# with no successful call for anyone. Nobody knew. This mails the same
# picture every Monday morning:
#
#   1. organizations that made tool calls in the window and have NEVER had a
#      successful one, marked NEW or STILL STUCK against the previous report;
#   2. catalog connectors whose success rate in the window is 0 %, or under
#      REPORT_CONNECTOR_MAX_RATE % with at least REPORT_CONNECTOR_MIN_CALLS
#      calls, across all organizations — i.e. broken adapters;
#   3. signups in the window that never created a connector or never made a
#      call — the onboarding signal.
#
# Read-only: every query runs in a read-only transaction (PGOPTIONS below)
# through `docker exec` into the Postgres container, as the operators do by
# hand. Tool inputs, outputs, auth configs and secrets are never selected.
# Error texts can carry customer data, so they are collapsed to one line,
# stripped of URL query strings, e-mail addresses and long tokens, and cut to
# 150 characters.
#
# Mail goes through the SMTP the backend uses, read from the deployment's .env
# (same approach as uptime-probe.sh), to REPORT_TO, falling back to
# UPTIME_ALERT_TO. With neither set the report is written to stdout, i.e. the
# journal: `journalctl -u anythingmcp-stuck-report`.
#
#   stuck-users-report.sh              build, mail, remember the stuck orgs
#   stuck-users-report.sh --dry-run    build and print; no state, no mail
#   stuck-users-report.sh --print      same as --dry-run
#
# Tunables (environment or .env): REPORT_TO, REPORT_WINDOW_DAYS (7),
# REPORT_TZ (Europe/Berlin), REPORT_CONNECTOR_MIN_CALLS (5),
# REPORT_CONNECTOR_MAX_RATE (20), REPORT_LIST_MAX (30).
# Plumbing (environment only): ENV_FILE, STATE_DIR, PG_CONTAINER, PG_USER, PG_DB.
# =============================================================================
set -uo pipefail

ENV_FILE="${ENV_FILE:-/opt/anythingmcp-cloud/.env}"
STATE_DIR="${STATE_DIR:-/var/lib/anythingmcp-report}"
PG_CONTAINER="${PG_CONTAINER:-amcp-cloud-postgres}"
PG_USER="${PG_USER:-amcp}"
PG_DB="${PG_DB:-anythingmcp}"

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run|--print) DRY_RUN=1 ;;
  -h|--help) sed -n '3,/^# =====/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
esac

# One value from the .env, without sourcing it (values may hold anything).
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
# The process environment wins over the .env, then the default.
setting() { local v; eval "v=\${$1:-}"; [ -n "$v" ] || v=$(envval "$1"); printf '%s' "${v:-$2}"; }

DOMAIN=$(setting DOMAIN "cloud.anythingmcp.com")
REPORT_TO=$(setting REPORT_TO "")
[ -n "$REPORT_TO" ] || REPORT_TO=$(setting UPTIME_ALERT_TO "")
WINDOW_DAYS=$(setting REPORT_WINDOW_DAYS 7)
REPORT_TZ=$(setting REPORT_TZ "Europe/Berlin")
MIN_CALLS=$(setting REPORT_CONNECTOR_MIN_CALLS 5)
MAX_RATE=$(setting REPORT_CONNECTOR_MAX_RATE 20)
LIST_MAX=$(setting REPORT_LIST_MAX 30)
for n in WINDOW_DAYS MIN_CALLS MAX_RATE LIST_MAX; do
  eval "v=\$$n"
  case "$v" in ''|*[!0-9]*) echo "$n must be a whole number, got '$v'" >&2; exit 2 ;; esac
done
case "$REPORT_TZ" in *[!A-Za-z0-9/_+-]*) echo "REPORT_TZ looks wrong: '$REPORT_TZ'" >&2; exit 2 ;; esac

log() {
  logger -t anythingmcp-report -- "$*" 2>/dev/null || true
  [ "$DRY_RUN" = 1 ] && echo "$*" >&2
  return 0
}

# ── Mail (same SMTP handling as uptime-probe.sh) ─────────────────────────────
send_mail() {
  local subject="$1" body="$2"
  local host port user pass from secure from_addr
  host=$(envval SMTP_HOST); port=$(envval SMTP_PORT); user=$(envval SMTP_USER); pass=$(envval SMTP_PASS); from=$(envval SMTP_FROM); secure=$(envval SMTP_SECURE)
  [ -n "$host" ] && [ -n "$from" ] || { log "SMTP not configured — cannot mail: $subject"; return 1; }
  # SMTP_FROM may be "Name <addr>"; the envelope sender must be the bare address.
  from_addr=$(printf '%s' "$from" | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | head -1); [ -n "$from_addr" ] || from_addr="$from"
  local url="smtp://${host}:${port:-587}"; local tls=(--ssl-reqd)
  [ "$secure" = "true" ] && url="smtps://${host}:${port:-465}" && tls=()
  # REPORT_TO may list several addresses, separated by commas or spaces.
  local rcpts=() r
  for r in ${REPORT_TO//,/ }; do rcpts+=(--mail-rcpt "$r"); done
  local to_hdr; to_hdr=$(printf '%s' "${REPORT_TO//,/ }" | tr -s ' ' | sed -e 's/^ //' -e 's/ $//' -e 's/ /, /g')
  local err; err=$(mktemp)
  # Headers and body with LF, turned into CRLF on the way out; curl does the
  # SMTP dot-stuffing itself.
  { printf 'From: AnythingMCP report <%s>\n' "$from_addr"
    printf 'To: %s\n' "$to_hdr"
    printf 'Subject: %s\n' "$subject"
    printf 'Date: %s\n' "$(LC_ALL=C date -R)"
    printf 'MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 8bit\n\n'
    printf '%s\n' "$body"
  } | sed 's/$/\r/' \
    | curl -sS --max-time 60 --url "$url" "${tls[@]}" --mail-from "$from_addr" "${rcpts[@]}" \
        ${user:+--user "$user:$pass"} -T - >/dev/null 2>"$err"
  local rc=$?
  if [ "$rc" = 0 ]; then log "mailed to ${to_hdr}: $subject"
  else log "mail failed (curl $rc): $subject — $(tr -d '\n' < "$err" | cut -c1-200)"; fi
  rm -f "$err"
  return "$rc"
}

# ── SQL ──────────────────────────────────────────────────────────────────────
US=$'\037'   # field separator: never appears in the (sanitised) values
RS=$'\036'   # list separator inside a field
SQL_ERR=$(mktemp); trap 'rm -f "$SQL_ERR"' EXIT

# Runs the SQL on stdin; prints unaligned, tuples-only rows separated by $US.
# Read-only transaction, 5-minute statement cap, UTC session. The columns are
# `timestamp without time zone` holding UTC, so every comparison is made
# against now() AT TIME ZONE 'UTC' and times are converted for display only.
q() {
  docker exec -i \
    -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=300000 -c TimeZone=UTC' \
    "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -X -q -A -t -F "$US" -v ON_ERROR_STOP=1 \
    -v days="$WINDOW_DAYS" -v tz="$REPORT_TZ" -v min_calls="$MIN_CALLS" -v max_rate="$MAX_RATE" \
    -v prev="$PREV_IDS" "$@" 2>>"$SQL_ERR"
}

fail() {
  local why="$1"
  log "report failed: $why — $(tr '\n' ' ' < "$SQL_ERR" | cut -c1-300)"
  if [ "$DRY_RUN" = 0 ] && [ -n "$REPORT_TO" ]; then
    send_mail "[AnythingMCP] weekly stuck-users report FAILED" \
      "The weekly report on ${DOMAIN} could not be built: ${why}."$'\n\n'"$(cut -c1-500 "$SQL_ERR")"$'\n\n'"ssh root@${DOMAIN} 'journalctl -u anythingmcp-stuck-report -n 50'"
  fi
  exit 1
}

# An error message, one line, no query strings / e-mails / long tokens, max 150
# characters. Applied to a column name.
clean() {
  cat <<EOF
(select case when length(e) > 150 then left(e, 149) || '…' else e end from (select
  regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    coalesce(nullif(btrim($1), ''), '(no error text)'),
    '[[:space:][:cntrl:]]+', ' ', 'g'),
    '(https?://[^ ?#]*)[?#][^ ]*', '\\1?…', 'gi'),
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+', '<email>', 'g'),
    '[A-Za-z0-9_-]{32,}', '<token>', 'g') as e) z)
EOF
}
# A name for display: one line, no separators.
oneline() { printf "regexp_replace(coalesce(%s, ''), '[[:space:][:cntrl:]]+', ' ', 'g')" "$1"; }
fmt_ts() { printf "to_char((%s at time zone 'UTC') at time zone :'tz', 'YYYY-MM-DD HH24:MI')" "$1"; }
fmt_day() { printf "to_char((%s at time zone 'UTC') at time zone :'tz', 'YYYY-MM-DD')" "$1"; }
WIN="((now() at time zone 'UTC') - make_interval(days => :days))"
WIN30="((now() at time zone 'UTC') - make_interval(days => 30))"

# ── State: the orgs listed last time ─────────────────────────────────────────
STATE_FILE="$STATE_DIR/stuck-orgs"
FIRST_RUN=0
if [ -r "$STATE_FILE" ]; then
  PREV_IDS=$(grep -E '^[A-Za-z0-9_-]+$' "$STATE_FILE" | paste -sd, -)
else
  FIRST_RUN=1; PREV_IDS=""
fi
PREV_COUNT=0; [ -n "$PREV_IDS" ] && PREV_COUNT=$(printf '%s' "$PREV_IDS" | tr ',' '\n' | grep -c .)
is_prev() { case ",$PREV_IDS," in *",$1,"*) return 0 ;; esac; return 1; }

# ── 0. Header ────────────────────────────────────────────────────────────────
header=$(q <<SQL
select $(fmt_ts "$WIN"), $(fmt_ts "(now() at time zone 'UTC')");
SQL
) || fail "header query"
IFS="$US" read -r WIN_FROM WIN_TO <<< "$header"

# ── 1. Organizations that have never had a successful call ───────────────────
orgs=$(q <<SQL
with win as (
  select ti.organization_id as org_id, ti.connector_id as conn_id, ti.status, ti.created_at, ti.error
  from tool_invocations ti
  where ti.created_at >= $WIN and ti.organization_id is not null
),
stuck as (
  select w.org_id, count(*) as calls, max(w.created_at) as last_call
  from win w
  group by w.org_id
  having bool_and(w.status <> 'SUCCESS')
),
never as (
  select s.* from stuck s
  where not exists (select 1 from tool_invocations t where t.organization_id = s.org_id and t.status = 'SUCCESS')
),
errs as (
  select distinct on (org_id) org_id, e, n from (
    select w.org_id, $(clean w.error) as e, count(*) as n
    from win w join never s using (org_id) group by 1, 2
  ) x order by org_id, n desc, e
),
conns as (
  select org_id, string_agg(name || ' ×' || n, ', ' order by n desc, name) as conns from (
    select w.org_id, coalesce(nullif($(oneline c.name), ''), '(deleted connector)') as name, count(*) as n
    from win w join never s using (org_id) left join connectors c on c.id = w.conn_id
    group by 1, 2
  ) x group by 1
),
people as (
  select org_id, string_agg(email || case when optout then ' [opt-out]' else '' end, ', ' order by since, email) as emails from (
    select m.organization_id as org_id, u.email, u.email_marketing_opt_out as optout, u.created_at as since
    from organization_members m join users u on u.id = m.user_id
    where m.deactivated_at is null and m.organization_id in (select org_id from never)
    union
    select u.organization_id, u.email, u.email_marketing_opt_out, u.created_at
    from users u
    where u.organization_id in (select org_id from never)
      and not exists (select 1 from organization_members m
                      where m.user_id = u.id and m.organization_id = u.organization_id and m.deactivated_at is not null)
  ) p group by 1
)
select s.org_id,
       $(fmt_ts s.last_call),
       $(fmt_day o.created_at),
       coalesce($(oneline p.emails), '(no active member)'),
       coalesce(c.conns, ''),
       s.calls,
       (select count(*) from tool_invocations t where t.organization_id = s.org_id and t.created_at >= $WIN30),
       $(fmt_day "(select min(t.created_at) from tool_invocations t where t.organization_id = s.org_id)"),
       coalesce(e.n, 0),
       coalesce(e.e, '')
from never s
join organizations o on o.id = s.org_id
left join people p on p.org_id = s.org_id
left join conns c on c.org_id = s.org_id
left join errs e on e.org_id = s.org_id
order by s.last_call desc, s.org_id;
SQL
) || fail "stuck organizations query"

ctx=$(q <<SQL
select
  (select count(*) from organizations o
    where exists (select 1 from tool_invocations t where t.organization_id = o.id and t.created_at >= $WIN30)
      and not exists (select 1 from tool_invocations t where t.organization_id = o.id and t.status = 'SUCCESS')),
  (select count(*) from organizations o
    where exists (select 1 from tool_invocations t where t.organization_id = o.id)
      and not exists (select 1 from tool_invocations t where t.organization_id = o.id and t.status = 'SUCCESS')),
  (select count(*) from organizations o
    where o.id = any(string_to_array(nullif(:'prev', ''), ','))
      and exists (select 1 from tool_invocations t where t.organization_id = o.id and t.status = 'SUCCESS'));
SQL
) || fail "30-day context query"
IFS="$US" read -r STUCK_30 STUCK_ALL UNSTUCK <<< "$ctx"

# ── 2. Connectors failing across all organizations ───────────────────────────
# Grouped by the catalog adapter slug; connectors without one (custom, or
# installed before the slug was recorded) are grouped by name and listed only
# when two or more organizations share that name — a single org's own API
# failing is already visible in section 1 or is that org's business.
KEY="case when coalesce(c.config->>'adapterSlug', '') <> '' then 'slug:' || (c.config->>'adapterSlug') else 'name:' || c.name end"
conns=$(q <<SQL
with calls as (
  select $KEY as key, c.name, (c.config->>'adapterSlug') as slug,
         ti.organization_id as org_id, ti.status, ti.created_at, ti.error,
         ti.created_at >= $WIN as in_win
  from tool_invocations ti join connectors c on c.id = ti.connector_id
  where ti.created_at >= $WIN30
),
agg as (
  select key, min(name) as name, min(slug) as slug,
         count(*) filter (where in_win) as calls,
         count(distinct org_id) filter (where in_win) as orgs,
         count(*) filter (where in_win and status = 'SUCCESS') as ok,
         count(*) as calls30,
         count(*) filter (where status = 'SUCCESS') as ok30,
         count(distinct org_id) as orgs30
  from calls group by key
),
failing as (
  select * from agg
  where calls > 0
    and (ok = 0 or (calls >= :min_calls and ok * 100 < :max_rate * calls))
    and (slug is not null or orgs >= 2)
),
errs as (
  select key, string_agg(n || '× ' || e, E'\x1e' order by n desc, e) as errs from (
    select key, e, n, row_number() over (partition by key order by n desc, e) as rn from (
      select c.key, $(clean c.error) as e, count(*) as n
      from calls c join failing f using (key)
      where c.in_win and c.status <> 'SUCCESS' group by 1, 2
    ) x
  ) y where rn <= 3 group by key
)
select f.key,
       $(oneline f.name) || case when f.slug is null then ' (no adapter slug)' else ' (' || $(oneline f.slug) || ')' end,
       f.calls, f.orgs, f.ok, f.calls30, f.ok30,
       coalesce($(fmt_day "(select max(ti.created_at) from tool_invocations ti join connectors c on c.id = ti.connector_id
                   where ti.status = 'SUCCESS' and $KEY = f.key)"), 'never'),
       coalesce(e.errs, '')
from failing f left join errs e using (key)
order by (f.ok = 0) desc, f.orgs desc, f.calls desc, f.key;
SQL
) || fail "failing connectors query"

# ── 3. Signups ───────────────────────────────────────────────────────────────
# One row per user who signed up in the last 30 days, with the stage their
# organization reached: 1 no connector, 2 connector but no call, 3 calls but
# none succeeded, 4 at least one successful call.
signups=$(q <<SQL
select case
         when not exists (select 1 from connectors c where c.organization_id = u.organization_id) then 1
         when not exists (select 1 from tool_invocations t where t.organization_id = u.organization_id) then 2
         when not exists (select 1 from tool_invocations t where t.organization_id = u.organization_id and t.status = 'SUCCESS') then 3
         else 4 end,
       case when u.created_at >= $WIN then 1 else 0 end,
       $(fmt_day u.created_at),
       $(oneline u.email) || case when u.email_marketing_opt_out then ' [opt-out]' else '' end
from users u
where u.created_at >= $WIN30
order by u.created_at desc, u.email;
SQL
) || fail "signups query"

# ── Render ───────────────────────────────────────────────────────────────────
NL=$'\n'
s1=""; n_new=0; n_still=0; CUR_IDS=""
while IFS="$US" read -r org last signup emails cl calls calls30 first errn err; do
  [ -n "$org" ] || continue
  CUR_IDS+="$org$NL"
  if is_prev "$org"; then tag="STILL STUCK"; n_still=$((n_still + 1)); else tag="NEW"; n_new=$((n_new + 1)); fi
  s1+="  [$tag] $emails$NL"
  s1+="    last call $last, signed up $signup, first call $first$NL"
  s1+="    $calls calls this week, $calls30 in 30 days: $cl$NL"
  [ -n "$err" ] && s1+="    most frequent error (${errn}×): $err$NL"
  s1+="$NL"
done <<< "$orgs"
n_orgs=$((n_new + n_still))

s2=""; n_dead=0; n_weak=0
while IFS="$US" read -r key label calls orgs ok calls30 ok30 lastok errs; do
  [ -n "$key" ] || continue
  if [ "$ok" = 0 ]; then n_dead=$((n_dead + 1)); else n_weak=$((n_weak + 1)); fi
  s2+="  $label$NL"
  s2+="    this week: $ok of $calls calls succeeded ($((ok * 100 / calls)) %), $orgs org(s); 30 days: $ok30 of $calls30 ($((calls30 > 0 ? ok30 * 100 / calls30 : 0)) %); last success ever: $lastok$NL"
  if [ -n "$errs" ]; then
    while IFS= read -r line; do s2+="      $line$NL"; done <<< "$(printf '%s' "$errs" | tr "$RS" '\n')"
  fi
  s2+="$NL"
done <<< "$conns"
n_conn=$((n_dead + n_weak))

w_total=0; m_total=0
w1=0; w2=0; w3=0; w4=0; m1=0; m2=0; m3=0; m4=0
list1=""; list2=""
while IFS="$US" read -r stage recent day email; do
  [ -n "$stage" ] || continue
  m_total=$((m_total + 1)); eval "m$stage=\$((m$stage + 1))"
  [ "$recent" = 1 ] || continue
  w_total=$((w_total + 1)); eval "w$stage=\$((w$stage + 1))"
  [ "$stage" = 1 ] && list1+="    $day  $email$NL"
  [ "$stage" = 2 ] && list2+="    $day  $email$NL"
done <<< "$signups"

# ── Summary ──────────────────────────────────────────────────────────────────
plural() { [ "$1" = 1 ] && printf '%s %s' "$1" "$2" || printf '%s %s' "$1" "${3:-$2s}"; }
summary="$(plural "$n_new" "new stuck org") ($n_still still stuck)"
summary+=", $(plural "$n_dead" "connector") failing for everyone"
[ "$n_weak" -gt 0 ] && summary+=" (+$n_weak under ${MAX_RATE} %)"
summary+=", $w1 of $(plural "$w_total" "signup") without a connector"

out="AnythingMCP Cloud — weekly stuck-users report$NL"
out+="Window: $WIN_FROM to $WIN_TO ($REPORT_TZ), last $WINDOW_DAYS days; context: last 30 days.$NL$NL"
out+="SUMMARY: $summary.$NL$NL"

out+="1. ORGANIZATIONS WHOSE TOOL CALLS HAVE NEVER SUCCEEDED$NL"
out+="   Active this week: $n_orgs ($n_new new, $n_still still stuck). Active in the last 30 days: $STUCK_30. All time: $STUCK_ALL.$NL"
if [ "$FIRST_RUN" = 1 ]; then
  out+="   First report: nothing to compare with, so every org is NEW.$NL"
else
  out+="   Since the last report: $UNSTUCK of the $PREV_COUNT orgs listed then have had a successful call.$NL"
fi
out+="$NL"
[ -n "$s1" ] && out+="$s1" || out+="  None.$NL$NL"

out+="2. CONNECTORS FAILING FOR EVERYONE (0 % success, or under ${MAX_RATE} % with ${MIN_CALLS}+ calls, this week)$NL$NL"
[ -n "$s2" ] && out+="$s2" || out+="  None.$NL$NL"

out+="3. SIGNUPS THIS WEEK (last 30 days in brackets)$NL"
out+="  $w_total signed up [$m_total]$NL"
out+="  $w1 never created a connector [$m1]$NL"
out+="  $w2 created a connector but never made a call [$m2]$NL"
out+="  $w3 made calls, none succeeded [$m3]$NL"
out+="  $w4 have had a successful call [$m4]$NL$NL"
for which in 1 2; do
  eval "cnt=\$w$which; list=\$list$which"
  [ "$cnt" -gt 0 ] || continue
  [ "$which" = 1 ] && title="Never created a connector" || title="Created a connector, never made a call"
  if [ "$cnt" -le "$LIST_MAX" ]; then out+="  $title ($cnt):$NL$list$NL"
  else out+="  $title: $cnt, more than REPORT_LIST_MAX=$LIST_MAX, not listed.$NL$NL"; fi
done

out+="--$NL"
out+="Generated by deploy/cloud/stuck-users-report.sh on $(hostname) for ${DOMAIN}.$NL"
out+="Contains customer e-mail addresses: keep it inside the team. Error texts are cut to 150$NL"
out+="characters, with URL query strings, e-mail addresses and long tokens removed.$NL"

subject="[AnythingMCP] Weekly stuck users: $summary"

if [ "$DRY_RUN" = 1 ]; then
  printf 'Subject: %s\n\n%s' "$subject" "$out"
  echo "(dry run: state not updated, nothing mailed)" >&2
  exit 0
fi

# ── Deliver, then remember who was listed ────────────────────────────────────
# The state moves on only when the report reached someone (or, with no
# recipient configured, the journal): after a failed send, next week's report
# still calls these orgs NEW, since nobody has seen them yet.
if [ -n "$REPORT_TO" ]; then
  send_mail "$subject" "$out" || exit 1
else
  log "no REPORT_TO or UPTIME_ALERT_TO — report follows on stdout"
  printf 'Subject: %s\n\n%s' "$subject" "$out"
fi
mkdir -p "$STATE_DIR"
printf '%s' "$CUR_IDS" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
log "report done: $summary"
exit 0
