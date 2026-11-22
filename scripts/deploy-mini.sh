#!/bin/sh
# Deploy origin's default branch to the always-on host's daemon over SSH.
#   MYPI_MINI_HOST  ssh destination (default: mac-mini, an ~/.ssh/config alias)
#   MYPI_MINI_DIR   daemon checkout on that host (default: ~/services/mypi)
set -eu
host="${MYPI_MINI_HOST:-mac-mini}"
dir="${MYPI_MINI_DIR:-services/mypi}"

ssh "$host" /bin/zsh -s -- "$dir" <<'REMOTE'
set -eu
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$1"
before=$(git rev-parse HEAD)
git pull --ff-only --quiet
after=$(git rev-parse HEAD)
echo "deploy: ${before:0:7} -> ${after:0:7}"

# Reinstall only when dependencies changed, so running sessions keep their modules.
if [[ ! -d node_modules ]] || ! git diff --quiet "$before" "$after" -- package-lock.json; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    source "$NVM_DIR/nvm.sh" --no-use
    nvm use --silent default
  fi
  npm ci --workspace=@mypi/server --workspace=@mypi/shared --include-workspace-root --no-audit --no-fund
fi

launchctl kickstart -k "gui/$(id -u)/dev.mypi.daemon"
for _ in {1..30}; do
  if curl -fs -o /dev/null --max-time 1 "http://127.0.0.1:${MYPI_PORT:-4780}/healthz"; then
    echo "deploy: daemon healthy"
    exit 0
  fi
  sleep 1
done
echo "deploy: daemon did not become healthy in 30s; last log lines:" >&2
tail -n 40 "$HOME/Library/Logs/mypi/daemon.log" >&2
exit 1
REMOTE
