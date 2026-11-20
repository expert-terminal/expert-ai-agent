import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { chunkNote, isRestorableHistoryEntry } from "../src/core";
import { LocalVaultStore } from "../src/local-store";

const originalIndexedDb = globalThis.indexedDB;
const originalKeyRange = globalThis.IDBKeyRange;
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

test("local index supports keyword, semantic, replacement, removal, and retained undo history", async () => {
  const store = new LocalVaultStore(`test-${crypto.randomUUID()}`);
  try {
    const river = chunkNote("Novel/River.md", "# Flood\nA cartographer maps a river flood.", 1).map((chunk) => ({ ...chunk, vector: [1, 0, 0] }));
    const bills = chunkNote("Work/Bills.md", "# Bills\nRent and electricity payments are due.", 1).map((chunk) => ({ ...chunk, vector: [0, 1, 0] }));
    await store.replaceDocument("Novel/River.md", 1, 38, river);
    await store.replaceDocument("Work/Bills.md", 1, 48, bills);
    assert.equal((await store.search("cartographer river")).at(0)?.path, "Novel/River.md");
    assert.equal((await store.search("waterway story", [1, 0, 0])).at(0)?.path, "Novel/River.md");
    assert.equal((await store.stats()).documents, 2);

    const revised = chunkNote("Novel/River.md", "# Flood\nThe flood moved inland.", 2);
    await store.replaceDocument("Novel/River.md", 2, 29, revised);
    assert.equal((await store.search("cartographer")).length, 0, "old posting entries disappear on note reindex");
    assert.equal((await store.search("inland")).at(0)?.path, "Novel/River.md");
    await store.removeDocument("Work/Bills.md");
    assert.equal((await store.stats()).documents, 1);

    await store.addHistory({ id: "h1", createdAt: Date.now(), action: "replace", path: "Novel/River.md", before: "old", after: "new" }, 13);
    assert.equal((await store.getHistoryEntry("h1"))?.before, "old");
    await store.markReverted("h1");
    assert.ok((await store.getHistoryEntry("h1"))?.revertedAt);
    await store.clearSearchIndex();
    assert.equal((await store.stats()).documents, 0, "scope reset clears only derived search data");
    assert.ok((await store.getHistoryEntry("h1"))?.revertedAt, "scope reset preserves local change history");
    await store.clearHistory();
    assert.equal((await store.getHistory(5)).length, 0);
  } finally { await store.close(); }
});

test("incremental sync skips embedding notes that already have current vectors", async () => {
  const { VaultIndexer } = await import("../src/indexer");
  const store = new LocalVaultStore(`test-sync-${crypto.randomUUID()}`);
  const file = { path: "Notes/Current.md", stat: { mtime: 7, size: 30 } } as any;
  const app = {
    vault: { getMarkdownFiles: () => [file], cachedRead: async () => "# Current\nExisting indexed content" },
    metadataCache: { getFileCache: () => null },
  } as any;
  let embeddings = 0;
  try {
    const indexer = new VaultIndexer(app, store);
    indexer.setIndexFolders(["*"]);
    indexer.setSemanticFolders(["*"]);
    indexer.setEmbedder(async (texts) => { embeddings += texts.length; return texts.map(() => [1, 0, 0]); });
    const first = await indexer.sync();
    assert.equal(first.changed, 1);
    assert.ok(embeddings > 0);
    const firstEmbeddingCount = embeddings;
    const second = await indexer.sync();
    assert.equal(second.changed, 0);
    assert.equal(embeddings, firstEmbeddingCount, "unchanged notes are not re-embedded");
  } finally { await store.close(); }
});

test("semantic scope embeds only selected folders and expands incrementally", async () => {
  const { VaultIndexer } = await import("../src/indexer");
  const store = new LocalVaultStore(`test-scope-${crypto.randomUUID()}`);
  const files = [
    { path: "Research/Topic.md", stat: { mtime: 7, size: 30 } },
    { path: "Journal/Today.md", stat: { mtime: 8, size: 30 } },
  ] as any[];
  const app = {
    vault: { getMarkdownFiles: () => files, cachedRead: async (file: any) => file.path.startsWith("Research/") ? "# Topic\nA note about river ecology." : "# Today\nA note about personal journaling." },
    metadataCache: { getFileCache: () => null },
  } as any;
  let embeddedTexts: string[] = [];
  try {
    const indexer = new VaultIndexer(app, store);
    indexer.setIndexFolders(["*"]);
    indexer.setSemanticFolders(["Research"]);
    indexer.setEmbedder(async (texts) => { embeddedTexts.push(...texts); return texts.map(() => [1, 0, 0]); });
    await indexer.sync();
    assert.ok(embeddedTexts.some((text) => text.includes("river ecology")));
    assert.ok(!embeddedTexts.some((text) => text.includes("personal journaling")));
    assert.equal((await store.stats()).vectors, 1);
    const firstCount = embeddedTexts.length;
    await indexer.sync();
    assert.equal(embeddedTexts.length, firstCount, "unchanged scoped notes are not embedded again");
    indexer.setSemanticFolders(["*"]);
    await indexer.sync();
    assert.ok(embeddedTexts.some((text) => text.includes("personal journaling")), "expanding the scope embeds only newly included notes");
    assert.equal((await store.stats()).vectors, 2);
  } finally { await store.close(); }
});

test("duplicate Obsidian modify and Agent callbacks share one in-flight note update", async () => {
  const { VaultIndexer } = await import("../src/indexer");
  const store = new LocalVaultStore(`test-dedupe-${crypto.randomUUID()}`);
  const file = { path: "Notes/Edited.md", stat: { mtime: 9, size: 22 } } as any;
  let reads = 0;
  const app = {
    vault: { getMarkdownFiles: () => [file], cachedRead: async () => { reads++; await new Promise((resolve) => setTimeout(resolve, 10)); return "# Edited\nChanged once."; } },
    metadataCache: { getFileCache: () => null },
  } as any;
  try {
    const indexer = new VaultIndexer(app, store);
    indexer.setIndexFolders(["*"]);
    await Promise.all([indexer.indexFile(file), indexer.indexFile(file)]);
    assert.equal(reads, 1);
    assert.equal((await store.stats()).documents, 1);
  } finally { await store.close(); }
});

test("vault indexing stays idle until folders are explicitly selected", async () => {
  const { VaultIndexer } = await import("../src/indexer");
  const store = new LocalVaultStore(`test-opt-in-${crypto.randomUUID()}`);
  const files = [
    { path: "Research/One.md", stat: { mtime: 1, size: 20 } },
    { path: "Private/Two.md", stat: { mtime: 1, size: 20 } },
  ] as any[];
  let reads = 0;
  const app = { vault: { getMarkdownFiles: () => files, cachedRead: async () => { reads++; return "A note."; } }, metadataCache: { getFileCache: () => null } } as any;
  try {
    const indexer = new VaultIndexer(app, store);
    await indexer.sync();
    assert.equal(reads, 0, "default scope performs no content reads");
    assert.equal((await store.stats()).documents, 0);
    indexer.setIndexFolders(["Research"]);
    await indexer.sync();
    assert.equal(reads, 1, "only the explicitly selected folder is read");
    assert.equal((await store.stats()).documents, 1);
  } finally { await store.close(); }
});

test("selected folders include nested folders by default and can be limited to direct notes", async () => {
  const { VaultIndexer } = await import("../src/indexer");
  const store = new LocalVaultStore(`test-recursive-scope-${crypto.randomUUID()}`);
  const files = [
    { path: "Projects/Overview.md", stat: { mtime: 1, size: 20 } },
    { path: "Projects/Book/Chapter.md", stat: { mtime: 2, size: 20 } },
    { path: "Private/Diary.md", stat: { mtime: 3, size: 20 } },
  ] as any[];
  const app = { vault: { getMarkdownFiles: () => files, cachedRead: async (file: any) => `# ${file.path}\nSelected note.` }, metadataCache: { getFileCache: () => null } } as any;
  try {
    const indexer = new VaultIndexer(app, store);
    indexer.setIndexFolders(["Projects"], true);
    await indexer.sync();
    assert.deepEqual((await store.listDocuments()).map((doc) => doc.path).sort(), ["Projects/Book/Chapter.md", "Projects/Overview.md"]);
    indexer.setIndexFolders(["Projects"], false);
    await indexer.sync();
    assert.deepEqual((await store.listDocuments()).map((doc) => doc.path), ["Projects/Overview.md"]);
  } finally { await store.close(); }
});

test("large scope changes clear only the old search cache before rebuilding the selected scope", async () => {
  const { VaultIndexer } = await import("../src/indexer");
  let docs = Array.from({ length: 200 }, (_, index) => ({ path: `Old/${index}.md`, mtime: 1, size: 10, vectorized: false, ids: [], terms: [] }));
  let clearCount = 0;
  const store = {
    async listDocuments() { return docs; },
    async clearSearchIndex() { clearCount++; docs = []; },
    async replaceDocument(path: string, mtime: number, size: number) { docs.push({ path, mtime, size, vectorized: false, ids: [], terms: [] }); },
    async setLastIndexedAt() {},
    async stats() { return { documents: docs.length, chunks: 1, vectors: 0 }; },
  } as any;
  const file = { path: "Selected/One.md", stat: { mtime: 2, size: 16 } } as any;
  const app = { vault: { getMarkdownFiles: () => [file], cachedRead: async () => "# One\nSelected content." }, metadataCache: { getFileCache: () => null } } as any;
  const indexer = new VaultIndexer(app, store);
  indexer.setIndexFolders(["Selected"], true);
  await indexer.sync();
  assert.equal(clearCount, 1);
  assert.deepEqual(docs.map((doc) => doc.path), ["Selected/One.md"]);
});

test("restore history is previewable only when a safe restore operation exists", () => {
  assert.equal(isRestorableHistoryEntry({ id: "edit", createdAt: 1, action: "replace", path: "a.md", before: "old", after: "new" }), true);
  assert.equal(isRestorableHistoryEntry({ id: "create", createdAt: 1, action: "create", path: "a.md", after: "new" }), true);
  assert.equal(isRestorableHistoryEntry({ id: "trash", createdAt: 1, action: "trash", path: "a.md", before: "old" }), true);
  assert.equal(isRestorableHistoryEntry({ id: "move", createdAt: 1, action: "move", path: "a.md", nextPath: "b.md" }), true);
  assert.equal(isRestorableHistoryEntry({ id: "task", createdAt: 1, action: "task_checkpoint", path: "" }), false);
  assert.equal(isRestorableHistoryEntry({ id: "restore", createdAt: 1, action: "restore", path: "a.md" }), false);
  assert.equal(isRestorableHistoryEntry({ id: "bad", createdAt: 1, action: "replace", path: "a.md", before: "old" }), false);
  assert.equal(isRestorableHistoryEntry({ id: "done", createdAt: 1, action: "replace", path: "a.md", before: "old", after: "new", revertedAt: 2 }), false);
});

test.after(() => {
  globalThis.indexedDB = originalIndexedDb;
  globalThis.IDBKeyRange = originalKeyRange;
});
