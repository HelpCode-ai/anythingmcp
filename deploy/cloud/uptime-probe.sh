#!/usr/bin/env bash
# =============================================================================
# AnythingMCP Cloud — uptime probe, run by a systemd timer on the droplet.
#
# Why this lives here and not in GitHub Actions: the scheduled workflow
# (.github/workflows/uptime.yml) ran three times in the ten hours after it was
# merged. GitHub's cron is best-effort and this repository is not busy enough
# to be scheduled on time. The failure mode we actually have — the backend
# process dies, the droplet stays up — is exactly the one a timer on the
# droplet can see, every minute, with nothing in between to be late.
#
# Probes the public URL (through Caddy, like a customer), keeps one line of
# state, and emails on a change of state only: once when it goes down, once
# when it comes back, with how long it was gone. Mail goes through the same
# SMTP the backend uses for its own transactional mail, read from the
# deployment's .env; if UPTIME_ALERT_TO is unset it logs to the journal and
# sends nothing.
#
#   uptime-probe.sh              probe, update state, mail on change
#   uptime-probe.sh --dry-run    probe and print, touch nothing, send nothing
#   uptime-probe.sh --test-mail  send one test mail to UPTIME_ALERT_TO and exit
# =============================================================================
set -uo pipefail

ENV_FILE="${ENV_FILE:-/opt/anythingmcp-cloud/.env}"
STATE_DIR="${STATE_DIR:-/var/lib/anythingmcp-probe}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# One value from the .env, without sourcing it (values may hold anything).
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }

DOMAIN="${DOMAIN:-$(envval DOMAIN)}"
ALERT_TO="${UPTIME_ALERT_TO:-$(envval UPTIME_ALERT_TO)}"
[ -n "$DOMAIN" ] || { echo "no DOMAIN in $ENV_FILE" >&2; exit 2; }

# Returns 0 always: the old one-liner ended on `[ "$DRY_RUN" = 1 ] && echo`,
# which is false outside a dry run, so every successful send_mail fell into its
# own `|| { log "mail failed" ...; return 1; }`. The journal for the 21 Sep
# recovery mail reads "mailed" and "mail failed" on the same second, and
# --test-mail exited 1 on a mail that had arrived.
log() {
  logger -t anythingmcp-probe -- "$*" 2>/dev/null || true
  [ "$DRY_RUN" = 1 ] && echo "$*"
  return 0
}

send_mail() {
  local subject="$1" body="$2"
  [ -n "$ALERT_TO" ] || { log "no UPTIME_ALERT_TO — would have mailed: $subject"; return 0; }
  local host port user pass from secure from_addr
  host=$(envval SMTP_HOST); port=$(envval SMTP_PORT); user=$(envval SMTP_USER); pass=$(envval SMTP_PASS); from=$(envval SMTP_FROM); secure=$(envval SMTP_SECURE)
  [ -n "$host" ] && [ -n "$from" ] || { log "SMTP not configured — would have mailed: $subject"; return 0; }
  # SMTP_FROM may be "Name <addr>"; the envelope sender must be the bare address.
  from_addr=$(printf '%s' "$from" | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | head -1); [ -n "$from_addr" ] || from_addr="$from"
  local url="smtp://${host}:${port:-587}"; local tls=(--ssl-reqd)
  [ "$secure" = "true" ] && url="smtps://${host}:${port:-465}" && tls=()
  printf 'From: AnythingMCP probe <%s>\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
    "$from_addr" "$ALERT_TO" "$subject" "$body" \
    | curl -sS --max-time 30 --url "$url" "${tls[@]}" --mail-from "$from_addr" --mail-rcpt "$ALERT_TO" \
        ${user:+--user "$user:$pass"} -T - >/dev/null 2>/tmp/probe-mail.err \
    && log "mailed: $subject" || { log "mail failed: $subject — $(tr -d '\n' < /tmp/probe-mail.err | cut -c1-200)"; return 1; }
}

if [ "${1:-}" = "--test-mail" ]; then
  DRY_RUN=1
  send_mail "[AnythingMCP] probe test mail" "$(date -u +'%Y-%m-%d %H:%M:%S UTC')"$'\n\n'"If you can read this, the uptime probe on ${DOMAIN} can reach you. It will write again only when the site changes state."
  exit $?
fi

# ── Probes ───────────────────────────────────────────────────────────────────
fail=0; report=""
note() { report+="$1"$'\n'; }

# Truncate the body first, and take the code from curl's own -w rather than
# from an `|| echo 000` that appends a second one. A connection that never
# happens (DNS, TLS, timeout) leaves -o untouched, so the old form both
# printed "HTTP 000000" and parsed *last* minute's body: a DOWN mail could
# report "status=ok heap 12%" for a backend that had not answered at all.
: > /tmp/probe-health.json
code=$(curl -sS -o /tmp/probe-health.json -w '%{http_code}' --max-time 15 "https://${DOMAIN}/health" 2>/dev/null); code=${code:-000}
# Anchored at the start: terminus nests a "status" per indicator, and a
# greedy match reads the last one ("up" for the heap) instead of the verdict.
status=$(sed -n 's/^{"status":"\([a-z]*\)".*/\1/p' /tmp/probe-health.json 2>/dev/null | head -1)
heap=$(sed -n 's/.*"heap":{[^}]*"usedMb":\([0-9]*\)[^}]*"limitMb":\([0-9]*\)[^}]*"percent":\([0-9.]*\).*/\3% of \2 MB (\1 MB)/p' /tmp/probe-health.json 2>/dev/null | head -1)
if [ "$code" = "200" ] && [ "$status" = "ok" ]; then
  note "ok   /health 200 ok, heap ${heap:-n/a}"
else
  fail=1; note "FAIL /health HTTP $code status=${status:-?} heap ${heap:-n/a}"
fi

: > /tmp/probe-mcp.txt
code=$(curl -sS -o /tmp/probe-mcp.txt -w '%{http_code}' --max-time 20 -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  "https://${DOMAIN}/mcp/demo" 2>/dev/null); code=${code:-000}
if [ "$code" = "200" ] && grep -q '"tools"' /tmp/probe-mcp.txt 2>/dev/null; then
  note "ok   /mcp/demo tools/list 200"
else
  fail=1; note "FAIL /mcp/demo HTTP $code"
fi

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/login" 2>/dev/null); code=${code:-000}
if [ "$code" = "200" ]; then note "ok   /login 200"; else fail=1; note "FAIL /login HTTP $code"; fi

now=$(date -u +%s)
stamp=$(date -u +'%Y-%m-%d %H:%M:%S UTC')

if [ "$DRY_RUN" = 1 ]; then
  printf '%s' "$report"; echo "result: $([ "$fail" = 1 ] && echo DOWN || echo UP)  (dry run: no state, no mail)"; exit "$fail"
fi

# ── State ────────────────────────────────────────────────────────────────────
mkdir -p "$STATE_DIR"
prev=$(cat "$STATE_DIR/state" 2>/dev/null || echo "up")   # "up" | "down:<epoch>"

# A deploy recreates the two app containers, and Caddy answers 502 for the ~20 s
# in between. On 21 Sep that window landed on a tick and mailed a DOWN for a
# planned deploy — the kind of false page that teaches you to ignore the real
# one. deploy-cloud.yml writes an expiry epoch here before it touches a
# container and clears it on every exit path, the failing ones included. The
# marker carries an expiry rather than being a bare flag so that a deploy killed
# mid-flight cannot silence the probe for good: the silence ends by itself and a
# site still down mails as usual.
maintenance_until=$(head -1 "$STATE_DIR/maintenance" 2>/dev/null | tr -cd '0-9')
[ -n "$maintenance_until" ] || maintenance_until=0


if [ "$fail" = 1 ]; then
  log "DOWN — ${report//$'\n'/ | }"
  if [ "$now" -lt "$maintenance_until" ]; then
    log "suppressed: deploy in progress until $(date -u -d "@$maintenance_until" +'%H:%M:%S UTC') — no mail, state left as '$prev'"
    exit 0
  fi
  case "$prev" in
    down:*) : ;;  # still down; the first mail said so
    *) echo "down:$now" > "$STATE_DIR/state"
       send_mail "[AnythingMCP] cloud.${DOMAIN#cloud.} is DOWN" \
         "$stamp"$'\n\n'"$report"$'\n'"Probed every minute from the droplet. You will get one more mail when it recovers."$'\n\n'"ssh root@${DOMAIN} 'docker ps; docker logs --tail 50 amcp-cloud-backend'"
       ;;
  esac
else
  case "$prev" in
    down:*) since=${prev#down:}; mins=$(( (now - since) / 60 ))
       echo "up" > "$STATE_DIR/state"
       log "RECOVERED after ${mins} min"
       send_mail "[AnythingMCP] recovered after ${mins} min" "$stamp"$'\n\n'"$report"
       ;;
    *) : ;;
  esac
fi
exit 0
