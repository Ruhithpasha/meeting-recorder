# TODOS

## Platform

### Windows agent (Rust)

**What:** Windows capture agent: Graphics Capture with GPU scaling to NV12, WASAPI loopback with silence fill, Media Foundation fragmented MP4 (`MFTranscodeContainerType_FMPEG4`, GOP 75), registry mic detection via `RegNotifyChangeKeyValue`, tray icon, `install.ps1`, plus a CI release workflow with SHA-256 checksums.

**Why:** Most 4 GB RAM laptops run Windows. The 4 GB memory target that shaped the architecture is only truly tested here.

**Context:** Deferred by the owner on 2026-11-08 ("skip windows now, build for macos now"). The full design notes are in the design doc (`~/.gstack/projects/meeting-recorder/*-design-*.md`, Windows sections). The agent protocol (`packages/shared/protocol.schema.json`) is platform-neutral, so this is a new agent plus quicktype Rust codegen; the daemon and web app don't change. Evaluate the `windows-capture` and `tray-icon` crates before writing COM code by hand. Windows 10 always shows a yellow capture border.

**Effort:** XL
**Priority:** P2
**Depends on:** macOS v1 shipped; protocol schema stable.

## Capture

### Webcam recording

**What:** Optionally record the built-in camera to `camera.mp4` next to `recording.mp4`, or as a picture-in-picture overlay.

**Why:** It was part of the original idea ("native camera of the laptop").

**Context:** Cut from v1 to protect the memory budget. macOS lets Zoom and our agent share the camera. Use an AVCaptureSession in the agent with a hardware H.264 encoder at 480p/15fps. Picture-in-picture compositing costs GPU/CPU, so prefer a separate file and overlay it in the player.

**Effort:** M
**Priority:** P3
**Depends on:** v1 stable; spike memory measurements show headroom under the 250 MB recording budget.

## Completed
