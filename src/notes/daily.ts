import { zonedDateParts } from "../when/timezone";

export const DAILY_FOLDER = "Günlük";

/** "Günlük/2026-11-13.md" for the calendar day `now` falls on in `timezone`. */
export function dailyNotePath(now: number, timezone: string, date?: string): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return `${DAILY_FOLDER}/${date}.md`;
  const p = zonedDateParts(now, timezone);
  const mm = String(p.month0 + 1).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${DAILY_FOLDER}/${p.year}-${mm}-${dd}.md`;
}

/** Heading for a new daily note, e.g. "# 13 Kasım 2026 Cuma". */
export function dailyNoteHeading(path: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})\.md$/.exec(path);
  if (!m) return "# Günlük";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  const text = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric", weekday: "long", timeZone: "UTC" }).format(d);
  return `# ${text}`;
}
