#!/bin/sh

DASHBOARD="/mnt/us/extensions/kindle-dashboard/bin/dashboard.sh"
LOG="/mnt/us/documents/kindle-dashboard-kual-action.log"

echo "kindle-dashboard once dark wrapper $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
DASHBOARD_FORCE_DARK_MODE=1 /bin/sh "$DASHBOARD" once >> "$LOG" 2>&1
echo "dashboard.sh once dark exit=$?" >> "$LOG"
exit 0
