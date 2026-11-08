#!/usr/bin/env bash
# Meeting Recorder installer (macOS 15+). Usage:
#   curl -fsSL https://raw.githubusercontent.com/Ruhithpasha/meeting-recorder/main/scripts/install.sh | bash
#
# Deliberately tiny: checks prerequisites, clones the repo, then hands over to the versioned CLI
# (scripts/meeting-recorder install-local), which does the real work. Everything runs inside main()
# so a connection dropped mid-download can never execute half a script.
set -euo pipefail

main() {
  local repo="${MR_REPO:-https://github.com/Ruhithpasha/meeting-recorder.git}"
  local ref="${MR_REF:-main}"
  local home="${MR_HOME:-$HOME/.meeting-recorder}"

  say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
  die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

  [ "$(uname -s)" = "Darwin" ] || die "Meeting Recorder runs on macOS only."
  local major
  major="$(sw_vers -productVersion | cut -d. -f1)"
  [ "$major" -ge 15 ] || die "macOS 15 or later is required (you have $(sw_vers -productVersion))."
  if ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install >/dev/null 2>&1 || true
    die "The Xcode Command Line Tools are needed. An installer window just opened: finish it, then run this command again."
  fi
  command -v git >/dev/null 2>&1 || die "git is missing (it comes with the Command Line Tools)."

  mkdir -p "$home"
  if [ -d "$home/app/.git" ]; then
    say "Meeting Recorder is already installed. Updating instead."
    exec "$home/app/scripts/meeting-recorder" update
  fi
  say "Downloading Meeting Recorder…"
  git clone --quiet --depth 1 --branch "$ref" "$repo" "$home/app"
  # curl | bash: stdin is the script itself, so read answers from the terminal when there is one
  # (ssh without -t, CI or provisioning tools have none; the installer then skips the question).
  if (: </dev/tty) 2>/dev/null; then
    exec "$home/app/scripts/meeting-recorder" install-local </dev/tty
  fi
  exec "$home/app/scripts/meeting-recorder" install-local </dev/null
}

main "$@"
