import { type App, type TFile } from "obsidian";
import { chunkNote, metadataFrom, type NoteChunk } from "./core";
import { type EmbedBatch } from "./embedder";
import { LocalVaultStore } from "./local-store";

const LARGE_SCOPE_PRUNE_THRESHOLD = 128;

export interface IndexProgress {
  indexed: number;
  total: number;
  currentPath?: string;
  phase: "scanning" | "embedding" | "ready";
}

export class VaultIndexer {
  private app: App;
  private store: LocalVaultStore;
  private embedding: EmbedBatch | null = null;
  private semanticFolders: string[] = [];
  private indexFolders: string[] = [];
  private indexIncludeSubfolders = true;
  private semanticIncludeSubfolders = true;
  private chain: Promise<unknown> = Promise.resolve();
  private inFlight = new Map<string, Promise<void>>();
  private stopped = false;
  private onProgress: (state: IndexProgress) => void;

  constructor(app: App, store: LocalVaultStore, onProgress: (state: IndexProgress) => void = () => {}) {
    this.app = app;
    this.store = store;
    this.onProgress = onProgress;
  }

  setEmbedder(embedder: EmbedBatch | null) { this.embedding = embedder; }
  setSemanticFolders(folders: string[], includeSubfolders = true) {
    this.semanticFolders = folders;
    this.semanticIncludeSubfolders = includeSubfolders;
  }
  setIndexFolders(folders: string[], includeSubfolders = true) {
    this.indexFolders = folders;
    this.indexIncludeSubfolders = includeSubfolders;
  }

  private isInScope(path: string, folders: string[], includeSubfolders: boolean): boolean {
    if (folders.includes("*")) return true;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return folders.some((folder) => includeSubfolders
      ? path.startsWith(`${folder}/`)
      : parent === folder);
  }

  private shouldIndex(path: string): boolean { return this.isInScope(path, this.indexFolders, this.indexIncludeSubfolders); }
  private shouldEmbed(path: string): boolean { return this.isInScope(path, this.semanticFolders, this.semanticIncludeSubfolders); }
  stop() { this.stopped = true; }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  async sync(): Promise<{ scanned: number; changed: number; removed: number }> {
    this.stopped = false;
    return this.enqueue(async () => {
      const files = this.app.vault.getMarkdownFiles();
      const known = new Map((await this.store.listDocuments()).map((doc) => [doc.path, doc]));
      const present = new Set(files.map((file) => file.path));
      const staleScopeCount = [...known.keys()].filter((path) => !present.has(path) || !this.shouldIndex(path)).length;
      if (staleScopeCount > LARGE_SCOPE_PRUNE_THRESHOLD) {
        // A big scope change can leave thousands of old cached entries. Clear
        // only the derived search database in one transaction, then rebuild
        // the newly selected scope. Keep task/change history and all notes.
        await this.store.clearSearchIndex();
        known.clear();
      }
      const changed: TFile[] = [];
      for (const previous of known.values()) {
        if (!this.shouldIndex(previous.path)) {
          await this.store.removeDocument(previous.path);
        } else if (previous.vectorized && this.embedding && !this.shouldEmbed(previous.path)) {
          await this.store.clearDocumentVectors(previous.path);
        }
      }
      for (const file of files) {
        if (!this.shouldIndex(file.path)) continue;
        const previous = known.get(file.path);
        const needsEmbedding = !!this.embedding && this.shouldEmbed(file.path) && !previous?.vectorized;
        if (!previous || previous.mtime !== file.stat.mtime || previous.size !== file.stat.size || needsEmbedding) changed.push(file);
      }
      if (changed.length === 0) {
        let removed = 0;
        for (const path of known.keys()) {
          if (!present.has(path)) { await this.store.removeDocument(path); removed++; }
        }
        if (removed) await this.store.setLastIndexedAt();
        this.onProgress({ indexed: 0, total: 0, phase: "ready" });
        return { scanned: files.length, changed: 0, removed };
      }
      this.onProgress({ indexed: 0, total: changed.length, phase: "scanning" });
      let indexed = 0;
      for (const file of changed) {
        if (this.stopped) break;
        await this.indexFileNow(file);
        indexed++;
        this.onProgress({ indexed, total: changed.length, currentPath: file.path, phase: this.embedding ? "embedding" : "scanning" });
        // Give Obsidian and the OS time between small indexing batches.
        // This keeps bulk work responsive without holding the renderer busy.
        if (indexed % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let removed = 0;
      for (const path of known.keys()) {
        if (!present.has(path)) { await this.store.removeDocument(path); removed++; }
      }
      await this.store.setLastIndexedAt();
      const stats = await this.store.stats();
      this.onProgress({ indexed, total: changed.length, phase: "ready" });
      return { scanned: files.length, changed: indexed, removed };
    });
  }

  async indexFile(file: TFile): Promise<void> {
    if (!this.shouldIndex(file.path)) return;
    const key = `${file.path}\u0000${file.stat.mtime}\u0000${file.stat.size}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = this.enqueue(() => this.indexFileNow(file)).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async indexFileNow(file: TFile): Promise<void> {
      if (this.stopped) return;
      if (file.stat.size > 2_000_000) {
        // Keep metadata searchable without copying oversized files into the local index.
        const metadata = this.app.metadataCache.getFileCache(file);
        const title = `${file.path} ${metadata?.frontmatter?.title || ""} ${(metadata?.tags || []).map((tag) => tag.tag).join(" ")}`;
        const chunks = chunkNote(file.path, title, file.stat.mtime, 1200, 100);
        await this.store.replaceDocument(file.path, file.stat.mtime, file.stat.size, chunks);
        return;
      }
      const content = await this.app.vault.cachedRead(file);
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter || {};
      const fmTags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === "string" ? [fm.tags] : [];
      const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : typeof fm.aliases === "string" ? [fm.aliases] : [];
      const tags = [...new Set([...(cache?.tags || []).map((item) => item.tag), ...fmTags])];
      const metadata = metadataFrom(content, tags, aliases);
      const contextual = `${metadata.tags.map((tag) => `#${tag}`).join(" ")} ${metadata.aliases.join(" ")}\n${content}`;
      const chunks = chunkNote(file.path, contextual, file.stat.mtime);
      if (this.embedding && this.shouldEmbed(file.path)) {
        try {
          for (let start = 0; start < chunks.length; start += 16) {
            const batch = chunks.slice(start, start + 16);
            const vectors = await this.embedding(batch.map((chunk) => chunk.text));
            batch.forEach((chunk, index) => { if (vectors[index]?.length) chunk.vector = vectors[index]; });
          }
        } catch {
          this.embedding = null;
        }
      }
      await this.store.replaceDocument(file.path, file.stat.mtime, file.stat.size, chunks);
  }

  async remove(path: string): Promise<void> { return this.enqueue(() => this.store.removeDocument(path)); }
}
