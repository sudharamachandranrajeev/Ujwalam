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
import { appendFileSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { sha256File } from './index.mjs';

export const DELETE_FLAG = 'post-delete-uploaded';
export const DELETED_LOG_NAME = 'deleted.jsonl';
/** Reasons that will not change by waiting: the file is kept and not checked again. Every other reason is checked again. */
export const FINAL_KEEP = new Set(['upload-failed', 'upload-rejected', 'not-in-folder', 'outside-folder', 'link', 'not-a-file', 'sha-mismatch', 'no-source-file', 'file-gone']);

const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (child, parent) => { const rel = path.relative(parent, child); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

/** Is `file` a regular file inside `folder`, reached without any link? -> null (yes) or the reason it is not. */
export function checkInFolder(file, folder) {
  if (typeof file !== 'string' || !file || !path.isAbsolute(file)) return 'no-source-file';
  if (typeof folder !== 'string' || !folder) return 'not-in-folder';
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

/** The status check's verdict: 'processed' (may delete), 'final' (failed/rejected: keep for good), else null (ask again). */
export function statusVerdict(status) {
  if (!status || status.found !== true) return null;
  if (status.uploadStatus === 'processed') return 'processed';
  if (status.uploadStatus === 'failed' || status.uploadStatus === 'rejected' || status.uploadStatus === 'deleted') return 'final';
  return null;
}

export async function deleteUploadedFile({ flagOn, status, item, ledgerEntry, file, folder, logFile, nowMs = Date.now() }) {
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
  let sha;
  try { sha = await sha256File(file); } catch { return keep('file-unreadable'); }
  if (sha !== item.sha) return keep('sha-mismatch');
  // Checked again right before the unlink: the file must still be the same regular file in the folder.
  const again = checkInFolder(file, folder);
  if (again) return keep(again);
  try { unlinkSync(file); } catch (e) { return keep(e?.code === 'ENOENT' ? 'file-gone' : 'delete-failed'); }
  const at = new Date(nowMs).toISOString();
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify({ file: path.basename(file), videoId: item.videoId, at })}\n`);
  } catch { /* the deletion happened; the queue item records it as well */ }
  return { deleted: true, reason: null, at };
}
