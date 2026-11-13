// SPDX-License-Identifier: GPL-3.0-or-later
// D375 Delete a clip file after it is posted (flag post-delete-uploaded, off by default; user 2026-11-13: "delete the
// file permanently", not the Recycle Bin). Node stdlib only.
//   deleteUploadedFile({ flagOn, status, item, ledgerEntry, file, folder, logFile, nowMs }) -> { deleted, reason }
// Deletes only when EVERY check passes, and keeps the file on any doubt:
//   1. the flag is on;
//   2. YouTube answered and says the upload finished processing (videos.list status.uploadStatus == 'processed');
//   3. the ledger has this exact video as uploaded (status 'uploaded', same videoId and sha256) with the publish time
//      Google got, the same as the queue item's sentPublishAt;
//   4. the file is the one that was uploaded: the post's source file (post.json source.file), a regular file (no link),
//      inside the clips folder by its real path (a junction or link that leads out is refused), never a folder, and its
//      sha256 equals the uploaded video's;
// then it is unlinked and one line { file (name only), videoId, at } is appended to <data>/posting/deleted.jsonl.
// Race (Codex review 2026-11-13): the file is opened once and hashed through that handle; its identity (device, file id,
// size, modified time) is taken from the same handle. Right before the unlink the path is looked up again (lstat) and
// its folder's real path resolved again; the unlink happens only if the identity is unchanged and the folder still
// resolves inside the clips folder. Node has no unlink-by-handle, so a swap in the few microseconds between that last
// check and the unlink is still possible (residual risk, documented in docs/evidence/2026-11-13-auto-post-scheduled.md).
// Codex re-review: that last step no longer unlinks the clip's own path. The file is moved by one atomic rename (same
// volume) under a random name into <clips folder>/.ujwalam-deleting/, checked again there through its own handle (same
// file id, size, modified time and sha256) and only then unlinked; on any mismatch it is moved back (only to a free
// path, never over a file) or, if that is not possible, left in the holding folder (never deleted). What remains: a
// program that writes the holding folder and guesses the random name within microseconds; and a crash between the
// rename and the unlink leaves the verified file in the holding folder (nothing is lost).
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

export const DELETE_FLAG = 'post-delete-uploaded';
export const DELETED_LOG_NAME = 'deleted.jsonl';
/** The holding folder inside the clips folder (not a YYYY-MM-DD folder, so the clips scan never reads it). */
export const HOLD_DIR_NAME = '.ujwalam-deleting';
/** Reasons that will not change by waiting: the file is kept and not checked again. Every other reason is checked again. */
export const FINAL_KEEP = new Set(['upload-failed', 'upload-rejected', 'not-in-folder', 'outside-folder', 'link', 'not-a-file', 'sha-mismatch', 'no-source-file', 'file-gone', 'unc-path', 'held-in-holding-folder']);

const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (child, parent) => { const rel = path.relative(parent, child); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
/** A UNC, device or long-path form (\\server\share, \\?\, \\.\, //x): never used for a delete. */
const uncLike = (p) => /^[\\/]{2}/.test(p);

/** Is `file` a regular file inside `folder`, reached without any link? -> null (yes) or the reason it is not. */
export function checkInFolder(file, folder) {
  if (typeof file !== 'string' || !file || !path.isAbsolute(file)) return 'no-source-file';
  if (typeof folder !== 'string' || !folder) return 'not-in-folder';
  if (uncLike(file) || uncLike(folder)) return 'unc-path';
  const lexical = path.resolve(file);
  if (!inside(lower(lexical), lower(path.resolve(folder)))) return 'not-in-folder';
  let st;
  try { st = lstatSync(lexical); } catch (e) { return e?.code === 'ENOENT' ? 'file-gone' : 'file-unreadable'; }
  if (st.isSymbolicLink()) return 'link';
  if (!st.isFile()) return 'not-a-file';
  let realFile; let realFolder;
  try { realFile = realpathSync.native(lexical); realFolder = realpathSync.native(path.resolve(folder)); } catch { return 'file-unreadable'; }
  if (!inside(lower(realFile), lower(realFolder))) return 'outside-folder';
  // A junction or link anywhere between the folder and the file changes the real path: refused as well.
  if (lower(path.relative(realFolder, realFile)) !== lower(path.relative(path.resolve(folder), lexical))) return 'link';
  return null;
}

/** sha256 and identity of the file, both through one open handle. -> { sha, id: { dev, ino, size, mtimeNs } }. */
export async function hashWithIdentity(file) {
  const fh = await open(file, 'r');
  try {
    const st = await fh.stat({ bigint: true });
    const h = createHash('sha256'); const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = (await fh.read(buf, 0, buf.length, null)).bytesRead) > 0;) h.update(n === buf.length ? buf : buf.subarray(0, n));
    const after = await fh.stat({ bigint: true });
    if (after.size !== st.size || after.mtimeNs !== st.mtimeNs) throw Object.assign(new Error('changed while hashed'), { code: 'file-changed' });
    return { sha: h.digest('hex'), id: { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs } };
  } finally { await fh.close(); }
}

/** Right before the unlink: the path still names the same file (lstat: same device, file id, size, modified time, not
 *  a link) and its folder still resolves inside the clips folder. -> null (go) or the reason to keep it. */
export function sameFileStill(file, folder, id) {
  let st;
  try { st = lstatSync(file, { bigint: true }); } catch (e) { return e?.code === 'ENOENT' ? 'file-gone' : 'file-unreadable'; }
  if (st.isSymbolicLink() || !st.isFile()) return 'file-changed';
  if (!id || id.ino === 0n || st.dev !== id.dev || st.ino !== id.ino || st.size !== id.size || st.mtimeNs !== id.mtimeNs) return 'file-changed';
  let realDir; let realFolder;
  try { realDir = realpathSync.native(path.dirname(path.resolve(file))); realFolder = realpathSync.native(path.resolve(folder)); } catch { return 'file-unreadable'; }
  if (uncLike(realDir) !== uncLike(realFolder)) return 'unc-path';
  const dirRel = lower(path.relative(realFolder, realDir));
  if (dirRel.startsWith('..') || path.isAbsolute(dirRel)) return 'outside-folder';
  if (dirRel !== lower(path.relative(path.resolve(folder), path.dirname(path.resolve(file))))) return 'link';
  return null;
}

/** The status check's verdict: 'processed' (may delete), 'final' (failed/rejected: keep for good), else null (ask again). */
export function statusVerdict(status) {
  if (!status || status.found !== true) return null;
  if (status.uploadStatus === 'processed') return 'processed';
  if (status.uploadStatus === 'failed' || status.uploadStatus === 'rejected' || status.uploadStatus === 'deleted') return 'final';
  return null;
}

/** The holding folder <clips folder real path>/.ujwalam-deleting: made if missing; must be a real folder (no link or
 *  junction) that resolves to itself inside the clips folder. Throws otherwise. */
export function holdingDir(folder) {
  const realFolder = realpathSync.native(path.resolve(folder));
  const dir = path.join(realFolder, HOLD_DIR_NAME);
  try { mkdirSync(dir); } catch (e) { if (e?.code !== 'EEXIST') throw e; }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('holding folder is not a plain folder');
  if (lower(realpathSync.native(dir)) !== lower(dir)) throw new Error('holding folder resolves elsewhere');
  return dir;
}

const sameIdentity = (a, b) => !!a && !!b && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

/** A held file that failed its check goes back to its own path when that is still free; otherwise it stays in the
 *  holding folder (never overwrites anything, never deleted). -> the keep reason. */
function putBack(held, file, reason) {
  try { lstatSync(file); return 'held-in-holding-folder'; } catch (e) { if (e?.code !== 'ENOENT') return 'held-in-holding-folder'; }
  try { renameSync(held, file); return reason; } catch { return 'held-in-holding-folder'; }
}

export async function deleteUploadedFile({ flagOn, status, item, ledgerEntry, file, folder, logFile, nowMs = Date.now(), beforeUnlink = null, beforeDelete = null }) {
  const keep = (reason) => ({ deleted: false, reason });
  if (flagOn !== true) return keep('flag-off');
  const v = statusVerdict(status);
  if (v === 'final') return keep(status.uploadStatus === 'rejected' ? 'upload-rejected' : 'upload-failed');
  if (v !== 'processed') return keep(status?.found === false ? 'video-not-found' : 'still-processing');
  if (!item || typeof item.videoId !== 'string' || !item.videoId || typeof item.sha !== 'string' || !item.sha) return keep('not-recorded');
  if (typeof item.sentPublishAt !== 'string' || !item.sentPublishAt) return keep('no-publish-time');
  if (!ledgerEntry || ledgerEntry.status !== 'uploaded' || ledgerEntry.videoId !== item.videoId || ledgerEntry.sha256 !== item.sha) return keep('not-recorded');
  if (ledgerEntry.publishAt !== item.sentPublishAt) return keep('no-publish-time');
  const where = checkInFolder(file, folder);
  if (where) return keep(where);
  let hashed;
  try { hashed = await hashWithIdentity(file); } catch (e) { return keep(e?.code === 'file-changed' ? 'file-changed' : 'file-unreadable'); }
  if (hashed.sha !== item.sha) return keep('sha-mismatch');
  if (typeof beforeUnlink === 'function') await beforeUnlink(); // test seam: what another program could do meanwhile
  // Checked again right before the unlink: the same file (by its id) at the same path, in a folder that still resolves
  // inside the clips folder.
  const again = checkInFolder(file, folder) ?? sameFileStill(file, folder, hashed.id);
  if (again) return keep(again);
  // Codex re-review: the file is first moved (one atomic rename, same volume) under a random name into the holding
  // folder inside the clips folder, checked again there by its own handle (same file id, size, time and sha256), and
  // only then unlinked. Anything else found there is moved back and kept.
  let dir;
  try { dir = holdingDir(folder); } catch { return keep('hold-unsafe'); }
  const held = path.join(dir, `${process.pid}-${randomBytes(8).toString('hex')}-${path.basename(file)}`);
  try { renameSync(file, held); } catch (e) { return keep(e?.code === 'ENOENT' ? 'file-gone' : 'delete-failed'); }
  if (typeof beforeDelete === 'function') await beforeDelete(held); // test seam
  let bad = null;
  try {
    const st = lstatSync(held, { bigint: true });
    if (st.isSymbolicLink() || !st.isFile()) bad = 'file-changed';
    else { const h = await hashWithIdentity(held); if (h.sha !== item.sha || !sameIdentity(h.id, hashed.id)) bad = 'file-changed'; }
  } catch { bad = 'file-changed'; }
  if (bad) return keep(putBack(held, file, bad));
  try { unlinkSync(held); } catch { return keep(putBack(held, file, 'delete-failed')); }
  const at = new Date(nowMs).toISOString();
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify({ file: path.basename(file), videoId: item.videoId, at })}\n`);
  } catch { /* the deletion happened; the queue item records it as well */ }
  return { deleted: true, reason: null, at };
}
