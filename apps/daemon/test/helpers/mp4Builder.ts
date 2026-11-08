// Builds tiny synthetic MP4 files that mimic AVAssetWriter's fragmented layout, so recovery can be
// tested without real recordings (which would contain someone's screen).

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

export const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]);
};
/** Box whose size field is 0: "runs to end of file" (AVAssetWriter's in-progress mdat). */
export const boxToEof = (type: string, body: Buffer) => Buffer.concat([u32(0), Buffer.from(type, "latin1"), body]);
const fullBox = (type: string, version: number, flags: number, ...parts: Buffer[]) =>
  box(type, u32((version << 24) | flags), ...parts);

export interface TrackSpec { id: number; timescale: number; initialDuration: number; defaultSampleDuration: number }

export function moov(tracks: TrackSpec[], movie = { timescale: 600, duration: 0 }, opts = { mvex: true }): Buffer {
  const mvhd = fullBox("mvhd", 0, 0, u32(0), u32(0), u32(movie.timescale), u32(movie.duration), Buffer.alloc(80));
  const traks = tracks.map((t) =>
    box("trak",
      fullBox("tkhd", 0, 0, u32(0), u32(0), u32(t.id), u32(0), u32(0), Buffer.alloc(60)),
      box("mdia", fullBox("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(t.initialDuration), u32(0)))));
  const mvex = box("mvex", ...tracks.map((t) =>
    fullBox("trex", 0, 0, u32(t.id), u32(1), u32(t.defaultSampleDuration), u32(0), u32(0))));
  return opts.mvex ? box("moov", mvhd, ...traks, mvex) : box("moov", mvhd, ...traks);
}

export interface TrafSpec {
  trackId: number;
  /** Absolute file offset of this fragment's data (tfhd base_data_offset). */
  baseDataOffset: number;
  /** Per-sample durations written in trun; omit to rely on trex defaults. */
  sampleDurations?: number[];
  sampleCount?: number;
  tfdt?: number;
}

export function moof(trafs: TrafSpec[]): Buffer {
  return box("moof",
    fullBox("mfhd", 0, 0, u32(1)),
    ...trafs.map((t) => {
      const tfhd = fullBox("tfhd", 0, 0x1, u32(t.trackId), u64(t.baseDataOffset));
      const tfdt = t.tfdt === undefined ? [] : [fullBox("tfdt", 1, 0, u64(t.tfdt))];
      const count = t.sampleDurations?.length ?? t.sampleCount ?? 1;
      const flags = 0x1 | (t.sampleDurations ? 0x100 : 0);
      const trun = fullBox("trun", 0, flags, u32(count), i32(0), ...(t.sampleDurations ?? []).map(u32));
      return box("traf", tfhd, ...tfdt, trun);
    }));
}

/**
 * AVAssetWriter order: ftyp, mdat(first segment), moov, then per fragment: mdat(data), moof, wide.
 * Returns the bytes plus the offset just after each complete fragment's moof+wide.
 */
export function appleFragmented(opts: {
  tracks: TrackSpec[];
  fragments: { trackId: number; sampleDurations: number[] }[][];
  inProgressBytes?: number;
}): { bytes: Buffer; fragmentEnds: number[] } {
  const parts: Buffer[] = [box("ftyp", Buffer.from("mp42", "latin1")), box("mdat", Buffer.alloc(64)), moov(opts.tracks)];
  let length = parts.reduce((n, p) => n + p.length, 0);
  const fragmentEnds: number[] = [];
  for (const fragment of opts.fragments) {
    const data = box("mdat", Buffer.alloc(32));
    const dataOffset = length + 8;
    parts.push(data);
    length += data.length;
    const m = moof(fragment.map((t) => ({ trackId: t.trackId, baseDataOffset: dataOffset, sampleDurations: t.sampleDurations })));
    const wide = box("wide");
    parts.push(m, wide);
    length += m.length + wide.length;
    fragmentEnds.push(length);
  }
  if (opts.inProgressBytes) parts.push(boxToEof("mdat", Buffer.alloc(opts.inProgressBytes)));
  return { bytes: Buffer.concat(parts), fragmentEnds };
}
