// =============================================================================
// Atomic file write
// =============================================================================
//
// fsync + rename pattern. A reader that opens the path either sees the old
// contents in full or the new contents in full — never a half-written file.
// Important for Coax because customers will be running CI tools (or VS Code
// REST Client) against the same .http files Coax is editing.
//
// Implementation notes:
//   - We write to a sibling temp file named `<basename>.coax-tmp-<pid>-<rand>`.
//     Sibling (not /tmp) so the rename is on the same filesystem and atomic
//     per POSIX. Including pid + random suffix lets concurrent Coax processes
//     (rare, but possible — e.g. CLI run while GUI is open) not collide.
//   - We `fsync` the file *and* the parent directory. Without the directory
//     fsync, the rename can survive a crash but the new inode's contents can
//     be lost on some filesystems. The cost is small (one syscall per write).
//   - Mode 0o600 on the temp file matches the sidecar convention used by
//     telemetry storage — owner read+write only.

import { existsSync, mkdirSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function writeAtomic(path: string, content: string | Buffer): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = tempPath(path);

  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fileHandle = await open(tmp, 'w', 0o600);
    await fileHandle.writeFile(content);
    await fileHandle.sync();
  } finally {
    if (fileHandle !== null) await fileHandle.close();
  }

  try {
    await rename(tmp, path);
  } catch (err) {
    // Make a best-effort cleanup of the temp file so we don't leak files
    // sitting around in the workspace if the rename failed.
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Fsync the parent directory so the rename is durably recorded. Some
  // filesystems (ext4 on Linux historically) could otherwise lose the new
  // inode's contents on a crash even though the directory entry survived.
  // On macOS APFS this is mostly a no-op but cheap; we do it unconditionally
  // because reasoning about per-filesystem behavior in JS is not worth it.
  let dirHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    dirHandle = await open(dir, 'r');
    await dirHandle.sync();
  } catch {
    // Directory fsync isn't supported on all platforms (Windows in particular).
    // The rename has already happened; the durability guarantee just degrades.
    // Don't fail the write over it.
  } finally {
    if (dirHandle !== null) await dirHandle.close();
  }
}

/**
 * Build a unique temp-path sibling for `path`. Includes pid + random suffix
 * so two concurrent Coax processes writing the same file don't pick the same
 * temp name. The `coax-tmp-` infix makes orphaned temps easy to spot.
 */
function tempPath(path: string): string {
  const dir = dirname(path);
  const base = path.slice(dir.length + 1);
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
  return join(dir, `.${base}.coax-tmp-${suffix}`);
}
