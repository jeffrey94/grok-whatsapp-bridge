#!/bin/sh
# Compact health summary for the keep-alive routine. Read-only; prints no secrets.
#   deploy/health-summary.sh           new log lines since the last run (+ current status)
#   deploy/health-summary.sh --daily   last-24h pause/reconnect summary
set -eu
BRIDGE_HOME=${BRIDGE_HOME:-/home/box/grokbot-whatsapp-bridge}
export BRIDGE_HOME
exec timeout --foreground 30 node "$BRIDGE_HOME/scripts/health-summary.mjs" "$@"
