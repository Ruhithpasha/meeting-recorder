#!/usr/bin/env bats
load helpers

setup() { setup_sandbox; }

@test "install.sh refuses macOS older than 15" {
  stub sw_vers 'echo 14.6'
  run bash "$REPO_ROOT/scripts/install.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"macOS 15 or later is required"* ]]
}

@test "install.sh starts the Command Line Tools install and stops when they're missing" {
  stub xcode-select 'if [ "$1" = "-p" ]; then exit 2; fi; exit 0'
  run bash "$REPO_ROOT/scripts/install.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Command Line Tools are needed"* ]]
  grep -q "xcode-select --install" "$CALLS"
}

@test "install.sh runs nothing if the download is cut off (everything is inside main)" {
  head -c 400 "$REPO_ROOT/scripts/install.sh" > "$SANDBOX/partial.sh"
  run bash "$SANDBOX/partial.sh"
  ! grep -q "git clone" "$CALLS"
}

@test "Node download with a wrong checksum is rejected and nothing is installed" {
  fake_install
  rm -rf "$MR_HOME/runtime"
  stub curl 'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then echo "tampered" > "$2"; fi; shift; done'
  run "$CLI" repair
  [ "$status" -ne 0 ]
  [[ "$output" == *"checksum mismatch"* ]]
  [ ! -d "$MR_HOME/runtime/node-v26.13.0-darwin-arm64" ]
}

@test "repair rewrites agent.json with absolute paths and restarts the agent via launchd" {
  fake_install
  run "$CLI" repair
  [ "$status" -eq 0 ]
  grep -q "\"nodePath\": \"$MR_HOME/runtime/node-v26.13.0-darwin-arm64/bin/node\"" "$MR_HOME/agent.json"
  grep -q "\"meetingsDir\": \"$MR_MEETINGS_DIR\"" "$MR_HOME/agent.json"
  grep -q "<string>com.meetingrecorder.agent</string>" "$MR_LAUNCH_AGENTS_DIR/com.meetingrecorder.agent.plist"
  bootout_line="$(grep -n "launchctl bootout" "$CALLS" | head -1 | cut -d: -f1)"
  bootstrap_line="$(grep -n "launchctl bootstrap" "$CALLS" | head -1 | cut -d: -f1)"
  [ "$bootout_line" -lt "$bootstrap_line" ]
}

@test "update refuses while a meeting is being recorded" {
  fake_install
  echo '{"pid":1,"port":47321,"token":"t"}' > "$MR_HOME/runtime.json"
  stub curl 'echo "{\"state\":\"recording\",\"meetingId\":\"x\"}"'
  run "$CLI" update
  [ "$status" -ne 0 ]
  [[ "$output" == *"being recorded"* ]]
  ! grep -q "git -C" "$CALLS"
}

# A local bare repo plays the role of GitHub; only the build steps are fake.
make_remote() {
  local work="$SANDBOX/remote-work"
  git init --quiet -b main "$work"
  mkdir -p "$work/scripts"
  cp "$REPO_ROOT/scripts/meeting-recorder" "$REPO_ROOT/scripts/node-version.txt" "$work/scripts/"
  printf '#!/bin/bash\necho fake-build "$@" >> "$CALLS"\nmkdir -p "$2"\n' > "$work/scripts/build-agent.sh"
  chmod +x "$work/scripts/build-agent.sh"
  echo v1 > "$work/VERSION"
  git -C "$work" add -A && git -C "$work" -c user.name=t -c user.email=t@t commit --quiet -m v1
  git clone --quiet --bare "$work" "$SANDBOX/remote.git"
  echo "$work"
}

@test "update (real git) installs the new commit from the remote" {
  unstub_git
  work="$(make_remote)"
  fake_install
  rm -rf "$MR_HOME/app" && git clone --quiet "$SANDBOX/remote.git" "$MR_HOME/app"
  echo v2 > "$work/VERSION"
  git -C "$work" -c user.name=t -c user.email=t@t commit --quiet -am v2
  git -C "$work" push --quiet "$SANDBOX/remote.git" main
  run "$MR_HOME/app/scripts/meeting-recorder" update
  [ "$status" -eq 0 ]
  [ "$(cat "$MR_HOME/app/VERSION")" = "v2" ]
  [[ "$output" == *"Updated to"* ]]
}

@test "update (real git) with nothing new says so and touches nothing" {
  unstub_git
  make_remote >/dev/null
  fake_install
  rm -rf "$MR_HOME/app" && git clone --quiet "$SANDBOX/remote.git" "$MR_HOME/app"
  run "$MR_HOME/app/scripts/meeting-recorder" update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Already up to date"* ]]
  ! grep -q "launchctl bootout" "$CALLS"
}

@test "update restores the previous version when switching fails after the agent stopped" {
  unstub_git
  work="$(make_remote)"
  fake_install
  rm -rf "$MR_HOME/app" && git clone --quiet "$SANDBOX/remote.git" "$MR_HOME/app"
  echo v2 > "$work/VERSION"
  git -C "$work" -c user.name=t -c user.email=t@t commit --quiet -am v2
  git -C "$work" push --quiet "$SANDBOX/remote.git" main
  stub launchctl 'if [ "$1" = "bootstrap" ] && [ ! -f "$SANDBOX/bootstrapped-once" ]; then touch "$SANDBOX/bootstrapped-once"; exit 5; fi; exit 0'
  run "$MR_HOME/app/scripts/meeting-recorder" update
  [ "$status" -ne 0 ]
  [[ "$output" == *"previous version was restored"* ]]
  [ "$(cat "$MR_HOME/app/VERSION")" = "v1" ]
  [ -d "$MR_APPS_DIR/Meeting Recorder.app" ]
  [ "$(grep -c "launchctl bootstrap" "$CALLS")" -ge 2 ] # tried new, then restarted old
}

@test "repair and uninstall refuse during a recording" {
  fake_install
  echo '{"pid":1,"port":47321,"token":"t"}' > "$MR_HOME/runtime.json"
  stub curl 'echo "{\"state\":\"recording\"}"'
  run "$CLI" repair
  [ "$status" -ne 0 ]
  [[ "$output" == *"being recorded"* ]]
  run "$CLI" uninstall
  [ "$status" -ne 0 ]
  [ -d "$MR_HOME" ]
}

@test "update with a failing build keeps the current version and never stops the agent" {
  fake_install
  echo "old" > "$MR_HOME/app/VERSION"
  # The staged clone gets a build-agent.sh that fails.
  stub git 'case "$*" in
    *"clone"*) dest="${@: -1}"; mkdir -p "$dest/scripts"; cp "$MR_HOME/app/scripts/node-version.txt" "$dest/scripts/";
               printf "#!/bin/bash\nexit 1\n" > "$dest/scripts/build-agent.sh"; chmod +x "$dest/scripts/build-agent.sh" ;;
    *"remote get-url"*) echo https://example.invalid/repo.git ;;
    *"rev-parse HEAD"*) echo "$RANDOM$RANDOM" ;;
  esac; exit 0'
  run "$CLI" update
  [ "$status" -ne 0 ]
  [[ "$output" == *"current version is untouched"* ]]
  [ "$(cat "$MR_HOME/app/VERSION")" = "old" ]
  [ ! -d "$MR_HOME/app-next" ]
  ! grep -q "launchctl bootout" "$CALLS"
}

@test "uninstall removes the app but never the recordings" {
  fake_install
  run "$CLI" uninstall
  [ "$status" -eq 0 ]
  [ ! -d "$MR_HOME" ]
  [ ! -d "$MR_APPS_DIR/Meeting Recorder.app" ]
  [ "$(cat "$MR_MEETINGS_DIR/2026-11-08_10-00-00_zoom/recording.mp4")" = "keep me" ]
}

@test "status and open fail clearly when not running" {
  run "$CLI" status
  [ "$status" -ne 0 ]
  [[ "$output" == *"isn't running"* ]]
  rm -rf "$MR_APPS_DIR/Meeting Recorder.app"
  run "$CLI" open
  [ "$status" -ne 0 ]
  [[ "$output" == *"isn't installed"* ]]
}

@test "open shows the dashboard in the app, not a browser URL with the token" {
  fake_install
  run "$CLI" open
  [ "$status" -eq 0 ]
  grep -q "open -a $MR_APPS_DIR/Meeting Recorder.app" "$CALLS"
  ! grep -q "#t=" "$CALLS"
}

@test "the login item starts the agent in the background (no window at login)" {
  fake_install
  run "$CLI" repair
  grep -q "<string>--background</string>" "$MR_LAUNCH_AGENTS_DIR/com.meetingrecorder.agent.plist"
}

@test "unknown commands print usage and exit 64" {
  run "$CLI" frobnicate
  [ "$status" -eq 64 ]
  [[ "$output" == *"meeting-recorder <command>"* ]]
}

@test "a dashboard build that produces no index.html fails the update (no half-built swap)" {
  unstub_git
  work="$(make_remote)"
  fake_install
  rm -rf "$MR_HOME/app" && git clone --quiet "$SANDBOX/remote.git" "$MR_HOME/app"
  echo v2 > "$work/VERSION"
  git -C "$work" -c user.name=t -c user.email=t@t commit --quiet -am v2
  git -C "$work" push --quiet "$SANDBOX/remote.git" main
  printf '#!/bin/bash\necho "npm $*" >> "$CALLS"\n' > "$MR_HOME/runtime/node-v26.13.0-darwin-arm64/bin/npm" # build "succeeds" but writes nothing
  run "$MR_HOME/app/scripts/meeting-recorder" update
  [ "$status" -ne 0 ]
  [ "$(cat "$MR_HOME/app/VERSION")" = "v1" ]
  ! grep -q "launchctl bootout" "$CALLS"
}
