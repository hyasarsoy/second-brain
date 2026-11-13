/**
 * REST surface for the Notes vault (markdown files in folders).
 *
 *   GET    /notes/tree                      folders + note metadata
 *   GET    /notes/recent?n=20               recently changed notes
 *   GET    /notes/file?path=a/b.md          one note (+ backlinks, outgoing links)
 *   PUT    /notes/file                      {path, content, expected_modified_at?, mode?}
 *   PATCH  /notes/file                      {path, pinned}
 *   DELETE /notes/file?path=a/b.md          move to trash
 *   POST   /notes/append                    {path, text, heading?}
 *   POST   /notes/daily                     {text?, heading?, date?} → today's daily note
 *   POST   /notes/move                      {from, to, kind: "note"|"folder"}
 *   POST   /notes/folder                    {path}
 *   DELETE /notes/folder?path=a             trash every note inside
 *   GET    /notes/search?q=&folder=&tag=    full-text search
 *   GET    /notes/resolve?ref=Title         resolve a [[wikilink]]
 *   GET    /notes/versions?path=            version list
 *   GET    /notes/version?id=               one version's content
 *   POST   /notes/version/restore           {id}
 *   GET    /notes/trash                     trashed notes
 *   POST   /notes/trash/restore             {id}
 *   DELETE /notes/trash?id=                 purge one (or all without id)
 *   POST   /notes/import                    {notes:[{path,content}], on_conflict}
 *   GET    /notes/export?folder=            every note with content
 *
 * Every route needs a valid token and works on the caller's personal workspace.
 */
import type { Env } from "../env";
import { json } from "../lib/http";
import { requireIdentity, type Identity } from "../lib/identity";
import { resolveConfig } from "../config";
import {
  appendToNote,
  backlinks,
  createFolder,
  exportNotes,
  getNote,
  getVersion,
  importNotes,
  InvalidNotePathError,
  listRecentNotes,
  listTrash,
  listTree,
  listVersions,
  moveFolder,
  moveNote,
  NoteConflictError,
  NoteEditError,
  NoteExistsError,
  NoteNotFoundError,
  NoteTooLargeError,
  outgoingLinks,
  purgeTrash,
  resolveNote,
  restoreNote,
  restoreVersion,
  searchNotes,
  setPinned,
  toMeta,
  trashFolder,
  trashNote,
  writeNote,
  type NoteRow,
} from "../notes/store";
import { dailyNoteHeading, dailyNotePath } from "../notes/daily";

const MAX_IMPORT_ITEMS = 100;

function ws(identity: Identity): string {
  return identity.personalWorkspaceId;
}

function noteView(n: NoteRow) {
  return { ...toMeta(n), content: n.content };
}

function failure(e: unknown): Response {
  if (e instanceof InvalidNotePathError || e instanceof NoteEditError) return json({ ok: false, error: e.message }, 400);
  if (e instanceof NoteNotFoundError) return json({ ok: false, error: e.message }, 404);
  if (e instanceof NoteExistsError) return json({ ok: false, error: e.message, code: "exists" }, 409);
  if (e instanceof NoteConflictError) {
    return json({ ok: false, error: e.message, code: "conflict", current: noteView(e.current) }, 409);
  }
  if (e instanceof NoteTooLargeError) return json({ ok: false, error: e.message, code: "too_large" }, 413);
  throw e;
}

async function body<T>(request: Request): Promise<T | Response> {
  try {
    const b = await request.json();
    if (b === null || typeof b !== "object" || Array.isArray(b)) return json({ ok: false, error: "Invalid JSON" }, 400);
    return b as T;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
}

export async function handleNotesRoutes(request: Request, url: URL, env: Env, _ctx: ExecutionContext): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/notes" && !p.startsWith("/notes/")) return null;

  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return auth;
  const W = ws(auth);
  const db = env.DB;
  const m = request.method;
  const q = (k: string) => url.searchParams.get(k) ?? "";

  try {
    if ((p === "/notes" || p === "/notes/tree") && m === "GET") {
      return json({ ok: true, ...(await listTree(db, W)) });
    }

    if (p === "/notes/recent" && m === "GET") {
      const n = Number(q("n") || 20);
      return json({ ok: true, notes: await listRecentNotes(db, W, Number.isFinite(n) ? n : 20) });
    }

    if (p === "/notes/file") {
      if (m === "GET") {
        const note = await getNote(db, W, q("path"));
        if (!note) return json({ ok: false, error: "Not found" }, 404);
        const [back, out] = await Promise.all([backlinks(db, W, note), outgoingLinks(db, W, note)]);
        return json({ ok: true, note: noteView(note), backlinks: back, links: out });
      }
      if (m === "PUT") {
        const b = await body<{ path?: string; content?: string; expected_modified_at?: number; mode?: "create" | "replace" | "upsert" }>(request);
        if (b instanceof Response) return b;
        if (typeof b.path !== "string" || typeof b.content !== "string") return json({ ok: false, error: "path and content are required" }, 400);
        const res = await writeNote(db, W, {
          path: b.path,
          content: b.content,
          mode: b.mode,
          expectedUpdatedAt: typeof b.expected_modified_at === "number" ? b.expected_modified_at : undefined,
          actorId: auth.userId,
          channel: "web",
        });
        return json({ ok: true, created: res.created, changed: res.changed, note: noteView(res.note) }, res.created ? 201 : 200);
      }
      if (m === "PATCH") {
        const b = await body<{ path?: string; pinned?: boolean }>(request);
        if (b instanceof Response) return b;
        if (typeof b.path !== "string" || typeof b.pinned !== "boolean") return json({ ok: false, error: "path and pinned are required" }, 400);
        return json({ ok: true, note: toMeta(await setPinned(db, W, b.path, b.pinned)) });
      }
      if (m === "DELETE") {
        const note = await trashNote(db, W, q("path"));
        return json({ ok: true, trashed: note.path, id: note.id });
      }
    }

    if (p === "/notes/append" && m === "POST") {
      const b = await body<{ path?: string; text?: string; heading?: string }>(request);
      if (b instanceof Response) return b;
      if (typeof b.path !== "string" || typeof b.text !== "string") return json({ ok: false, error: "path and text are required" }, 400);
      const res = await appendToNote(db, W, { path: b.path, text: b.text, heading: b.heading || undefined, actorId: auth.userId, channel: "web" });
      return json({ ok: true, note: noteView(res.note) });
    }

    if (p === "/notes/daily" && m === "POST") {
      const b = await body<{ text?: string; heading?: string; date?: string }>(request);
      if (b instanceof Response) return b;
      const tz = (await resolveConfig(env)).TIMEZONE || "UTC";
      const path = dailyNotePath(Date.now(), tz, b.date);
      let note = await getNote(db, W, path);
      if (!note) note = (await writeNote(db, W, { path, content: `${dailyNoteHeading(path)}\n`, mode: "upsert", actorId: auth.userId, channel: "web" })).note;
      if (b.text && b.text.trim()) {
        note = (await appendToNote(db, W, { path, text: b.text, heading: b.heading || undefined, actorId: auth.userId, channel: "web" })).note;
      }
      return json({ ok: true, note: noteView(note) });
    }

    if (p === "/notes/move" && m === "POST") {
      const b = await body<{ from?: string; to?: string; kind?: string }>(request);
      if (b instanceof Response) return b;
      if (typeof b.from !== "string" || typeof b.to !== "string") return json({ ok: false, error: "from and to are required" }, 400);
      if (b.kind === "folder") return json({ ok: true, ...(await moveFolder(db, W, b.from, b.to)) });
      return json({ ok: true, note: toMeta(await moveNote(db, W, b.from, b.to, auth.userId)) });
    }

    if (p === "/notes/folder") {
      if (m === "POST") {
        const b = await body<{ path?: string }>(request);
        if (b instanceof Response) return b;
        return json({ ok: true, folder: await createFolder(db, W, String(b.path ?? "")) }, 201);
      }
      if (m === "DELETE") return json({ ok: true, trashed: await trashFolder(db, W, q("path")) });
    }

    if (p === "/notes/search" && m === "GET") {
      const limit = Number(q("limit") || 30);
      const hits = await searchNotes(db, W, q("q"), { folder: q("folder") || undefined, tag: q("tag") || undefined, limit: Number.isFinite(limit) ? limit : 30 });
      return json({ ok: true, hits });
    }

    if (p === "/notes/resolve" && m === "GET") {
      const note = await resolveNote(db, W, q("ref"));
      return note ? json({ ok: true, path: note.path, title: note.title }) : json({ ok: false, error: "Not found" }, 404);
    }

    if (p === "/notes/versions" && m === "GET") {
      const { note, versions } = await listVersions(db, W, q("path"));
      return json({ ok: true, note: toMeta(note), versions });
    }
    if (p === "/notes/version" && m === "GET") {
      const v = await getVersion(db, W, q("id"));
      return v ? json({ ok: true, version: v }) : json({ ok: false, error: "Not found" }, 404);
    }
    if (p === "/notes/version/restore" && m === "POST") {
      const b = await body<{ id?: string }>(request);
      if (b instanceof Response) return b;
      return json({ ok: true, note: noteView(await restoreVersion(db, W, String(b.id ?? ""), auth.userId, "web")) });
    }

    if (p === "/notes/trash") {
      if (m === "GET") return json({ ok: true, notes: await listTrash(db, W) });
      if (m === "DELETE") return json({ ok: true, purged: await purgeTrash(db, W, q("id") || undefined) });
    }
    if (p === "/notes/trash/restore" && m === "POST") {
      const b = await body<{ id?: string }>(request);
      if (b instanceof Response) return b;
      return json({ ok: true, note: toMeta(await restoreNote(db, W, String(b.id ?? ""))) });
    }

    if (p === "/notes/import" && m === "POST") {
      const b = await body<{ notes?: Array<{ path?: unknown; content?: unknown }>; on_conflict?: string }>(request);
      if (b instanceof Response) return b;
      if (!Array.isArray(b.notes)) return json({ ok: false, error: "notes must be an array" }, 400);
      if (b.notes.length > MAX_IMPORT_ITEMS) return json({ ok: false, error: `At most ${MAX_IMPORT_ITEMS} notes per request` }, 400);
      const onConflict = b.on_conflict === "overwrite" || b.on_conflict === "skip" ? b.on_conflict : "rename";
      const items = b.notes
        .filter((n) => typeof n?.path === "string" && typeof n?.content === "string")
        .map((n) => ({ path: n.path as string, content: n.content as string }));
      return json({ ok: true, ...(await importNotes(db, W, items, { onConflict, actorId: auth.userId })) });
    }

    if (p === "/notes/export" && m === "GET") {
      return json({ ok: true, notes: await exportNotes(db, W, q("folder") || undefined) });
    }
  } catch (e) {
    return failure(e);
  }

  return json({ ok: false, error: "Unknown notes route or method" }, 404);
}
