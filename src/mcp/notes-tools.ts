/**
 * MCP tools for the Notes vault: long-form markdown documents in folders.
 * Memories (remember/recall) hold short facts and decisions; notes hold
 * documents the user edits and keeps: plans, runbooks, meeting notes,
 * checklists, daily journal.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { resolveConfig } from "../config";
import {
  appendToNote,
  backlinks,
  editNote,
  getNote,
  InvalidNotePathError,
  listRecentNotes,
  listTree,
  moveFolder,
  moveNote,
  NoteConflictError,
  NoteEditError,
  NoteExistsError,
  NoteNotFoundError,
  NoteTooLargeError,
  resolveNote,
  searchNotes,
  trashFolder,
  trashNote,
  writeNote,
  type NoteRow,
} from "../notes/store";
import { dailyNoteHeading, dailyNotePath } from "../notes/daily";
import { isInside, normalizeFolderPath } from "../notes/path";

const READ_DEFAULT_CHARS = 40_000;

type Text = { content: Array<{ type: "text"; text: string }> };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function errorText(e: unknown): Text {
  if (
    e instanceof InvalidNotePathError ||
    e instanceof NoteEditError ||
    e instanceof NoteNotFoundError ||
    e instanceof NoteExistsError ||
    e instanceof NoteTooLargeError
  ) {
    return text(`Not done: ${e.message}`);
  }
  if (e instanceof NoteConflictError) return text(`Not done: ${e.message}`);
  throw e;
}

const VAULT_INTRO =
  "The notes vault holds the user's markdown documents in folders (plans, runbooks, meeting notes, checklists, "
  + "project pages, the daily journal), unlike memories, which hold short facts and decisions. "
  + "Paths look like \"IGA/Proofpoint/Test planı.md\"; notes link with [[Note title]].";

export function registerNoteTools(server: McpServer, env: Env, identity?: Identity): void {
  const ws = () => identity?.personalWorkspaceId;
  const actor = () => identity?.userId ?? "";
  const needIdentity = text("Notes require an authenticated identity.");

  async function find(ref: string): Promise<NoteRow | null> {
    const w = ws()!;
    return (await getNote(env.DB, w, ref).catch(() => null)) ?? (await resolveNote(env.DB, w, ref));
  }

  server.registerTool(
    "notes_tree",
    {
      description: `${VAULT_INTRO} List folders and notes (whole vault or one folder). Check it before creating a note so it lands in the right folder.`,
      inputSchema: {
        folder: z.string().optional().describe("Only list this folder (and below). Omit for the whole vault"),
        recent: z.boolean().optional().describe("Instead of the tree, list the 20 most recently changed notes"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ folder, recent }) => {
      const w = ws();
      if (!w) return needIdentity;
      try {
        if (recent) {
          const notes = await listRecentNotes(env.DB, w, 20);
          if (!notes.length) return text("The vault is empty.");
          return text(notes.map((n) => `- ${n.path} (${day(n.modified_at)})`).join("\n"));
        }
        const f = normalizeFolderPath(folder ?? "");
        const tree = await listTree(env.DB, w);
        const folders = tree.folders.filter((x) => !f || x === f || isInside(x, f));
        const notes = tree.notes.filter((n) => isInside(n.path, f));
        if (!folders.length && !notes.length) return text(f ? `Folder "${f}" is empty or does not exist.` : "The vault is empty. Create the first note with note_write.");
        const lines: string[] = [];
        lines.push(`Folders (${folders.length}):`);
        for (const x of folders) lines.push(`  ${x}/`);
        lines.push(`Notes (${notes.length}):`);
        for (const n of notes.slice(0, 400)) lines.push(`  ${n.path}${n.pinned ? " [pinned]" : ""}${n.tags.length ? ` #${n.tags.join(" #")}` : ""}`);
        if (notes.length > 400) lines.push(`  … ${notes.length - 400} more; pass folder to narrow.`);
        return text(lines.join("\n"));
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    "notes_search",
    {
      description: "Full-text search in the notes vault (every word must appear; partial words of 3+ letters match). Use it when the user refers to a document, plan or procedure they wrote down, or when recall lacks the details.",
      inputSchema: {
        query: z.string().describe("Words to find"),
        folder: z.string().optional().describe("Only search inside this folder"),
        tag: z.string().optional().describe("Only notes with this tag"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results, default 10"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, folder, tag, limit }) => {
      const w = ws();
      if (!w) return needIdentity;
      try {
        const hits = await searchNotes(env.DB, w, query, { folder, tag, limit: limit ?? 10 });
        if (!hits.length) return text(`No note matches "${query}". Try fewer or different words, or notes_tree to browse.`);
        return text(
          hits.map((h) => `- ${h.path} — ${h.title} (${day(h.modified_at)})\n  ${h.snippet}`).join("\n")
            + "\n\nCall note_read(path) for the full text.",
        );
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    "note_read",
    {
      description: "Read a note in full. Accepts a path (\"IGA/DNS plan.md\"), a path without .md, or a [[wikilink]] title. Long notes come back in parts: pass offset to continue.",
      inputSchema: {
        path: z.string().describe("Note path or title"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from, for long notes"),
        max_chars: z.number().int().min(1000).max(200_000).optional().describe(`Characters to return, default ${READ_DEFAULT_CHARS}`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, offset, max_chars }) => {
      const w = ws();
      if (!w) return needIdentity;
      try {
        const note = await find(path);
        if (!note) return text(`No note found for "${path}". Use notes_search or notes_tree.`);
        const start = offset ?? 0;
        const size = max_chars ?? READ_DEFAULT_CHARS;
        const part = note.content.slice(start, start + size);
        const back = await backlinks(env.DB, w, note);
        const header = `${note.path} · "${note.title}" · updated ${day(note.modified_at)}${note.tags.length ? ` · #${note.tags.join(" #")}` : ""}`;
        const more = start + size < note.content.length
          ? `\n\n[partial: characters ${start}-${start + part.length} of ${note.content.length}; call note_read with offset ${start + part.length} for the rest]`
          : "";
        const links = back.length ? `\n\nLinked from: ${back.map((b) => b.path).join(", ")}` : "";
        return text(`${header}\n\n${part}${more}${links}`);
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    "note_write",
    {
      description: "Create a note, or replace a whole note. For changes to an existing note prefer note_edit or note_append. Folders are created automatically; replaced content stays in the note's history.",
      inputSchema: {
        path: z.string().describe("Path such as \"IGA/Proofpoint/Go-live checklist.md\" (.md is added if missing)"),
        content: z.string().describe("Full markdown content. Start with a # heading; the heading becomes the title"),
        mode: z.enum(["create", "replace", "upsert"]).optional().describe("create = fail if it exists (default), replace = fail if missing, upsert = either"),
      },
    },
    async ({ path, content, mode }) => {
      const w = ws();
      if (!w) return needIdentity;
      try {
        const res = await writeNote(env.DB, w, { path, content, mode: mode ?? "create", actorId: actor(), channel: "mcp" });
        return text(`${res.created ? "Created" : res.changed ? "Replaced" : "Unchanged"}: ${res.note.path} ("${res.note.title}").`);
      } catch (e) {
        if (e instanceof NoteExistsError) return text(`Not done: ${e.message} Read it and use note_edit/note_append, or pass mode "replace".`);
        return errorText(e);
      }
    },
  );

  server.registerTool(
    "note_append",
    {
      description: "Add markdown to the end of a note, or to the end of the section under a heading. Creates the note when missing. Good for logs and to-dos (\"- [ ] item\").",
      inputSchema: {
        path: z.string().describe("Note path or title"),
        text: z.string().describe("Markdown to add"),
        heading: z.string().optional().describe("Add at the end of the section with this heading; the section is created when missing"),
      },
    },
    async ({ path, text: body, heading }) => {
      const w = ws();
      if (!w) return needIdentity;
      try {
        const existing = await find(path);
        const res = await appendToNote(env.DB, w, { path: existing?.path ?? path, text: body, heading, actorId: actor(), channel: "mcp" });
        return text(`Added to ${res.note.path}${heading ? ` under "${heading}"` : ""}.`);
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    "note_edit",
    {
      description: "Replace an exact piece of a note with new text. Read the note first; old_text must appear exactly once unless replace_all. E.g. tick a task: \"- [ ] x\" → \"- [x] x\".",
      inputSchema: {
        path: z.string().describe("Note path or title"),
        old_text: z.string().describe("Exact text currently in the note"),
        new_text: z.string().describe("Replacement text (empty string deletes old_text)"),
        replace_all: z.boolean().optional().describe("Replace every occurrence"),
      },
    },
    async ({ path, old_text, new_text, replace_all }) => {
      const w = ws();
      if (!w) return needIdentity;
      try {
        const existing = await find(path);
        if (!existing) return text(`No note found for "${path}".`);
        const res = await editNote(env.DB, w, { path: existing.path, oldText: old_text, newText: new_text, replaceAll: replace_all, actorId: actor(), channel: "mcp" });
        return text(`Edited ${res.note.path} (${res.replacements} replacement${res.replacements === 1 ? "" : "s"}).`);
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    "note_move",
    {
      description: "Rename or move a note or a whole folder. To move a note into a folder keeping its name, end `to` with \"/\".",
      inputSchema: {
        from: z.string().describe("Current note path, or folder path when kind is folder"),
        to: z.string().describe("New path"),
        kind: z.enum(["note", "folder"]).optional().describe("Default note"),
      },
    },
    async ({ from, to, kind }) => {
      const w = ws();
      if (!w) return needIdentity;
      try {
        if (kind === "folder") {
          const r = await moveFolder(env.DB, w, from, to);
          return text(`Moved folder to ${r.folder}/ (${r.moved} notes).`);
        }
        const existing = await find(from);
        if (!existing) return text(`No note found for "${from}".`);
        const n = await moveNote(env.DB, w, existing.path, to, actor());
        return text(`Moved to ${n.path}.`);
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    "note_delete",
    {
      description: "Move a note, or every note in a folder, to the trash (restorable for 30 days). Only when the user asks.",
      inputSchema: {
        path: z.string().describe("Note path, or folder path when kind is folder"),
        kind: z.enum(["note", "folder"]).optional().describe("Default note"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path, kind }) => {
      const w = ws();
      if (!w) return needIdentity;
      try {
        if (kind === "folder") return text(`Moved ${await trashFolder(env.DB, w, path)} notes to the trash.`);
        const existing = await find(path);
        if (!existing) return text(`No note found for "${path}".`);
        await trashNote(env.DB, w, existing.path);
        return text(`Moved ${existing.path} to the trash.`);
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    "note_daily",
    {
      description: "Today's daily note (folder \"Günlük\"). With text, adds it (optionally under a heading); without text, returns the note.",
      inputSchema: {
        text: z.string().optional().describe("Markdown to add to today's note"),
        heading: z.string().optional().describe("Section heading to add under"),
        date: z.string().optional().describe("Another day as YYYY-MM-DD; default today in the brain's timezone"),
      },
    },
    async ({ text: body, heading, date }) => {
      const w = ws();
      if (!w) return needIdentity;
      try {
        const tz = (await resolveConfig(env)).TIMEZONE || "UTC";
        const path = dailyNotePath(Date.now(), tz, date);
        let note = await getNote(env.DB, w, path);
        if (!body || !body.trim()) {
          return note ? text(`${note.path}\n\n${note.content}`) : text(`No daily note for ${path} yet.`);
        }
        if (!note) note = (await writeNote(env.DB, w, { path, content: `${dailyNoteHeading(path)}\n`, mode: "upsert", actorId: actor(), channel: "mcp" })).note;
        note = (await appendToNote(env.DB, w, { path, text: body, heading, actorId: actor(), channel: "mcp" })).note;
        return text(`Added to ${note.path}${heading ? ` under "${heading}"` : ""}.`);
      } catch (e) {
        return errorText(e);
      }
    },
  );
}
