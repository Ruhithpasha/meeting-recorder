# Shared bats setup: a fake HOME, and stub commands on PATH that log every call to $CALLS.
setup_sandbox() {
  export SANDBOX="$BATS_TEST_TMPDIR/sandbox"
  export HOME="$SANDBOX/home"
  export MR_HOME="$HOME/.meeting-recorder"
  export MR_APPS_DIR="$HOME/Applications"
  export MR_MEETINGS_DIR="$HOME/Meetings"
  export MR_LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
  export CALLS="$SANDBOX/calls.log"
  export STUBS="$SANDBOX/stubs"
  mkdir -p "$HOME" "$STUBS"
  : > "$CALLS"
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  export REPO_ROOT
  CLI="$REPO_ROOT/scripts/meeting-recorder"
  # Default stubs: record the call and succeed.
  for cmd in launchctl codesign security npm swift git curl open xcode-select; do stub "$cmd" 'exit 0'; done
  stub uname 'if [ "$1" = "-m" ]; then echo arm64; else echo Darwin; fi'
  stub sw_vers 'echo 15.4'
  export PATH="$STUBS:/usr/bin:/bin:/usr/sbin:/sbin"
}

# Use the real git (for update tests against a local bare "remote").
unstub_git() { rm -f "$STUBS/git"; }

# stub <name> <body>: creates an executable that logs "name args" then runs body.
stub() {
  printf '#!/bin/bash\necho "%s $*" >> "$CALLS"\n%s\n' "$1" "$2" > "$STUBS/$1"
  chmod +x "$STUBS/$1"
}

# A fake installed checkout with a fake verified Node runtime, so commands skip downloads.
fake_install() {
  mkdir -p "$MR_HOME/app/.git" "$MR_HOME/app/scripts" "$MR_HOME/runtime/node-v26.13.0-darwin-arm64/bin"
  cp "$REPO_ROOT/scripts/node-version.txt" "$MR_HOME/app/scripts/"
  cp "$REPO_ROOT/scripts/meeting-recorder" "$MR_HOME/app/scripts/"
  printf '#!/bin/bash\necho fake-build "$@" >> "$CALLS"\nmkdir -p "$2"\n' > "$MR_HOME/app/scripts/build-agent.sh"
  chmod +x "$MR_HOME/app/scripts/build-agent.sh" "$MR_HOME/runtime/node-v26.13.0-darwin-arm64/bin"
  printf '#!/bin/bash\n' > "$MR_HOME/runtime/node-v26.13.0-darwin-arm64/bin/node"
  # Fake npm: logs, and a successful "run build" leaves the dashboard's index.html behind.
  printf '#!/bin/bash\necho "npm $*" >> "$CALLS"\ncase "$*" in *"run build"*) mkdir -p apps/web/dist && touch apps/web/dist/index.html ;; esac\n' > "$MR_HOME/runtime/node-v26.13.0-darwin-arm64/bin/npm"
  chmod +x "$MR_HOME/runtime/node-v26.13.0-darwin-arm64/bin/"*
  mkdir -p "$MR_APPS_DIR/Meeting Recorder.app" "$MR_MEETINGS_DIR/2026-11-08_10-00-00_zoom"
  echo "keep me" > "$MR_MEETINGS_DIR/2026-11-08_10-00-00_zoom/recording.mp4"
}
