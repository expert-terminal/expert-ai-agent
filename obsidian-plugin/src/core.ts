export interface NoteMetadata {
  tags: string[];
  aliases: string[];
  headings: string[];
}

export interface NoteChunk {
  id: string;
  path: string;
  heading: string;
  text: string;
  tokens: string[];
  updatedAt: number;
  vector?: number[];
}

export interface SearchHit {
  path: string;
  heading: string;
  excerpt: string;
  score: number;
}

export interface HistoryEntry {
  id: string;
  createdAt: number;
  action: string;
  path: string;
  nextPath?: string;
  request?: string;
  before?: string | null;
  after?: string | null;
  revertedAt?: number;
  taskId?: string;
  groupId?: string;
  sessionId?: string;
  updatedAt?: number;
  taskStatus?: "running" | "complete" | "error";
  messages?: Array<{ role: "user" | "assistant"; text: string; updatedAt: number; streaming?: boolean }>;
  traceEvents?: Array<{ id: string; at: number; kind: string; label: string; detail?: string; error?: boolean }>;
  pendingMessages?: Array<{ id: string; text: string; status: "queued" | "sent" }>;
}

export function isRestorableHistoryEntry(entry: HistoryEntry): boolean {
  if (entry.revertedAt || entry.action === "task_checkpoint" || entry.action === "restore") return false;
  if (entry.action === "create") return typeof entry.after === "string";
  if (entry.action === "rename" || entry.action === "move") return !!entry.nextPath;
  if (entry.action === "trash") return typeof entry.before === "string";
  return typeof entry.before === "string" && typeof entry.after === "string";
}

const WORD_RE = /[\p{L}\p{N}_-]{2,}/gu;
const FRONTMATTER_RE = /^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
const MAX_FILE_SIZE = 2_000_000;
const MAX_CONTEXT_CHARS = 900;

export function tokenize(text: string): string[] {
  return (String(text || "").toLocaleLowerCase().match(WORD_RE) || [])
    .filter((word) => word.length < 80);
}

export function normalizeVaultPath(input: string): string {
  const raw = String(input || "").trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\0")) {
    throw new Error("Use a vault-relative path.");
  }
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) throw new Error("Path traversal is not allowed.");
  if (parts.some((part) => part.startsWith(".obsidian"))) throw new Error("The plugin cannot edit Obsidian settings files.");
  return parts.join("/");
}

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, "");
}

export function extractHeadings(text: string): string[] {
  return [...String(text || "").matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)]
    .map((match) => match[1].trim()).filter(Boolean).slice(0, 100);
}

export function chunkNote(path: string, text: string, updatedAt = Date.now(), maxChars = 1500, overlap = 180): NoteChunk[] {
  if (text.length > MAX_FILE_SIZE) return [];
  const content = stripFrontmatter(text).trim();
  const headingMatches = [...content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)];
  const sections: Array<{ heading: string; start: number; end: number }> = [];
  let start = 0;
  let heading = "";
  for (const match of headingMatches) {
    const index = match.index ?? 0;
    if (index > start) sections.push({ heading, start, end: index });
    heading = match[1].trim();
    start = index;
  }
  if (start < content.length || sections.length === 0) sections.push({ heading, start, end: content.length });

  const chunks: NoteChunk[] = [];
  for (const section of sections) {
    const body = content.slice(section.start, section.end).trim();
    if (!body) continue;
    let offset = 0;
    while (offset < body.length) {
      let end = Math.min(body.length, offset + maxChars);
      if (end < body.length) {
        const boundary = body.lastIndexOf("\n\n", end);
        if (boundary > offset + Math.floor(maxChars * 0.55)) end = boundary;
      }
      const part = body.slice(offset, end).trim();
      if (part) chunks.push({
        id: `${path}\u0000${chunks.length}`,
        path,
        heading: section.heading,
        text: part.slice(0, MAX_CONTEXT_CHARS),
        tokens: tokenize(`${path} ${section.heading} ${part}`),
        updatedAt,
      });
      if (end >= body.length) break;
      offset = Math.max(offset + 1, end - overlap);
    }
  }
  return chunks;
}

function normalizeVector(vector: ArrayLike<number>): number[] {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += Number(vector[i]) ** 2;
  const norm = Math.sqrt(sum) || 1;
  return Array.from(vector, (value) => Number(value) / norm);
}

export function cosineSimilarity(a?: ArrayLike<number>, b?: ArrayLike<number>): number {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += Number(a[i]) * Number(b[i]);
  return dot;
}

export function rankHybrid(query: string, chunks: NoteChunk[], queryVector?: ArrayLike<number>, limit = 6): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length && !queryVector) return [];
  const df = new Map<string, number>();
  for (const term of terms) {
    let count = 0;
    for (const chunk of chunks) if (chunk.tokens.includes(term)) count++;
    df.set(term, count);
  }
  const total = Math.max(1, chunks.length);
  const scores: Array<{ chunk: NoteChunk; lexical: number; semantic: number; score: number }> = [];
  for (const chunk of chunks) {
    const termCounts = new Map<string, number>();
    for (const term of chunk.tokens) termCounts.set(term, (termCounts.get(term) || 0) + 1);
    const length = Math.max(1, chunk.tokens.length);
    let lexical = 0;
    for (const term of terms) {
      const tf = termCounts.get(term) || 0;
      if (!tf) continue;
      const idf = Math.log(1 + (total - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));
      lexical += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * length / 300));
    }
    const semantic = queryVector ? cosineSimilarity(queryVector, chunk.vector) : 0;
    const score = queryVector ? 0.62 * Math.max(0, semantic) + 0.38 * Math.min(1, lexical / 8) : lexical;
    if (score > 0) scores.push({ chunk, lexical, semantic, score });
  }
  scores.sort((a, b) => b.score - a.score || b.chunk.updatedAt - a.chunk.updatedAt);
  const dedup = new Set<string>();
  return scores.filter(({ chunk }) => {
    const key = `${chunk.path}\u0000${chunk.heading}`;
    if (dedup.has(key)) return false;
    dedup.add(key);
    return true;
  }).slice(0, Math.max(1, Math.min(limit, 12))).map(({ chunk, score }) => ({
    path: chunk.path,
    heading: chunk.heading,
    excerpt: chunk.text.slice(0, MAX_CONTEXT_CHARS),
    score,
  }));
}

export function summarizeContext(query: string, hits: SearchHit[], recent: HistoryEntry[] = [], maxChars = 3600): string {
  const lines = ["Local Obsidian retrieval results (snippets only; read a note before making a precise edit):"];
  let size = lines[0].length;
  for (const hit of hits.slice(0, 5)) {
    const line = `- [[${hit.path.replace(/\.md$/i, "")}]]${hit.heading ? ` — ${hit.heading}` : ""}: ${hit.excerpt.replace(/\s+/g, " ")}`;
    if (size + line.length > maxChars) break;
    lines.push(line); size += line.length;
  }
  const last = recent.find((entry) => !entry.revertedAt);
  if (last && size < maxChars - 200) {
    const age = Math.max(0, Math.floor((Date.now() - last.createdAt) / 86_400_000));
    const line = `Recent vault activity (${age === 0 ? "today" : `${age} days ago`}): ${last.action} ${last.path}${last.nextPath ? ` → ${last.nextPath}` : ""}. Offer to continue only if it is relevant to the current request.`;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join("\n") : `No relevant indexed notes found for: ${query.slice(0, 100)}`;
}

export function compactDiff(before: string, after: string, maxChars = 6000): { removed: string; added: string } {
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return {
    removed: before.slice(prefix, before.length - suffix).slice(0, maxChars),
    added: after.slice(prefix, after.length - suffix).slice(0, maxChars),
  };
}

export interface LineDiffRow {
  kind: "added" | "removed" | "context" | "gap";
  oldLine?: number;
  newLine?: number;
  text: string;
}

/** Create a bounded unified, line-level diff suitable for the review panel. */
export function lineDiff(before: string, after: string, contextLines = 3, maxRows = 700): LineDiffRow[] {
  if (before === after) return [{ kind: "context", text: "The selected versions are identical." }];
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  const cellCount = oldLines.length * newLines.length;
  if (cellCount > 1_500_000) {
    const compact = compactDiff(before, after, 18_000);
    const rows: LineDiffRow[] = [{ kind: "gap", text: "Large note: showing the changed passage only." }];
    for (const text of compact.removed.split(/\r?\n/)) rows.push({ kind: "removed", text });
    for (const text of compact.added.split(/\r?\n/)) rows.push({ kind: "added", text });
    return rows;
  }

  const n = oldLines.length;
  const m = newLines.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = oldLines[i] === newLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const operations: LineDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[i] === newLines[j]) {
      operations.push({ kind: "context", oldLine: i + 1, newLine: j + 1, text: oldLines[i] }); i++; j++;
    } else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) {
      operations.push({ kind: "removed", oldLine: i + 1, text: oldLines[i] }); i++;
    } else {
      operations.push({ kind: "added", newLine: j + 1, text: newLines[j] }); j++;
    }
  }

  const visible = new Set<number>();
  for (let index = 0; index < operations.length; index++) {
    if (operations[index].kind === "context") continue;
    for (let near = Math.max(0, index - contextLines); near <= Math.min(operations.length - 1, index + contextLines); near++) visible.add(near);
  }
  if (!visible.size) return [{ kind: "context", text: "The selected versions are identical." }];

  const rows: LineDiffRow[] = [];
  let hidden = 0;
  for (let index = 0; index < operations.length; index++) {
    if (!visible.has(index)) { hidden++; continue; }
    if (hidden) { rows.push({ kind: "gap", text: `… ${hidden} unchanged lines hidden …` }); hidden = 0; }
    if (rows.length >= maxRows) {
      rows.push({ kind: "gap", text: "… remaining diff lines hidden; review the full versions below …" });
      break;
    }
    rows.push(operations[index]);
  }
  if (hidden && rows.length < maxRows) rows.push({ kind: "gap", text: `… ${hidden} unchanged lines hidden …` });
  return rows;
}

export function makeChunkId(path: string, index: number): string {
  return `${path}\u0000${index}`;
}

export function metadataFrom(text: string, tags: string[] = [], aliases: string[] = []): NoteMetadata {
  return { tags: tags.slice(0, 100), aliases: aliases.slice(0, 100), headings: extractHeadings(text) };
}

export const MAX_NOTE_SIZE = MAX_FILE_SIZE;
