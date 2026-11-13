/**
 * Path rules for the Notes vault (markdown files in folders).
 *
 * A note path is a "/"-separated relative path ending in ".md", for example
 * "iga/proofpoint/test-plani.md". A folder path is the same without the
 * extension: "iga/proofpoint". Paths never start or end with "/", never hold
 * "." or ".." segments and never hold control characters.
 *
 * Pure module: no Env, no DB.
 */

export const MAX_SEGMENT_CHARS = 120;
export const MAX_PATH_CHARS = 512;
export const NOTE_EXT = ".md";

export class InvalidNotePathError extends Error {}

// Control characters, plus characters Windows/macOS file systems refuse. Keeping
// paths file-system safe means an exported zip always unpacks cleanly.
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f<>:"|?*]/;

function cleanSegments(raw: string): string[] {
  const unified = String(raw ?? "").replace(/\\/g, "/").normalize("NFC");
  const segments: string[] = [];
  for (const part of unified.split("/")) {
    const seg = part.trim().replace(/\s+/g, " ");
    if (!seg || seg === ".") continue;
    if (seg === "..") throw new InvalidNotePathError('".." is not allowed in a note path');
    if (BAD_CHARS.test(seg)) throw new InvalidNotePathError(`"${seg}" contains a character that is not allowed in a path`);
    if ([...seg].length > MAX_SEGMENT_CHARS) throw new InvalidNotePathError(`a path segment is longer than ${MAX_SEGMENT_CHARS} characters`);
    segments.push(seg);
  }
  return segments;
}

/** Normalize a folder path. "" is the vault root. */
export function normalizeFolderPath(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const segments = cleanSegments(raw);
  const out = segments.join("/");
  if (out.length > MAX_PATH_CHARS) throw new InvalidNotePathError(`path is longer than ${MAX_PATH_CHARS} characters`);
  return out;
}

/** Normalize a note path; ".md" is added when missing. */
export function normalizeNotePath(raw: string | null | undefined): string {
  const segments = cleanSegments(raw ?? "");
  if (!segments.length) throw new InvalidNotePathError("note path is empty");
  let last = segments[segments.length - 1];
  if (!last.toLowerCase().endsWith(NOTE_EXT)) last += NOTE_EXT;
  else last = last.slice(0, -NOTE_EXT.length) + NOTE_EXT;
  if (last === NOTE_EXT) throw new InvalidNotePathError("note file name is empty");
  segments[segments.length - 1] = last;
  const out = segments.join("/");
  if (out.length > MAX_PATH_CHARS) throw new InvalidNotePathError(`path is longer than ${MAX_PATH_CHARS} characters`);
  return out;
}

export function folderOf(notePath: string): string {
  const i = notePath.lastIndexOf("/");
  return i < 0 ? "" : notePath.slice(0, i);
}

export function baseName(notePath: string): string {
  const i = notePath.lastIndexOf("/");
  const name = i < 0 ? notePath : notePath.slice(i + 1);
  return name.toLowerCase().endsWith(NOTE_EXT) ? name.slice(0, -NOTE_EXT.length) : name;
}

/** Every ancestor folder of a path, shallowest first: "a/b/c.md" → ["a", "a/b"]. */
export function ancestorFolders(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** True when `path` sits inside `folder` (at any depth). The root contains everything. */
export function isInside(path: string, folder: string): boolean {
  if (!folder) return true;
  return path.toLowerCase().startsWith(folder.toLowerCase() + "/");
}

/** Escape LIKE wildcards; pair with `ESCAPE '\\'`. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}
