import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** Unique temp name next to the target (pid alone can be reused after a crash). */
function temporaryName(filename) {
  return `${filename}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
}

async function fsyncDir(dir) {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Some filesystems refuse directory fsync; the file itself is already synced.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Crash-safe replace: write a unique temp file (mode 600), fsync it, rename it
 * over the target, then fsync the directory so the rename itself is durable.
 */
export async function writeFileDurable(filename, payload, { mode = 0o600 } = {}) {
  const temporary = temporaryName(filename);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await fsyncDir(path.dirname(filename));
}

/** Synchronous twin (inbound journal: must be on disk before the event is dispatched). */
export function writeFileDurableSync(filename, payload, { mode = 0o600 } = {}) {
  const temporary = temporaryName(filename);
  const fd = openSync(temporary, "wx", mode);
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, filename);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  try {
    const dirFd = openSync(path.dirname(filename), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {}
}
