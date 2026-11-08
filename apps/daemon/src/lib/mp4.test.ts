import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appleFragmented, box, boxToEof, moof, moov, type TrackSpec } from "../../test/helpers/mp4Builder.ts";
import { inspectMp4 } from "./mp4.ts";

const dir = mkdtempSync(join(tmpdir(), "mp4-test-"));
let n = 0;
const write = (bytes: Buffer) => { const p = join(dir, `${n++}.mp4`); writeFileSync(p, bytes); return p; };

// Video at timescale 600 (15 fps -> 40 units/frame), audio at 48 kHz (1024 samples/packet).
const video: TrackSpec = { id: 1, timescale: 600, initialDuration: 3000, defaultSampleDuration: 40 };
const audio: TrackSpec = { id: 2, timescale: 48_000, initialDuration: 240_000, defaultSampleDuration: 1024 };
const fiveSecondsVideo = Array<number>(75).fill(40);

describe("inspectMp4: AVAssetWriter layout (data, then moof)", () => {
  it("sums moov's first segment and every complete fragment (no tfdt)", async () => {
    const { bytes } = appleFragmented({ tracks: [video], fragments: [[{ trackId: 1, sampleDurations: fiveSecondsVideo }]] });
    const r = await inspectMp4(write(bytes));
    expect(r).toMatchObject({ fragmented: true, completeBytes: bytes.length, fileBytes: bytes.length });
    expect(r.durationSec).toBeCloseTo(10, 5);
  });

  it("uses trex default durations when trun has none, and reports the longest track", async () => {
    const { bytes } = appleFragmented({
      tracks: [video, audio],
      fragments: [[{ trackId: 1, sampleDurations: fiveSecondsVideo }, { trackId: 2, sampleDurations: [] }]],
    });
    const r = await inspectMp4(write(bytes));
    expect(r.durationSec).toBeCloseTo(10, 5); // audio fragment empty -> video (10 s) is longest
  });

  it("stops before the in-progress size-0 mdat left by kill -9", async () => {
    const { bytes, fragmentEnds } = appleFragmented({
      tracks: [video],
      fragments: [[{ trackId: 1, sampleDurations: fiveSecondsVideo }], [{ trackId: 1, sampleDurations: fiveSecondsVideo }]],
      inProgressBytes: 5000,
    });
    const r = await inspectMp4(write(bytes));
    expect(r.completeBytes).toBe(fragmentEnds[1]);
    expect(r.fileBytes).toBe(bytes.length);
    expect(r.durationSec).toBeCloseTo(15, 5);
  });

  it("ignores a moof cut off mid-box", async () => {
    const { bytes, fragmentEnds } = appleFragmented({
      tracks: [video],
      fragments: [[{ trackId: 1, sampleDurations: fiveSecondsVideo }], [{ trackId: 1, sampleDurations: fiveSecondsVideo }]],
    });
    const cut = bytes.subarray(0, (fragmentEnds[1] ?? 0) - 20); // fragment 2's moof cut mid-box
    const r = await inspectMp4(write(cut));
    // Fragment 2's data mdat is complete (kept, unreferenced and harmless); its moof is not.
    expect(r.completeBytes).toBeGreaterThanOrEqual(fragmentEnds[0] ?? 0);
    expect(r.completeBytes).toBeLessThan(cut.length);
    expect(r.durationSec).toBeCloseTo(10, 5); // fragment 2 not counted

    // Truncating at completeBytes leaves a file whose boxes all parse to the end.
    const healed = await inspectMp4(write(cut.subarray(0, r.completeBytes)));
    expect(healed.completeBytes).toBe(healed.fileBytes);
    expect(healed.durationSec).toBeCloseTo(10, 5);
  });
});

describe("inspectMp4: ISO layout (moof, then mdat)", () => {
  const head = Buffer.concat([box("ftyp", Buffer.from("isom", "latin1")), moov([video])]);

  it("counts a moof only once the mdat after it is complete", async () => {
    const base = head.length;
    const m = moof([{ trackId: 1, baseDataOffset: base + 400, sampleDurations: fiveSecondsVideo, tfdt: 3000 }]);
    const complete = Buffer.concat([head, m, box("mdat", Buffer.alloc(32))]);
    const r = await inspectMp4(write(complete));
    expect(r.durationSec).toBeCloseTo(10, 5);
    expect(r.completeBytes).toBe(complete.length);

    const truncated = complete.subarray(0, complete.length - 10);
    const t = await inspectMp4(write(truncated));
    expect(t.completeBytes).toBe(head.length);
    expect(t.durationSec).toBeCloseTo(5, 5); // only moov's first segment
  });

  it("prefers tfdt as the fragment start when present", async () => {
    const m = moof([{ trackId: 1, baseDataOffset: head.length + 500, sampleDurations: [600], tfdt: 6000 }]);
    const r = await inspectMp4(write(Buffer.concat([head, m, box("mdat", Buffer.alloc(8))])));
    expect(r.durationSec).toBeCloseTo(11, 5); // 6000/600 + 600/600
  });
});

describe("inspectMp4: other files", () => {
  it("reads mvhd duration of a normally finished (non-fragmented) file", async () => {
    const bytes = Buffer.concat([box("ftyp"), box("mdat", Buffer.alloc(16)),
      moov([video], { timescale: 600, duration: 6140 }, { mvex: false })]);
    const r = await inspectMp4(write(bytes));
    expect(r).toMatchObject({ fragmented: false, completeBytes: bytes.length });
    expect(r.durationSec).toBeCloseTo(6140 / 600, 5);
  });

  it("crash before the first fragment: in-progress size-0 mdat after a fragmented moov is cut", async () => {
    const head = Buffer.concat([box("ftyp"), box("mdat", Buffer.alloc(16)), moov([video])]);
    const bytes = Buffer.concat([head, boxToEof("mdat", Buffer.alloc(500))]);
    const r = await inspectMp4(write(bytes));
    expect(r).toMatchObject({ fragmented: true, completeBytes: head.length, fileBytes: bytes.length });
    expect(r.durationSec).toBeCloseTo(5, 5);
  });

  it("handles a file with only a cut-off header", async () => {
    const r = await inspectMp4(write(Buffer.from([0, 0, 0, 40, 0x66])));
    expect(r).toMatchObject({ completeBytes: 0, durationSec: null, fragmented: false });
  });

  it("handles an empty file", async () => {
    const r = await inspectMp4(write(Buffer.alloc(0)));
    expect(r).toMatchObject({ fileBytes: 0, completeBytes: 0, durationSec: null });
  });

  it("supports 64-bit box sizes", async () => {
    const body = Buffer.alloc(24);
    const large = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("mdat", "latin1"), (() => {
      const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(16 + body.length)); return b; })(), body]);
    const bytes = Buffer.concat([box("ftyp"), large]);
    const r = await inspectMp4(write(bytes));
    expect(r.completeBytes).toBe(bytes.length);
  });
});
