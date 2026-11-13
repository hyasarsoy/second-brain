import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { resetNotesSchemaMemo } from "../../src/notes/store";
import type { Identity } from "../../src/lib/identity";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

describe("notes MCP tools", () => {
  it("write, append, edit, search, read, move, delete round-trip", async () => {
    resetNotesSchemaMemo();
    const env = makeTestEnv(makeSqliteD1({ schema: false }).db as never);
    const identity = { userId: "owner", role: "admin", personalWorkspaceId: "ws_me", companyWorkspaceIds: [] } as unknown as Identity;
    const server = buildMcpServer(env, ctx, identity);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(a), server.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
      return r.content[0].text;
    };
    expect(await call("note_write", { path: "Confidenya/Müşteriler/Eska", content: "# Eska Valve\n\n## Açık işler\n- [ ] Wazuh raporu\n" })).toMatch(/Created: Confidenya\/Müşteriler\/Eska.md/);
    expect(await call("note_write", { path: "Confidenya/Müşteriler/Eska", content: "x" })).toMatch(/already exists/);
    expect(await call("note_append", { path: "Eska Valve", text: "- [ ] Forcepoint raporu", heading: "Açık işler" })).toMatch(/Added to Confidenya\/Müşteriler\/Eska.md/);
    expect(await call("note_edit", { path: "Eska Valve", old_text: "- [ ] Wazuh raporu", new_text: "- [x] Wazuh raporu" })).toMatch(/1 replacement/);
    expect(await call("notes_search", { query: "forcepoint" })).toMatch(/Eska.md/);
    const read = await call("note_read", { path: "[[Eska Valve]]" });
    expect(read).toContain("- [x] Wazuh raporu\n- [ ] Forcepoint raporu");
    expect(await call("notes_tree", {})).toMatch(/Confidenya\/Müşteriler\//);
    expect(await call("note_move", { from: "Confidenya", to: "Şirket/Confidenya", kind: "folder" })).toMatch(/1 notes/);
    expect(await call("note_daily", { text: "Eska toplantısı", heading: "Notlar" })).toMatch(/Günlük\/\d{4}-\d{2}-\d{2}\.md/);
    expect(await call("note_delete", { path: "Şirket/Confidenya/Müşteriler/Eska.md" })).toMatch(/trash/);
    expect(await call("notes_search", { query: "forcepoint" })).toMatch(/No note matches/);
    await client.close();
  });
});
