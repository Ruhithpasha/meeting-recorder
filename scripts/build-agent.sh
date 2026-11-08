#!/usr/bin/env bash
# Builds "Meeting Recorder.app" from native/macos with the Command Line Tools, then signs it.
#   build-agent.sh <repo dir> <output .app path>
# Signs with the local "Meeting Recorder Local Signing" identity when present (permissions survive
# rebuilds), else ad-hoc (permissions must be re-granted after each rebuild). No hardened runtime.
set -euo pipefail

src="${1:?repo dir}"
out="${2:?output .app path}"
identity="Meeting Recorder Local Signing"

swift build -c release --package-path "$src/native/macos" --product MeetingRecorderAgent >/dev/null
# The transcriber needs the macOS 26 SDK. It's optional: without it, transcription is unavailable.
has_transcriber=1
swift build -c release --package-path "$src/native/macos" --product MeetingRecorderTranscriber >/dev/null 2>&1 || {
  has_transcriber=0
  echo "note: transcription needs macOS 26 (and its Command Line Tools); building without it." >&2
}
bin="$(swift build -c release --package-path "$src/native/macos" --show-bin-path)"

tmp="$out.building"
rm -rf "$tmp"
mkdir -p "$tmp/Contents/MacOS" "$tmp/Contents/Resources"
cp "$bin/MeetingRecorderAgent" "$tmp/Contents/MacOS/"
if [ "$has_transcriber" = 1 ]; then cp "$bin/MeetingRecorderTranscriber" "$tmp/Contents/MacOS/"; fi
cp "$src/native/macos/Resources/Info.plist" "$tmp/Contents/Info.plist"
cp "$src/native/macos/Resources/AppIcon.icns" "$tmp/Contents/Resources/AppIcon.icns"

sign_id="-"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$identity"; then sign_id="$identity"; fi
# Helper first, then the bundle (which seals everything inside it).
if [ "$has_transcriber" = 1 ]; then
  codesign --force --sign "$sign_id" --identifier com.meetingrecorder.transcriber "$tmp/Contents/MacOS/MeetingRecorderTranscriber"
fi
codesign --force --sign "$sign_id" --identifier com.meetingrecorder.agent "$tmp"
codesign --verify --strict "$tmp"

rm -rf "$out"
mv "$tmp" "$out"
