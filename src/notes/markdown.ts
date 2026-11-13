/**
 * Small, dependency-free markdown helpers for the Notes vault: frontmatter,
 * title, tags and [[wikilinks]]. Pure module.
 */
import { baseName } from "./path";

export interface Frontmatter {
  raw: string;
  fields: Record<string, string | string[]>;
  body: string;
}

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** A tolerant YAML subset: `key: value`, `key: [a, b]` and `key:` followed by `- item` lines. */
export function parseFrontmatter(content: string): Frontmatter {
  const m = FM_RE.exec(content);
  if (!m) return { raw: "", fields: {}, body: content };
  const fields: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const cur = fields[listKey];
      const arr = Array.isArray(cur) ? cur : [];
      arr.push(unquote(item[1]));
      fields[listKey] = arr;
      continue;
    }
    const kv = /^([A-Za-z0-9_\-ğüşıöçĞÜŞİÖÇ]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (value === "") {
      listKey = key;
      fields[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      listKey = null;
      fields[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else {
      listKey = null;
      fields[key] = unquote(value);
    }
  }
  return { raw: m[0], fields, body: content.slice(m[0].length) };
}

/** Title: frontmatter `title`, else the first `# heading`, else the file name. */
export function deriveTitle(content: string, path: string): string {
  const fm = parseFrontmatter(content);
  const t = fm.fields.title;
  if (typeof t === "string" && t.trim()) return t.trim().slice(0, 200);
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(fm.body);
  if (h) return h[1].trim().slice(0, 200);
  return baseName(path).slice(0, 200);
}

const INLINE_TAG = /(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;

/** Tags from frontmatter (`tags`/`etiketler`) plus inline #tags outside code. Lowercased, unique. */
export function extractTags(content: string): string[] {
  const fm = parseFrontmatter(content);
  const out = new Set<string>();
  for (const key of ["tags", "tag", "etiketler", "etiket"]) {
    const v = fm.fields[key];
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
    for (const t of list) {
      const clean = t.trim().replace(/^#/, "").toLocaleLowerCase("tr");
      if (clean) out.add(clean.slice(0, 64));
    }
  }
  const body = fm.body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  for (const m of body.matchAll(INLINE_TAG)) {
    const tag = m[2];
    if (/^\d+$/.test(tag)) continue; // "#298" is an issue reference, not a tag
    out.add(tag.toLocaleLowerCase("tr").slice(0, 64));
    if (out.size >= 64) break;
  }
  return [...out];
}

/** Targets of [[wikilinks]] in a note: "[[Page|alias]]" and "[[folder/page#heading]]" give "Page", "folder/page". */
export function extractWikilinks(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    const target = m[1].trim();
    if (target) out.add(target);
  }
  return [...out];
}

/** Does a wikilink target point at this note? Matches title, file name or path (with or without .md), case-insensitive. */
export function linkMatchesNote(target: string, note: { path: string; title: string }): boolean {
  const t = target.trim().replace(/\.md$/i, "").toLocaleLowerCase("tr");
  const candidates = [
    note.title.toLocaleLowerCase("tr"),
    baseName(note.path).toLocaleLowerCase("tr"),
    note.path.replace(/\.md$/i, "").toLocaleLowerCase("tr"),
  ];
  return candidates.includes(t);
}

/**
 * Append text at the end of the section that starts with `heading` (any level),
 * i.e. just before the next heading of the same or a higher level. When the
 * heading does not exist, a new "## heading" section is added at the end.
 */
export function appendUnderHeading(content: string, heading: string, text: string): string {
  const lines = content.split("\n");
  const want = heading.replace(/^#+\s*/, "").trim().toLocaleLowerCase("tr");
  let start = -1;
  let level = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (h && h[2].trim().toLocaleLowerCase("tr") === want) {
      start = i;
      level = h[1].length;
      break;
    }
  }
  const block = text.replace(/\s+$/, "");
  if (start < 0) {
    const sep = content.trim() ? (content.endsWith("\n") ? "\n" : "\n\n") : "";
    return `${content}${sep}## ${heading.replace(/^#+\s*/, "").trim()}\n\n${block}\n`;
  }
  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const h = /^(#{1,6})\s+/.exec(lines[i]);
    if (h && h[1].length <= level) {
      end = i;
      break;
    }
  }
  // Insert after the last non-blank line of the section.
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const needsGap = insertAt === start + 1;
  return [...before, ...(needsGap ? [""] : []), block, ...(after.length && after[0].trim() !== "" ? [""] : []), ...after].join("\n");
}
