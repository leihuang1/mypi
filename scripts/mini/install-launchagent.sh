#!/bin/zsh
# Install (or reinstall) the dev.mypi.daemon LaunchAgent for this checkout.
# Run on the always-on host, inside the user's logged-in GUI session.
set -eu

label="dev.mypi.daemon"
repo="${0:A:h:h:h}"
plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/mypi"
domain="gui/$(id -u)"

mkdir -p "$log_dir" "${plist:h}"
cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$repo/scripts/mini/run-daemon.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$repo</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log_dir/daemon.log</string>
  <key>StandardErrorPath</key><string>$log_dir/daemon.log</string>
</dict>
</plist>
EOF
plutil -lint "$plist" >/dev/null

launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
echo "Installed $label from $repo"
echo "Logs: $log_dir/daemon.log"
