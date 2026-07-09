#!/usr/bin/env bash
# Generate (but do NOT load) launchd jobs for the off-hours trader:
#   - pipeline: once per weekday at 17:05 ET (after the close)
#   - executor: every 15 minutes (no-ops outside enabled sessions)
# The plists are written to ~/Library/LaunchAgents but left UNLOADED. Loading
# them starts recurring jobs that autonomously hit the market, so that step is
# deliberately manual — see the printed instructions and the runbook.
#
# Usage: bash scripts/install-schedule.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PNPM="$(command -v pnpm || echo /usr/local/bin/pnpm)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS"

# launchd StartCalendarInterval fires in the Mac's LOCAL timezone. These files
# assume the Mac is set to America/New_York. If not, adjust the pipeline Hour.
PIPELINE_PLIST="$AGENTS/com.offhours.pipeline.plist"
RTH_PIPELINE_PLIST="$AGENTS/com.offhours.pipeline-rth.plist"
TICK_PLIST="$AGENTS/com.offhours.tick.plist"

cat > "$PIPELINE_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.offhours.pipeline</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>ProgramArguments</key>
  <array><string>$PNPM</string><string>pipeline</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>5</integer></dict>
  <key>StandardOutPath</key><string>/tmp/offhours-pipeline.log</string>
  <key>StandardErrorPath</key><string>/tmp/offhours-pipeline.log</string>
</dict></plist>
PLIST

# RTH morning pipeline: 09:00 ET, builds the regular-session thesis. Only
# useful when sessions.regularhours is enabled in config.yaml.
cat > "$RTH_PIPELINE_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.offhours.pipeline-rth</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>ProgramArguments</key>
  <array><string>$PNPM</string><string>pipeline</string><string>rth</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/offhours-pipeline-rth.log</string>
  <key>StandardErrorPath</key><string>/tmp/offhours-pipeline-rth.log</string>
</dict></plist>
PLIST

cat > "$TICK_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.offhours.tick</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>ProgramArguments</key>
  <array><string>$PNPM</string><string>tick</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/offhours-tick.log</string>
  <key>StandardErrorPath</key><string>/tmp/offhours-tick.log</string>
</dict></plist>
PLIST

echo "Wrote (UNLOADED):"
echo "  $PIPELINE_PLIST       (evening off-hours thesis, 17:05 ET)"
echo "  $RTH_PIPELINE_PLIST   (morning RTH thesis, 09:00 ET — only if regularhours enabled)"
echo "  $TICK_PLIST           (executor, every 15 min)"
echo ""
echo "These are NOT running yet. Before loading, complete the go-live runbook"
echo "(docs/RUNBOOK.md) — at minimum: pnpm preflight passes, and you have soaked"
echo "on paper. To start the recurring jobs:"
echo "  launchctl load $PIPELINE_PLIST"
echo "  launchctl load $TICK_PLIST"
echo "To stop them:"
echo "  launchctl unload $PIPELINE_PLIST $TICK_PLIST"
