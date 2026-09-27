#!/usr/bin/env bash
# =============================================================================
# AnythingMCP Cloud — daily trial report, run by a systemd timer on the droplet
# (deploy/cloud/systemd/anythingmcp-trial-report.{service,timer}).
#
# Why: most buyers either pay on the day they sign up or when their 7-day
# trial runs out, and until 2026-09-27 the only way to see how a cohort was
# doing was a query run by hand. The 21–25 Sep sign-up wave (about 70 trials)
# ends between 30 Sep and 2 Oct; this mails, every morning:
#
#   1. licences that became paid in the last 24 hours;
#   2. trials that end in the next 3 days, with how far each workspace got
#      (connector, calls, a successful call) and which trial e-mails went out;
#   3. trials that ended in the last 24 hours, converted or not;
#   4. conversion by expiry day over the last 14 days.
#
# Read-only: every query runs in a read-only transaction through `docker exec`
# into the Postgres container, like stuck-users-report.sh. No tool inputs,
# outputs, credentials or error texts are selected; the report does carry the
# admins' e-mail addresses, so it goes to the team only.
#
# Mail goes through the backend's SMTP (from the deployment's .env) to
# REPORT_TO, falling back to UPTIME_ALERT_TO; with neither set it is written
# to stdout, i.e. `journalctl -u anythingmcp-trial-report`.
#
#   trial-report.sh              build and mail
#   trial-report.sh --dry-run    build and print; nothing mailed
#
# Tunables (environment or .env): REPORT_TO, REPORT_TZ (Europe/Berlin),
# TRIAL_REPORT_AHEAD_DAYS (3), REPORT_LIST_MAX (40).
# Plumbing (environment only): ENV_FILE, PG_CONTAINER, PG_USER, PG_DB.
# =============================================================================
set -uo pipefail

ENV_FILE="${ENV_FILE:-/opt/anythingmcp-cloud/.env}"
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

envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
setting() { local v; eval "v=\${$1:-}"; [ -n "$v" ] || v=$(envval "$1"); printf '%s' "${v:-$2}"; }

DOMAIN=$(setting DOMAIN "cloud.anythingmcp.com")
REPORT_TO=$(setting REPORT_TO "")
[ -n "$REPORT_TO" ] || REPORT_TO=$(setting UPTIME_ALERT_TO "")
REPORT_TZ=$(setting REPORT_TZ "Europe/Berlin")
AHEAD=$(setting TRIAL_REPORT_AHEAD_DAYS 3)
LIST_MAX=$(setting REPORT_LIST_MAX 40)
for n in AHEAD LIST_MAX; do
  eval "v=\$$n"
  case "$v" in ''|*[!0-9]*) echo "$n must be a whole number, got '$v'" >&2; exit 2 ;; esac
done
case "$REPORT_TZ" in *[!A-Za-z0-9/_+-]*) echo "REPORT_TZ looks wrong: '$REPORT_TZ'" >&2; exit 2 ;; esac

log() {
  logger -t anythingmcp-trial-report -- "$*" 2>/dev/null || true
  [ "$DRY_RUN" = 1 ] && echo "$*" >&2
  return 0
}

# ── Mail (same SMTP handling as stuck-users-report.sh) ───────────────────────
send_mail() {
  local subject="$1" body="$2"
  local host port user pass from secure from_addr
  host=$(envval SMTP_HOST); port=$(envval SMTP_PORT); user=$(envval SMTP_USER); pass=$(envval SMTP_PASS); from=$(envval SMTP_FROM); secure=$(envval SMTP_SECURE)
  [ -n "$host" ] && [ -n "$from" ] || { log "SMTP not configured — cannot mail: $subject"; return 1; }
  from_addr=$(printf '%s' "$from" | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | head -1); [ -n "$from_addr" ] || from_addr="$from"
  local url="smtp://${host}:${port:-587}"; local tls=(--ssl-reqd)
  [ "$secure" = "true" ] && url="smtps://${host}:${port:-465}" && tls=()
  local rcpts=() r
  for r in ${REPORT_TO//,/ }; do rcpts+=(--mail-rcpt "$r"); done
  local to_hdr; to_hdr=$(printf '%s' "${REPORT_TO//,/ }" | tr -s ' ' | sed -e 's/^ //' -e 's/ $//' -e 's/ /, /g')
  local err; err=$(mktemp)
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
US=$'\037'
SQL_ERR=$(mktemp); trap 'rm -f "$SQL_ERR"' EXIT

# Timestamps are `timestamp without time zone` holding UTC: compare against
# now() at time zone 'UTC', convert for display only.
q() {
  docker exec -i \
    -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=120000 -c TimeZone=UTC' \
    "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -X -q -A -t -F "$US" -v ON_ERROR_STOP=1 \
    -v tz="$REPORT_TZ" -v ahead="$AHEAD" "$@" 2>>"$SQL_ERR"
}

fail() {
  log "report failed: $1 — $(tr '\n' ' ' < "$SQL_ERR" | cut -c1-300)"
  if [ "$DRY_RUN" = 0 ] && [ -n "$REPORT_TO" ]; then
    send_mail "[AnythingMCP] daily trial report FAILED" \
      "The daily trial report on ${DOMAIN} could not be built: $1."$'\n\n'"$(cut -c1-500 "$SQL_ERR")"$'\n\n'"ssh root@${DOMAIN} 'journalctl -u anythingmcp-trial-report -n 50'"
  fi
  exit 1
}

NOW="(now() at time zone 'UTC')"
fmt_day() { printf "to_char((%s at time zone 'UTC') at time zone :'tz', 'YYYY-MM-DD')" "$1"; }
fmt_ts() { printf "to_char((%s at time zone 'UTC') at time zone :'tz', 'YYYY-MM-DD HH24:MI')" "$1"; }
oneline() { printf "regexp_replace(coalesce(%s, ''), '[[:space:][:cntrl:]]+', ' ', 'g')" "$1"; }

# Admin e-mails of an organization, active memberships only.
admins() {
  cat <<EOF
(select string_agg($(oneline u.email), ', ' order by u.created_at)
   from organization_members m join users u on u.id = m.user_id
  where m.organization_id = $1 and m.role = 'ADMIN' and m.deactivated_at is null)
EOF
}
# How far the workspace got: 1 no connector, 2 no call, 3 no successful call, 4 success.
stage() {
  cat <<EOF
case
  when not exists (select 1 from connectors c where c.organization_id = $1) then 'no connector'
  when not exists (select 1 from tool_invocations t where t.organization_id = $1) then 'connector, no call'
  when not exists (select 1 from tool_invocations t where t.organization_id = $1 and t.status = 'SUCCESS') then 'calls, none succeeded'
  else (select count(*) from tool_invocations t where t.organization_id = $1 and t.status = 'SUCCESS') || ' successful calls'
end
EOF
}
# A paid licence for the organization, created at or after the given time.
paid_since() {
  printf "exists (select 1 from licenses p where p.organization_id = %s and p.plan <> 'trial' and p.status = 'active' and p.created_at >= %s)" "$1" "$2"
}

header=$(q <<SQL
select $(fmt_ts "$NOW");
SQL
) || fail "header query"
NOW_TXT="$header"

# 1. Paid in the last 24 hours.
paid=$(q <<SQL
select $(fmt_ts l.created_at), l.plan, coalesce($(admins l.organization_id), '(no admin)'),
       coalesce($(fmt_day "(select min(u.created_at) from users u join organization_members m on m.user_id = u.id where m.organization_id = l.organization_id)"), '?')
from licenses l
where l.plan <> 'trial' and l.organization_id is not null
  and l.created_at >= $NOW - interval '24 hours'
order by l.created_at;
SQL
) || fail "paid query"

# 2. Trials ending in the next AHEAD days.
ending=$(q <<SQL
select $(fmt_ts l.expires_at), coalesce($(admins l.organization_id), '(no admin)'),
       $(fmt_day l.created_at), $(stage l.organization_id),
       coalesce((select string_agg(replace(s.key, 'trial_email_', ''), '+' order by s.key)
                   from org_settings s where s.organization_id = l.organization_id and s.key like 'trial_email_%'), '-')
from licenses l
where l.plan = 'trial' and l.status = 'active' and l.organization_id is not null
  and l.expires_at >= $NOW and l.expires_at < $NOW + make_interval(days => :ahead)
  and not $(paid_since l.organization_id l.created_at)
order by l.expires_at;
SQL
) || fail "ending query"

# 3. Trials that ended in the last 24 hours.
ended=$(q <<SQL
select case when $(paid_since l.organization_id l.created_at) then 'PAID' else 'lapsed' end,
       $(fmt_ts l.expires_at), coalesce($(admins l.organization_id), '(no admin)'), $(stage l.organization_id)
from licenses l
where l.plan = 'trial' and l.organization_id is not null
  and l.expires_at >= $NOW - interval '24 hours' and l.expires_at < $NOW
order by 1, l.expires_at;
SQL
) || fail "ended query"

# 4. Conversion by expiry day, last 14 days and the next AHEAD.
cohort=$(q <<SQL
select $(fmt_day l.expires_at) as day, count(*),
       count(*) filter (where $(paid_since l.organization_id l.created_at)),
       count(*) filter (where exists (select 1 from tool_invocations t where t.organization_id = l.organization_id and t.status = 'SUCCESS'))
from licenses l
where l.plan = 'trial' and l.organization_id is not null
  and l.expires_at >= $NOW - interval '14 days' and l.expires_at < $NOW + make_interval(days => :ahead)
group by 1 order by 1;
SQL
) || fail "cohort query"

# ── Render ───────────────────────────────────────────────────────────────────
NL=$'\n'
n_paid=0; s1=""
while IFS="$US" read -r at plan who signup; do
  [ -n "$at" ] || continue
  n_paid=$((n_paid + 1)); s1+="  $at  $plan  $who (signed up $signup)$NL"
done <<< "$paid"

n_end=0; s2=""
while IFS="$US" read -r at who created st mails; do
  [ -n "$at" ] || continue
  n_end=$((n_end + 1))
  [ "$n_end" -le "$LIST_MAX" ] && s2+="  ends $at  $who$NL    trial since $created; $st; e-mails sent: $mails$NL"
done <<< "$ending"
[ "$n_end" -gt "$LIST_MAX" ] && s2+="  … and $((n_end - LIST_MAX)) more (REPORT_LIST_MAX=$LIST_MAX).$NL"

n_ended=0; n_conv=0; s3=""
while IFS="$US" read -r res at who st; do
  [ -n "$res" ] || continue
  n_ended=$((n_ended + 1)); [ "$res" = PAID ] && n_conv=$((n_conv + 1))
  [ "$n_ended" -le "$LIST_MAX" ] && s3+="  [$res] $at  $who — $st$NL"
done <<< "$ended"

s4=""
while IFS="$US" read -r day total conv active; do
  [ -n "$day" ] || continue
  s4+="  $day  $total trials, $conv paid, $active with a successful call$NL"
done <<< "$cohort"

summary="$n_paid paid in 24 h, $n_end trials end in ${AHEAD} days, $n_conv of $n_ended ended yesterday converted"
out="AnythingMCP Cloud — daily trial report ($NOW_TXT $REPORT_TZ)$NL$NL"
out+="SUMMARY: $summary.$NL$NL"
out+="1. BECAME PAID IN THE LAST 24 HOURS$NL"; [ -n "$s1" ] && out+="$s1$NL" || out+="  None.$NL$NL"
out+="2. TRIALS ENDING IN THE NEXT ${AHEAD} DAYS (not yet paid)$NL"; [ -n "$s2" ] && out+="$s2$NL" || out+="  None.$NL$NL"
out+="3. TRIALS THAT ENDED IN THE LAST 24 HOURS$NL"; [ -n "$s3" ] && out+="$s3$NL" || out+="  None.$NL$NL"
out+="4. CONVERSION BY EXPIRY DAY (last 14 days, next ${AHEAD})$NL"; [ -n "$s4" ] && out+="$s4$NL" || out+="  None.$NL$NL"
out+="--$NL"
out+="Generated by deploy/cloud/trial-report.sh on $(hostname) for ${DOMAIN}.$NL"
out+="Contains customer e-mail addresses: keep it inside the team.$NL"

subject="[AnythingMCP] Trials: $summary"

if [ "$DRY_RUN" = 1 ]; then
  printf 'Subject: %s\n\n%s' "$subject" "$out"
  echo "(dry run: nothing mailed)" >&2
  exit 0
fi
if [ -n "$REPORT_TO" ]; then
  send_mail "$subject" "$out" || exit 1
else
  log "no REPORT_TO or UPTIME_ALERT_TO — report follows on stdout"
  printf 'Subject: %s\n\n%s' "$subject" "$out"
fi
log "report done: $summary"
exit 0
