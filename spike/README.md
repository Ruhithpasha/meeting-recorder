# Spike T1: macOS capture proof

Throwaway code. It proves the riskiest assumptions in the design before any app code is written. Delete `spike/` once v1's agent replaces it.

## What it proves

| # | Question | Pass when |
|---|---|---|
| 1 | Do system audio and mic both get captured via ScreenCaptureKit on macOS 15+? | `probe` prints `OK 1 video + 2 audio tracks`; in QuickTime you hear the video **and** your voice |
| 2 | Are they in sync, and do they stay in sync? | The status line `mic-system` stays within ±50 ms **and does not grow** across the run (growth means drift); your voice lines up with your lips if the camera's on screen |
| 3 | Is memory within budget? | Peak `footprint` stays under ~120 MB (agent's share of the 250 MB recording budget) |
| 4 | Does the file survive a crash? | After `kill -9` at t≈40 s, `probe` reports ~35 s and the file plays in QuickTime |

## Run it

```bash
cd spike/macos
swiftc -O -swift-version 5 record.swift -o record
swiftc -O -swift-version 5 probe.swift  -o probe

./record --self-test           # pure-logic checks, no capture, no permissions needed
./record 60                    # normal run, 60 s (refuses to overwrite an existing output file)
./probe spike-recording.mp4

./record 120 crash.mp4         # crash run: in a second terminal, kill -9 <pid> at t≈40s
./probe crash.mp4
```

The first run asks for **Screen Recording** and **Microphone** permission for your terminal app. Allow both, then quit and reopen the terminal. (In the real app these prompts say "Meeting Recorder".)

While it records: play a YouTube video with sound **and** talk.

## Results (fill in)

| Check | macOS version | Result | Notes |
|---|---|---|---|
| 1 Two-sided audio | 27.0.1 (arm64) | PASS (tracks) / **listen pending** | probe: 1 video + 2 audio. System track was silent (nothing playing). Still to do: play a video while talking and listen in QuickTime |
| 2 Sync (mic-system) | 27.0.1 | PASS | +33 ms → +34 ms over 10 s, no growth |
| 3 Peak footprint | 27.0.1 | PASS | 15 MB (10 s run), 24 MB before frame pacing |
| 4 kill -9 survival | 27.0.1 | PASS | killed ~15 s into capture; file plays 10.2 s (last complete 5 s fragment) |
| Device change (connect AirPods mid-run) | | pending | |

### Findings fed back into the design
- **Frame pacing:** `minimumFrameInterval` (1/15) was not honored, and about 48 fps arrived. The agent must pace video itself, dropping frames closer than 0.9 × the frame period. After pacing, footprint went from 24 MB to 15 MB.
- **Stale first frame:** the first run produced a 16.2 s file from 5 s of capture, which points to a first frame with an old timestamp. The agent only starts the session on a frame less than 500 ms old. The guard did not fire on the re-run, so the cause is still a hypothesis; keep the guard and its log line.
- **Fragmented MP4 crash survival works** with `movieFragmentInterval` plus a time-based keyframe interval (`AVVideoMaxKeyFrameIntervalDurationKey`). No CMAF fallback is needed.

If check 1 or 4 fails, stop: the design doc's fallback (CMAF segments) or architecture needs revisiting before T2.
