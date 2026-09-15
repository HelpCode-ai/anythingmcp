#!/bin/sh
# Boot MOTIS on the latest gtfs.de train timetable and keep it fresh.
#
# Layout under $MOTIS_DATA_DIR (a volume):
#   feeds/        the GTFS zips the current data was built from
#   current/      the imported data the server is running on
#   staging/      a freshly imported data set waiting to be swapped in
#   .imported     epoch of the last successful import
#
# The static feeds are re-downloaded and re-imported every $MOTIS_REFRESH_DAYS
# days. The import runs while the old server keeps answering; only the swap
# restarts it (a few seconds, and docker's healthcheck covers it). A failed
# refresh leaves the running data untouched and is retried on the next check.
set -eu

DATA="${MOTIS_DATA_DIR:-/data}"
FEEDS="$DATA/feeds"
CURRENT="$DATA/current"
STAGING="$DATA/staging"
STAMP="$DATA/.imported"
REFRESH_DAYS="${MOTIS_REFRESH_DAYS:-7}"
CHECK_INTERVAL="${MOTIS_REFRESH_CHECK_SECONDS:-3600}"
FV_URL="${MOTIS_GTFS_FV_URL:-https://download.gtfs.de/germany/fv_free/latest.zip}"
RV_URL="${MOTIS_GTFS_RV_URL:-https://download.gtfs.de/germany/rv_free/latest.zip}"
RT_URL="${MOTIS_GTFS_RT_URL:-https://realtime.gtfs.de/realtime-free.pb}"
UA="anythingmcp-motis/1.0 (+https://anythingmcp.com)"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [entrypoint] $*"; }

needs_refresh() {
  [ -f "$CURRENT/tt.bin" ] || return 0
  [ -f "$STAMP" ] || return 0
  now=$(date +%s)
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  [ $((now - last)) -ge $((REFRESH_DAYS * 86400)) ]
}

# Download both feeds and import them into $STAGING. Never touches $CURRENT.
build_staging() {
  tmp="$DATA/feeds.new"
  rm -rf "$tmp" "$STAGING"
  mkdir -p "$tmp"
  log "downloading $FV_URL"
  wget -q -U "$UA" -O "$tmp/fv.zip" "$FV_URL"
  log "downloading $RV_URL"
  wget -q -U "$UA" -O "$tmp/rv.zip" "$RV_URL"
  # A truncated or HTML "download" would fail the import; check the zip magic
  # first so the log names the real problem.
  for f in fv rv; do
    if [ "$(head -c 2 "$tmp/$f.zip")" != "PK" ]; then
      log "$f.zip is not a zip file (got: $(head -c 40 "$tmp/$f.zip"))"
      return 1
    fi
  done
  sed -e "s#__FEEDS__#$tmp#g" -e "s#__RT_URL__#$RT_URL#g" \
    /motis-config/config.yml > "$DATA/config.import.yml"
  log "importing"
  /motis import -c "$DATA/config.import.yml" -d "$STAGING"
  rm -rf "$FEEDS"
  mv "$tmp" "$FEEDS"
  log "import finished"
}

swap_in_staging() {
  rm -rf "$DATA/previous"
  [ -d "$CURRENT" ] && mv "$CURRENT" "$DATA/previous"
  mv "$STAGING" "$CURRENT"
  rm -rf "$DATA/previous"
  date +%s > "$STAMP"
}

# First boot, or the data on the volume is stale: build before serving.
if needs_refresh; then
  if build_staging; then
    swap_in_staging
  elif [ -f "$CURRENT/tt.bin" ]; then
    log "refresh failed; serving the previous data set"
  else
    log "no data set to serve"
    exit 1
  fi
fi

while :; do
  log "starting server on $CURRENT"
  /motis server -d "$CURRENT" &
  pid=$!
  swap=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$CHECK_INTERVAL" &
    wait $! || true
    kill -0 "$pid" 2>/dev/null || break
    if needs_refresh; then
      if build_staging; then
        swap=1
        log "restarting server on the new data set"
        kill "$pid"
        wait "$pid" || true
        swap_in_staging
        break
      else
        # Retried at the next check (hourly by default); the current data
        # set keeps serving meanwhile.
        log "refresh failed; keeping the current data set"
      fi
    fi
  done
  if [ "$swap" -eq 0 ]; then
    # The server died on its own; surface that so docker restarts the container.
    wait "$pid" && exit 0 || exit $?
  fi
done
