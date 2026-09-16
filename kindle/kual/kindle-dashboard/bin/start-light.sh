#!/bin/sh

DASHBOARD="/mnt/us/extensions/kindle-dashboard/bin/dashboard.sh"
LOG="/mnt/us/documents/kindle-dashboard-kual-action.log"

echo "kindle-dashboard start light wrapper $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
DASHBOARD_FORCE_DARK_MODE=0 /bin/sh "$DASHBOARD" start >> "$LOG" 2>&1
echo "dashboard.sh start light exit=$?" >> "$LOG"
exit 0
