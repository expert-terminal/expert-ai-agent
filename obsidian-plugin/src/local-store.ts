import type { HistoryEntry, NoteChunk, SearchHit } from "./core";
import { rankHybrid } from "./core";

interface IndexedDoc {
  path: string;
  mtime: number;
  size: number;
  vectorized: boolean;
  ids: string[];
  terms: string[];
}

interface Posting {
  term: string;
  rows: Array<{ id: string; tf: number; length: number }>;
}

interface VectorRow { id: string; vector: Int8Array }
interface MetaRow { key: string; value: number | string }
export interface NoteSnapshot { path: string; text: string; updatedAt: number }

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local index operation failed."));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Local index transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Local index transaction was aborted."));
  });
}

function quantize(vector?: ArrayLike<number>): Int8Array | undefined {
  if (!vector) return undefined;
  const out = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(Number(vector[i]) * 127)));
  return out;
}

function expand(vector: Int8Array): number[] {
  return Array.from(vector, (value) => value / 127);
}

export class LocalVaultStore {
  private dbPromise: Promise<IDBDatabase>;

  constructor(dbName: string) {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        const tx = request.transaction!;
        const chunks = db.objectStoreNames.contains("chunks") ? tx.objectStore("chunks") : db.createObjectStore("chunks", { keyPath: "id" });
        if (!chunks.indexNames.contains("path")) chunks.createIndex("path", "path", { unique: false });
        if (!db.objectStoreNames.contains("vectors")) db.createObjectStore("vectors", { keyPath: "id" });
        if (!db.objectStoreNames.contains("postings")) db.createObjectStore("postings", { keyPath: "term" });
        const docs = db.objectStoreNames.contains("docs") ? tx.objectStore("docs") : db.createObjectStore("docs", { keyPath: "path" });
        if (!docs.indexNames.contains("mtime")) docs.createIndex("mtime", "mtime", { unique: false });
        const history = db.objectStoreNames.contains("history") ? tx.objectStore("history") : db.createObjectStore("history", { keyPath: "id" });
        if (!history.indexNames.contains("createdAt")) history.createIndex("createdAt", "createdAt", { unique: false });
        if (!history.indexNames.contains("path")) history.createIndex("path", "path", { unique: false });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
        if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "path" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open the private local index."));
      request.onblocked = () => reject(new Error("Close another Obsidian window using this vault, then retry."));
    });
  }

  async close() { (await this.dbPromise).close(); }

  async getSnapshot(path: string): Promise<NoteSnapshot | undefined> {
    const db = await this.dbPromise;
    const tx = db.transaction("snapshots", "readonly");
    const snapshot = await requestResult(tx.objectStore("snapshots").get(path)) as NoteSnapshot | undefined;
    await done(tx);
    return snapshot;
  }

  async putSnapshot(snapshot: NoteSnapshot): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction("snapshots", "readwrite");
    tx.objectStore("snapshots").put(snapshot);
    await done(tx);
  }

  async deleteSnapshot(path: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction("snapshots", "readwrite");
    tx.objectStore("snapshots").delete(path);
    await done(tx);
  }

  async moveSnapshot(oldPath: string, newPath: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction("snapshots", "readwrite");
    const store = tx.objectStore("snapshots");
    const snapshot = await requestResult(store.get(oldPath)) as NoteSnapshot | undefined;
    if (snapshot) { store.put({ ...snapshot, path: newPath }); store.delete(oldPath); }
    await done(tx);
  }

  async moveSnapshotsPrefix(oldPrefix: string, newPrefix: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction("snapshots", "readwrite");
    const store = tx.objectStore("snapshots");
    const rows = await requestResult(store.getAll()) as NoteSnapshot[];
    for (const row of rows) {
      if (row.path !== oldPrefix && !row.path.startsWith(`${oldPrefix}/`)) continue;
      const path = `${newPrefix}${row.path.slice(oldPrefix.length)}`;
      store.put({ ...row, path });
      store.delete(row.path);
    }
    await done(tx);
  }

  async getSnapshotsPrefix(prefix: string): Promise<NoteSnapshot[]> {
    const db = await this.dbPromise;
    const tx = db.transaction("snapshots", "readonly");
    const rows = await requestResult(tx.objectStore("snapshots").getAll()) as NoteSnapshot[];
    await done(tx);
    return rows.filter((row) => row.path === prefix || row.path.startsWith(`${prefix}/`));
  }

  async deleteSnapshotsPrefix(prefix: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction("snapshots", "readwrite");
    const store = tx.objectStore("snapshots");
    const rows = await requestResult(store.getAll()) as NoteSnapshot[];
    for (const row of rows) if (row.path === prefix || row.path.startsWith(`${prefix}/`)) store.delete(row.path);
    await done(tx);
  }

  async clearSearchIndex(): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(["docs", "chunks", "vectors", "postings", "meta"], "readwrite");
    for (const name of ["docs", "chunks", "vectors", "postings", "meta"]) tx.objectStore(name).clear();
    await done(tx);
  }

  async listDocuments(): Promise<IndexedDoc[]> {
    const db = await this.dbPromise;
    const tx = db.transaction("docs", "readonly");
    const result = await requestResult(tx.objectStore("docs").getAll()) as IndexedDoc[];
    await done(tx);
    return result;
  }

  async replaceDocument(path: string, mtime: number, size: number, chunks: NoteChunk[]): Promise<void> {
    const db = await this.dbPromise;
    const stores = ["docs", "chunks", "vectors", "postings", "meta"];
    const tx = db.transaction(stores, "readwrite");
    const docs = tx.objectStore("docs");
    const chunkStore = tx.objectStore("chunks");
    const vectors = tx.objectStore("vectors");
    const postings = tx.objectStore("postings");
    const meta = tx.objectStore("meta");
    const previous = await requestResult(docs.get(path)) as IndexedDoc | undefined;
    const previousIds = new Set(previous?.ids || []);
    for (const id of previousIds) { chunkStore.delete(id); vectors.delete(id); }
    const ids = chunks.map((chunk) => chunk.id);
    const docTerms = new Set<string>();
    const additions = new Map<string, Array<{ id: string; tf: number; length: number }>>();
    for (const chunk of chunks) {
      chunkStore.put({ ...chunk, tokens: undefined, vector: undefined });
      if (chunk.vector) {
        const vector = quantize(chunk.vector);
        if (vector) vectors.put({ id: chunk.id, vector } satisfies VectorRow);
      }
      const tf = new Map<string, number>();
      for (const term of chunk.tokens) tf.set(term, (tf.get(term) || 0) + 1);
      for (const [term, count] of tf) {
        docTerms.add(term);
        const rows = additions.get(term) || [];
        rows.push({ id: chunk.id, tf: count, length: chunk.tokens.length });
        additions.set(term, rows);
      }
    }

    // Read each affected term once and queue those reads together. The old
    // chunk-by-chunk loop repeatedly fetched and rewrote common terms such as
    // "the" inside a single note, becoming quadratic for large vaults.
    const affectedTerms = [...new Set([...(previous?.terms || []), ...docTerms])];
    const existingPostings = await Promise.all(affectedTerms.map(async (term) =>
      [term, await requestResult(postings.get(term)) as Posting | undefined] as const));
    for (const [term, posting] of existingPostings) {
      const rows = (posting?.rows || []).filter((row) => !previousIds.has(row.id));
      rows.push(...(additions.get(term) || []));
      if (rows.length) postings.put({ term, rows } satisfies Posting);
      else postings.delete(term);
    }

    docs.put({ path, mtime, size, vectorized: chunks.length === 0 || chunks.every((chunk) => !!chunk.vector), ids, terms: [...docTerms] } satisfies IndexedDoc);
    const countRow = await requestResult(meta.get("chunkCount")) as MetaRow | undefined;
    const count = Math.max(0, Number(countRow?.value || 0) - (previous?.ids.length || 0) + chunks.length);
    meta.put({ key: "chunkCount", value: count } satisfies MetaRow);
    await done(tx);
  }

  async removeDocument(path: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(["docs", "chunks", "vectors", "postings", "meta"], "readwrite");
    const docs = tx.objectStore("docs");
    const previous = await requestResult(docs.get(path)) as IndexedDoc | undefined;
    if (!previous) { await done(tx); return; }
    for (const id of previous.ids) { tx.objectStore("chunks").delete(id); tx.objectStore("vectors").delete(id); }
    for (const term of previous.terms) {
      const posting = await requestResult(tx.objectStore("postings").get(term)) as Posting | undefined;
      if (!posting) continue;
      posting.rows = posting.rows.filter((row) => !previous.ids.includes(row.id));
      if (posting.rows.length) tx.objectStore("postings").put(posting); else tx.objectStore("postings").delete(term);
    }
    docs.delete(path);
    const countRow = await requestResult(tx.objectStore("meta").get("chunkCount")) as MetaRow | undefined;
    tx.objectStore("meta").put({ key: "chunkCount", value: Math.max(0, Number(countRow?.value || 0) - previous.ids.length) });
    await done(tx);
  }

  async clearDocumentVectors(path: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(["docs", "vectors"], "readwrite");
    const docs = tx.objectStore("docs");
    const previous = await requestResult(docs.get(path)) as IndexedDoc | undefined;
    if (previous) {
      for (const id of previous.ids) tx.objectStore("vectors").delete(id);
      docs.put({ ...previous, vectorized: false } satisfies IndexedDoc);
    }
    await done(tx);
  }

  async search(query: string, queryVector?: ArrayLike<number>, limit = 6): Promise<SearchHit[]> {
    const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])];
    const db = await this.dbPromise;
    const tx = db.transaction(["postings", "chunks", "vectors", "meta"], "readonly");
    const postingStore = tx.objectStore("postings");
    const chunkStore = tx.objectStore("chunks");
    const vectorStore = tx.objectStore("vectors");
    const countRow = await requestResult(tx.objectStore("meta").get("chunkCount")) as MetaRow | undefined;
    const total = Math.max(1, Number(countRow?.value || 0));
    const scored = new Map<string, { lexical: number; semantic: number }>();
    for (const term of terms) {
      const posting = await requestResult(postingStore.get(term)) as Posting | undefined;
      if (!posting) continue;
      const idf = Math.log(1 + (total - posting.rows.length + 0.5) / (posting.rows.length + 0.5));
      for (const row of posting.rows) {
        const score = idf * (row.tf * 2.2) / (row.tf + 1.2 * (0.25 + 0.75 * row.length / 300));
        const value = scored.get(row.id) || { lexical: 0, semantic: 0 };
        value.lexical += score;
        scored.set(row.id, value);
      }
    }
    if (queryVector) {
      const request = vectorStore.openCursor();
      await new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error || new Error("Semantic index scan failed."));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(); return; }
          const value = cursor.value as VectorRow;
          const vector = value.vector;
          let similarity = 0;
          for (let i = 0; i < Math.min(vector.length, queryVector.length); i++) similarity += (vector[i] / 127) * Number(queryVector[i]);
          if (similarity > 0) {
            const row = scored.get(value.id) || { lexical: 0, semantic: 0 };
            row.semantic = similarity;
            scored.set(value.id, row);
          }
          cursor.continue();
        };
      });
    }
    const maxLexical = Math.max(1, ...Array.from(scored.values(), (value) => value.lexical));
    const ranked = Array.from(scored, ([id, value]) => ({
      id,
      score: queryVector ? 0.62 * Math.max(0, value.semantic) + 0.38 * value.lexical / maxLexical : value.lexical,
    })).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit * 3, 24)));
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const row of ranked) {
      const chunk = await requestResult(chunkStore.get(row.id)) as NoteChunk | undefined;
      if (!chunk || seen.has(chunk.path)) continue;
      seen.add(chunk.path);
      hits.push({ path: chunk.path, heading: chunk.heading, excerpt: chunk.text, score: row.score });
      if (hits.length >= limit) break;
    }
    await done(tx);
    return hits;
  }

  async addHistory(entry: HistoryEntry, retentionDays: number): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction("history", "readwrite");
    const store = tx.objectStore("history");
    store.put(entry);
    const cutoff = Date.now() - Math.max(1, Math.min(30, retentionDays)) * 86_400_000;
    const index = store.index("createdAt");
    const expired = index.openCursor(IDBKeyRange.upperBound(cutoff));
    expired.onsuccess = () => {
      const cursor = expired.result;
      if (!cursor) return;
      cursor.delete(); cursor.continue();
    };
    await done(tx);
  }

  async updateHistory(id: string, update: (entry: HistoryEntry) => HistoryEntry): Promise<HistoryEntry | null> {
    const db = await this.dbPromise;
    const tx = db.transaction("history", "readwrite");
    const store = tx.objectStore("history");
    const current = await requestResult(store.get(id)) as HistoryEntry | undefined;
    if (!current) { await done(tx); return null; }
    const next = update(current);
    store.put(next);
    await done(tx);
    return next;
  }

  async pruneHistory(retentionDays: number): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction("history", "readwrite");
    const cutoff = Date.now() - Math.max(1, Math.min(30, retentionDays)) * 86_400_000;
    const request = tx.objectStore("history").index("createdAt").openCursor(IDBKeyRange.upperBound(cutoff));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete(); cursor.continue();
    };
    await done(tx);
  }

  async clearHistory(): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction("history", "readwrite");
    tx.objectStore("history").clear();
    await done(tx);
  }

  async getHistory(limit = 50): Promise<HistoryEntry[]> {
    const db = await this.dbPromise;
    const tx = db.transaction("history", "readonly");
    const index = tx.objectStore("history").index("createdAt");
    const result = await new Promise<HistoryEntry[]>((resolve, reject) => {
      const rows: HistoryEntry[] = [];
      const request = index.openCursor(null, "prev");
      request.onerror = () => reject(request.error || new Error("Could not read local change history."));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= Math.max(1, Math.min(1000, limit))) { resolve(rows); return; }
        rows.push(cursor.value as HistoryEntry);
        cursor.continue();
      };
    });
    await done(tx);
    return result;
  }

  async getHistoryEntry(id: string): Promise<HistoryEntry | undefined> {
    const db = await this.dbPromise;
    const tx = db.transaction("history", "readonly");
    const result = await requestResult(tx.objectStore("history").get(id)) as HistoryEntry | undefined;
    await done(tx);
    return result;
  }

  async markReverted(id: string): Promise<void> {
    const entry = await this.getHistoryEntry(id);
    if (!entry) throw new Error("That history item expired or does not exist.");
    const db = await this.dbPromise;
    const tx = db.transaction("history", "readwrite");
    tx.objectStore("history").put({ ...entry, revertedAt: Date.now() });
    await done(tx);
  }

  async stats(): Promise<{ documents: number; chunks: number; vectors: number; lastIndexedAt?: number }> {
    const db = await this.dbPromise;
    const tx = db.transaction(["docs", "chunks", "vectors", "meta"], "readonly");
    const [documents, chunks, vectors, indexed] = await Promise.all([
      requestResult(tx.objectStore("docs").count()),
      requestResult(tx.objectStore("chunks").count()),
      requestResult(tx.objectStore("vectors").count()),
      requestResult(tx.objectStore("meta").get("lastIndexedAt")),
    ]);
    await done(tx);
    return { documents, chunks, vectors, lastIndexedAt: Number((indexed as MetaRow | undefined)?.value) || undefined };
  }

  async setLastIndexedAt(value = Date.now()): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key: "lastIndexedAt", value });
    await done(tx);
  }
}
