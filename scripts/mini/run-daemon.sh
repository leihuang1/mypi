#!/bin/zsh
# Entry point for the dev.mypi.daemon LaunchAgent.
# launchd starts jobs with a bare PATH and no locale. The agent's bash inherits
# this environment, so give it the same tools a login shell would have.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="${LANG:-en_US.UTF-8}"
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh" --no-use
nvm use --silent default >/dev/null || exit 1

# Per-host settings (e.g. MYPI_NAME=mini) live outside the checkout.
if [[ -f "$HOME/.mypi/daemon.env" ]]; then
  set -a; source "$HOME/.mypi/daemon.env"; set +a
fi

cd "${0:A:h}/../.." || exit 1
echo "[run-daemon] $(date '+%F %T') starting $(git rev-parse --short HEAD) with node $(node -v)"
exec node --import tsx packages/server/src/main.ts
