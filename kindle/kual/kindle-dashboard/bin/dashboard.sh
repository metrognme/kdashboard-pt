#!/bin/sh

CONFIG="${DASHBOARD_CONFIG:-/mnt/us/extensions/kindle-dashboard/config.sh}"
[ -f "$CONFIG" ] && . "$CONFIG"

DASHBOARD_DATA_URL="${DASHBOARD_DATA_URL:-}"
DASHBOARD_EVENTS_URL="${DASHBOARD_EVENTS_URL:-}"
DASHBOARD_TOGGLE_URL="${DASHBOARD_TOGGLE_URL:-}"
DASHBOARD_READ_TOKEN="${DASHBOARD_READ_TOKEN:-}"
DASHBOARD_TOGGLE_TOKEN="${DASHBOARD_TOGGLE_TOKEN:-}"
CACHE="${CACHE:-/mnt/us/documents/kindle-dashboard-data.json}"
LOG="${LOG:-/mnt/us/documents/kindle-dashboard-native.log}"
PIDFILE="${PIDFILE:-/mnt/us/documents/kindle-dashboard-native.pid}"
SAVE_PGM="${SAVE_PGM:-/mnt/us/documents/kindle-dashboard-last-render.pgm}"
INTERVAL="${INTERVAL:-300}"
DASHBOARD_KEEP_AWAKE="${DASHBOARD_KEEP_AWAKE:-1}"
DASHBOARD_SLEEP_WINDOW="${DASHBOARD_SLEEP_WINDOW:-off}"
DASHBOARD_TITLE="${DASHBOARD_TITLE:-Kindle Dashboard}"
DASHBOARD_TIMEZONE="${DASHBOARD_TIMEZONE:-}"
[ -n "$DASHBOARD_TIMEZONE" ] && export TZ="$DASHBOARD_TIMEZONE"
# Dark mode. DARK_MODE is the current name; INVERT_IMAGES is what config.sh
# files written before it call the same setting, and it still works, so an
# upgrade keeps whatever the device was already set to.
DARK_MODE="${DARK_MODE:-${INVERT_IMAGES:-0}}"
[ -n "$DASHBOARD_FORCE_DARK_MODE" ] && DARK_MODE="$DASHBOARD_FORCE_DARK_MODE"
[ -n "$DASHBOARD_FORCE_INVERT_IMAGES" ] && DARK_MODE="$DASHBOARD_FORCE_INVERT_IMAGES"
SCRIPT_DIR="$(dirname "$0")"
NATIVE_APP="${NATIVE_APP:-$SCRIPT_DIR/kindle-dashboard}"
RUN_APP="${RUN_APP:-/tmp/kindle-dashboard-native}"
SHOW_STATUS="${DASHBOARD_SHOW_STATUS:-0}"

say() {
  [ "$SHOW_STATUS" = "1" ] && eips 2 2 "$1" >/dev/null 2>&1 || true
}

# Sets $theme_args, used by both the always-on start path and the one-shot
# refresh path below - a single spot so a future flag rename only needs one
# edit in this file (see the sibling copy in kindle/launch-dashboard.sh for
# why it isn't shared across both).
dark_mode_theme_args() {
  theme_args=""
  [ "$DARK_MODE" = "1" ] && theme_args="--dark"
}

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

keep_awake() {
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 >/dev/null 2>&1 || true
}

allow_sleep() {
  lipc-set-prop com.lab126.powerd preventScreenSaver 0 >/dev/null 2>&1 || true
}

enable_wifi() {
  lipc-set-prop com.lab126.cmd wirelessEnable 1 >/dev/null 2>&1 || true
}

stop_existing_processes() {
  if [ -s "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null)"
    [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1 || true
    rm -f "$PIDFILE"
  fi
  pkill -f "$NATIVE_APP" >/dev/null 2>&1 || true
  pkill -f "$RUN_APP" >/dev/null 2>&1 || true
}

is_running() {
  if [ ! -s "$PIDFILE" ]; then
    return 1
  fi

  pid="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

start_dashboard() {
  log "start action reached; native_app=$NATIVE_APP"
  stop_existing_processes

  if [ ! -x "$NATIVE_APP" ]; then
    log "missing native app: $NATIVE_APP"
    say "Native app missing"
    return 1
  fi
  if [ -z "$DASHBOARD_DATA_URL" ]; then
    log "missing DASHBOARD_DATA_URL; create /mnt/us/extensions/kindle-dashboard/config.sh"
    say "Dashboard config missing"
    return 1
  fi

  cp "$NATIVE_APP" "$RUN_APP" >> "$LOG" 2>&1
  chmod 755 "$RUN_APP" >> "$LOG" 2>&1
  if [ ! -x "$RUN_APP" ]; then
    log "native app copy not executable: $RUN_APP"
    say "Native copy failed"
    return 1
  fi

  if [ "$DASHBOARD_KEEP_AWAKE" = "1" ]; then
    keep_awake
  else
    allow_sleep
  fi
  enable_wifi
  log "starting native dashboard interval=$INTERVAL keep_awake=$DASHBOARD_KEEP_AWAKE sleep_window=$DASHBOARD_SLEEP_WINDOW timezone=${TZ:-kindle-local}"
  dark_mode_theme_args
  save_args=""
  [ -n "$SAVE_PGM" ] && save_args="--save-pgm $SAVE_PGM"
  nohup "$RUN_APP" \
    --url "$DASHBOARD_DATA_URL" \
    --events-url "$DASHBOARD_EVENTS_URL" \
    --toggle-url "$DASHBOARD_TOGGLE_URL" \
    --read-token "$DASHBOARD_READ_TOKEN" \
    --toggle-token "$DASHBOARD_TOGGLE_TOKEN" \
    --cache "$CACHE" \
    --interval "$INTERVAL" \
    --sleep-window "$DASHBOARD_SLEEP_WINDOW" \
    --title "$DASHBOARD_TITLE" \
    $theme_args \
    $save_args >> "$LOG" 2>&1 &
  echo "$!" > "$PIDFILE"
}

stop_dashboard() {
  log "stopping native dashboard"
  stop_existing_processes
  allow_sleep
  say "Dashboard stopped"
}

case "$1" in
  start)
    start_dashboard
    ;;
  once)
    keep_awake
    enable_wifi
    stop_existing_processes
    if [ ! -x "$NATIVE_APP" ]; then
      log "missing native app: $NATIVE_APP"
      say "Native app missing"
      allow_sleep
      exit 1
    fi
    if [ -z "$DASHBOARD_DATA_URL" ]; then
      log "missing DASHBOARD_DATA_URL; create /mnt/us/extensions/kindle-dashboard/config.sh"
      say "Dashboard config missing"
      allow_sleep
      exit 1
    fi
    cp "$NATIVE_APP" "$RUN_APP" >> "$LOG" 2>&1
    chmod 755 "$RUN_APP" >> "$LOG" 2>&1
    dark_mode_theme_args
    once_save_pgm="${SAVE_PGM:-/mnt/us/documents/kindle-dashboard-last-render.pgm}"
    "$RUN_APP" --url "$DASHBOARD_DATA_URL" --events-url "$DASHBOARD_EVENTS_URL" --toggle-url "$DASHBOARD_TOGGLE_URL" --read-token "$DASHBOARD_READ_TOKEN" --toggle-token "$DASHBOARD_TOGGLE_TOKEN" --cache "$CACHE" --sleep-window "$DASHBOARD_SLEEP_WINDOW" --title "$DASHBOARD_TITLE" --once $theme_args --save-pgm "$once_save_pgm" >> "$LOG" 2>&1
    allow_sleep
    ;;
  stop)
    stop_dashboard
    ;;
  *)
    say "Unknown dashboard action"
    log "unknown action: $1"
    exit 1
    ;;
esac
