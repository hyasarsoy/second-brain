import { describe, it, expect, beforeEach } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import {
  appendToNote, backlinks, createFolder, editNote, getNote, importNotes, listTrash, listTree, listVersions,
  moveFolder, moveNote, purgeTrash, resetNotesSchemaMemo, resolveNote, restoreNote, restoreVersion, searchNotes,
  trashFolder, trashNote, writeNote, NoteConflictError, NoteExistsError, NoteEditError,
} from "../../src/notes/store";
import { appendUnderHeading, deriveTitle, extractTags } from "../../src/notes/markdown";
import { normalizeNotePath, InvalidNotePathError } from "../../src/notes/path";

const WS = "ws_test";
const actor = { actorId: "u1", channel: "mcp" as const };

function freshDb() {
  resetNotesSchemaMemo();
  return makeSqliteD1({ schema: false }).db as unknown as D1Database;
}

describe("notes path + markdown", () => {
  it("normalizes paths", () => {
    expect(normalizeNotePath("/IGA//Proofpoint/ Test Planı ")).toBe("IGA/Proofpoint/Test Planı.md");
    expect(normalizeNotePath("a\\b\\c.MD")).toBe("a/b/c.md");
    expect(() => normalizeNotePath("../etc/passwd")).toThrow(InvalidNotePathError);
    expect(() => normalizeNotePath("a/b?.md")).toThrow(InvalidNotePathError);
  });
  it("derives title and tags", () => {
    const md = "---\ntitle: Başlık\ntags: [iga, Proofpoint]\n---\n# H1\nmetin #görev ve `#kod` #298";
    expect(deriveTitle(md, "x/y.md")).toBe("Başlık");
    expect(extractTags(md).sort()).toEqual(["görev", "iga", "proofpoint"]);
    expect(deriveTitle("# Toplantı\n", "x/y.md")).toBe("Toplantı");
    expect(deriveTitle("düz metin", "x/dosya.md")).toBe("dosya");
  });
  it("appends under a heading", () => {
    const md = "# A\n\n## Yapılacaklar\n- bir\n\n## Notlar\nx\n";
    expect(appendUnderHeading(md, "Yapılacaklar", "- iki")).toBe("# A\n\n## Yapılacaklar\n- bir\n- iki\n\n## Notlar\nx\n");
    expect(appendUnderHeading("# A\n", "Yeni", "y")).toBe("# A\n\n## Yeni\n\ny\n");
  });
});

describe("notes store", () => {
  let db: D1Database;
  beforeEach(() => { db = freshDb(); });

  it("creates, reads, updates with versions and conflict detection", async () => {
    const a = await writeNote(db, WS, { path: "iga/proofpoint/plan", content: "# Plan\nilk", ...actor });
    expect(a.created).toBe(true);
    expect(a.note.path).toBe("iga/proofpoint/plan.md");
    const tree = await listTree(db, WS);
    expect(tree.folders).toEqual(["iga", "iga/proofpoint"]);
    const b = await writeNote(db, WS, { path: "IGA/proofpoint/plan.md", content: "# Plan\nikinci", expectedUpdatedAt: a.note.modified_at, ...actor });
    expect(b.created).toBe(false);
    await expect(writeNote(db, WS, { path: "iga/proofpoint/plan.md", content: "x", expectedUpdatedAt: a.note.modified_at, ...actor }))
      .rejects.toBeInstanceOf(NoteConflictError);
    await expect(writeNote(db, WS, { path: "iga/proofpoint/plan.md", content: "x", mode: "create", ...actor }))
      .rejects.toBeInstanceOf(NoteExistsError);
    const v = await listVersions(db, WS, "iga/proofpoint/plan.md");
    expect(v.versions.length).toBe(1);
    const restored = await restoreVersion(db, WS, v.versions[0].id, "u1", "web");
    expect(restored.content).toBe("# Plan\nilk");
    expect(await getNote(db, "other_ws", "iga/proofpoint/plan.md")).toBeNull();
  });

  it("searches with FTS and LIKE fallback, scoped by folder", async () => {
    await writeNote(db, WS, { path: "iga/dns.md", content: "Azure Public DNS taşıma planı", ...actor });
    await writeNote(db, WS, { path: "kisisel/dns.md", content: "Ev ağı DNS ayarları", ...actor });
    await writeNote(db, "other", { path: "iga/dns.md", content: "Azure gizli", ...actor });
    const all = await searchNotes(db, WS, "dns");
    expect(all.map((h) => h.path).sort()).toEqual(["iga/dns.md", "kisisel/dns.md"]);
    const scoped = await searchNotes(db, WS, "dns", { folder: "iga" });
    expect(scoped.map((h) => h.path)).toEqual(["iga/dns.md"]);
    expect(scoped[0].snippet).toContain("«");
    const both = await searchNotes(db, WS, "azure taşıma");
    expect(both.map((h) => h.path)).toEqual(["iga/dns.md"]);
    const short = await searchNotes(db, WS, "ağ");
    expect(short.map((h) => h.path)).toEqual(["kisisel/dns.md"]);
  });

  it("appends, edits, moves notes and folders, links and trash", async () => {
    await appendToNote(db, WS, { path: "gunluk/2026-11-13", text: "- sabah", heading: "Akış", ...actor });
    const ap = await appendToNote(db, WS, { path: "gunluk/2026-11-13", text: "- öğle", heading: "Akış", ...actor });
    expect(ap.note.content).toBe("## Akış\n\n- sabah\n- öğle\n");
    await expect(editNote(db, WS, { path: "gunluk/2026-11-13", oldText: "yok", newText: "x", ...actor })).rejects.toBeInstanceOf(NoteEditError);
    const ed = await editNote(db, WS, { path: "gunluk/2026-11-13", oldText: "- öğle", newText: "- öğle [[Proje A]]", ...actor });
    expect(ed.note.content).toContain("[[Proje A]]");

    await writeNote(db, WS, { path: "projeler/a/proje-a.md", content: "# Proje A\n", ...actor });
    const target = (await getNote(db, WS, "projeler/a/proje-a.md"))!;
    expect((await backlinks(db, WS, target)).map((b) => b.path)).toEqual(["gunluk/2026-11-13.md"]);
    expect((await resolveNote(db, WS, "[[Proje A]]"))?.path).toBe("projeler/a/proje-a.md");

    const moved = await moveNote(db, WS, "projeler/a/proje-a.md", "arsiv/", "u1");
    expect(moved.path).toBe("arsiv/proje-a.md");
    await createFolder(db, WS, "projeler/a/bos");
    await writeNote(db, WS, { path: "projeler/a/b.md", content: "b", ...actor });
    const mf = await moveFolder(db, WS, "projeler", "eski-projeler");
    expect(mf.moved).toBe(1);
    const tree = await listTree(db, WS);
    expect(tree.folders).toContain("eski-projeler/a/bos");
    expect(tree.folders).not.toContain("projeler");

    await trashNote(db, WS, "arsiv/proje-a.md");
    await writeNote(db, WS, { path: "arsiv/proje-a.md", content: "yeni", ...actor });
    const trash = await listTrash(db, WS);
    expect(trash.length).toBe(1);
    const back = await restoreNote(db, WS, trash[0].id);
    expect(back.path).toBe("arsiv/proje-a (1).md");
    expect(await trashFolder(db, WS, "eski-projeler")).toBe(1);
    expect(await purgeTrash(db, WS)).toBe(1);
    expect((await listTrash(db, WS)).length).toBe(0);
  });

  it("imports with conflict policy", async () => {
    await writeNote(db, WS, { path: "a.md", content: "eski", ...actor });
    const r = await importNotes(db, WS, [{ path: "a.md", content: "yeni" }, { path: "b/c.md", content: "c" }, { path: "../x", content: "x" }], { onConflict: "rename", actorId: "u1" });
    expect(r).toMatchObject({ created: 2, updated: 0, skipped: 0 });
    expect(r.errors.length).toBe(1);
    expect((await getNote(db, WS, "a (1).md"))?.content).toBe("yeni");
  });
});
