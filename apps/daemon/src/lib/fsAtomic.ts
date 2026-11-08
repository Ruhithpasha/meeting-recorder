import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Writes JSON so readers never see a half-written file: write a temp file in the same
 * directory, then rename over the target (rename is atomic on the same filesystem).
 */
export async function writeJsonAtomic(path: string, data: unknown, mode = 0o644): Promise<void> {
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
