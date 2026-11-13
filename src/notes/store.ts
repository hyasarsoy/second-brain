/**
 * Notes vault storage: markdown files in folders, kept in D1 next to the
 * memories but in their own tables. Everything here is additive: new tables,
 * new indexes, nothing that touches `entries`. An older Worker simply ignores
 * these tables, so rolling back a deploy loses no data.
 *
 * Tables
 *   notes          one row per note (soft delete via deleted_at = trash)
 *   note_folders   explicit folders (so an empty folder can exist)
 *   note_versions  earlier contents of a note, newest kept, capped per note
 *   notes_fts      FTS5 trigram index over title/path/content (external content)
 *
 * Every query is scoped by workspace_id. Callers pass the caller's personal
 * workspace, so notes are private to their owner.
 */
import {
  ancestorFolders,
  baseName,
  folderOf,
  InvalidNotePathError,
  isInside,
  likeEscape,
  normalizeFolderPath,
  normalizeNotePath,
} from "./path";
import { appendUnderHeading, deriveTitle, extractTags, extractWikilinks, linkMatchesNote } from "./markdown";

export const MAX_NOTE_BYTES = 512 * 1024;
/** Versions kept per note. */
export const MAX_VERSIONS_PER_NOTE = 50;
/** Editor autosaves inside this window update in place instead of piling up versions. */
export const VERSION_COALESCE_MS = 10 * 60 * 1000;
/** Trash older than this is purged on the next trash listing. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound for tree/backlink scans; a personal vault stays far below it. */
export const MAX_SCAN_ROWS = 5000;

export { InvalidNotePathError };
export class NoteNotFoundError extends Error {}
export class NoteExistsError extends Error {}
export class NoteConflictError extends Error {
  constructor(public current: NoteRow) {
    super("The note changed since you opened it. Reload it and apply your change again.");
  }
}
export class NoteTooLargeError extends Error {
  constructor() {
    super(`Note is larger than ${Math.round(MAX_NOTE_BYTES / 1024)} KB. Split it into several notes.`);
  }
}
export class NoteEditError extends Error {}

export interface NoteRow {
  id: string;
  workspace_id: string;
  path: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  created_at: number;
  modified_at: number;
  deleted_at: number | null;
  actor_id: string;
}

export type NoteMeta = Omit<NoteRow, "content" | "workspace_id" | "actor_id" | "deleted_at"> & { size: number };

export type NoteChannel = "web" | "mcp" | "api" | "import";

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS notes (
     id           TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     path         TEXT NOT NULL COLLATE NOCASE,
     title        TEXT NOT NULL,
     content      TEXT NOT NULL,
     tags         TEXT NOT NULL DEFAULT '[]',
     pinned       INTEGER NOT NULL DEFAULT 0,
     created_at   INTEGER NOT NULL,
     modified_at   INTEGER NOT NULL,
     deleted_at   INTEGER,
     actor_id     TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_ws_path_live ON notes(workspace_id, path) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_notes_ws_updated ON notes(workspace_id, modified_at DESC)`,
  `CREATE TABLE IF NOT EXISTS note_folders (
     workspace_id TEXT NOT NULL,
     path         TEXT NOT NULL COLLATE NOCASE,
     created_at   INTEGER NOT NULL,
     PRIMARY KEY (workspace_id, path)
   )`,
  `CREATE TABLE IF NOT EXISTS note_versions (
     id         TEXT PRIMARY KEY,
     note_id    TEXT NOT NULL,
     path       TEXT NOT NULL,
     title      TEXT NOT NULL,
     content    TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     actor_id   TEXT NOT NULL DEFAULT '',
     channel    TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, created_at DESC)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
     title, path, content, content='notes', content_rowid='rowid', tokenize='trigram'
   )`,
  `CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
     INSERT INTO notes_fts(rowid, title, path, content) VALUES (new.rowid, new.title, new.path, new.content);
   END`,
  `CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
     INSERT INTO notes_fts(notes_fts, rowid, title, path, content) VALUES ('delete', old.rowid, old.title, old.path, old.content);
   END`,
  `CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE OF title, path, content ON notes BEGIN
     INSERT INTO notes_fts(notes_fts, rowid, title, path, content) VALUES ('delete', old.rowid, old.title, old.path, old.content);
     INSERT INTO notes_fts(rowid, title, path, content) VALUES (new.rowid, new.title, new.path, new.content);
   END`,
];

let schemaPromise: Promise<void> | null = null;

/** Idempotent, memoized per isolate; a failure clears the memo so the next call retries. */
export function ensureNotesSchema(db: D1Database): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = db
      .batch(SCHEMA.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((e) => {
        schemaPromise = null;
        throw e;
      });
  }
  return schemaPromise;
}

/** Test seam. */
export function resetNotesSchemaMemo(): void {
  schemaPromise = null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const byteLen = (s: string) => encoder.encode(s).length;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

interface RawNote {
  id: string;
  workspace_id: string;
  path: string;
  title: string;
  content: string;
  tags: string;
  pinned: number;
  created_at: number;
  modified_at: number;
  deleted_at: number | null;
  actor_id: string;
}

function toRow(r: RawNote): NoteRow {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(r.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
  } catch {}
  return { ...r, tags, pinned: !!r.pinned };
}

export function toMeta(r: NoteRow): NoteMeta {
  return {
    id: r.id,
    path: r.path,
    title: r.title,
    tags: r.tags,
    pinned: r.pinned,
    created_at: r.created_at,
    modified_at: r.modified_at,
    size: byteLen(r.content),
  };
}

function checkSize(content: string) {
  if (byteLen(content) > MAX_NOTE_BYTES) throw new NoteTooLargeError();
}

function folderInserts(db: D1Database, ws: string, notePathOrFolder: string, isFolder: boolean, now: number) {
  const folders = isFolder ? ancestorFolders(notePathOrFolder + "/x") : ancestorFolders(notePathOrFolder);
  return folders
    .filter(Boolean)
    .map((f) => db.prepare(`INSERT OR IGNORE INTO note_folders (workspace_id, path, created_at) VALUES (?, ?, ?)`).bind(ws, f, now));
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getNote(db: D1Database, ws: string, rawPath: string): Promise<NoteRow | null> {
  await ensureNotesSchema(db);
  const path = normalizeNotePath(rawPath);
  const r = await db
    .prepare(`SELECT * FROM notes WHERE workspace_id = ? AND path = ? AND deleted_at IS NULL`)
    .bind(ws, path)
    .first<RawNote>();
  return r ? toRow(r) : null;
}

export async function getNoteById(db: D1Database, ws: string, id: string, includeDeleted = false): Promise<NoteRow | null> {
  await ensureNotesSchema(db);
  const r = await db
    .prepare(`SELECT * FROM notes WHERE workspace_id = ? AND id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`)
    .bind(ws, id)
    .first<RawNote>();
  return r ? toRow(r) : null;
}

/**
 * Resolve a loose reference the way a person or an AI would write it: an exact
 * path, a path without ".md", a [[wikilink]] target (title or file name).
 */
export async function resolveNote(db: D1Database, ws: string, ref: string): Promise<NoteRow | null> {
  const clean = ref.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0].trim();
  if (!clean) return null;
  try {
    const exact = await getNote(db, ws, clean);
    if (exact) return exact;
  } catch (e) {
    if (!(e instanceof InvalidNotePathError)) throw e;
  }
  if (clean.includes("/")) return null;
  const { results } = await db
    .prepare(
      `SELECT * FROM notes WHERE workspace_id = ? AND deleted_at IS NULL
         AND (title = ? COLLATE NOCASE OR path = ? COLLATE NOCASE OR path LIKE ? ESCAPE '\\')
       ORDER BY modified_at DESC LIMIT 20`,
    )
    .bind(ws, clean, `${clean}.md`, `%/${likeEscape(clean)}.md`)
    .all<RawNote>();
  const rows = results.map(toRow);
  return rows.find((r) => linkMatchesNote(clean, r)) ?? rows[0] ?? null;
}

export interface Tree {
  folders: string[];
  notes: NoteMeta[];
  truncated: boolean;
}

export async function listTree(db: D1Database, ws: string): Promise<Tree> {
  await ensureNotesSchema(db);
  const [notesRes, foldersRes] = await db.batch([
    db
      .prepare(
        `SELECT id, path, title, tags, pinned, created_at, modified_at, length(CAST(content AS BLOB)) AS size
           FROM notes WHERE workspace_id = ? AND deleted_at IS NULL
          ORDER BY path COLLATE NOCASE LIMIT ${MAX_SCAN_ROWS}`,
      )
      .bind(ws),
    db.prepare(`SELECT path FROM note_folders WHERE workspace_id = ? ORDER BY path COLLATE NOCASE`).bind(ws),
  ]);
  const notes = (notesRes.results as Array<Omit<RawNote, "content"> & { size: number }>).map((r) => {
    let tags: string[] = [];
    try {
      tags = JSON.parse(r.tags);
    } catch {}
    return { id: r.id, path: r.path, title: r.title, tags, pinned: !!r.pinned, created_at: r.created_at, modified_at: r.modified_at, size: r.size };
  });
  const folders = new Set<string>((foldersRes.results as Array<{ path: string }>).map((f) => f.path));
  for (const n of notes) for (const f of ancestorFolders(n.path)) folders.add(f);
  return {
    folders: [...folders].sort((a, b) => a.localeCompare(b, "tr")),
    notes,
    truncated: notes.length >= MAX_SCAN_ROWS,
  };
}

export async function listRecentNotes(db: D1Database, ws: string, limit = 20): Promise<NoteMeta[]> {
  await ensureNotesSchema(db);
  const { results } = await db
    .prepare(
      `SELECT id, path, title, tags, pinned, created_at, modified_at, length(CAST(content AS BLOB)) AS size
         FROM notes WHERE workspace_id = ? AND deleted_at IS NULL
        ORDER BY modified_at DESC LIMIT ?`,
    )
    .bind(ws, Math.max(1, Math.min(200, limit)))
    .all<Omit<RawNote, "content"> & { size: number }>();
  return results.map((r) => {
    let tags: string[] = [];
    try {
      tags = JSON.parse(r.tags);
    } catch {}
    return { id: r.id, path: r.path, title: r.title, tags, pinned: !!r.pinned, created_at: r.created_at, modified_at: r.modified_at, size: r.size };
  });
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface SearchHit {
  id: string;
  path: string;
  title: string;
  snippet: string;
  modified_at: number;
  tags: string[];
}

function tokens(q: string): string[] {
  return q
    .normalize("NFC")
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}#[]+|[^\p{L}\p{N}\]]+$/gu, ""))
    .filter(Boolean)
    .slice(0, 12);
}

function likeSnippet(content: string, needle: string): string {
  const lc = content.toLocaleLowerCase("tr");
  const i = lc.indexOf(needle.toLocaleLowerCase("tr"));
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  if (i < 0) return flat(content.slice(0, 160));
  const start = Math.max(0, i - 60);
  return (start > 0 ? "…" : "") + flat(content.slice(start, i + needle.length + 100)) + "…";
}

/**
 * Full-text search. Every word must appear (AND). Words of 3+ characters use the
 * trigram index; shorter words, or a query with none, fall back to LIKE.
 * `folder` narrows to a folder subtree, `tag` to notes carrying that tag.
 */
export async function searchNotes(
  db: D1Database,
  ws: string,
  query: string,
  opts: { folder?: string; tag?: string; limit?: number } = {},
): Promise<SearchHit[]> {
  await ensureNotesSchema(db);
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const folder = normalizeFolderPath(opts.folder ?? "");
  const words = tokens(query);
  const longWords = words.filter((w) => [...w].length >= 3);
  const shortWords = words.filter((w) => [...w].length < 3);
  const filters: string[] = ["n.workspace_id = ?", "n.deleted_at IS NULL"];
  const binds: unknown[] = [ws];
  if (folder) {
    filters.push(`n.path LIKE ? ESCAPE '\\'`);
    binds.push(`${likeEscape(folder)}/%`);
  }
  if (opts.tag) {
    filters.push(`instr(lower(n.tags), ?) > 0`);
    binds.push(JSON.stringify(opts.tag.replace(/^#/, "").toLocaleLowerCase("tr")).toLowerCase());
  }
  for (const w of shortWords) {
    filters.push(`(instr(lower(n.content), lower(?)) > 0 OR instr(lower(n.title), lower(?)) > 0)`);
    binds.push(w, w);
  }

  type Row = { id: string; path: string; title: string; tags: string; modified_at: number; snip: string | null; content?: string };
  let rows: Row[] = [];
  if (longWords.length) {
    const match = longWords.map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
    try {
      const res = await db
        .prepare(
          `SELECT n.id, n.path, n.title, n.tags, n.modified_at,
                  snippet(notes_fts, 2, '«', '»', '…', 64) AS snip
             FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
            WHERE notes_fts MATCH ? AND ${filters.join(" AND ")}
            ORDER BY bm25(notes_fts, 8.0, 3.0, 1.0) LIMIT ?`,
        )
        .bind(match, ...binds, limit)
        .all<Row>();
      rows = res.results;
    } catch {
      // An FTS failure must not make search unusable: fall back to LIKE.
      rows = await likeQuery();
    }
  } else if (words.length || folder || opts.tag) {
    rows = await likeQuery();
  }

  async function likeQuery(): Promise<Row[]> {
    const f = [...filters];
    const b = [...binds];
    for (const w of longWords) {
      f.push(`(instr(lower(n.content), lower(?)) > 0 OR instr(lower(n.title), lower(?)) > 0 OR instr(lower(n.path), lower(?)) > 0)`);
      b.push(w, w, w);
    }
    const res = await db
      .prepare(`SELECT n.id, n.path, n.title, n.tags, n.modified_at, NULL AS snip, n.content FROM notes n WHERE ${f.join(" AND ")} ORDER BY n.modified_at DESC LIMIT ?`)
      .bind(...b, limit)
      .all<Row>();
    return res.results;
  }

  return rows.map((r) => {
    let tags: string[] = [];
    try {
      tags = JSON.parse(r.tags);
    } catch {}
    const snippet = r.snip ?? (r.content !== undefined ? likeSnippet(r.content, words[0] ?? "") : "");
    return { id: r.id, path: r.path, title: r.title, tags, modified_at: r.modified_at, snippet: snippet.replace(/\s+/g, " ").trim() };
  });
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface WriteResult {
  note: NoteRow;
  created: boolean;
  changed: boolean;
}

/** Snapshot `prev` into note_versions unless the last snapshot is very recent and came from the same channel. */
async function versionStatements(db: D1Database, prev: NoteRow, actorId: string, channel: NoteChannel, now: number): Promise<D1PreparedStatement[]> {
  const last = await db
    .prepare(`SELECT created_at, channel FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(prev.id)
    .first<{ created_at: number; channel: string }>();
  const coalesce = channel === "web" && last && last.channel === "web" && now - prev.modified_at < VERSION_COALESCE_MS && now - last.created_at < VERSION_COALESCE_MS;
  if (coalesce) return [];
  return [
    db
      .prepare(`INSERT INTO note_versions (id, note_id, path, title, content, created_at, actor_id, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId("nv"), prev.id, prev.path, prev.title, prev.content, now, actorId, channel),
    db
      .prepare(
        `DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (
           SELECT id FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT ${MAX_VERSIONS_PER_NOTE})`,
      )
      .bind(prev.id, prev.id),
  ];
}

export interface WriteInput {
  path: string;
  content: string;
  /** "create" fails when the path exists; "replace" fails when it does not; "upsert" does either. */
  mode?: "create" | "replace" | "upsert";
  /** Optimistic concurrency: the modified_at the caller last saw. */
  expectedUpdatedAt?: number;
  actorId: string;
  channel: NoteChannel;
}

export async function writeNote(db: D1Database, ws: string, input: WriteInput): Promise<WriteResult> {
  await ensureNotesSchema(db);
  const path = normalizeNotePath(input.path);
  const content = String(input.content ?? "").replace(/\r\n/g, "\n");
  checkSize(content);
  const mode = input.mode ?? "upsert";
  const now = Date.now();
  const prev = await getNote(db, ws, path);

  if (prev && mode === "create") throw new NoteExistsError(`A note already exists at "${prev.path}".`);
  if (!prev && mode === "replace") throw new NoteNotFoundError(`No note at "${path}".`);

  const title = deriveTitle(content, path);
  const tags = JSON.stringify(extractTags(content));

  if (!prev) {
    const id = newId("note");
    await db.batch([
      db
        .prepare(
          `INSERT INTO notes (id, workspace_id, path, title, content, tags, pinned, created_at, modified_at, deleted_at, actor_id)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)`,
        )
        .bind(id, ws, path, title, content, tags, now, now, input.actorId),
      ...folderInserts(db, ws, path, false, now),
    ]);
    const note = (await getNoteById(db, ws, id))!;
    return { note, created: true, changed: true };
  }

  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== prev.modified_at) {
    throw new NoteConflictError(prev);
  }
  if (prev.content === content && prev.path === path) return { note: prev, created: false, changed: false };

  const stmts = await versionStatements(db, prev, input.actorId, input.channel, now);
  // The WHERE on modified_at makes a concurrent write lose cleanly instead of overwriting.
  const update = db
    .prepare(`UPDATE notes SET path = ?, title = ?, content = ?, tags = ?, modified_at = ?, actor_id = ? WHERE id = ? AND modified_at = ?`)
    .bind(path, title, content, tags, Math.max(now, prev.modified_at + 1), input.actorId, prev.id, prev.modified_at);
  const results = await db.batch([update, ...stmts]);
  const meta = results[0].meta as { changes?: number; rows_written?: number };
  if (!(meta.changes ?? meta.rows_written ?? 0)) {
    const current = await getNoteById(db, ws, prev.id);
    if (current) throw new NoteConflictError(current);
    throw new NoteNotFoundError(`No note at "${path}".`);
  }
  return { note: (await getNoteById(db, ws, prev.id))!, created: false, changed: true };
}

/** Append text to a note (creating it when missing), at the end or under a heading. */
export async function appendToNote(
  db: D1Database,
  ws: string,
  input: { path: string; text: string; heading?: string; actorId: string; channel: NoteChannel },
): Promise<WriteResult> {
  const text = String(input.text ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) throw new NoteEditError("Nothing to append.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const prev = await getNote(db, ws, input.path);
    const base = prev?.content ?? "";
    const next = input.heading
      ? appendUnderHeading(base, input.heading, text)
      : base.trim()
        ? `${base.replace(/\s+$/, "")}\n\n${text}\n`
        : `${text}\n`;
    try {
      return await writeNote(db, ws, {
        path: input.path,
        content: next,
        mode: prev ? "replace" : "create",
        expectedUpdatedAt: prev?.modified_at,
        actorId: input.actorId,
        channel: input.channel,
      });
    } catch (e) {
      if (!(e instanceof NoteConflictError || e instanceof NoteExistsError) || attempt === 2) throw e;
    }
  }
  throw new NoteEditError("Could not append; try again.");
}

/** Replace one exact occurrence of `oldText` (or all, with replaceAll). */
export async function editNote(
  db: D1Database,
  ws: string,
  input: { path: string; oldText: string; newText: string; replaceAll?: boolean; actorId: string; channel: NoteChannel },
): Promise<WriteResult & { replacements: number }> {
  const prev = await getNote(db, ws, input.path);
  if (!prev) throw new NoteNotFoundError(`No note at "${normalizeNotePath(input.path)}".`);
  if (!input.oldText) throw new NoteEditError("old_text is empty.");
  const count = prev.content.split(input.oldText).length - 1;
  if (count === 0) throw new NoteEditError("old_text was not found in the note. Read the note again and copy the text exactly.");
  if (count > 1 && !input.replaceAll) {
    throw new NoteEditError(`old_text appears ${count} times. Add surrounding text to make it unique, or pass replace_all.`);
  }
  const next = input.replaceAll ? prev.content.split(input.oldText).join(input.newText) : prev.content.replace(input.oldText, () => input.newText);
  const res = await writeNote(db, ws, {
    path: prev.path,
    content: next,
    mode: "replace",
    expectedUpdatedAt: prev.modified_at,
    actorId: input.actorId,
    channel: input.channel,
  });
  return { ...res, replacements: input.replaceAll ? count : 1 };
}

export async function setPinned(db: D1Database, ws: string, rawPath: string, pinned: boolean): Promise<NoteRow> {
  const note = await getNote(db, ws, rawPath);
  if (!note) throw new NoteNotFoundError(`No note at "${normalizeNotePath(rawPath)}".`);
  await db.prepare(`UPDATE notes SET pinned = ? WHERE id = ?`).bind(pinned ? 1 : 0, note.id).run();
  return { ...note, pinned };
}

/** Move/rename a single note. */
export async function moveNote(db: D1Database, ws: string, fromRaw: string, toRaw: string, actorId: string): Promise<NoteRow> {
  await ensureNotesSchema(db);
  const note = await getNote(db, ws, fromRaw);
  if (!note) throw new NoteNotFoundError(`No note at "${normalizeNotePath(fromRaw)}".`);
  let to = toRaw.trim().endsWith("/") ? `${normalizeFolderPath(toRaw)}/${baseName(note.path)}.md` : normalizeNotePath(toRaw);
  if (to.startsWith("/")) to = to.slice(1);
  if (to === note.path) return note;
  const clash = await getNote(db, ws, to);
  if (clash && clash.id !== note.id) throw new NoteExistsError(`A note already exists at "${clash.path}".`);
  const now = Date.now();
  // A rename keeps the H1/frontmatter title; only a title that came from the file name follows the new name.
  const title = deriveTitle(note.content, to);
  await db.batch([
    db.prepare(`UPDATE notes SET path = ?, title = ?, modified_at = ?, actor_id = ? WHERE id = ?`).bind(to, title, now, actorId, note.id),
    ...folderInserts(db, ws, to, false, now),
  ]);
  return (await getNoteById(db, ws, note.id))!;
}

/** Move/rename a folder and everything inside it. */
export async function moveFolder(db: D1Database, ws: string, fromRaw: string, toRaw: string): Promise<{ moved: number; folder: string }> {
  await ensureNotesSchema(db);
  const from = normalizeFolderPath(fromRaw);
  const to = normalizeFolderPath(toRaw);
  if (!from) throw new InvalidNotePathError("Cannot move the vault root.");
  if (!to) throw new InvalidNotePathError("Target folder is empty.");
  if (from.toLowerCase() === to.toLowerCase() && from === to) return { moved: 0, folder: to };
  if (isInside(to, from)) throw new InvalidNotePathError("Cannot move a folder into itself.");

  const prefix = `${likeEscape(from)}/%`;
  const { results: inside } = await db
    .prepare(`SELECT id, path, content FROM notes WHERE workspace_id = ? AND deleted_at IS NULL AND path LIKE ? ESCAPE '\\'`)
    .bind(ws, prefix)
    .all<{ id: string; path: string; content: string }>();
  const targets = inside.map((n) => ({ ...n, newPath: to + n.path.slice(from.length) }));
  if (targets.length) {
    const placeholders = targets.map(() => "?").join(",");
    const { results: clashes } = await db
      .prepare(`SELECT path FROM notes WHERE workspace_id = ? AND deleted_at IS NULL AND path IN (${placeholders})`)
      .bind(ws, ...targets.map((t) => t.newPath))
      .all<{ path: string }>();
    const ownIds = new Set(inside.map((n) => n.path.toLowerCase()));
    const real = clashes.filter((c) => !ownIds.has(c.path.toLowerCase()));
    if (real.length) throw new NoteExistsError(`"${real[0].path}" already exists in the target folder.`);
  }
  const now = Date.now();
  const { results: folderRows } = await db
    .prepare(`SELECT path FROM note_folders WHERE workspace_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`)
    .bind(ws, from, prefix)
    .all<{ path: string }>();
  const stmts: D1PreparedStatement[] = [];
  for (const t of targets) {
    stmts.push(db.prepare(`UPDATE notes SET path = ?, title = ?, modified_at = ? WHERE id = ?`).bind(t.newPath, deriveTitle(t.content, t.newPath), now, t.id));
  }
  for (const f of folderRows) {
    stmts.push(db.prepare(`DELETE FROM note_folders WHERE workspace_id = ? AND path = ?`).bind(ws, f.path));
    stmts.push(db.prepare(`INSERT OR IGNORE INTO note_folders (workspace_id, path, created_at) VALUES (?, ?, ?)`).bind(ws, to + f.path.slice(from.length), now));
  }
  stmts.push(...folderInserts(db, ws, to, true, now));
  // D1 batches are transactional; chunk only to stay under per-batch limits on large folders.
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  return { moved: targets.length, folder: to };
}

export async function createFolder(db: D1Database, ws: string, raw: string): Promise<string> {
  await ensureNotesSchema(db);
  const folder = normalizeFolderPath(raw);
  if (!folder) throw new InvalidNotePathError("Folder path is empty.");
  await db.batch(folderInserts(db, ws, folder, true, Date.now()));
  return folder;
}

/** Move a note to the trash. */
export async function trashNote(db: D1Database, ws: string, rawPath: string): Promise<NoteRow> {
  const note = await getNote(db, ws, rawPath);
  if (!note) throw new NoteNotFoundError(`No note at "${normalizeNotePath(rawPath)}".`);
  await db.prepare(`UPDATE notes SET deleted_at = ? WHERE id = ?`).bind(Date.now(), note.id).run();
  return note;
}

/** Trash every note in a folder subtree and drop the folder rows. */
export async function trashFolder(db: D1Database, ws: string, raw: string): Promise<number> {
  await ensureNotesSchema(db);
  const folder = normalizeFolderPath(raw);
  if (!folder) throw new InvalidNotePathError("Cannot delete the vault root.");
  const prefix = `${likeEscape(folder)}/%`;
  const now = Date.now();
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM notes WHERE workspace_id = ? AND deleted_at IS NULL AND path LIKE ? ESCAPE '\\'`)
    .bind(ws, prefix)
    .first<{ n: number }>();
  await db.batch([
    db.prepare(`UPDATE notes SET deleted_at = ? WHERE workspace_id = ? AND deleted_at IS NULL AND path LIKE ? ESCAPE '\\'`).bind(now, ws, prefix),
    db.prepare(`DELETE FROM note_folders WHERE workspace_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`).bind(ws, folder, prefix),
  ]);
  return count?.n ?? 0;
}

export async function listTrash(db: D1Database, ws: string): Promise<Array<NoteMeta & { deleted_at: number }>> {
  await ensureNotesSchema(db);
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  await purgeStatements(db, ws, `deleted_at IS NOT NULL AND deleted_at < ?`, [cutoff]);
  const { results } = await db
    .prepare(
      `SELECT id, path, title, tags, pinned, created_at, modified_at, deleted_at, length(CAST(content AS BLOB)) AS size
         FROM notes WHERE workspace_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500`,
    )
    .bind(ws)
    .all<Omit<RawNote, "content"> & { size: number; deleted_at: number }>();
  return results.map((r) => ({
    id: r.id,
    path: r.path,
    title: r.title,
    tags: (() => {
      try {
        return JSON.parse(r.tags);
      } catch {
        return [];
      }
    })(),
    pinned: !!r.pinned,
    created_at: r.created_at,
    modified_at: r.modified_at,
    size: r.size,
    deleted_at: r.deleted_at,
  }));
}

async function purgeStatements(db: D1Database, ws: string, where: string, binds: unknown[]) {
  const { results } = await db
    .prepare(`SELECT id FROM notes WHERE workspace_id = ? AND ${where} LIMIT 200`)
    .bind(ws, ...binds)
    .all<{ id: string }>();
  if (!results.length) return 0;
  const ids = results.map((r) => r.id);
  const ph = ids.map(() => "?").join(",");
  await db.batch([
    db.prepare(`DELETE FROM note_versions WHERE note_id IN (${ph})`).bind(...ids),
    db.prepare(`DELETE FROM notes WHERE workspace_id = ? AND id IN (${ph})`).bind(ws, ...ids),
  ]);
  return ids.length;
}

/** Restore a trashed note. If its path is taken meanwhile, it comes back with a suffix. */
export async function restoreNote(db: D1Database, ws: string, id: string): Promise<NoteRow> {
  const note = await getNoteById(db, ws, id, true);
  if (!note || note.deleted_at === null) throw new NoteNotFoundError("That note is not in the trash.");
  let path = note.path;
  for (let i = 1; await getNote(db, ws, path); i++) {
    path = `${note.path.slice(0, -3)} (${i}).md`;
    if (i > 50) throw new NoteExistsError("Could not find a free name to restore to.");
  }
  const now = Date.now();
  await db.batch([
    db.prepare(`UPDATE notes SET deleted_at = NULL, path = ?, modified_at = ? WHERE id = ?`).bind(path, now, id),
    ...folderInserts(db, ws, path, false, now),
  ]);
  return (await getNoteById(db, ws, id))!;
}

/** Permanently delete one trashed note, or the whole trash when id is omitted. */
export async function purgeTrash(db: D1Database, ws: string, id?: string): Promise<number> {
  await ensureNotesSchema(db);
  if (id) return purgeStatements(db, ws, `deleted_at IS NOT NULL AND id = ?`, [id]);
  let total = 0;
  for (let i = 0; i < 25; i++) {
    const n = await purgeStatements(db, ws, `deleted_at IS NOT NULL`, []);
    total += n;
    if (n < 200) break;
  }
  return total;
}

// ── Versions ────────────────────────────────────────────────────────────────

export interface VersionMeta {
  id: string;
  created_at: number;
  title: string;
  path: string;
  size: number;
  channel: string;
}

export async function listVersions(db: D1Database, ws: string, rawPath: string): Promise<{ note: NoteRow; versions: VersionMeta[] }> {
  const note = await getNote(db, ws, rawPath);
  if (!note) throw new NoteNotFoundError(`No note at "${normalizeNotePath(rawPath)}".`);
  const { results } = await db
    .prepare(
      `SELECT id, created_at, title, path, length(CAST(content AS BLOB)) AS size, channel
         FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT ${MAX_VERSIONS_PER_NOTE}`,
    )
    .bind(note.id)
    .all<VersionMeta>();
  return { note, versions: results };
}

export async function getVersion(db: D1Database, ws: string, versionId: string): Promise<(VersionMeta & { content: string; note_id: string }) | null> {
  await ensureNotesSchema(db);
  // Join back to notes so a version id from another workspace never reads.
  return db
    .prepare(
      `SELECT v.id, v.note_id, v.created_at, v.title, v.path, v.content, v.channel, length(CAST(v.content AS BLOB)) AS size
         FROM note_versions v JOIN notes n ON n.id = v.note_id
        WHERE v.id = ? AND n.workspace_id = ?`,
    )
    .bind(versionId, ws)
    .first();
}

export async function restoreVersion(db: D1Database, ws: string, versionId: string, actorId: string, channel: NoteChannel): Promise<NoteRow> {
  const v = await getVersion(db, ws, versionId);
  if (!v) throw new NoteNotFoundError("Version not found.");
  const note = await getNoteById(db, ws, v.note_id);
  if (!note) throw new NoteNotFoundError("The note for that version is in the trash or gone.");
  const res = await writeNote(db, ws, { path: note.path, content: v.content, mode: "replace", actorId, channel });
  return res.note;
}

// ── Links ───────────────────────────────────────────────────────────────────

export interface LinkInfo {
  path: string;
  title: string;
}

/** Notes that [[link]] to this one. */
export async function backlinks(db: D1Database, ws: string, note: NoteRow): Promise<LinkInfo[]> {
  const needles = new Set([note.title, baseName(note.path), note.path.replace(/\.md$/i, "")].filter((s) => s.length > 0));
  const conds = [...needles].map(() => `instr(content, ?) > 0`).join(" OR ");
  const { results } = await db
    .prepare(
      `SELECT id, path, title, content FROM notes
        WHERE workspace_id = ? AND deleted_at IS NULL AND id != ? AND instr(content, '[[') > 0 AND (${conds})
        ORDER BY modified_at DESC LIMIT 200`,
    )
    .bind(ws, note.id, ...[...needles].map((n) => `[[${n}`))
    .all<{ id: string; path: string; title: string; content: string }>();
  return results
    .filter((r) => extractWikilinks(r.content).some((t) => linkMatchesNote(t, note)))
    .map((r) => ({ path: r.path, title: r.title }));
}

/** Outgoing [[links]] of a note, resolved to existing notes in one read. */
export async function outgoingLinks(db: D1Database, ws: string, note: NoteRow): Promise<Array<{ target: string; path: string | null }>> {
  const targets = extractWikilinks(note.content).slice(0, 100);
  if (!targets.length) return [];
  const { results } = await db
    .prepare(`SELECT path, title FROM notes WHERE workspace_id = ? AND deleted_at IS NULL LIMIT ${MAX_SCAN_ROWS}`)
    .bind(ws)
    .all<{ path: string; title: string }>();
  return targets.map((t) => ({ target: t, path: results.find((r) => linkMatchesNote(t, r))?.path ?? null }));
}

// ── Bulk import / export ────────────────────────────────────────────────────

export interface ImportItem {
  path: string;
  content: string;
}

/**
 * Bulk import in a fixed number of D1 calls (one read, one batched write),
 * so a large Notion export stays inside the Workers subrequest budget.
 */
export async function importNotes(
  db: D1Database,
  ws: string,
  items: ImportItem[],
  opts: { onConflict: "skip" | "overwrite" | "rename"; actorId: string },
): Promise<{ created: number; updated: number; skipped: number; errors: Array<{ path: string; error: string }> }> {
  await ensureNotesSchema(db);
  const out = { created: 0, updated: 0, skipped: 0, errors: [] as Array<{ path: string; error: string }> };
  const { results: existingRows } = await db
    .prepare(`SELECT * FROM notes WHERE workspace_id = ? AND deleted_at IS NULL LIMIT ${MAX_SCAN_ROWS}`)
    .bind(ws)
    .all<RawNote>();
  const existing = new Map(existingRows.map((r) => [r.path.toLowerCase(), toRow(r)]));
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const folders = new Set<string>();

  for (const item of items) {
    try {
      let path = normalizeNotePath(item.path);
      const content = String(item.content ?? "").replace(/\r\n/g, "\n");
      checkSize(content);
      const prev = existing.get(path.toLowerCase());
      if (prev && opts.onConflict === "skip") {
        out.skipped++;
        continue;
      }
      if (prev && opts.onConflict === "rename") {
        const stem = path.slice(0, -3);
        let i = 1;
        while (existing.has(`${stem} (${i}).md`.toLowerCase())) i++;
        path = `${stem} (${i}).md`;
      }
      const title = deriveTitle(content, path);
      const tags = JSON.stringify(extractTags(content));
      const target = existing.get(path.toLowerCase());
      if (target) {
        if (target.content === content) {
          out.skipped++;
          continue;
        }
        stmts.push(
          db
            .prepare(`INSERT INTO note_versions (id, note_id, path, title, content, created_at, actor_id, channel) VALUES (?, ?, ?, ?, ?, ?, ?, 'import')`)
            .bind(newId("nv"), target.id, target.path, target.title, target.content, now, opts.actorId),
          db
            .prepare(`UPDATE notes SET title = ?, content = ?, tags = ?, modified_at = ?, actor_id = ? WHERE id = ?`)
            .bind(title, content, tags, now, opts.actorId, target.id),
        );
        existing.set(path.toLowerCase(), { ...target, content });
        out.updated++;
      } else {
        const id = newId("note");
        stmts.push(
          db
            .prepare(
              `INSERT INTO notes (id, workspace_id, path, title, content, tags, pinned, created_at, modified_at, deleted_at, actor_id)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)`,
            )
            .bind(id, ws, path, title, content, tags, now, now, opts.actorId),
        );
        existing.set(path.toLowerCase(), { id, workspace_id: ws, path, title, content, tags: [], pinned: false, created_at: now, modified_at: now, deleted_at: null, actor_id: opts.actorId });
        out.created++;
      }
      for (const f of ancestorFolders(path)) folders.add(f);
    } catch (e) {
      out.errors.push({ path: String(item.path), error: (e as Error).message });
    }
  }
  for (const f of folders) {
    stmts.push(db.prepare(`INSERT OR IGNORE INTO note_folders (workspace_id, path, created_at) VALUES (?, ?, ?)`).bind(ws, f, now));
  }
  if (stmts.length) await db.batch(stmts);
  return out;
}

export async function exportNotes(db: D1Database, ws: string, folder?: string): Promise<Array<{ path: string; content: string; modified_at: number }>> {
  await ensureNotesSchema(db);
  const f = normalizeFolderPath(folder ?? "");
  const { results } = await db
    .prepare(
      `SELECT path, content, modified_at FROM notes WHERE workspace_id = ? AND deleted_at IS NULL${f ? ` AND path LIKE ? ESCAPE '\\'` : ""}
        ORDER BY path LIMIT ${MAX_SCAN_ROWS}`,
    )
    .bind(ws, ...(f ? [`${likeEscape(f)}/%`] : []))
    .all<{ path: string; content: string; modified_at: number }>();
  return results;
}

export { folderOf, normalizeFolderPath, normalizeNotePath };
