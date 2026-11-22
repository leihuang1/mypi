# Sourced (zsh) by run-daemon.sh and deploy-mini.sh on the always-on host.
# Gives non-login shells (launchd jobs, ssh commands) a login-shell PATH, the
# per-host settings in ~/.mypi/daemon.env, and nvm's default Node when nvm exists.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"

# Loaded first so it can also set PATH or NVM_DIR for a custom Node install.
if [[ -f "$HOME/.mypi/daemon.env" ]]; then
  set -a; source "$HOME/.mypi/daemon.env"; set +a
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
for nvm_sh in "$NVM_DIR/nvm.sh" /opt/homebrew/opt/nvm/nvm.sh /usr/local/opt/nvm/nvm.sh; do
  [[ -s "$nvm_sh" ]] || continue
  source "$nvm_sh" --no-use
  nvm use --silent default >/dev/null || {
    echo "mypi: nvm has no usable 'default' Node (try: nvm alias default 22)" >&2
    return 1
  }
  break
done
command -v node >/dev/null || {
  echo "mypi: node not found on PATH (set PATH in ~/.mypi/daemon.env)" >&2
  return 1
}
