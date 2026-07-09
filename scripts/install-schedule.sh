#!/usr/bin/env bash
# Generate (but do NOT load) launchd jobs for the off-hours trader:
#   - pipeline:     once per day at 17:05 ET (evening off-hours thesis)
#   - pipeline-rth: once per day at 09:00 ET (morning regular-session thesis)
#   - executor:     every 15 minutes (no-ops outside enabled sessions)
# The plists are written to ~/Library/LaunchAgents but left UNLOADED. Loading
# them starts recurring jobs that autonomously hit the market, so that step is
# deliberately manual — see the printed instructions and the runbook.
#
# launchd StartCalendarInterval fires in the Mac's LOCAL timezone. This script
# converts the intended ET times to the machine's local time AT INSTALL TIME, so
# it is correct on any timezone (e.g. IST). NOTE: the converted times are static
# — at a US DST transition the ET target drifts by 1 hour; re-run this installer
# after the transition to re-pin the times.
#
# Usage: bash scripts/install-schedule.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PNPM="$(command -v pnpm || echo /usr/local/bin/pnpm)"
# launchd runs with a minimal PATH; pnpm needs node on PATH to work. Bake in
# the dirs of the pnpm and node this shell resolved, plus the usual bins.
NODE_BIN="$(dirname "$(command -v node || echo /usr/local/bin/node)")"
PNPM_BIN="$(dirname "$PNPM")"
LAUNCH_PATH="$PNPM_BIN:$NODE_BIN:/usr/local/bin:/usr/bin:/bin"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS"

# Convert an ET wall-clock time (HH:MM) to the Mac's LOCAL hour/minute, using the
# current ET<->local offset (DST-correct at install time). Sets LH and LM.
et_to_local() { # $1 = "HH:MM" in America/New_York
  local d epoch
  d=$(TZ=America/New_York date +%F)
  epoch=$(TZ=America/New_York date -j -f "%Y-%m-%d %H:%M" "$d $1" +%s)
  LH=$(( 10#$(date -r "$epoch" +%H) ))
  LM=$(( 10#$(date -r "$epoch" +%M) ))
}

et_to_local 17:05; PIPE_H=$LH; PIPE_M=$LM
et_to_local 09:00; RTH_H=$LH;  RTH_M=$LM
LOCAL_TZ=$(date +%Z)

PIPELINE_PLIST="$AGENTS/com.offhours.pipeline.plist"
RTH_PIPELINE_PLIST="$AGENTS/com.offhours.pipeline-rth.plist"
TICK_PLIST="$AGENTS/com.offhours.tick.plist"

cat > "$PIPELINE_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.offhours.pipeline</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$LAUNCH_PATH</string></dict>
  <key>ProgramArguments</key>
  <array><string>$PNPM</string><string>pipeline</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$PIPE_H</integer><key>Minute</key><integer>$PIPE_M</integer></dict>
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
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$LAUNCH_PATH</string></dict>
  <key>ProgramArguments</key>
  <array><string>$PNPM</string><string>pipeline</string><string>rth</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$RTH_H</integer><key>Minute</key><integer>$RTH_M</integer></dict>
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
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$LAUNCH_PATH</string></dict>
  <key>ProgramArguments</key>
  <array><string>$PNPM</string><string>tick</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/offhours-tick.log</string>
  <key>StandardErrorPath</key><string>/tmp/offhours-tick.log</string>
</dict></plist>
PLIST

printf 'Wrote (UNLOADED), times converted to local %s:\n' "$LOCAL_TZ"
printf '  %s  (evening off-hours thesis, 17:05 ET = %02d:%02d %s)\n' "$PIPELINE_PLIST" "$PIPE_H" "$PIPE_M" "$LOCAL_TZ"
printf '  %s  (morning RTH thesis, 09:00 ET = %02d:%02d %s — only if regularhours enabled)\n' "$RTH_PIPELINE_PLIST" "$RTH_H" "$RTH_M" "$LOCAL_TZ"
printf '  %s  (executor, every 15 min)\n' "$TICK_PLIST"
echo ""
echo "These are NOT running yet. Before loading, complete the go-live runbook"
echo "(docs/RUNBOOK.md) — at minimum: pnpm preflight passes, and you have soaked"
echo "on paper. To start the recurring jobs:"
echo "  launchctl load $PIPELINE_PLIST $RTH_PIPELINE_PLIST $TICK_PLIST"
echo "To stop them:"
echo "  launchctl unload $PIPELINE_PLIST $RTH_PIPELINE_PLIST $TICK_PLIST"
echo ""
echo "Not on ET? The local times above are pinned to the current DST offset."
echo "Re-run this installer (and reload) after a US DST transition to re-pin."
