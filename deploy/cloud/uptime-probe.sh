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
#   uptime-probe.sh            probe, update state, mail on change
#   uptime-probe.sh --dry-run  probe and print, touch nothing, send nothing
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

log() { logger -t anythingmcp-probe -- "$*" 2>/dev/null || true; [ "$DRY_RUN" = 1 ] && echo "$*"; }

# ── Probes ───────────────────────────────────────────────────────────────────
fail=0; report=""
note() { report+="$1"$'\n'; }

code=$(curl -sS -o /tmp/probe-health.json -w '%{http_code}' --max-time 15 "https://${DOMAIN}/health" 2>/dev/null || echo 000)
status=$(sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' /tmp/probe-health.json 2>/dev/null | head -1)
heap=$(sed -n 's/.*"heap":{[^}]*"usedMb":\([0-9]*\)[^}]*"limitMb":\([0-9]*\)[^}]*"percent":\([0-9.]*\).*/\3% of \2 MB (\1 MB)/p' /tmp/probe-health.json 2>/dev/null | head -1)
if [ "$code" = "200" ] && [ "$status" = "ok" ]; then
  note "ok   /health 200 ok, heap ${heap:-n/a}"
else
  fail=1; note "FAIL /health HTTP $code status=${status:-?} heap ${heap:-n/a}"
fi

code=$(curl -sS -o /tmp/probe-mcp.txt -w '%{http_code}' --max-time 20 -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  "https://${DOMAIN}/mcp/demo" 2>/dev/null || echo 000)
if [ "$code" = "200" ] && grep -q '"tools"' /tmp/probe-mcp.txt 2>/dev/null; then
  note "ok   /mcp/demo tools/list 200"
else
  fail=1; note "FAIL /mcp/demo HTTP $code"
fi

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/login" 2>/dev/null || echo 000)
if [ "$code" = "200" ]; then note "ok   /login 200"; else fail=1; note "FAIL /login HTTP $code"; fi

now=$(date -u +%s)
stamp=$(date -u +'%Y-%m-%d %H:%M:%S UTC')

if [ "$DRY_RUN" = 1 ]; then
  printf '%s' "$report"; echo "result: $([ "$fail" = 1 ] && echo DOWN || echo UP)  (dry run: no state, no mail)"; exit "$fail"
fi

# ── State ────────────────────────────────────────────────────────────────────
mkdir -p "$STATE_DIR"
prev=$(cat "$STATE_DIR/state" 2>/dev/null || echo "up")   # "up" | "down:<epoch>"

send_mail() {
  local subject="$1" body="$2"
  [ -n "$ALERT_TO" ] || { log "no UPTIME_ALERT_TO — would have mailed: $subject"; return 0; }
  local host port user pass from secure
  host=$(envval SMTP_HOST); port=$(envval SMTP_PORT); user=$(envval SMTP_USER); pass=$(envval SMTP_PASS); from=$(envval SMTP_FROM); secure=$(envval SMTP_SECURE)
  [ -n "$host" ] && [ -n "$from" ] || { log "SMTP not configured — would have mailed: $subject"; return 0; }
  local url="smtp://${host}:${port:-587}" ; local tls=(--ssl-reqd)
  [ "$secure" = "true" ] && url="smtps://${host}:${port:-465}" && tls=()
  printf 'From: AnythingMCP probe <%s>\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
    "$from" "$ALERT_TO" "$subject" "$body" \
    | curl -sS --max-time 30 --url "$url" "${tls[@]}" --mail-from "$from" --mail-rcpt "$ALERT_TO" \
        ${user:+--user "$user:$pass"} -T - >/dev/null 2>/tmp/probe-mail.err \
    && log "mailed: $subject" || log "mail failed: $subject — $(tr -d '\n' < /tmp/probe-mail.err | cut -c1-200)"
}

if [ "$fail" = 1 ]; then
  log "DOWN — ${report//$'\n'/ | }"
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
