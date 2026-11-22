#!/bin/zsh
# Entry point for the dev.mypi.daemon LaunchAgent. launchd starts jobs with a
# bare environment, and the agent's bash inherits whatever env.sh sets up.
source "${0:A:h}/env.sh" || exit 1

cd "${0:A:h}/../.." || exit 1
echo "[run-daemon] $(date '+%F %T') starting $(git rev-parse --short HEAD) with node $(node -v)"
exec node --import tsx packages/server/src/main.ts
