// Crash-recovery inspection of the fragmented MP4 the agent writes.
//
// AVAssetWriter (movieFragmentInterval) writes each fragment's DATA FIRST, then the moof that
// describes it, and keeps the in-progress data in a size-0 ("to end of file") mdat:
//
//   ftyp │ mdat │ moov │ mdat │ moof │ wide │ mdat │ moof │ wide │ mdat(size 0, in progress)
//          └ first ~5 s ┘ └ fragment 1 ┘            └ fragment 2 ┘            └ truncated away
//
// The first segment is described by moov's sample tables and fragments carry no tfdt, so a track's
// end time = mdhd duration + every complete fragment. Standard ISO order (moof, then its mdat) is
// also handled: such a moof only counts once the mdat after it is complete.
//
// Only box headers and the small moof boxes are read, never mdat payloads, so inspecting a
// multi-gigabyte recording reads kilobytes and uses flat memory.
import { open, type FileHandle } from "node:fs/promises";

export interface Mp4Inspection {
  fileBytes: number;
  /** Bytes up to the end of the last complete box (fragmented: last complete moof+mdat pair). */
  completeBytes: number;
  fragmented: boolean;
  /** Longest track duration in seconds, or null if it cannot be determined. */
  durationSec: number | null;
}

interface BoxHeader { type: string; start: number; headerSize: number; size: number; toEof: boolean }
interface TrackInfo { timescale: number; defaultSampleDuration: number; initialDuration: number }

const MAX_METADATA_BOX = 64 * 1024 * 1024; // moov/moof larger than this is not a file we wrote

async function readAt(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

/** Reads a box header at `offset`; null if the header itself is cut off or malformed. */
async function readHeader(fh: FileHandle, offset: number, fileBytes: number): Promise<BoxHeader | null> {
  if (offset + 8 > fileBytes) return null;
  const head = await readAt(fh, offset, 16);
  let size = head.readUInt32BE(0);
  const type = head.toString("latin1", 4, 8);
  let headerSize = 8;
  const toEof = size === 0; // "runs to end of file": for a live fragmented file, data still being written
  if (size === 1) {
    if (head.length < 16) return null;
    size = Number(head.readBigUInt64BE(8));
    headerSize = 16;
  } else if (toEof) {
    size = fileBytes - offset;
  }
  if (size < headerSize) return null;
  return { type, start: offset, headerSize, size, toEof };
}

/** Iterates child boxes inside an in-memory buffer (payload of a container box). */
function* children(buf: Buffer, from = 0, to = buf.length): Generator<{ type: string; body: Buffer }> {
  let offset = from;
  while (offset + 8 <= to) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > to) return;
      size = Number(buf.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < headerSize || offset + size > to) return;
    yield { type, body: buf.subarray(offset + headerSize, offset + size) };
    offset += size;
  }
}

const child = (buf: Buffer, type: string) => {
  for (const c of children(buf)) if (c.type === type) return c.body;
  return undefined;
};

/** Track id -> timescale/default duration, from moov (trak/tkhd, trak/mdia/mdhd, mvex/trex). */
function parseMoov(moov: Buffer): { tracks: Map<number, TrackInfo>; movieDurationSec: number | null; fragmented: boolean } {
  const tracks = new Map<number, TrackInfo>();
  let movieDurationSec: number | null = null;
  let fragmented = false; // mvex present: fragments will follow
  for (const c of children(moov)) {
    if (c.type === "mvhd") {
      const v1 = c.body[0] === 1;
      const timescale = c.body.readUInt32BE(v1 ? 20 : 12);
      const duration = v1 ? Number(c.body.readBigUInt64BE(24)) : c.body.readUInt32BE(16);
      if (timescale > 0 && duration > 0) movieDurationSec = duration / timescale;
    } else if (c.type === "trak") {
      const tkhd = child(c.body, "tkhd");
      const mdhd = child(child(c.body, "mdia") ?? Buffer.alloc(0), "mdhd");
      if (!tkhd || !mdhd) continue;
      const trackId = tkhd.readUInt32BE(tkhd[0] === 1 ? 20 : 12);
      const v1 = mdhd[0] === 1;
      const timescale = mdhd.readUInt32BE(v1 ? 20 : 12);
      const initialDuration = v1 ? Number(mdhd.readBigUInt64BE(24)) : mdhd.readUInt32BE(16);
      tracks.set(trackId, { timescale, initialDuration, defaultSampleDuration: tracks.get(trackId)?.defaultSampleDuration ?? 0 });
    } else if (c.type === "mvex") {
      fragmented = true;
      for (const trex of children(c.body)) {
        if (trex.type !== "trex") continue;
        const trackId = trex.body.readUInt32BE(4);
        const existing = tracks.get(trackId) ?? { timescale: 0, defaultSampleDuration: 0, initialDuration: 0 };
        tracks.set(trackId, { ...existing, defaultSampleDuration: trex.body.readUInt32BE(12) });
      }
    }
  }
  return { tracks, movieDurationSec, fragmented };
}

interface FragmentSpan { baseTime: number | null; total: number }

/**
 * Per track in a moof: tfdt base time (null when absent) and summed sample durations, plus the
 * lowest file offset of sample data it references (to tell data-before-moof from moof-then-mdat).
 */
function fragmentSpans(moof: Buffer, moofStart: number, tracks: Map<number, TrackInfo>) {
  const spans = new Map<number, FragmentSpan>();
  let dataStart = Number.POSITIVE_INFINITY;
  for (const traf of children(moof)) {
    if (traf.type !== "traf") continue;
    let trackId = 0, defaultDuration = 0, total = 0;
    let baseTime: number | null = null;
    let baseDataOffset = moofStart; // default-base-is-moof unless tfhd gives an explicit base
    for (const c of children(traf.body)) {
      const b = c.body;
      const flags = b.readUInt32BE(0) & 0xffffff;
      if (c.type === "tfhd") {
        trackId = b.readUInt32BE(4);
        let p = 8;
        if (flags & 0x1) { baseDataOffset = Number(b.readBigUInt64BE(p)); p += 8; } // base_data_offset
        if (flags & 0x2) p += 4; // sample_description_index
        defaultDuration = flags & 0x8 ? b.readUInt32BE(p) : tracks.get(trackId)?.defaultSampleDuration ?? 0;
      } else if (c.type === "tfdt") {
        baseTime = b[0] === 1 ? Number(b.readBigUInt64BE(4)) : b.readUInt32BE(4);
      } else if (c.type === "trun") {
        const count = b.readUInt32BE(4);
        let p = 8;
        if (flags & 0x1) { dataStart = Math.min(dataStart, baseDataOffset + b.readInt32BE(p)); p += 4; } // data_offset
        else dataStart = Math.min(dataStart, baseDataOffset);
        if (flags & 0x4) p += 4; // first_sample_flags
        const perSample = [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length * 4;
        for (let i = 0; i < count; i++) {
          total += flags & 0x100 ? b.readUInt32BE(p) : defaultDuration;
          p += perSample;
        }
      }
    }
    if (trackId) {
      const prev = spans.get(trackId);
      spans.set(trackId, { baseTime: prev?.baseTime ?? baseTime, total: (prev?.total ?? 0) + total });
    }
  }
  return { spans, dataStart };
}

export async function inspectMp4(path: string): Promise<Mp4Inspection> {
  const fh = await open(path, "r");
  try {
    const fileBytes = (await fh.stat()).size;
    let offset = 0;
    let completeBytes = 0;
    let fragmented = false;
    let moovInfo: ReturnType<typeof parseMoov> | null = null;
    let pendingMoof: Map<number, FragmentSpan> | null = null; // moof seen, waiting for its mdat
    const trackEnds = new Map<number, number>(); // track id -> end time in its timescale
    const applySpans = (spans: Map<number, FragmentSpan>) => {
      for (const [id, span] of spans) trackEnds.set(id, (span.baseTime ?? trackEnds.get(id) ?? 0) + span.total);
    };

    while (offset < fileBytes) {
      const box = await readHeader(fh, offset, fileBytes);
      if (!box || box.start + box.size > fileBytes) break; // cut off: stop at last complete point
      const end = box.start + box.size;

      if (box.type === "moov" || box.type === "moof") {
        if (box.size > MAX_METADATA_BOX) break;
        const body = (await readAt(fh, box.start, box.size)).subarray(box.headerSize);
        if (box.type === "moov") {
          moovInfo = parseMoov(body);
          fragmented ||= moovInfo.fragmented;
          for (const [id, t] of moovInfo.tracks) trackEnds.set(id, t.initialDuration);
        } else {
          fragmented = true;
          const fragment = fragmentSpans(body, box.start, moovInfo?.tracks ?? new Map());
          if (fragment.dataStart < box.start) {
            applySpans(fragment.spans); // Apple order: its data is already complete before it
          } else {
            pendingMoof = fragment.spans; // ISO order: only counts once the following mdat completes
            offset = end;
            continue;
          }
        }
      } else if (box.toEof && fragmented) {
        break; // the fragment still being written when the process died
      } else if (pendingMoof) {
        if (box.type !== "mdat") { offset = end; continue; } // padding (wide/free) between moof and mdat
        applySpans(pendingMoof);
        pendingMoof = null;
      }
      completeBytes = end;
      offset = end;
    }

    let durationSec: number | null = null;
    if (fragmented && moovInfo && [...trackEnds.values()].some((t) => t > 0)) {
      for (const [id, units] of trackEnds) {
        const timescale = moovInfo.tracks.get(id)?.timescale ?? 0;
        if (timescale > 0) durationSec = Math.max(durationSec ?? 0, units / timescale);
      }
    } else if (moovInfo) {
      // mvhd may be 0 when only the first segment was written; fall back to the longest track.
      const trackSeconds = [...moovInfo.tracks.values()]
        .filter((t) => t.timescale > 0 && t.initialDuration > 0)
        .map((t) => t.initialDuration / t.timescale);
      durationSec = moovInfo.movieDurationSec ?? (trackSeconds.length ? Math.max(...trackSeconds) : null);
    }
    return { fileBytes, completeBytes, fragmented, durationSec };
  } finally {
    await fh.close();
  }
}
