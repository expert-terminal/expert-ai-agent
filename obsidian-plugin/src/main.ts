import {
  App, FileSystemAdapter, ItemView, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, requestUrl,
  Setting, TAbstractFile, TFile, TFolder, WorkspaceLeaf,
} from "obsidian";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { copyFile, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import {
  chunkNote, compactDiff, isMarkdownPath, isRestorableHistoryEntry, lineDiff, normalizeVaultPath, summarizeContext,
  type HistoryEntry,
} from "./core";
import { loadLocalEmbedder, type LocalEmbedder } from "./embedder";
import { VaultIndexer, type IndexProgress } from "./indexer";
import { LocalVaultStore } from "./local-store";

const VIEW_TYPE = "expert-ai-companion-activity";
const CHAT_VIEW_TYPE = "expert-ai-companion-chat";
const SYNC_VIEW_TYPE = "expert-ai-companion-sync";
const PLUGIN_ID = "expert-ai-companion";
const GATEWAY_API_URL = "https://api.ssv.asia";
const PORT = 0;
const BODY_LIMIT = 2_000_000;
const SNAPSHOT_LIMIT = 5_000_000;
const MAX_NOTE_CHARS = 250_000;
const RETENTION_OPTIONS = [7, 13] as const;
const execFile = promisify(execFileCallback);

interface CompanionSettings {
  retentionDays: 7 | 13;
  semanticEnabled: boolean;
  semanticFolders: string[];
  semanticIncludeSubfolders: boolean;
  localIndexEnabled: boolean;
  localIndexFolders: string[];
  localIndexIncludeSubfolders: boolean;
  agentWritesEnabled: boolean;
  workspaceAwarenessEnabled: boolean;
  rememberTasks: boolean;
  archiveFolder: string;
  connectedAgent: boolean;
  appDataPath: string;
  gitRemote: string;
  gitStartupPull: boolean;
  cloudBackupEnabled: boolean;
  cloudBackupFolders: string[];
  cloudBackupIncludeSubfolders: boolean;
  cloudBackupAutoOnOpen: boolean;
  syncActivity: SyncLogEntry[];
}

const DEFAULT_SETTINGS: CompanionSettings = {
  retentionDays: 13,
  semanticEnabled: false,
  semanticFolders: [],
  semanticIncludeSubfolders: true,
  localIndexEnabled: false,
  localIndexFolders: [],
  localIndexIncludeSubfolders: true,
  agentWritesEnabled: true,
  workspaceAwarenessEnabled: true,
  rememberTasks: true,
  archiveFolder: "AI Archive",
  connectedAgent: false,
  appDataPath: "",
  gitRemote: "",
  gitStartupPull: false,
  cloudBackupEnabled: false,
  cloudBackupFolders: ["*"],
  cloudBackupIncludeSubfolders: true,
  cloudBackupAutoOnOpen: false,
  syncActivity: [],
};

interface BridgeRequest { action: string; args?: Record<string, unknown> }
interface BridgeResult { ok: boolean; result?: unknown; error?: string }
interface SyncLogEntry { id: string; at: number; action: string; ok: boolean; detail: string }
interface CloudBackupSnapshot { id: string; createdAt: string; bytes: number; files?: number; parts?: number; sha256?: string; format?: string }
interface CloudBackupFile { path: string; size: number; modifiedAt: number; contentBase64: string }
interface CloudRestoreCandidate { file: CloudBackupFile; status: "add" | "replace" | "same" | "blocked"; localHash?: string }

function platformDataHome(): string {
  if (process.platform === "win32") return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function agentDataCandidates(): string[] {
  const home = platformDataHome();
  return [join(home, "expert-ai-agent"), join(home, "Expert AI Agent")];
}

function safeEqualToken(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const item of request) {
    const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item);
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function fileName(path: string): string { return path.split("/").pop() || path; }
function parentPath(path: string): string { return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; }

function offsetToPos(text: string, offset: number): { line: number; ch: number } {
  const safe = Math.max(0, Math.min(text.length, offset));
  const before = text.slice(0, safe);
  const line = (before.match(/\n/g) || []).length;
  return { line, ch: before.length - before.lastIndexOf("\n") - 1 };
}

function diffRange(before: string, after: string) {
  let prefix = 0;
  const common = Math.min(before.length, after.length);
  while (prefix < common && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < common - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  return { from: prefix, to: before.length - suffix, insert: after.slice(prefix, after.length - suffix) };
}

function formatRelativeTime(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function summarizeGitNameStatus(output: string) {
  const rows = output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [status = "", ...paths] = line.split("\t");
    return { status: status[0] || "M", path: paths.at(-1) || line.slice(1).trim() };
  });
  const counts = { added: 0, updated: 0, removed: 0, moved: 0 };
  for (const row of rows) {
    if (row.status === "A" || row.status === "?") counts.added++;
    else if (row.status === "D") counts.removed++;
    else if (row.status === "R" || row.status === "C") counts.moved++;
    else counts.updated++;
  }
  const detail = [
    counts.added ? `${counts.added} added` : "",
    counts.updated ? `${counts.updated} updated` : "",
    counts.removed ? `${counts.removed} removed` : "",
    counts.moved ? `${counts.moved} moved/renamed` : "",
  ].filter(Boolean).join(", ") || "no file contents changed";
  const paths = rows.slice(0, 8).map((row) => row.path);
  const more = rows.length > paths.length ? ` · and ${rows.length - paths.length} more` : "";
  return { files: rows.length, counts, paths, detail: `${rows.length} file${rows.length === 1 ? "" : "s"} · ${detail}${paths.length ? ` · ${paths.join(", ")}${more}` : ""}` };
}

function renderLineDiff(container: HTMLElement, before: string, after: string) {
  const panel = container.createDiv({ cls: "eai-line-diff" });
  const top = panel.createDiv({ cls: "eai-line-diff-head" });
  top.createEl("strong", { text: "Changes" });
  const legend = top.createDiv({ cls: "eai-line-diff-legend" });
  legend.createSpan({ cls: "is-removed", text: "− Removed" });
  legend.createSpan({ cls: "is-added", text: "+ Added" });
  const lines = panel.createDiv({ cls: "eai-line-diff-lines" });
  for (const change of lineDiff(before, after)) {
    if (change.kind === "gap") {
      lines.createDiv({ cls: "eai-line-diff-gap", text: change.text });
      continue;
    }
    const row = lines.createDiv({ cls: `eai-line-diff-row is-${change.kind}` });
    row.createSpan({ cls: "eai-line-diff-number", text: `${change.oldLine ?? ""}` });
    row.createSpan({ cls: "eai-line-diff-number", text: `${change.newLine ?? ""}` });
    row.createSpan({ cls: "eai-line-diff-marker", text: change.kind === "removed" ? "−" : change.kind === "added" ? "+" : " " });
    row.createEl("code", { text: change.text || " " });
  }
  return panel;
}

class CompanionView extends ItemView {
  private plugin: ExpertAICompanion;
  private rendering = false;
  private renderQueued = false;
  private connectionEl?: HTMLElement;
  private indexLineEl?: HTMLElement;
  private progressEl?: HTMLProgressElement;
  private indexHintEl?: HTMLElement;
  private workspaceEl?: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: ExpertAICompanion) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Expert AI Activity"; }
  getIcon() { return "brain-circuit"; }

  async onOpen() { await this.render(); }

  async onClose() {}

  async render() {
    if (this.rendering) { this.renderQueued = true; return; }
    this.rendering = true;
    try {
    // Fetch slow IndexedDB status before touching the visible DOM. During a
    // large vault scan this may take a while; keep the existing panel in place.
    const status = await this.plugin.statusSummary();
    const entries = await this.plugin.getVisibleHistory();
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("eai-companion-view");
    const header = root.createDiv({ cls: "eai-head" });
    const logo = header.createEl("img", { cls: "eai-logo" });
    logo.src = this.plugin.getIconUrl();
    const title = header.createDiv({ cls: "eai-title-block" });
    title.createEl("strong", { text: "Expert AI" });
    title.createEl("small", { text: "Obsidian vault" });
    const state = this.plugin.liveStatus();
    const agentActive = state.listening && state.agentLastSeen && Date.now() - state.agentLastSeen < 90_000;
    this.connectionEl = root.createDiv({ cls: `eai-connection ${agentActive ? "is-online" : "is-offline"}`,
      text: agentActive ? "● Expert AI Agent connected" : state.listening ? "● Bridge ready · waiting for Agent" : "● Bridge stopped" });

    const progressCard = root.createDiv({ cls: "eai-card eai-index-card" });
    progressCard.createEl("div", { cls: "eai-card-title", text: "Vault search" });
    const indexLine = !this.plugin.isLocalIndexEnabled()
      ? this.plugin.getIndexFolders().length
        ? `Local search paused · ${this.plugin.getIndexFolders().includes("*") ? "all folders" : `${this.plugin.getIndexFolders().length} selected folders`} saved`
        : "Local search is off · no vault scan running"
      : status.indexing ? `Preparing local search ${status.indexed}/${status.total}`
        : status.documents ? `${status.documents.toLocaleString()} notes · ${status.chunks.toLocaleString()} searchable sections`
          : "Local search index is empty";
    this.indexLineEl = progressCard.createEl("div", { cls: "eai-index-line", text: indexLine });
    this.progressEl = progressCard.createEl("progress", { cls: "eai-progress" });
    this.progressEl.max = Math.max(1, status.total || 1);
    this.progressEl.value = status.indexing ? status.indexed : status.chunks ? this.progressEl.max : 0;
    this.indexHintEl = progressCard.createEl("div", { cls: "eai-muted", text: status.semantic
      ? `Local semantic search ready · ${status.vectors.toLocaleString()} vectors`
      : this.plugin.isLocalIndexEnabled() ? "Fast local keyword search is ready. Meaning search is optional."
        : this.plugin.getIndexFolders().length
          ? "Your folder choices are saved. Start local search when you want faster repeated lookups; nothing scans while it is paused."
          : "The Agent searches files only when your task needs it; choose folders any time to prepare faster local search." });
    progressCard.createEl("div", { cls: "eai-explainer", text: "Ask from your phone and the Agent can search, open, change, or archive notes here. The open note updates in Obsidian as soon as its edit is applied." });

    const group = root.createDiv({ cls: "eai-actions" });
    const hasIndexScope = this.plugin.getIndexFolders().length > 0;
    const indexButton = group.createEl("button", { text: status.indexing ? "Pause indexing" : this.plugin.isLocalIndexEnabled() ? "Change indexed folders" : hasIndexScope ? "Start local search" : "Choose folders for faster search" });
    indexButton.onclick = () => status.indexing ? void this.plugin.disableLocalIndex()
      : this.plugin.isLocalIndexEnabled() ? this.plugin.openIndexSetup()
        : hasIndexScope ? void this.plugin.enableLocalIndex() : this.plugin.openIndexSetup();
    const settingsButton = group.createEl("button", { text: "Settings" });
    settingsButton.onclick = () => this.plugin.openSettings();
    const syncButton = group.createEl("button", { text: "Sync & backups" });
    syncButton.onclick = () => void this.plugin.activateSyncView();

    root.createEl("h3", { text: "Open in Obsidian" });
    this.workspaceEl = root.createDiv({ cls: "eai-open-workspace" });
    this.updateWorkspace();

    root.createEl("h3", { text: "File changes" });
    root.createDiv({ cls: "eai-muted", text: "Note versions are saved locally while Expert AI is connected. Open a change to compare and restore any saved version." });
    const fileChanges = entries.filter((entry) => entry.action !== "task_checkpoint");
    if (!fileChanges.length) root.createDiv({ cls: "eai-empty", text: "Edits, creates, moves, and restores will appear here with their diffs." });
    for (const entry of fileChanges) this.renderEntry(root, entry);
    const tasks = entries.filter((entry) => entry.action === "task_checkpoint");
    root.createEl("h3", { text: "Agent tasks" });
    if (!tasks.length) root.createDiv({ cls: "eai-empty", text: "Agent conversations will appear here." });
    for (const entry of tasks) this.renderEntry(root, entry);
    } catch (error) {
      console.error("[Expert AI] activity view refresh failed", error);
    } finally {
      this.rendering = false;
      if (this.renderQueued) { this.renderQueued = false; void this.render(); }
    }
  }

  private renderEntry(root: HTMLElement, entry: HistoryEntry) {
    const card = root.createDiv({ cls: "eai-card eai-history" });
    const row = card.createDiv({ cls: "eai-history-top" });
    row.createSpan({ cls: entry.revertedAt ? "eai-check eai-reverted" : "eai-check", text: entry.revertedAt ? "↶" : "✓" });
    const summary = row.createDiv({ cls: "eai-history-summary" });
    const rawAction = entry.action === "task_checkpoint" ? "Agent task" : entry.action.replaceAll("_", " ");
    const action = rawAction.charAt(0).toUpperCase() + rawAction.slice(1);
    summary.createEl("strong", { text: action });
    summary.createEl("span", { text: entry.nextPath ? `${entry.path} → ${entry.nextPath}` : entry.path || "Active vault task" });
    row.createEl("small", { text: formatRelativeTime(entry.createdAt) });
    if (entry.request && entry.action === "task_checkpoint") card.createDiv({ cls: "eai-task-summary", text: entry.request.slice(0, 380) });
    if (entry.taskId && entry.action !== "task_checkpoint") card.createDiv({ cls: "eai-muted", text: "Recorded during an Agent task" });
    if (entry.before !== undefined && entry.after !== undefined && typeof entry.before === "string" && typeof entry.after === "string") {
      renderLineDiff(card, entry.before, entry.after).addClass("is-compact");
    }
    if (entry.request && entry.action !== "task_checkpoint") card.createDiv({ cls: "eai-muted", text: entry.request.slice(0, 260) });
    const tools = card.createDiv({ cls: "eai-history-actions" });
    const taskEntry = entry.action === "task_checkpoint";
    const open = tools.createEl("button", { text: taskEntry ? "Open chat" : "Open" });
    open.onclick = () => taskEntry
      ? void this.plugin.openChat(entry.id)
      : void this.plugin.openHistoryPath(entry.id);
    const review = tools.createEl("button", { text: entry.revertedAt ? "Restored" : isRestorableHistoryEntry(entry) ? "Compare versions" : "View details" });
    review.onclick = () => new VersionReviewModal(this.app, this.plugin, entry).open();
    if (entry.taskId && !taskEntry) {
      const task = tools.createEl("button", { text: "Task chat" });
      task.onclick = () => void this.plugin.openChat(entry.taskId!);
    }
  }

  updateConnection() {
    if (!this.connectionEl) return;
    const state = this.plugin.liveStatus();
    const active = state.listening && !!state.agentLastSeen && Date.now() - state.agentLastSeen < 90_000;
    this.connectionEl.className = `eai-connection ${active ? "is-online" : "is-offline"}`;
    this.connectionEl.setText(active ? "● Expert AI Agent connected" : state.listening ? "● Bridge ready · waiting for Agent" : "● Bridge stopped");
  }

  updateWorkspace() {
    if (!this.workspaceEl) return;
    const target = this.workspaceEl; target.empty();
    const snapshot = this.plugin.getWorkspaceSnapshot();
    target.createDiv({ cls: "eai-muted", text: snapshot.openFileCount
      ? `${snapshot.openFileCount} open file${snapshot.openFileCount === 1 ? "" : "s"} · ${snapshot.paneCount} pane${snapshot.paneCount === 1 ? "" : "s"}${snapshot.activePath ? ` · active: ${snapshot.activePath}` : ""}`
      : "No files are currently open in Obsidian." });
    if (!snapshot.openFiles.length) return;
    const list = target.createDiv({ cls: "eai-open-workspace-list" });
    for (const item of snapshot.openFiles.slice(0, 12)) {
      const row = list.createDiv({ cls: `eai-open-workspace-row${item.active ? " is-active" : ""}` });
      const detail = row.createDiv();
      detail.createEl("strong", { text: item.active ? `● ${item.path}` : item.path });
      detail.createDiv({ cls: "eai-muted", text: `Window ${item.window} · Pane ${item.pane} · Tab ${item.tab}${item.mode ? ` · ${item.mode}` : ""}${item.cursorLine ? ` · line ${item.cursorLine}` : ""}` });
      const open = row.createEl("button", { text: "Focus" }); open.onclick = () => this.plugin.focusWorkspaceFile(item.path);
    }
    if (snapshot.openFileCount > 12) target.createDiv({ cls: "eai-muted", text: `${snapshot.openFileCount - 12} more open files are available to the Agent.` });
  }

  updateSemanticStatus(message: string) {
    if (this.indexHintEl && message) this.indexHintEl.setText(message);
  }

  updateIndexProgress(state: IndexProgress) {
    if (!this.indexLineEl || !this.progressEl || !this.indexHintEl) return;
    if (state.phase === "ready") {
      this.indexLineEl.setText(state.indexed === 0
        ? "Vault index is current · no notes needed updating"
        : `Index updated · ${state.indexed.toLocaleString()} notes processed`);
      this.progressEl.max = Math.max(1, state.total || 1);
      this.progressEl.value = this.progressEl.max;
      return;
    }
    const label = state.phase === "embedding" ? "Creating local embeddings" : "Indexing notes";
    this.indexLineEl.setText(`${label} ${state.indexed.toLocaleString()}/${state.total.toLocaleString()}`);
    this.progressEl.max = Math.max(1, state.total || 1);
    this.progressEl.value = state.indexed;
    this.indexHintEl.setText(state.phase === "embedding"
      ? `Preparing notes locally · Obsidian remains available${state.currentPath ? ` · ${state.currentPath}` : ""}`
      : `Preparing local search in the background · Obsidian remains available${state.currentPath ? ` · ${state.currentPath}` : ""}`);
  }
}

class VersionReviewModal extends Modal {
  private plugin: ExpertAICompanion;
  private entry: HistoryEntry;

  constructor(app: App, plugin: ExpertAICompanion, entry: HistoryEntry) {
    super(app); this.plugin = plugin; this.entry = entry;
  }

  onOpen() {
    void this.renderComparison();
  }

  private async renderComparison() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Review this change" });
    contentEl.createEl("p", { cls: "eai-muted", text: `${this.entry.action.replaceAll("_", " ")} · ${new Date(this.entry.createdAt).toLocaleString()}` });
    contentEl.createEl("p", { text: this.entry.nextPath ? `${this.entry.path}  →  ${this.entry.nextPath}` : this.entry.path || "Task activity" });
    if (this.entry.request) contentEl.createDiv({ cls: "eai-task-summary", text: this.entry.request });
    const loading = contentEl.createDiv({ cls: "eai-muted", text: "Loading the saved version and current note…" });
    let comparison: Awaited<ReturnType<ExpertAICompanion["getHistoryComparisonForView"]>>;
    try { comparison = await this.plugin.getHistoryComparisonForView(this.entry.id); }
    catch (error) { loading.setText(error instanceof Error ? error.message : "Could not load version comparison."); return; }
    loading.remove();

    if (typeof this.entry.before === "string" || typeof this.entry.after === "string" || ["move", "rename"].includes(this.entry.action)) {
      const versions = await this.plugin.getFileVersions(this.entry.nextPath || this.entry.path);
      if (versions.length > 1) {
        const compare = contentEl.createDiv({ cls: "eai-version-compare" });
        const compareHeader = compare.createDiv({ cls: "eai-version-compare-head" });
        compareHeader.createEl("h3", { text: "Version comparison" });
        compareHeader.createDiv({ cls: "eai-muted", text: "Choose any two saved versions to see exactly what changed." });
        const selectors = compare.createDiv({ cls: "eai-version-selectors" });
        const leftChoice = selectors.createDiv({ cls: "eai-version-choice" });
        leftChoice.createEl("label", { text: "Earlier version" });
        const leftSelect = leftChoice.createEl("select");
        const rightChoice = selectors.createDiv({ cls: "eai-version-choice" });
        rightChoice.createEl("label", { text: "Compare with" });
        const rightSelect = rightChoice.createEl("select");
        const renderDiff = compare.createDiv();
        const selectedVersion = (select: HTMLSelectElement) => versions.find((version) => version.id === select.value) || versions[0];
        const draw = () => {
          const left = selectedVersion(leftSelect); const right = selectedVersion(rightSelect);
          renderDiff.empty();
          renderDiff.createDiv({ cls: "eai-muted eai-version-pair-label", text: `${left.label}  →  ${right.label}` });
          renderLineDiff(renderDiff, left.text, right.text);
          const panels = renderDiff.createDiv({ cls: "eai-version-columns eai-selected-versions" });
          const oldPanel = panels.createDiv({ cls: "eai-version-panel eai-version-before" });
          oldPanel.createEl("strong", { text: "Selected earlier version" });
          oldPanel.createEl("pre", { text: left.text });
          const newPanel = panels.createDiv({ cls: "eai-version-panel eai-version-current" });
          newPanel.createEl("strong", { text: right.current ? "Current file" : "Selected version to restore" });
          newPanel.createEl("pre", { text: right.text });
          restoreSaved.disabled = right.current;
          restoreSaved.setText(right.current ? "Current version selected" : "Restore right-hand version");
        };
        for (const version of versions) {
          leftSelect.createEl("option", { text: version.label, value: version.id });
          rightSelect.createEl("option", { text: version.label, value: version.id });
        }
        leftSelect.value = versions[Math.max(0, versions.length - 2)].id;
        rightSelect.value = versions[versions.length - 1].id;
        leftSelect.onchange = draw; rightSelect.onchange = draw;
        const restoreSaved = selectors.createEl("button", { text: "Restore right-hand version", cls: "mod-warning" });
        restoreSaved.onclick = async () => {
          const target = selectedVersion(rightSelect);
          if (target.current) return;
          const currentVersion = versions.find((version) => version.current);
          restoreSaved.disabled = true; restoreSaved.setText("Restoring…");
          try {
            await this.plugin.restoreSelectedVersion(this.entry.nextPath || this.entry.path, target.text, currentVersion?.text);
            this.close(); new Notice(`Restored ${this.entry.nextPath || this.entry.path}.`);
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) void (leaf.view as CompanionView).render();
          } catch (error) {
            restoreSaved.disabled = false; new Notice(error instanceof Error ? error.message : "Could not restore this version.", 10_000); draw();
          }
        };
        draw();
      }
      if (versions.length <= 1) {
      const columns = contentEl.createDiv({ cls: "eai-version-columns" });
      const previous = columns.createDiv({ cls: "eai-version-panel eai-version-before" });
      previous.createEl("strong", { text: "Previous version" });
      previous.createEl("pre", { text: typeof this.entry.before === "string" ? this.entry.before : "No file existed before this change." });
      const current = columns.createDiv({ cls: "eai-version-panel eai-version-current" });
      current.createEl("strong", { text: "Current version now" });
      current.createEl("pre", { text: comparison.currentText ?? (comparison.currentKind === "missing" ? "This note is currently missing." : "This change did not snapshot note text.") });
      if (typeof this.entry.after === "string") {
        const matches = comparison.currentText === this.entry.after;
        contentEl.createDiv({ cls: `eai-version-state ${matches ? "is-match" : "is-different"}`,
          text: matches ? "The live note still matches the version saved after this change."
            : "The live note differs from the saved after-version. Review the live text above; restore will stop if it would overwrite newer edits." });
        const details = contentEl.createEl("details", { cls: "eai-version-details" });
        details.createEl("summary", { text: "Show the exact version saved after this change" });
        details.createEl("pre", { text: this.entry.after });
      }
      }
    } else if (this.entry.action === "move" || this.entry.action === "rename") {
      contentEl.createDiv({ cls: "eai-version-state", text: `This operation changes the path from “${this.entry.path}” to “${this.entry.nextPath}”. It does not replace note contents. The item is currently ${comparison.currentKind === "missing" ? "missing" : `present at ${comparison.currentPath}`}.` });
      if (comparison.currentText !== null) {
        const current = contentEl.createDiv({ cls: "eai-version-panel eai-version-current" });
        current.createEl("strong", { text: "Current contents (will be preserved)" });
        current.createEl("pre", { text: comparison.currentText });
      }
    } else {
      contentEl.createDiv({ cls: "eai-version-state", text: this.entry.action === "task_checkpoint"
        ? "This is a task record. It does not change a note and cannot be restored."
        : "This history item does not contain a comparable note snapshot." });
    }

    const actions = contentEl.createDiv({ cls: "eai-version-actions" });
    if (this.entry.action === "task_checkpoint") {
      actions.createEl("button", { text: "Continue in chat" }).onclick = () => { this.close(); void this.plugin.openChat(this.entry.id); };
    }
    actions.createEl("button", { text: "Keep current version" }).onclick = () => this.close();
    const restore = actions.createEl("button", { text: this.restoreLabel(), cls: "mod-warning" });
    restore.disabled = !isRestorableHistoryEntry(this.entry);
    restore.onclick = async () => {
      restore.disabled = true; restore.setText("Restoring…");
      try {
        const result = await this.plugin.undoFromView(this.entry.id);
        this.close(); new Notice(`Restored ${result.path}.`);
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) void (leaf.view as CompanionView).render();
      } catch (error) {
        restore.disabled = false; restore.setText(this.restoreLabel());
        new Notice(error instanceof Error ? error.message : "Restore stopped to protect the current file.", 10_000);
      }
    };
  }

  private restoreLabel() {
    if (this.entry.action === "create") return "Remove this created note";
    if (this.entry.action === "trash") return "Restore deleted note";
    if (this.entry.action === "move" || this.entry.action === "rename") return "Move it back";
    return "Restore previous version";
  }
}

class SyncView extends ItemView {
  private plugin: ExpertAICompanion;
  private busy = false;

  constructor(leaf: WorkspaceLeaf, plugin: ExpertAICompanion) { super(leaf); this.plugin = plugin; }
  getViewType() { return SYNC_VIEW_TYPE; }
  getDisplayText() { return "Expert AI Sync"; }
  getIcon() { return "git-branch"; }
  async onOpen() { await this.render(); }
  async onClose() {}

  async render() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty(); root.addClass("eai-sync-view");
    const header = root.createDiv({ cls: "eai-sync-header" });
    const title = header.createDiv();
    title.createEl("strong", { text: "Vault sync" });
    title.createEl("small", { text: "GitHub sync · private cloud recovery" });
    const refresh = header.createEl("button", { text: "Refresh" });
    refresh.disabled = this.busy;
    refresh.onclick = () => void this.perform("Refresh", () => this.plugin.refreshSyncDashboard());

    const gitCard = root.createDiv({ cls: "eai-card eai-sync-card" });
    const gitHead = gitCard.createDiv({ cls: "eai-sync-card-head" });
    gitHead.createEl("strong", { text: "GitHub" });
    const gitConnect = gitHead.createEl("button", { text: this.plugin.settings.gitRemote ? "Repository" : "Connect" });
    gitConnect.onclick = () => this.plugin.openGitSetup();
    const gitStatusEl = gitCard.createDiv({ cls: "eai-sync-status", text: "Checking repository…" });
    const gitChangesEl = gitCard.createDiv({ cls: "eai-sync-files" });
    const commitRow = gitCard.createDiv({ cls: "eai-sync-commit-row" });
    const commitInput = commitRow.createEl("input", { attr: { type: "text", placeholder: "vault backup: YYYY-MM-DD HH:mm:ss" } });
    commitInput.value = this.plugin.gitCommitMessage || this.plugin.defaultGitCommitMessage();
    commitInput.oninput = () => { this.plugin.gitCommitMessage = commitInput.value; };
    const commit = commitRow.createEl("button", { text: "Commit changes" });
    commit.disabled = this.busy || !this.plugin.settings.gitRemote;
    commit.onclick = () => void this.perform("Commit", () => this.plugin.commitGit(true));
    const gitActions = gitCard.createDiv({ cls: "eai-sync-actions" });
    const pull = gitActions.createEl("button", { text: "Pull & merge" });
    const push = gitActions.createEl("button", { text: "Push / reconcile" });
    const sync = gitActions.createEl("button", { text: "Sync", cls: "mod-cta" });
    const sourceControl = gitActions.createEl("button", { text: "Git source control" });
    pull.disabled = push.disabled = sync.disabled = this.busy || !this.plugin.settings.gitRemote;
    pull.onclick = () => void this.perform("Pull", () => this.plugin.pullGit(true));
    push.onclick = () => void this.perform("Push", () => this.plugin.pushGit(true));
    sync.onclick = () => void this.perform("Sync", () => this.plugin.commitAndPushGit("", true));
    sourceControl.onclick = () => this.plugin.openGitSourceControl();

    const cloudCard = root.createDiv({ cls: "eai-card eai-sync-card" });
    const cloudHead = cloudCard.createDiv({ cls: "eai-sync-card-head" });
    cloudHead.createEl("strong", { text: "Cloud backup · 7 days" });
    const scopeButton = cloudHead.createEl("button", { text: "Folders" });
    scopeButton.onclick = () => new SemanticScopeModal(this.app, this.plugin, "backup").open();
    const cloudStatusEl = cloudCard.createDiv({ cls: "eai-sync-status", text: "Checking backup service…" });
    const cloudControls = cloudCard.createDiv({ cls: "eai-sync-controls" });
    const enabledLabel = cloudControls.createEl("label", { cls: "eai-sync-toggle" });
    const enabled = enabledLabel.createEl("input", { attr: { type: "checkbox" } });
    enabled.checked = this.plugin.settings.cloudBackupEnabled;
    enabled.onchange = async () => { this.plugin.settings.cloudBackupEnabled = enabled.checked; await this.plugin.saveSettings(); };
    enabledLabel.createSpan({ text: "Cloud backup enabled" });
    const autoLabel = cloudControls.createEl("label", { cls: "eai-sync-toggle" });
    const auto = autoLabel.createEl("input", { attr: { type: "checkbox" } });
    auto.checked = this.plugin.settings.cloudBackupAutoOnOpen;
    auto.disabled = !this.plugin.settings.cloudBackupEnabled;
    auto.onchange = async () => { this.plugin.settings.cloudBackupAutoOnOpen = auto.checked; await this.plugin.saveSettings(); };
    autoLabel.createSpan({ text: "Back up when Obsidian opens" });
    const backupActions = cloudCard.createDiv({ cls: "eai-sync-actions" });
    const backup = backupActions.createEl("button", { text: "Back up now", cls: "mod-cta" });
    const refreshBackups = backupActions.createEl("button", { text: "Refresh backups" });
    backup.disabled = refreshBackups.disabled = this.busy;
    backup.onclick = () => void this.perform("Cloud backup", () => this.plugin.backupVault(true));
    refreshBackups.onclick = () => void this.perform("Refresh backups", () => this.plugin.refreshCloudBackupStatus());
    const snapshotsEl = cloudCard.createDiv({ cls: "eai-sync-snapshots" });

    const activityCard = root.createDiv({ cls: "eai-card eai-sync-card" });
    const activityHead = activityCard.createDiv({ cls: "eai-sync-card-head" });
    activityHead.createEl("strong", { text: "Sync activity" });
    activityHead.createEl("small", { text: "Saved locally for this vault" });
    const activityEl = activityCard.createDiv({ cls: "eai-sync-log" });

    try {
      const status = await this.plugin.getGitDashboardStatus();
      gitStatusEl.setText(status.repository ? `${status.branch || "Branch status unavailable"}${status.remote ? `\n${status.remote}` : "\nNo Git remote connected"}` : status.status);
      gitStatusEl.toggleClass("is-success", status.repository && status.changes === 0);
      gitStatusEl.toggleClass("is-warning", status.changes > 0);
      gitConnect.setText(status.remote ? "Change repo" : "Connect repo");
      if (status.paths.length) {
        gitChangesEl.createEl("strong", { text: `${status.paths.length} changed file${status.paths.length === 1 ? "" : "s"}` });
        const list = gitChangesEl.createEl("ul");
        for (const change of status.paths.slice(0, 30)) list.createEl("li", { text: `${change.code}  ${change.path}` });
        if (status.paths.length > 30) gitChangesEl.createEl("small", { text: `and ${status.paths.length - 30} more` });
      } else if (status.repository) gitChangesEl.createDiv({ cls: "eai-muted", text: "Working tree clean." });
      else gitChangesEl.createDiv({ cls: "eai-muted", text: "Connect a GitHub repository to enable commit, pull, and push." });
      if (status.recentCommits.length) {
        const recent = gitChangesEl.createEl("details");
        recent.createEl("summary", { text: "Recent commits" });
        const list = recent.createEl("ul");
        for (const line of status.recentCommits) {
          const [hash, subject, time] = line.split("\t");
          const date = Number(time) ? new Date(Number(time) * 1000).toLocaleString() : "";
          list.createEl("li", { text: `${hash} · ${subject}${date ? ` · ${date}` : ""}` });
        }
      }

      const cloud = await this.plugin.refreshCloudBackupStatus();
      const used = this.plugin.formatBytes(Number(cloud.usedBytes) || 0);
      const unlimited = cloud.unlimited === true;
      const limit = unlimited ? "no app-level vault cap · Supabase quota applies" : `${this.plugin.formatBytes(Number(cloud.limitBytes) || 50 * 1024 * 1024)} rolling vault limit`;
      const snapshots = Array.isArray(cloud.snapshots) ? cloud.snapshots as CloudBackupSnapshot[] : [];
      cloudStatusEl.setText(`${snapshots.length} snapshots · ${used} used · ${limit}`);
      cloudStatusEl.toggleClass("is-success", true);
      if (snapshots.length) {
        const list = snapshotsEl.createEl("ul");
        for (const snapshot of snapshots.slice(0, 8)) {
          const row = list.createEl("li");
          row.createSpan({ text: `${new Date(snapshot.createdAt).toLocaleString()} · ${this.plugin.formatBytes(snapshot.bytes)}${snapshot.files ? ` · ${snapshot.files.toLocaleString()} files` : ""}${snapshot.parts ? ` · ${snapshot.parts} verified chunks` : ""}` });
          const restore = row.createEl("button", { text: "Review restore" });
          restore.onclick = () => void this.plugin.openCloudRestore(snapshot);
        }
      } else snapshotsEl.createDiv({ cls: "eai-muted", text: "No cloud snapshots yet. A successful backup appears here." });
    } catch (error) {
      cloudStatusEl.setText(error instanceof Error ? error.message : "Could not load sync status.");
      cloudStatusEl.addClass("is-error");
    }

    const log = this.plugin.getSyncLog();
    if (!log.length) activityEl.createDiv({ cls: "eai-muted", text: "Git and backup operations will be recorded here with success or failure details." });
    for (const entry of log.slice(0, 30)) {
      const row = activityEl.createDiv({ cls: `eai-sync-log-entry ${entry.ok ? "is-ok" : "is-error"}` });
      const top = row.createDiv({ cls: "eai-sync-log-top" });
      top.createEl("strong", { text: entry.action });
      top.createEl("small", { text: formatRelativeTime(entry.at) });
      row.createDiv({ cls: "eai-sync-log-detail", text: entry.detail });
    }
  }

  private async perform(label: string, action: () => Promise<unknown>) {
    if (this.busy) return;
    this.busy = true;
    await this.render();
    try {
      const result = await action();
      const summary = result && typeof result === "object" ? result as Record<string, unknown> : {};
      const detail = typeof summary.report === "string" ? summary.report
        : typeof summary.status === "string" ? summary.status
          : typeof summary.bytesLabel === "string" ? `Saved ${summary.files || "vault"} files · ${summary.bytesLabel} · 7-day retention.`
            : `${label} completed.`;
      if (label.startsWith("Refresh")) await this.plugin.recordSyncActivity(label, true, detail);
      new Notice(detail, 10_000);
    } catch (error) {
      const detail = error instanceof Error ? error.message : `${label} failed.`;
      if (label.startsWith("Refresh")) await this.plugin.recordSyncActivity(label, false, detail);
      new Notice(detail, 10_000);
    } finally {
      this.busy = false;
      await this.render();
    }
  }
}

class AgentChatView extends ItemView {
  private plugin: ExpertAICompanion;
  private selectedSessionId = "";
  private initialized = false;
  private statusEl?: HTMLElement;
  private transcriptEl?: HTMLElement;
  private inputEl?: HTMLTextAreaElement;
  private sendButton?: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, plugin: ExpertAICompanion) { super(leaf); this.plugin = plugin; }
  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return "Expert AI Chat"; }
  getIcon() { return "message-circle"; }
  async onOpen() { await this.render(); }
  async onClose() { this.initialized = false; }

  async render() {
    if (this.initialized) { await this.refresh(); return; }
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty(); root.addClass("eai-chat-view");
    const header = root.createDiv({ cls: "eai-chat-header" });
    header.createEl("strong", { text: "Expert AI Chat" });
    this.statusEl = header.createEl("span", { cls: "eai-muted", text: "Connecting to the Agent…" });
    root.createEl("div", { cls: "eai-muted", text: "Live replies and tool actions appear here. Private model reasoning is not displayed." });
    this.transcriptEl = root.createDiv({ cls: "eai-chat-transcript" });
    const composer = root.createDiv({ cls: "eai-chat-composer" });
    this.inputEl = composer.createEl("textarea", { attr: { rows: "3", placeholder: "Message Expert AI…" } });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void this.send(); }
    });
    this.sendButton = composer.createEl("button", { text: "Send", cls: "mod-cta" });
    this.sendButton.onclick = () => { void this.send(); };
    composer.createEl("small", { cls: "eai-muted", text: "Ctrl+Enter to send · tool activity is shown below each reply" });
    this.initialized = true;
    await this.refresh();
  }

  selectTask(id: string) { this.selectedSessionId = id; if (this.initialized) void this.refresh(); }

  async refresh() {
    if (!this.initialized || !this.transcriptEl || !this.statusEl) return;
    const entries = await this.plugin.getTaskActivities();
    const sessions = [...new Set(entries.map((entry) => entry.sessionId).filter((id): id is string => !!id))];
    const agent = this.plugin.liveStatus();
    if (agent.agentSessionId && !sessions.includes(agent.agentSessionId)) sessions.unshift(agent.agentSessionId);
    if (!this.selectedSessionId || !sessions.includes(this.selectedSessionId)) this.selectedSessionId = agent.agentSessionId || sessions[0] || "";
    const conversation = entries.filter((entry) => entry.sessionId === this.selectedSessionId).sort((a, b) => a.createdAt - b.createdAt);
    const entry = conversation[conversation.length - 1];
    this.statusEl.setText(agent.agentSessionId === entry?.sessionId && entry?.sessionId
      ? "Connected to Pi session"
      : this.selectedSessionId ? "Saved conversation · reopen its session in Expert AI Agent to continue"
        : "Open Expert AI Agent in this vault to start chatting" );
    this.renderTranscript(conversation);
    const canSend = !!this.selectedSessionId && agent.agentSessionId === this.selectedSessionId;
    if (this.inputEl) this.inputEl.disabled = !canSend;
    if (this.sendButton) this.sendButton.disabled = !canSend;
  }

  private renderTranscript(entries: HistoryEntry[]) {
    if (!this.transcriptEl) return;
    const wasNearBottom = this.transcriptEl.scrollHeight - this.transcriptEl.scrollTop - this.transcriptEl.clientHeight < 80;
    this.transcriptEl.empty();
    if (!entries.length) {
      this.transcriptEl.createDiv({ cls: "eai-empty", text: "Your Pi conversation will appear here. Send a message below to continue it." });
      return;
    }
    for (const entry of entries) for (const message of entry.messages?.length ? entry.messages : entry.request ? [{ role: "user" as const, text: entry.request, updatedAt: entry.createdAt }] : []) {
      const bubble = this.transcriptEl.createDiv({ cls: `eai-chat-message is-${message.role}` });
      bubble.createEl("strong", { text: message.role === "user" ? "You" : "Expert AI" });
      bubble.createEl("div", { text: `${message.text}${message.streaming ? " ▍" : ""}` });
    }
    const events = entries.flatMap((entry) => entry.traceEvents || []).sort((a, b) => a.at - b.at);
    if (events.length) {
      const details = this.transcriptEl.createEl("details", { cls: "eai-chat-trace" });
      details.createEl("summary", { text: `What the Agent did · ${events.length} steps` });
      const list = details.createEl("ol");
      for (const item of events) {
        const row = list.createEl("li", { cls: item.error ? "is-error" : "" });
        row.createEl("strong", { text: item.label });
        if (item.detail) row.createEl("pre", { text: item.detail });
        row.createEl("small", { text: new Date(item.at).toLocaleTimeString() });
      }
    }
    if (entries.some((entry) => entry.taskStatus === "running")) this.transcriptEl.createDiv({ cls: "eai-muted eai-chat-running", text: "Agent is working… visible replies and tool steps will appear here." });
    if (wasNearBottom) this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  private async send() {
    const text = this.inputEl?.value.trim();
    if (!text || !this.selectedSessionId || !this.sendButton) return;
    this.sendButton.disabled = true;
    try {
      await this.plugin.sendChatMessage(this.selectedSessionId, text);
      if (this.inputEl) this.inputEl.value = "";
      await this.refresh();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not send this message to the Agent.", 8000);
    } finally {
      await this.refresh();
    }
  }
}

class CloudRestoreReviewModal extends Modal {
  private plugin: ExpertAICompanion;
  private snapshot: CloudBackupSnapshot;
  private candidates: CloudRestoreCandidate[];
  private page = 0;

  constructor(app: App, plugin: ExpertAICompanion, snapshot: CloudBackupSnapshot, candidates: CloudRestoreCandidate[]) {
    super(app); this.plugin = plugin; this.snapshot = snapshot; this.candidates = candidates;
  }

  onOpen() { this.renderPage(); }

  private renderPage() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("eai-cloud-restore-modal");
    const addCount = this.candidates.filter((item) => item.status === "add").length;
    const replaceCount = this.candidates.filter((item) => item.status === "replace").length;
    const sameCount = this.candidates.filter((item) => item.status === "same").length;
    const blockedCount = this.candidates.filter((item) => item.status === "blocked").length;
    contentEl.createEl("h2", { text: "Review cloud backup" });
    contentEl.createEl("p", { text: `${new Date(this.snapshot.createdAt).toLocaleString()} · ${this.snapshot.files || this.candidates.length} files · ${this.plugin.formatBytes(this.snapshot.bytes)}` });
    contentEl.createEl("p", { text: `Missing here: ${addCount} · Different here: ${replaceCount} · Already identical: ${sameCount} · Path conflicts: ${blockedCount}. Files not in this backup will not be deleted.` });
    contentEl.createEl("p", { cls: "eai-muted", text: "Replacing a file first copies its current version under .expert-ai-recovery, so you can get it back. Add missing files is the safer first option." });
    const list = contentEl.createDiv({ cls: "eai-cloud-restore-list" });
    const pageSize = 200;
    const start = this.page * pageSize;
    for (const item of this.candidates.slice(start, start + pageSize)) {
      const row = list.createDiv({ cls: `eai-cloud-restore-row is-${item.status}` });
      row.createEl("strong", { text: item.status === "add" ? "ADD" : item.status === "replace" ? "REPLACE" : item.status === "same" ? "SAME" : "SKIP" });
      row.createSpan({ text: item.file.path });
    }
    if (this.candidates.length > pageSize) {
      const pages = contentEl.createDiv({ cls: "eai-sync-actions" });
      const previous = pages.createEl("button", { text: "Previous files" }); previous.disabled = this.page === 0;
      previous.onclick = () => { this.page--; this.renderPage(); };
      pages.createSpan({ text: `Files ${start + 1}–${Math.min(start + pageSize, this.candidates.length)} of ${this.candidates.length}` });
      const next = pages.createEl("button", { text: "Next files" }); next.disabled = start + pageSize >= this.candidates.length;
      next.onclick = () => { this.page++; this.renderPage(); };
      contentEl.createEl("small", { text: "The restore buttons apply to all eligible files in this snapshot, across every page." });
    }
    const status = contentEl.createDiv({ cls: "eai-muted" });
    const actions = contentEl.createDiv({ cls: "eai-sync-actions" });
    const add = actions.createEl("button", { text: `Add ${addCount} missing files`, cls: "mod-cta" });
    add.disabled = addCount === 0;
    add.onclick = () => void this.apply(false, add, status);
    const restore = actions.createEl("button", { text: `Restore all differences · save ${replaceCount} current versions first` });
    restore.disabled = addCount + replaceCount === 0;
    restore.onclick = () => void this.apply(true, restore, status);
  }

  private async apply(replace: boolean, button: HTMLButtonElement, status: HTMLElement) {
    button.disabled = true;
    status.setText("Restoring selected files…");
    try {
      const result = await this.plugin.applyCloudRestore(this.snapshot, this.candidates, replace);
      new Notice(`Restore complete · ${result.added} added · ${result.replaced} replaced · ${result.preserved} current versions saved · ${result.skipped} skipped.`, 12_000);
      this.close();
    } catch (error) {
      status.setText(error instanceof Error ? error.message : "Cloud restore failed.");
      button.disabled = false;
    }
  }
}

class SemanticScopeModal extends Modal {
  private plugin: ExpertAICompanion;
  private kind: "index" | "semantic" | "backup";
  private selected = new Set<string>();
  private allVault = false;
  private includeSubfolders = true;

  constructor(app: App, plugin: ExpertAICompanion, kind: "index" | "semantic" | "backup") { super(app); this.plugin = plugin; this.kind = kind; }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.kind === "index" ? "Choose folders for local search" : this.kind === "semantic" ? "Choose folders for meaning search" : "Choose folders for cloud backup" });
    contentEl.createEl("p", { text: this.kind === "index"
      ? "The Agent can already use on-demand file search without preparing your vault. A local index can make repeated mobile searches faster and send fewer, more relevant excerpts to the model. Choose folders with Markdown notes such as research, projects, or meeting notes. The index does not process PDFs, images, or other attachments; the Agent can still use its own tools where supported. Your full vault stays on this computer."
      : this.kind === "semantic"
        ? "Meaning search can find notes about an idea even when your question uses different words. It prepares local embeddings for selected Markdown notes. This can improve mobile answers about themes and related concepts, while using extra setup time, CPU, and disk space. Your note text and embeddings stay on this computer."
        : "Choose what gets a recoverable cloud snapshot. All folders are selected by default; turn off large folders such as media or archives to save storage and make backups faster. Backups are kept for 7 days in your Expert AI account. Files are sent to your configured private Supabase project; cloud storage is not end-to-end encrypted." });
    const current = this.kind === "index" ? this.plugin.getIndexFolders() : this.kind === "semantic" ? this.plugin.getSemanticFolders() : this.plugin.getCloudBackupFolders();
    this.includeSubfolders = this.kind === "index" ? this.plugin.getIndexIncludeSubfolders() : this.kind === "semantic" ? this.plugin.getSemanticIncludeSubfolders() : this.plugin.getCloudBackupIncludeSubfolders();
    this.allVault = current.includes("*");
    this.selected = new Set(current.filter((folder) => folder !== "*"));
    const collapseCoveredSelection = () => {
      if (!this.includeSubfolders) return;
      const roots: string[] = [];
      for (const path of [...this.selected].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
        if (!roots.some((parent) => path.startsWith(`${parent}/`))) roots.push(path);
      }
      this.selected = new Set(roots);
    };
    collapseCoveredSelection();
    const allRow = contentEl.createEl("label", { cls: "eai-scope-row eai-scope-all" });
    const allBox = allRow.createEl("input", { attr: { type: "checkbox" } });
    allBox.checked = this.allVault;
    allRow.createSpan({ text: this.kind === "backup" ? "All folders and files (default)" : "All folders and Markdown notes" });
    const recursiveRow = contentEl.createEl("label", { cls: "eai-scope-row eai-scope-recursive" });
    const recursiveBox = recursiveRow.createEl("input", { attr: { type: "checkbox" } });
    recursiveBox.checked = this.includeSubfolders;
    recursiveBox.disabled = this.allVault;
    recursiveRow.createSpan({ text: "Include subfolders automatically" });
    const folderList = contentEl.createDiv({ cls: "eai-scope-list" });
    const folders = this.plugin.app.vault.getAllFolders().filter((folder) => !!folder.path).sort((a, b) => a.path.localeCompare(b.path));
    const updateStartState = () => { start.disabled = !this.allVault && this.selected.size === 0; };
    const renderFolderRows = () => {
      folderList.empty();
      for (const folder of folders) {
        const inherited = this.includeSubfolders && [...this.selected].some((parent) => parent !== folder.path && folder.path.startsWith(`${parent}/`));
        const row = folderList.createEl("label", { cls: "eai-scope-row" });
        const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
        checkbox.checked = this.selected.has(folder.path) || inherited;
        checkbox.disabled = this.allVault || inherited;
        row.createSpan({ text: inherited ? `${folder.path} · included by parent` : folder.path });
        checkbox.addEventListener("change", () => {
          checkbox.checked ? this.selected.add(folder.path) : this.selected.delete(folder.path);
          collapseCoveredSelection();
          renderFolderRows(); updateStartState();
        });
      }
    };
    renderFolderRows();
    recursiveBox.addEventListener("change", () => { this.includeSubfolders = recursiveBox.checked; collapseCoveredSelection(); renderFolderRows(); });
    allBox.addEventListener("change", () => {
      this.allVault = allBox.checked;
      recursiveBox.disabled = this.allVault;
      renderFolderRows(); updateStartState();
    });
    contentEl.createEl("p", { cls: "eai-muted", text: this.kind === "index"
      ? "After you continue, only Markdown notes inside your selected folders are read for the local keyword index. With subfolders enabled, choosing a parent automatically covers everything nested beneath it. Setup runs in short batches; Obsidian stays available. You can pause or change the scope later."
      : this.kind === "semantic"
        ? "After you continue, the first setup downloads the local model, then creates embeddings only for notes in this scope. With subfolders enabled, choosing a parent covers everything nested beneath it. This takes extra CPU and disk space, so it runs in the background. You can pause or change scope later."
        : "With subfolders enabled, choosing a parent automatically includes its nested folders. Obsidian cache, workspace state, and Git metadata are always excluded. The backup is compressed and limited to a maximum upload size; if it is too large, deselect folders and retry." });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const start = buttons.createEl("button", { text: this.kind === "index" ? "Build search for selected folders" : this.kind === "semantic" ? "Enable for selected folders" : "Save backup scope", cls: "mod-cta" });
    updateStartState();
    start.onclick = () => {
      const folders = this.allVault ? ["*"] : [...this.selected];
      this.close();
      if (this.kind === "index") void this.plugin.configureLocalIndex(folders, this.includeSubfolders);
      else if (this.kind === "semantic") void this.plugin.configureSemanticSearch(folders, this.includeSubfolders);
      else void this.plugin.configureCloudBackupScope(folders, this.includeSubfolders);
    };
  }
}

class GitRemoteModal extends Modal {
  private plugin: ExpertAICompanion;
  constructor(app: App, plugin: ExpertAICompanion) { super(app); this.plugin = plugin; }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl("h2", { text: "Connect a GitHub repository" });
    contentEl.createEl("p", { text: "Enter the repository URL for this vault. Use a private repository if it contains personal notes. Authentication stays with Git Credential Manager or your SSH agent; do not paste a token into the URL." });
    const input = contentEl.createEl("input", { type: "url", attr: { placeholder: "https://github.com/you/your-vault.git" } });
    input.value = this.plugin.settings.gitRemote;
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const connect = actions.createEl("button", { text: "Check and connect", cls: "mod-cta" });
    connect.onclick = async () => {
      connect.disabled = true; connect.setText("Checking repository…");
      try { await this.plugin.configureGitRemote(input.value); this.close(); }
      catch (error) { new Notice(error instanceof Error ? error.message : "Could not connect this repository.", 10_000); connect.disabled = false; connect.setText("Check and connect"); }
    };
  }
}

class SupabaseSetupModal extends Modal {
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl("h2", { text: "Set up managed backup storage" });
    contentEl.createEl("p", { text: "This pilot uses your second Supabase project behind the Expert AI Gateway. End users sign in with Expert AI only; the Supabase service key stays in the Gateway secret store and is never placed in this plugin or sent to the model." });
    const list = contentEl.createEl("ol");
    list.createEl("li", { text: "In your second Supabase project, create a private Storage bucket named expert-ai-vault-backups." });
    list.createEl("li", { text: "Configure the Gateway secrets SUPABASE_BACKUP_URL and SUPABASE_BACKUP_KEY for that project. The key must be a server-side service key; never paste it into a note, chat, plugin setting, or APK." });
    list.createEl("li", { text: "Deploy the Gateway route, then restart the Expert AI Agent server. Backup snapshots are scoped to the signed-in Expert AI account and kept for up to 7 days." });
    contentEl.createEl("p", { cls: "eai-muted", text: "Recent snapshots are kept for 7 days. Standard accounts have a 50 MB rolling limit per vault; the verified owner account has no app-level rolling cap. Supabase project storage quota and the 250 MB uncompressed preparation limit still apply. This storage is not end-to-end encrypted." });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Close", cls: "mod-cta" }).onclick = () => this.close();
  }
}

class CompanionSettingsTab extends PluginSettingTab {
  private plugin: ExpertAICompanion;
  constructor(app: App, plugin: ExpertAICompanion) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Expert AI" });
    containerEl.createEl("p", { cls: "eai-settings-intro", text: "The plugin indexes your vault locally. Only a few retrieved snippets are sent to the model for the current Agent request; the full archive is never uploaded or indexed in the Gateway." });

    new Setting(containerEl).setName("Connect Expert AI Agent")
      .setDesc("Install the local Pi tools for this vault. Restart the Agent server after the first connection. The activity pane changes to Agent connected after a real Agent request reaches this vault; the connection stays on this computer.")
      .addButton((button) => button.setButtonText(this.plugin.settings.connectedAgent ? "Reconnect adapter" : "Connect")
        .setCta().onClick(async () => {
          button.setDisabled(true); button.setButtonText("Connecting…");
          try { await this.plugin.connectAgent(); button.setButtonText("Adapter installed"); }
          catch (error) { button.setButtonText("Connect"); new Notice(error instanceof Error ? error.message : "Could not connect the Agent."); }
          finally { button.setDisabled(false); }
        }))
      .addButton((button) => button.setButtonText("Disconnect").onClick(async () => {
        await this.plugin.disconnectAgent(); new Notice("Expert AI Agent disconnected from this vault."); this.display();
      }));

    new Setting(containerEl).setName("Allow Agent vault changes")
      .setDesc("Allow explicit Agent requests to create, append, edit, move, rename, and trash notes through Obsidian. Every change is recorded for review and restore.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.agentWritesEnabled).onChange(async (value) => {
        this.plugin.settings.agentWritesEnabled = value; await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName("Share the open workspace with Agent")
      .setDesc("On each Agent request, share open file paths, the active note, panes/tabs, and editor mode. Note contents are not sent by this feature. Turn this off to keep workspace details local.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.workspaceAwarenessEnabled).onChange(async (value) => {
        this.plugin.settings.workspaceAwarenessEnabled = value; await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName("Fast local search (optional)")
      .setDesc(this.plugin.localIndexDescription())
      .addButton((button) => button.setButtonText(this.plugin.isIndexing() ? "Pause indexing"
        : this.plugin.settings.localIndexEnabled ? "Change folders"
          : this.plugin.settings.localIndexFolders.length ? "Start local search" : "Choose folders…")
        .onClick(() => this.plugin.isIndexing() ? void this.plugin.disableLocalIndex()
          : this.plugin.settings.localIndexEnabled ? new SemanticScopeModal(this.app, this.plugin, "index").open()
            : this.plugin.settings.localIndexFolders.length ? void this.plugin.enableLocalIndex()
              : new SemanticScopeModal(this.app, this.plugin, "index").open()))
      .addButton((button) => button.setButtonText(this.plugin.settings.localIndexEnabled ? "Pause" : "Off")
        .setDisabled(!this.plugin.settings.localIndexEnabled)
        .onClick(async () => { await this.plugin.disableLocalIndex(); this.display(); }));

    new Setting(containerEl).setName("Search by related meaning (optional)")
      .setDesc(this.plugin.semanticSearchDescription())
      .addButton((button) => button.setButtonText(this.plugin.settings.semanticEnabled ? "Change folders" : "Choose folders…")
        .onClick(() => new SemanticScopeModal(this.app, this.plugin, "semantic").open()))
      .addButton((button) => button.setButtonText(this.plugin.settings.semanticEnabled ? "Turn off" : "Off")
        .setDisabled(!this.plugin.settings.semanticEnabled)
        .onClick(async () => { await this.plugin.disableSemanticSearch(); this.display(); }));

    new Setting(containerEl).setName("Change history retention")
      .setDesc("Keep local task checkpoints, diffs, and restorable before-versions. History stays on this device.")
      .addDropdown((dropdown) => dropdown.addOption("7", "7 days").addOption("13", "13 days")
        .setValue(String(this.plugin.settings.retentionDays)).onChange(async (value) => {
          this.plugin.settings.retentionDays = Number(value) === 7 ? 7 : 13;
          await this.plugin.saveSettings(); await this.plugin.pruneHistory();
        }));

    new Setting(containerEl).setName("Remember recent Agent tasks")
      .setDesc("Keep the last short request and vault activity locally for cross-session continuity. Task text is never sent to the Gateway as stored memory.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.rememberTasks).onChange(async (value) => {
        this.plugin.settings.rememberTasks = value; await this.plugin.saveSettings();
      }));

    containerEl.createEl("h3", { text: "Git sync" });
    containerEl.createEl("p", { cls: "eai-settings-intro", text: "Use Sync to checkpoint local edits, merge GitHub changes without rewriting history, and push the combined result. Non-conflicting changes merge automatically; genuine file conflicts stay in Git for review, with both commits preserved. Companion uses this computer's Git credential manager or SSH and does not store GitHub passwords or tokens." });
    new Setting(containerEl).setName("Repository")
      .setDesc(this.plugin.gitStatusSummary)
      .addButton((button) => button.setButtonText(this.plugin.settings.gitRemote ? "Change repository" : "Connect repository")
        .onClick(() => new GitRemoteModal(this.app, this.plugin).open()))
      .addButton((button) => button.setButtonText("Refresh").onClick(async () => {
        button.setDisabled(true); button.setButtonText("Refreshing…");
        try { await this.plugin.refreshGit(); this.display(); }
        catch (error) { new Notice(error instanceof Error ? error.message : "Git refresh failed.", 10_000); }
        finally { button.setDisabled(false); button.setButtonText("Refresh"); }
      }));
    new Setting(containerEl).setName("Pull updates")
      .setDesc("Checkpoints local edits, fetches GitHub, and merges remote commits. Non-conflicting changes apply automatically; unresolved file conflicts remain available in Git for review.")
      .addButton((button) => button.setButtonText("Pull & merge").setDisabled(!this.plugin.settings.gitRemote)
        .onClick(async () => { button.setDisabled(true); try { await this.plugin.pullGit(); this.display(); } catch (error) { new Notice(error instanceof Error ? error.message : "Git pull failed.", 10_000); } finally { button.setDisabled(false); } }));
    new Setting(containerEl).setName("Pull & merge when this vault opens")
      .setDesc("On Obsidian startup, checkpoint local edits and merge GitHub changes. Disable this if you prefer to sync manually.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.gitStartupPull).setDisabled(!this.plugin.settings.gitRemote)
        .onChange(async (value) => { this.plugin.settings.gitStartupPull = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Commit local vault changes")
      .setDesc("Stages all vault changes, including deletions, and creates a local Git commit. Review the file list in Obsidian Git or your Git client before committing if needed.")
      .addText((text) => text.setPlaceholder("vault backup: YYYY-MM-DD HH:mm:ss").setValue(this.plugin.gitCommitMessage || this.plugin.defaultGitCommitMessage()).onChange((value) => { this.plugin.gitCommitMessage = value; }))
      .addButton((button) => button.setButtonText("Commit").setDisabled(!this.plugin.settings.gitRemote)
        .onClick(async () => { button.setDisabled(true); try { await this.plugin.commitGit(); this.display(); } catch (error) { new Notice(error instanceof Error ? error.message : "Git commit failed.", 10_000); } finally { button.setDisabled(false); } }));
    new Setting(containerEl).setName("Push commits")
      .setDesc("Checkpoints uncommitted edits, merges newer GitHub history when necessary, then pushes without rewriting either branch.")
      .addButton((button) => button.setButtonText("Push").setDisabled(!this.plugin.settings.gitRemote)
        .onClick(async () => { button.setDisabled(true); try { await this.plugin.pushGit(); this.display(); } catch (error) { new Notice(error instanceof Error ? error.message : "Git push failed.", 10_000); } finally { button.setDisabled(false); } }));

    containerEl.createEl("h3", { text: "Cloud backup · 7-day recovery" });
    containerEl.createEl("p", { cls: "eai-settings-intro", text: "Back up selected folders to your Expert AI account's private Supabase storage through the Gateway. No separate Supabase login is needed. Git remains optional for full sync and merges; this cloud backup keeps recent snapshots for recovery." });
    new Setting(containerEl).setName("Choose backup folders")
      .setDesc(this.plugin.cloudBackupDescription())
      .addButton((button) => button.setButtonText("Choose folders…").onClick(() => new SemanticScopeModal(this.app, this.plugin, "backup").open()));
    new Setting(containerEl).setName("Managed storage connection")
      .setDesc("Uses the Supabase project configured on the Expert AI Gateway. No Supabase account or API key is needed on this computer.")
      .addButton((button) => button.setButtonText("Setup instructions").onClick(() => this.plugin.openSupabaseSetupGuide()));
    new Setting(containerEl).setName("Enable cloud backup")
      .setDesc("When enabled, the Agent can create a cloud snapshot when you ask. Files go to the private backup bucket and are not end-to-end encrypted. Only turn this on if you want this vault stored in your account's cloud backup.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.cloudBackupEnabled)
        .onChange(async (value) => { this.plugin.settings.cloudBackupEnabled = value; await this.plugin.saveSettings(); this.display(); }));
    new Setting(containerEl).setName("Back up automatically when Obsidian opens")
      .setDesc("After you enable cloud backup, check this to make a background snapshot when the vault opens. It compares against recent snapshots and avoids uploading an unchanged vault.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.cloudBackupAutoOnOpen).setDisabled(!this.plugin.settings.cloudBackupEnabled)
        .onChange(async (value) => { this.plugin.settings.cloudBackupAutoOnOpen = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Back up this vault now")
      .setDesc("Streams a compressed snapshot in verified 4 MiB pieces. Obsidian settings, cache, workspace state, and Git metadata are excluded; backup progress appears in the status bar and Sync activity.")
      .addButton((button) => button.setButtonText("Back up now").setDisabled(!this.plugin.settings.cloudBackupEnabled)
        .onClick(async () => { button.setDisabled(true); button.setButtonText("Preparing snapshot…"); try { const result = await this.plugin.backupVault(); new Notice(`${result.skipped ? "Backup already saved" : "Backup complete"} · ${result.files} files · ${result.parts} verified chunks · ${result.bytesLabel} · kept for 7 days.`, 10_000); } catch (error) { new Notice(error instanceof Error ? error.message : "Cloud backup failed.", 10_000); } finally { button.setDisabled(false); button.setButtonText("Back up now"); } }));

    new Setting(containerEl).setName("Conversation archive folder")
      .setDesc("Choose where saved AI conversations and research notes go. Ask Expert AI Agent to save a conversation after sharing its content or transcript.")
      .addText((text) => text.setPlaceholder("AI Archive").setValue(this.plugin.settings.archiveFolder).onChange(async (value) => {
        this.plugin.settings.archiveFolder = value.trim() || "AI Archive";
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName("Clear local history and memory")
      .setDesc("Remove saved task prompts and Agent change snapshots for this vault. The notes themselves are not changed.")
      .addButton((button) => button.setButtonText("Clear local history").setWarning().onClick(async () => {
        const confirmed = await this.plugin.confirm("Clear local history?", "This deletes Expert AI's local diffs, before-versions, and recent task checkpoints. It does not delete or change your notes.");
        if (confirmed) { await this.plugin.clearHistory(); new Notice("Local history cleared."); }
      }));
  }
}

export default class ExpertAICompanion extends Plugin {
  settings: CompanionSettings = { ...DEFAULT_SETTINGS };
  private bridge?: Server;
  private bridgePort = 0;
  private token = "";
  private basePath = "";
  private vaultId = "";
  private localDataDir = "";
  private agentExtensionDir = "";
  private localStore!: LocalVaultStore;
  private indexer!: VaultIndexer;
  private embedder: LocalEmbedder | null = null;
  private indexState: { indexing: boolean; indexed: number; total: number; currentPath: string; phase: "ready" | "scanning" | "embedding" } = { indexing: false, indexed: 0, total: 0, currentPath: "", phase: "ready" };
  private agentLastSeen = 0;
  private activeAgentSessionId = "";
  private activeTaskId = "";
  private indexSync: Promise<{ scanned: number; changed: number; removed: number }> | null = null;
  private indexAgain = false;
  private semanticGeneration = 0;
  private semanticStatusText = "";
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private pendingVaultMoves = new Set<string>();
  private backupStartupTimer?: number;
  gitStatusSummary = "Git status has not been checked yet.";
  gitCommitMessage = "";

  async onload() {
    const savedSettings = await this.loadData() || {};
    this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
    this.settings.retentionDays = this.settings.retentionDays === 7 ? 7 : 13;
    this.settings.gitRemote = typeof this.settings.gitRemote === "string" && this.isSafeGitHubRemote(this.settings.gitRemote) ? this.settings.gitRemote : "";
    this.settings.gitStartupPull = savedSettings.gitStartupPull === true;
    this.settings.semanticFolders = Array.isArray(savedSettings.semanticFolders)
      ? savedSettings.semanticFolders.map(String)
      : this.settings.semanticEnabled ? ["*"] : [];
    this.settings.semanticIncludeSubfolders = savedSettings.semanticIncludeSubfolders !== false;
    this.settings.localIndexEnabled = this.settings.semanticEnabled || savedSettings.localIndexEnabled === true;
    this.settings.localIndexFolders = Array.isArray(savedSettings.localIndexFolders)
      ? savedSettings.localIndexFolders.map(String)
      : this.settings.semanticEnabled ? [...this.settings.semanticFolders] : [];
    this.settings.localIndexIncludeSubfolders = savedSettings.localIndexIncludeSubfolders !== false;
    this.settings.cloudBackupEnabled = savedSettings.cloudBackupEnabled === true;
    this.settings.cloudBackupFolders = Array.isArray(savedSettings.cloudBackupFolders) && savedSettings.cloudBackupFolders.length
      ? savedSettings.cloudBackupFolders.map(String) : ["*"];
    this.settings.cloudBackupIncludeSubfolders = savedSettings.cloudBackupIncludeSubfolders !== false;
    this.settings.cloudBackupAutoOnOpen = savedSettings.cloudBackupAutoOnOpen === true;
    this.settings.syncActivity = Array.isArray(savedSettings.syncActivity)
      ? savedSettings.syncActivity.filter((entry: SyncLogEntry) => entry && typeof entry.id === "string" && typeof entry.at === "number").slice(0, 100)
      : [];
    if (!Platform.isDesktopApp) {
      new Notice("Expert AI currently needs Obsidian Desktop to connect to Expert AI Agent. Local vault search remains available on desktop.");
    }
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) throw new Error("Expert AI requires a local Obsidian vault.");
    this.basePath = this.app.vault.adapter.getBasePath();
    this.vaultId = createHash("sha256").update(resolve(this.basePath).toLocaleLowerCase()).digest("hex").slice(0, 20);
    this.localDataDir = join(platformDataHome(), "Expert AI", "Obsidian Companion", this.vaultId);
    this.agentExtensionDir = this.settings.appDataPath || this.findAgentDataPath();
    this.localStore = new LocalVaultStore(`expert-ai-obsidian-${this.vaultId}`);
    this.indexer = new VaultIndexer(this.app, this.localStore, (state) => {
      this.indexState = { ...state, currentPath: state.currentPath || "", indexing: state.phase !== "ready" };
      this.updateOpenViewIndex(state);
      if (state.phase === "ready") {
        this.setFooterStatus(`Vault index ready · ${state.indexed.toLocaleString()} notes updated`);
        this.refreshOpenView();
      } else {
        const label = state.phase === "embedding" ? "Embedding local notes" : "Indexing vault notes";
        this.setFooterStatus(`${label} · ${state.indexed.toLocaleString()}/${state.total.toLocaleString()}`);
      }
    });
    this.indexer.setSemanticFolders(this.settings.semanticFolders, this.settings.semanticIncludeSubfolders);
    this.indexer.setIndexFolders(this.settings.localIndexFolders, this.settings.localIndexIncludeSubfolders);
    await mkdir(this.localDataDir, { recursive: true });
    if (this.settings.connectedAgent && this.agentExtensionDir) await this.startBridge();

    this.registerView(VIEW_TYPE, (leaf) => new CompanionView(leaf, this));
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new AgentChatView(leaf, this));
    this.registerView(SYNC_VIEW_TYPE, (leaf) => new SyncView(leaf, this));
    this.addRibbonIcon("brain-circuit", "Open Expert AI", () => { void this.activateView(); });
    this.addRibbonIcon("git-branch", "Open Expert AI Sync", () => { void this.activateSyncView(); });
    this.addCommand({ id: "open-activity", name: "Open activity and history", callback: () => this.activateView() });
    this.addCommand({ id: "open-agent-chat", name: "Open Expert AI chat", callback: () => this.openChat() });
    this.addCommand({ id: "open-sync", name: "Open vault sync dashboard", callback: () => this.activateSyncView() });
    this.addCommand({ id: "sync-refresh", name: "Refresh Git and cloud backup status", callback: () => this.runSyncCommand("Sync refresh", () => this.refreshSyncDashboard()) });
    this.addCommand({ id: "git-commit", name: "Commit vault changes (timestamped)", callback: () => this.runSyncCommand("Git commit", () => this.commitGit(true)) });
    this.addCommand({ id: "git-pull", name: "Pull vault changes safely", callback: () => this.runSyncCommand("Git pull", () => this.pullGit(true)) });
    this.addCommand({ id: "git-push", name: "Push vault commits", callback: () => this.runSyncCommand("Git push", () => this.pushGit(true)) });
    this.addCommand({ id: "git-sync", name: "Commit and push vault changes", callback: () => this.runSyncCommand("Git sync", () => this.commitAndPushGit("", true)) });
    this.addCommand({ id: "git-source-control", name: "Open Obsidian Git source control", callback: () => this.openGitSourceControl() });
    this.addCommand({ id: "cloud-backup-now", name: "Back up vault to Expert AI cloud", callback: () => this.runSyncCommand("Cloud backup", () => this.backupVault(true)) });
    this.addCommand({ id: "cloud-backup-refresh", name: "Refresh Expert AI cloud backups", callback: () => this.runSyncCommand("Refresh backups", () => this.refreshCloudBackupStatus()) });
    this.addCommand({ id: "refresh-index", name: "Refresh local vault index", callback: () => this.refreshIndex() });
    this.addSettingTab(new CompanionSettingsTab(this.app, this));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshWorkspaceViews()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshWorkspaceViews()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshWorkspaceViews()));
    this.registerEvent(this.app.vault.on("create", (file) => { if (this.settings.localIndexEnabled && file instanceof TFile && isMarkdownPath(file.path)) void this.indexer.indexFile(file); }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (!(file instanceof TFile) || !isMarkdownPath(file.path)) return;
      void this.queueMutation(async () => {
        const text = await this.fullText(file);
        const known = await this.localStore.getSnapshot(file.path);
        if (!known) {
          await this.record({ id: crypto.randomUUID(), createdAt: Date.now(), action: "create", path: file.path, after: text, request: "Created in the connected vault", taskId: this.activeTaskId || undefined });
        }
        await this.localStore.putSnapshot({ path: file.path, text, updatedAt: Date.now() });
      }).catch((error) => console.warn("[Expert AI] could not track created note", error));
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile) || !isMarkdownPath(file.path)) return;
      if (this.settings.localIndexEnabled) void this.indexer.indexFile(file);
      void this.queueMutation(() => this.trackModifiedNote(file)).catch((error) => console.warn("[Expert AI] could not track note version", error));
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.settings.localIndexEnabled) void this.indexer.remove(oldPath).then(() => file instanceof TFile && isMarkdownPath(file.path) ? this.indexer.indexFile(file) : undefined);
      if (file instanceof TFolder) void this.queueMutation(async () => {
        const moveKey = `${oldPath}\0${file.path}`;
        if (this.pendingVaultMoves.delete(moveKey)) return;
        await this.localStore.moveSnapshotsPrefix(oldPath, file.path);
        await this.record({ id: crypto.randomUUID(), createdAt: Date.now(), action: "move", path: oldPath, nextPath: file.path, request: "Moved or renamed folder in the connected vault", taskId: this.activeTaskId || undefined });
      }).catch((error) => console.warn("[Expert AI] could not track folder move", error));
      if (file instanceof TFile && isMarkdownPath(file.path) && isMarkdownPath(oldPath)) {
        void this.queueMutation(async () => {
          const previous = await this.localStore.getSnapshot(oldPath);
          if (!previous) return;
          const text = await this.fullText(file);
          await this.localStore.moveSnapshot(oldPath, file.path);
          if (text !== previous.text) await this.record({ id: crypto.randomUUID(), createdAt: Date.now(), action: "edit", path: file.path, before: previous.text, after: text, request: "Edited and moved in the connected vault", taskId: this.activeTaskId || undefined });
          await this.record({ id: crypto.randomUUID(), createdAt: Date.now(), action: "rename", path: oldPath, nextPath: file.path, before: previous.text, after: text, request: "Moved or renamed in the connected vault", taskId: this.activeTaskId || undefined });
          await this.localStore.putSnapshot({ path: file.path, text, updatedAt: Date.now() });
        }).catch((error) => console.warn("[Expert AI] could not track renamed note", error));
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (this.settings.localIndexEnabled) void this.indexer.remove(file.path);
      if (file instanceof TFolder) void this.queueMutation(async () => {
        const snapshots = await this.localStore.getSnapshotsPrefix(file.path);
        for (const snapshot of snapshots) await this.record({ id: crypto.randomUUID(), createdAt: Date.now(), action: "trash", path: snapshot.path, before: snapshot.text, request: "Deleted with its folder in the connected vault", taskId: this.activeTaskId || undefined });
        await this.localStore.deleteSnapshotsPrefix(file.path);
      }).catch((error) => console.warn("[Expert AI] could not track deleted folder versions", error));
      if (file instanceof TFile && isMarkdownPath(file.path)) void this.queueMutation(async () => {
        const previous = await this.localStore.getSnapshot(file.path);
        if (previous) await this.record({ id: crypto.randomUUID(), createdAt: Date.now(), action: "trash", path: file.path, before: previous.text, request: "Deleted in the connected vault", taskId: this.activeTaskId || undefined });
        await this.localStore.deleteSnapshot(file.path);
      }).catch((error) => console.warn("[Expert AI] could not track deleted note", error));
    }));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.localIndexEnabled) void this.refreshIndex().catch((error) => console.error("[Expert AI] local search refresh failed", error));
      void this.seedVersionSnapshots();
      if (this.settings.cloudBackupEnabled && this.settings.cloudBackupAutoOnOpen) {
        this.backupStartupTimer = window.setTimeout(() => {
          void this.backupVault().catch((error) => new Notice(`Automatic cloud backup skipped: ${error instanceof Error ? error.message : "retry from settings"}`, 10_000));
        }, 8000);
      }
      void this.initializeGitSettings().then(() => {
        if (this.settings.gitStartupPull && this.settings.gitRemote) return this.pullGit(true);
      }).catch((error) => new Notice(`Automatic Git pull paused: ${error instanceof Error ? error.message : "review required"}`, 10_000));
    });
    if (this.settings.semanticEnabled && this.settings.localIndexEnabled) void this.loadSemanticSearchInBackground();
  }

  async onunload() {
    if (this.backupStartupTimer) window.clearTimeout(this.backupStartupTimer);
    this.indexer?.stop();
    await this.stopBridge();
    await this.localStore?.close();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
  }

  private async seedVersionSnapshots() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    const files = this.app.vault.getMarkdownFiles();
    if (active && active.stat.size <= MAX_NOTE_CHARS) {
      const current = await this.fullText(active);
      const previous = await this.localStore.getSnapshot(active.path);
      if (previous && previous.text !== current) {
        await this.record({ id: crypto.randomUUID(), createdAt: active.stat.mtime || Date.now(), action: "edit", path: active.path, before: previous.text, after: current, request: "Changed while Expert AI was closed" });
      }
      await this.localStore.putSnapshot({ path: active.path, text: current, updatedAt: active.stat.mtime || Date.now() });
    }
    for (const file of files) {
      if (file.path === active?.path || file.stat.size > MAX_NOTE_CHARS) continue;
      try {
        const current = await this.app.vault.read(file);
        const previous = await this.localStore.getSnapshot(file.path);
        if (previous && previous.text !== current) {
          await this.record({ id: crypto.randomUUID(), createdAt: file.stat.mtime || Date.now(), action: "edit", path: file.path, before: previous.text, after: current, request: "Changed while Expert AI was closed" });
        }
        await this.localStore.putSnapshot({ path: file.path, text: current, updatedAt: file.stat.mtime || Date.now() });
      } catch (error) { console.warn(`[Expert AI] skipped version baseline for ${file.path}`, error); }
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
  }

  private async trackModifiedNote(file: TFile) {
    const after = await this.fullText(file);
    if (after.length > MAX_NOTE_CHARS) return;
    const before = await this.localStore.getSnapshot(file.path);
    if (before && before.text !== after) {
      await this.record({ id: crypto.randomUUID(), createdAt: Date.now(), action: "edit", path: file.path, before: before.text, after, request: "Edited in the connected vault", taskId: this.activeTaskId || undefined });
    }
    await this.localStore.putSnapshot({ path: file.path, text: after, updatedAt: file.stat.mtime || Date.now() });
  }

  private async ensureVersionSnapshot(file: TFile) {
    const current = await this.fullText(file);
    if (current.length > MAX_NOTE_CHARS) return current;
    const previous = await this.localStore.getSnapshot(file.path);
    if (previous && previous.text !== current) {
      await this.record({ id: crypto.randomUUID(), createdAt: file.stat.mtime || Date.now(), action: "edit", path: file.path, before: previous.text, after: current, request: "Changed in the connected vault", taskId: this.activeTaskId || undefined });
    }
    await this.localStore.putSnapshot({ path: file.path, text: current, updatedAt: file.stat.mtime || Date.now() });
    return current;
  }

  getIconUrl() { return this.app.vault.adapter.getResourcePath(`${this.manifest.dir}/icon.png`); }
  openSettings() { (this.app as any).setting?.open(); (this.app as any).setting?.openTabById(this.manifest.id); }

  async saveSettings() { await this.saveData(this.settings); }

  defaultGitCommitMessage() {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `vault backup: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  getSyncLog() { return [...(this.settings.syncActivity || [])]; }

  async recordSyncActivity(action: string, ok: boolean, detail: string) {
    this.settings.syncActivity = [{ id: crypto.randomUUID(), at: Date.now(), action, ok, detail: detail.slice(0, 600) }, ...(this.settings.syncActivity || [])].slice(0, 100);
    await this.saveSettings();
    this.refreshOpenSyncView();
  }

  async getGitDashboardStatus() {
    if (!(await this.isGitRepository())) return { repository: false, remote: "", branch: "", status: "Git is not initialized for this vault.", paths: [] as Array<{ code: string; path: string }>, changes: 0, recentCommits: [] as string[] };
    const [{ stdout: status }, remote] = await Promise.all([
      this.runGit(["-c", "core.quotepath=false", "status", "--short", "--branch", "--untracked-files=all"]),
      this.runGit(["remote", "get-url", "origin"]).catch(() => ({ stdout: "", stderr: "" })),
    ]);
    const lines = status.split(/\r?\n/).filter(Boolean);
    const branchLine = lines.find((line) => line.startsWith("## ")) || "";
    const paths = lines.filter((line) => !line.startsWith("## ")).map((line) => ({ code: line.slice(0, 2).trim() || "??", path: line.slice(3).trim() })).filter((change) => change.path);
    const recent = await this.runGit(["log", "-5", "--pretty=format:%h%x09%s%x09%ct"]).catch(() => ({ stdout: "", stderr: "" }));
    return { repository: true, remote: remote.stdout, branch: branchLine.replace(/^##\s*/, ""), status: branchLine || "Repository status available.", paths, changes: paths.length,
      recentCommits: recent.stdout.split(/\r?\n/).filter(Boolean) };
  }

  async refreshSyncDashboard() {
    await this.refreshGit(true);
    await this.refreshCloudBackupStatus();
    this.refreshOpenSyncView();
  }

  async refreshCloudBackupStatus() { return this.listCloudBackups(); }

  async runSyncCommand(label: string, action: () => Promise<unknown>) {
    try {
      const result = await action();
      const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
      const detail = typeof value.bytesLabel === "string" ? `Saved ${value.files || "vault"} files · ${value.bytesLabel}.`
        : typeof value.report === "string" ? value.report
          : typeof value.status === "string" ? value.status : `${label} completed.`;
      if (label.startsWith("Refresh")) await this.recordSyncActivity(label, true, detail);
      new Notice(detail, 10_000);
      this.refreshOpenSyncView();
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : `${label} failed.`;
      if (label.startsWith("Refresh")) await this.recordSyncActivity(label, false, detail);
      new Notice(detail, 10_000);
      this.refreshOpenSyncView();
      return null;
    }
  }

  openGitSetup() { new GitRemoteModal(this.app, this).open(); }

  openGitSourceControl() {
    const commandId = "obsidian-git:open-git-view";
    const available = (this.app as any).commands?.findCommand?.(commandId);
    if (!available) { new Notice("Obsidian Git’s Source Control View is not available. Enable the Git plugin, then refresh this dashboard.", 8000); return; }
    (this.app as any).commands.executeCommandById(commandId);
  }

  private async runGit(args: string[]) {
    try {
      const result = await execFile("git", args, { cwd: this.basePath, windowsHide: true, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
      return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    } catch (error) {
      const detail = error as Error & { stderr?: string; code?: string };
      if (detail.code === "ENOENT") throw new Error("Git was not found. Install Git for your computer, then restart Obsidian.");
      throw new Error((detail.stderr || detail.message || "Git command failed.").trim());
    }
  }

  private async isGitRepository() {
    try { await this.runGit(["rev-parse", "--is-inside-work-tree"]); return true; }
    catch { return false; }
  }

  private isSafeGitHubRemote(remote: string) {
    return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(remote)
      || /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(remote);
  }

  private async gitStatusText() {
    if (!(await this.isGitRepository())) return "This vault is not inside a Git repository.";
    const { stdout } = await this.runGit(["status", "--short", "--branch"]);
    return stdout || "Repository is clean.";
  }

  private async initializeGitSettings() {
    if (!(await this.isGitRepository())) return;
    const remote = await this.runGit(["remote", "get-url", "origin"]).catch(() => ({ stdout: "", stderr: "" }));
    if (remote.stdout && this.isSafeGitHubRemote(remote.stdout) && this.settings.gitRemote !== remote.stdout) {
      this.settings.gitRemote = remote.stdout;
      await this.saveSettings();
    }
  }

  async configureGitRemote(raw: string) {
    const remote = raw.trim();
    if (!this.isSafeGitHubRemote(remote)) throw new Error("Enter a GitHub HTTPS or SSH repository URL without a username, password, or token.");
    if (!(await this.isGitRepository())) throw new Error("This vault is not a Git repository yet. Initialize it with Obsidian Git or your preferred Git client first so the initial file set and .gitignore can be reviewed safely.");
    const current = await this.runGit(["remote", "get-url", "origin"]).catch(() => ({ stdout: "", stderr: "" }));
    if (current.stdout && current.stdout !== remote) {
      const confirmed = await this.confirm("Replace this vault's origin remote?", `Current: ${current.stdout}\nNew: ${remote}`);
      if (!confirmed) return;
      await this.runGit(["remote", "set-url", "origin", remote]);
    } else if (!current.stdout) await this.runGit(["remote", "add", "origin", remote]);
    // A read-only remote check lets Git Credential Manager or SSH authenticate without changing vault files.
    await this.runGit(["ls-remote", "--heads", "origin"]);
    this.settings.gitRemote = remote;
    await this.saveSettings();
    await this.refreshGit();
    new Notice("GitHub repository connected. Review vault files before your first commit.");
  }

  async refreshGit(quiet = false) {
    try {
      if (!(await this.isGitRepository())) { this.gitStatusSummary = "Git is not initialized for this vault. Initialize it with Obsidian Git or your preferred Git client, then connect the repository."; throw new Error(this.gitStatusSummary); }
      const remote = await this.runGit(["remote", "get-url", "origin"]).catch(() => ({ stdout: "", stderr: "" }));
      if (!this.settings.gitRemote && remote.stdout && this.isSafeGitHubRemote(remote.stdout)) this.settings.gitRemote = remote.stdout;
      if (this.settings.gitRemote && remote.stdout !== this.settings.gitRemote) throw new Error("The local Git origin differs from the repository saved in Expert AI. Reconnect the intended repository.");
      if (this.settings.gitRemote) await this.runGit(["fetch", "--prune", "origin"]);
      const status = await this.gitStatusText();
      this.gitStatusSummary = status.length > 700 ? `${status.slice(0, 700)}…` : status;
      await this.saveSettings();
      await this.recordSyncActivity("Git refresh", true, status || "Git status refreshed.");
      if (!quiet) new Notice("Git status refreshed.");
    } catch (error) {
      await this.recordSyncActivity("Git refresh", false, error instanceof Error ? error.message : "Git refresh failed.");
      throw error;
    }
  }

  private async gitUpstreamRef() {
    try {
      const upstream = await this.runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      if (upstream.stdout) return upstream.stdout;
    } catch { /* A repo can have origin without a configured branch upstream. */ }
    const branch = (await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"])).stdout;
    if (!branch || branch === "HEAD") return "";
    const fallback = `origin/${branch}`;
    try { await this.runGit(["rev-parse", "--verify", `${fallback}^{commit}`]); return fallback; }
    catch { return ""; }
  }

  private async gitUnmergedPaths() {
    const result = await this.runGit(["diff", "--name-only", "--diff-filter=U"]);
    return result.stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
  }

  private async gitMergeIsInProgress() {
    try { await this.runGit(["rev-parse", "--verify", "-q", "MERGE_HEAD"]); return true; }
    catch { return false; }
  }

  private async mergeUpstreamSafely(upstream: string) {
    try { await this.runGit(["merge", "--no-edit", upstream]); }
    catch (error) {
      const conflicts = await this.gitUnmergedPaths().catch(() => []);
      if (conflicts.length) {
        await this.updateGitStatus().catch(() => {});
        const shown = conflicts.slice(0, 12).join(", ");
        const more = conflicts.length > 12 ? `, and ${conflicts.length - 12} more` : "";
        throw new Error(`Git merge paused on ${conflicts.length} conflicting file${conflicts.length === 1 ? "" : "s"}: ${shown}${more}. Local and GitHub commits are both preserved; nothing was pushed. Resolve these files in Obsidian Git or a text editor, then run Sync again.`);
      }
      throw error;
    }
  }

  private async reconcileGitHistory(pushRemote: boolean) {
    if (!this.settings.gitRemote) throw new Error("Connect a GitHub repository first.");

    // If the last sync stopped on conflicts, never create a normal commit over
    // the unresolved merge. Continue only after Git reports every file resolved.
    if (await this.gitMergeIsInProgress()) {
      const unresolved = await this.gitUnmergedPaths();
      if (unresolved.length) {
        const shown = unresolved.slice(0, 12).join(", ");
        const more = unresolved.length > 12 ? `, and ${unresolved.length - 12} more` : "";
        throw new Error(`Sync is waiting for ${unresolved.length} conflict${unresolved.length === 1 ? "" : "s"} to be resolved: ${shown}${more}. Both versions remain in Git. Resolve and stage each file, then run Sync again.`);
      }
      await this.runGit(["commit", "--no-edit"]);
    }

    const before = await this.runGit(["status", "--porcelain"]);
    let checkpoint = "";
    if (before.stdout) {
      this.gitCommitMessage = this.gitCommitMessage.trim() || this.defaultGitCommitMessage();
      const committed = await this.commitGit(true) as { report?: string };
      checkpoint = committed.report || "Local changes checkpointed.";
    }

    await this.runGit(["fetch", "--prune", "origin"]);
    let upstream = await this.gitUpstreamRef();
    if (!upstream) throw new Error("Git fetched successfully, but this local branch has no matching GitHub branch. Check the branch name and tracking setup.");
    let incoming = Number((await this.runGit(["rev-list", "--count", `HEAD..${upstream}`])).stdout) || 0;
    let outgoing = Number((await this.runGit(["rev-list", "--count", `${upstream}..HEAD`])).stdout) || 0;
    let pulledFiles = summarizeGitNameStatus(incoming ? (await this.runGit(["diff", "--name-status", "--find-renames", "HEAD", upstream])).stdout : "").files;
    if (incoming) await this.mergeUpstreamSafely(upstream);

    let pushedFiles = 0;
    let pushedCommits = 0;
    if (pushRemote) {
      for (let attempt = 0; ; attempt++) {
        try {
          upstream = await this.gitUpstreamRef() || upstream;
          outgoing = Number((await this.runGit(["rev-list", "--count", `${upstream}..HEAD`])).stdout) || 0;
          pushedCommits = outgoing;
          if (outgoing) pushedFiles = summarizeGitNameStatus((await this.runGit(["diff", "--name-status", "--find-renames", `${upstream}...HEAD`])).stdout).files;
          await this.runGit(["push", "origin", "HEAD"]);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= 2 || !/non-fast-forward|non fast forward|fetch first/i.test(message)) throw error;
          await this.runGit(["fetch", "--prune", "origin"]);
          upstream = await this.gitUpstreamRef() || upstream;
          const newlyIncoming = Number((await this.runGit(["rev-list", "--count", `HEAD..${upstream}`])).stdout) || 0;
          if (!newlyIncoming) continue;
          incoming += newlyIncoming;
          await this.mergeUpstreamSafely(upstream);
        }
      }
    }

    upstream = await this.gitUpstreamRef() || upstream;
    outgoing = Number((await this.runGit(["rev-list", "--count", `${upstream}..HEAD`])).stdout) || 0;

    await this.updateGitStatus();
    return { checkpoint, incoming, outgoing, pulledFiles, pushedFiles, pushedCommits };
  }

  async pullGit(quiet = false) {
    try {
      const result = await this.reconcileGitHistory(false);
      const report = `${result.checkpoint ? `Local edits checkpointed. ` : ""}${result.incoming
        ? `Merged ${result.pulledFiles} remote file change${result.pulledFiles === 1 ? "" : "s"} across ${result.incoming} commit${result.incoming === 1 ? "" : "s"}.`
        : `GitHub is up to date · 0 files pulled.`}${result.outgoing ? ` · ${result.outgoing} local commit${result.outgoing === 1 ? "" : "s"} remain to push` : ""}`;
      await this.recordSyncActivity("Git pull", true, report);
      if (!quiet) new Notice(report, 10_000);
      return { action: "pull", report, files: result.pulledFiles, commits: result.incoming };
    } catch (error) {
      await this.recordSyncActivity("Git pull", false, error instanceof Error ? error.message : "Git pull failed.");
      throw error;
    }
  }

  private async updateGitStatus() {
    const status = await this.gitStatusText();
    this.gitStatusSummary = status.length > 700 ? `${status.slice(0, 700)}…` : status;
    await this.saveSettings();
  }

  async commitGit(quiet = false) {
    try {
      if (!this.settings.gitRemote) throw new Error("Connect a GitHub repository first.");
      const message = this.gitCommitMessage.trim() || this.defaultGitCommitMessage();
      this.gitCommitMessage = message;
      await this.runGit(["add", "-A"]);
      const staged = await this.runGit(["diff", "--cached", "--name-status", "--find-renames"]);
      if (!staged.stdout) throw new Error("There are no changes to commit.");
      const changed = summarizeGitNameStatus(staged.stdout);
      await this.runGit(["commit", "-m", message]);
      await this.updateGitStatus();
      const report = `Committed locally · ${changed.detail}\n${message}`;
      await this.recordSyncActivity("Git commit", true, report);
      this.gitCommitMessage = "";
      if (!quiet) new Notice(report, 10_000);
      return { action: "commit", files: changed.files, report };
    } catch (error) {
      await this.recordSyncActivity("Git commit", false, error instanceof Error ? error.message : "Git commit failed.");
      throw error;
    }
  }

  async pushGit(quiet = false) {
    try {
      const result = await this.reconcileGitHistory(true);
      const report = `${result.checkpoint ? "Local edits checkpointed · " : ""}${result.incoming ? `merged ${result.incoming} GitHub commit${result.incoming === 1 ? "" : "s"} · ` : ""}${result.pushedCommits || result.checkpoint ? `pushed ${result.pushedFiles} changed file${result.pushedFiles === 1 ? "" : "s"} across ${result.pushedCommits} commit${result.pushedCommits === 1 ? "" : "s"}` : "GitHub is up to date · 0 files pushed"}.`;
      await this.recordSyncActivity("Git push", true, report);
      if (!quiet) new Notice(report, 10_000);
      return { action: "push", files: result.pushedFiles, commits: result.outgoing, report };
    } catch (error) {
      await this.recordSyncActivity("Git push", false, error instanceof Error ? error.message : "Git push failed.");
      throw error;
    }
  }

  async commitAndPushGit(message = "", quiet = false) {
    try {
      if (message.trim()) this.gitCommitMessage = message.trim();
      const result = await this.reconcileGitHistory(true);
      const report = `${result.checkpoint ? "Local edits checkpointed · " : ""}${result.incoming ? `merged ${result.incoming} GitHub commit${result.incoming === 1 ? "" : "s"} · ` : ""}${result.pushedCommits || result.checkpoint ? `pushed ${result.pushedFiles} changed file${result.pushedFiles === 1 ? "" : "s"} across ${result.pushedCommits} commit${result.pushedCommits === 1 ? "" : "s"}` : "GitHub is up to date · no local commit needed"}.`;
      await this.recordSyncActivity("Git sync", true, report);
      if (!quiet) new Notice(report, 10_000);
      return { action: "sync", files: result.pushedFiles, report };
    } catch (error) {
      await this.recordSyncActivity("Git sync", false, error instanceof Error ? error.message : "Git sync failed.");
      throw error;
    }
  }

  getCloudBackupFolders() { return [...this.settings.cloudBackupFolders]; }
  getCloudBackupIncludeSubfolders() { return this.settings.cloudBackupIncludeSubfolders; }
  configureCloudBackupScope(folders: string[], includeSubfolders: boolean) {
    this.settings.cloudBackupFolders = folders;
    this.settings.cloudBackupIncludeSubfolders = includeSubfolders;
    return this.saveSettings();
  }

  cloudBackupDescription() {
    const selected = this.settings.cloudBackupFolders.includes("*") ? "All folders" : `${this.settings.cloudBackupFolders.length} selected folders`;
    return `${selected}${this.settings.cloudBackupIncludeSubfolders ? " and subfolders" : " only"}. Private Supabase storage through the Gateway; 7-day retention. Standard accounts have a 50 MB rolling vault limit; the verified owner account has no app-level rolling cap. Large folders can be excluded.`;
  }

  openSupabaseSetupGuide() { new SupabaseSetupModal(this.app).open(); }

  private async gatewaySessionToken() {
    const candidates = [...new Set([this.agentExtensionDir, this.settings.appDataPath, this.findAgentDataPath()].filter(Boolean))];
    for (const appData of candidates) {
      try {
        const config = JSON.parse(await readFile(join(appData, ".pi", "agent", "models.json"), "utf8"));
        const token = config?.providers?.["expert-ai-gateway"]?.apiKey;
        if (typeof token === "string" && token.length > 20) return token;
      } catch { /* Try the other known Expert AI data directory. */ }
    }
    throw new Error("Sign in to Expert AI Agent on this computer, then restart its Agent server before using cloud backup.");
  }

  private async callCloudBackup(method: "GET" | "POST", body?: ArrayBuffer, headers: Record<string, string> = {}, route = "") {
    const token = await this.gatewaySessionToken();
    const response = await requestUrl({
      url: `${GATEWAY_API_URL}/v1/vault/backups${route}?vaultId=${encodeURIComponent(this.vaultId)}`,
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...headers },
      ...(body ? { body } : {}),
      throw: false,
    });
    let payload: Record<string, unknown> = {};
    try { payload = response.json as Record<string, unknown>; } catch { /* use the HTTP status below */ }
    if (response.status < 200 || response.status >= 300) throw new Error(typeof payload.error === "string" ? payload.error : `Cloud backup service returned HTTP ${response.status}.`);
    return payload;
  }

  async listCloudBackups() {
    return this.callCloudBackup("GET");
  }

  async openCloudRestore(snapshot: CloudBackupSnapshot) {
    this.setFooterStatus("Downloading cloud backup for review…");
    try {
      const token = await this.gatewaySessionToken();
      const response = await requestUrl({
        url: `${GATEWAY_API_URL}/v1/vault/backups/download?vaultId=${encodeURIComponent(this.vaultId)}&snapshotId=${encodeURIComponent(snapshot.id)}`,
        method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/gzip" }, throw: false,
      });
      if (response.status < 200 || response.status >= 300) {
        let detail = "";
        try { detail = JSON.parse(response.text).error || ""; } catch { detail = response.text; }
        throw new Error(detail || `Cloud backup download failed (${response.status}).`);
      }
      const compressed = Buffer.from(response.arrayBuffer);
      const checksum = createHash("sha256").update(compressed).digest("hex");
      if (snapshot.sha256 && checksum !== snapshot.sha256) throw new Error("The downloaded cloud backup did not match its saved SHA-256 checksum.");
      if (!snapshot.sha256 && snapshot.id.slice(-12) !== checksum.slice(0, 12)) throw new Error("The downloaded legacy backup did not match its saved checksum prefix.");
      const archiveBytes = gunzipSync(compressed, { maxOutputLength: 350 * 1024 * 1024 });
      const archive = JSON.parse(archiveBytes.toString("utf8")) as { format?: string; files?: CloudBackupFile[] };
      if (archive.format !== "expert-ai-vault-backup-v1" || !Array.isArray(archive.files) || archive.files.length > 30_000)
        throw new Error("This cloud backup has an unsupported or invalid archive format.");
      let totalFileBytes = 0;
      const seen = new Set<string>();
      const candidates: CloudRestoreCandidate[] = [];
      for (let index = 0; index < archive.files.length; index++) {
        const file = archive.files[index];
        if (!file || !this.isSafeCloudRestorePath(file.path) || seen.has(file.path)
          || !Number.isSafeInteger(file.size) || file.size < 0
          || typeof file.contentBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64))
          throw new Error(`The backup contains an invalid or unsafe path at item ${index + 1}.`);
        seen.add(file.path);
        totalFileBytes += file.size;
        if (totalFileBytes > 250 * 1024 * 1024) throw new Error("The backup expands beyond the 250 MB restore safety limit.");
        const remoteBytes = Buffer.from(file.contentBase64, "base64");
        if (remoteBytes.byteLength !== file.size) throw new Error(`The saved size does not match ${file.path}.`);
        const existing = this.app.vault.getAbstractFileByPath(file.path);
        if (!existing) {
          candidates.push({ file, status: this.hasCloudRestorePathBlocker(file.path) ? "blocked" : "add" });
        } else if (existing instanceof TFile) {
          const local = Buffer.from(await this.app.vault.readBinary(existing));
          candidates.push({ file, status: local.equals(remoteBytes) ? "same" : "replace", localHash: createHash("sha256").update(local).digest("hex") });
        } else candidates.push({ file, status: "blocked" });
        if ((index + 1) % 100 === 0) this.setFooterStatus(`Comparing backup with vault · ${index + 1}/${archive.files.length} files…`);
      }
      const safeSnapshot: CloudBackupSnapshot = { ...snapshot, files: candidates.length };
      await this.recordSyncActivity("Cloud restore review", true, `Loaded ${candidates.length} files · ${candidates.filter((item) => item.status === "add").length} missing · ${candidates.filter((item) => item.status === "replace").length} changed · no files changed.`);
      this.setFooterStatus("Cloud backup ready for review");
      new CloudRestoreReviewModal(this.app, this, safeSnapshot, candidates).open();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not prepare this cloud backup for restore.";
      this.setFooterStatus("Cloud restore review failed");
      await this.recordSyncActivity("Cloud restore review", false, detail);
      new Notice(detail, 12_000);
    }
  }

  private isSafeCloudRestorePath(path: string) {
    if (!path || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) return false;
    return ![".obsidian", ".git", ".trash", ".expert-ai-recovery"].includes(parts[0].toLowerCase());
  }

  private hasCloudRestorePathBlocker(path: string) {
    const parts = path.split("/");
    let parent = "";
    for (const part of parts.slice(0, -1)) {
      parent = parent ? `${parent}/${part}` : part;
      const item = this.app.vault.getAbstractFileByPath(parent);
      if (item && !(item instanceof TFolder)) return true;
    }
    return false;
  }

  async applyCloudRestore(snapshot: CloudBackupSnapshot, candidates: CloudRestoreCandidate[], replaceExisting: boolean) {
    let added = 0; let replaced = 0; let preserved = 0; let skipped = 0;
    const eligible = candidates.filter((item) => item.status === "add" || replaceExisting && item.status === "replace");
    for (let index = 0; index < eligible.length; index++) {
      const candidate = eligible[index];
      const path = candidate.file.path;
      try {
        const current = this.app.vault.getAbstractFileByPath(path);
        if (candidate.status === "add" && current) { skipped++; continue; }
        if (candidate.status === "replace" && (!(current instanceof TFile) || !candidate.localHash
          || createHash("sha256").update(Buffer.from(await this.app.vault.readBinary(current))).digest("hex") !== candidate.localHash)) { skipped++; continue; }
        if (this.hasCloudRestorePathBlocker(path)) { skipped++; continue; }
        const bytes = Buffer.from(candidate.file.contentBase64, "base64");
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        if (candidate.status === "replace" && current instanceof TFile) {
          let savedPath = `.expert-ai-recovery/Before-cloud-restore/${snapshot.id}/${path}`;
          if (this.app.vault.getAbstractFileByPath(savedPath)) savedPath = `${savedPath}.${randomBytes(4).toString("hex")}`;
          await this.ensureParent(savedPath);
          const previous = await this.app.vault.readBinary(current);
          await this.app.vault.createBinary(savedPath, previous);
          await this.app.vault.modifyBinary(current, arrayBuffer);
          replaced++; preserved++;
        } else {
          await this.ensureParent(path);
          await this.app.vault.createBinary(path, arrayBuffer);
          added++;
        }
      } catch { skipped++; }
      if ((index + 1) % 50 === 0 || index + 1 === eligible.length) this.setFooterStatus(`Restoring cloud backup · ${index + 1}/${eligible.length} files…`);
    }
    const report = `Restored ${added + replaced} files · ${added} added · ${replaced} replaced · ${preserved} current versions copied to .expert-ai-recovery · ${skipped} skipped.`;
    await this.recordSyncActivity("Cloud restore", true, report);
    this.setFooterStatus("Cloud restore complete");
    this.refreshOpenView();
    this.refreshOpenSyncView();
    return { added, replaced, preserved, skipped, report };
  }

  private isInCloudBackupScope(path: string) {
    const normalized = path.replace(/\\/g, "/");
    const lower = normalized.toLowerCase();
    if (lower.startsWith(".obsidian/") || lower === ".obsidian" || lower.startsWith(".git/") || lower === ".git" || lower.startsWith(".trash/") || lower === ".trash" || lower.startsWith(".expert-ai-recovery/")) return false;
    const selected = this.settings.cloudBackupFolders;
    if (selected.includes("*")) return true;
    const parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    return selected.some((folder) => parent === folder || this.settings.cloudBackupIncludeSubfolders && parent.startsWith(`${folder}/`));
  }

  async backupVault(explicitRequest = false) {
    try {
      const result = await this.createVaultBackup(explicitRequest);
      await this.recordSyncActivity("Cloud backup", true, `${result.skipped ? "Snapshot already saved" : "Snapshot saved"} · ${result.files} files · ${result.parts} verified chunks · ${result.bytesLabel} · retained for 7 days.`);
      return result;
    } catch (error) {
      await this.recordSyncActivity("Cloud backup", false, error instanceof Error ? error.message : "Cloud backup failed.");
      throw error;
    }
  }

  private async createVaultBackup(explicitRequest = false) {
    if (!this.settings.cloudBackupEnabled && !explicitRequest) throw new Error("Enable cloud backup in Expert AI settings before sending vault files to cloud storage.");
    if (!this.settings.cloudBackupEnabled && explicitRequest) { this.settings.cloudBackupEnabled = true; await this.saveSettings(); }
    const files = this.app.vault.getFiles().filter((file) => this.isInCloudBackupScope(file.path));
    if (!files.length) throw new Error("No files are inside the selected backup folders.");
    const rawSize = files.reduce((sum, file) => sum + file.stat.size, 0);
    if (rawSize > 250 * 1024 * 1024) throw new Error("The selected folders exceed the 250 MB preparation limit for a single snapshot. Exclude large folders and try again.");
    const chunkBytes = 4 * 1024 * 1024;
    const snapshotId = `${String(Date.now()).padStart(13, "0")}-${randomBytes(6).toString("hex")}`;
    const checksum = createHash("sha256");
    const partHashes: string[] = [];
    let totalBytes = 0;
    let uploadedParts = 0;
    const abortUpload = async () => {
      const abortBody = Buffer.from(JSON.stringify({ snapshotId }), "utf8");
      const abortArrayBuffer = abortBody.buffer.slice(abortBody.byteOffset, abortBody.byteOffset + abortBody.byteLength) as ArrayBuffer;
      await this.callCloudBackup("POST", abortArrayBuffer, { "content-type": "application/json" }, "/abort").catch(() => {});
    };
    const uploadPart = async (chunk: Buffer) => {
      if (!chunk.byteLength) return;
      if (totalBytes + chunk.byteLength > 350 * 1024 * 1024) throw new Error("This backup exceeds the 350 MB compressed preparation limit. Exclude large folders and retry.");
      const partHash = createHash("sha256").update(chunk).digest("hex");
      checksum.update(chunk);
      partHashes.push(partHash);
      totalBytes += chunk.byteLength;
      const body = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      await this.callCloudBackup("POST", body, {
        "content-type": "application/octet-stream",
        "x-snapshot-id": snapshotId,
        "x-snapshot-part-index": String(uploadedParts),
        "x-part-sha256": partHash,
      }, "/part");
      uploadedParts++;
      this.setFooterStatus(`Uploading private backup · ${uploadedParts} chunks · ${this.formatBytes(totalBytes)} sent…`);
    };
    const metadata = JSON.stringify({
      format: "expert-ai-vault-backup-v1",
      vault: this.app.vault.getName(),
      selectedFolders: this.settings.cloudBackupFolders,
      includeSubfolders: this.settings.cloudBackupIncludeSubfolders,
    });
    const plugin = this;
    async function* archiveJson() {
      yield Buffer.from(`${metadata.slice(0, -1)},"files":[`, "utf8");
      let first = true;
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const binary = await plugin.app.vault.readBinary(file);
        const entry = JSON.stringify({ path: file.path, size: binary.byteLength, modifiedAt: file.stat.mtime, contentBase64: Buffer.from(binary).toString("base64") });
        yield Buffer.from(`${first ? "" : ","}${entry}`, "utf8");
        first = false;
        if ((index + 1) % 100 === 0) plugin.setFooterStatus(`Preparing backup · ${index + 1}/${files.length} files…`);
      }
      yield Buffer.from("]}", "utf8");
    }
    const source = Readable.from(archiveJson());
    const gzip = createGzip({ level: 3 });
    const streamDone = pipeline(source, gzip);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    this.setFooterStatus(`Preparing a backup of ${files.length.toLocaleString()} files…`);
    try {
      for await (const output of gzip) {
        const buffer = Buffer.from(output);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const take = Math.min(chunkBytes - pendingBytes, buffer.byteLength - offset);
          pending.push(buffer.subarray(offset, offset + take));
          pendingBytes += take;
          offset += take;
          if (pendingBytes === chunkBytes) {
            await uploadPart(Buffer.concat(pending, pendingBytes));
            pending = [];
            pendingBytes = 0;
          }
        }
      }
      await streamDone;
      if (pendingBytes) await uploadPart(Buffer.concat(pending, pendingBytes));
    } catch (error) {
      source.destroy();
      gzip.destroy();
      await streamDone.catch(() => {});
      await abortUpload();
      throw error;
    }
    if (!uploadedParts) { await abortUpload(); throw new Error("The selected folders did not produce a backup archive."); }
    const hash = checksum.digest("hex");
    const manifest = {
      snapshotId, sha256: hash, bytes: totalBytes, parts: uploadedParts, partHashes,
      files: files.length, vault: this.app.vault.getName(),
      selectedFolders: this.settings.cloudBackupFolders,
      includeSubfolders: this.settings.cloudBackupIncludeSubfolders,
    };
    const manifestBody = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestArrayBuffer = manifestBody.buffer.slice(manifestBody.byteOffset, manifestBody.byteOffset + manifestBody.byteLength) as ArrayBuffer;
    let result: Record<string, unknown>;
    try {
      result = await this.callCloudBackup("POST", manifestArrayBuffer, { "content-type": "application/json" }, "/finalize");
    } catch (error) {
      await abortUpload();
      throw error;
    }
    this.setFooterStatus("Cloud backup saved · kept for 7 days");
    return { ...result, files: files.length, parts: uploadedParts, skipped: result.skipped === true, bytesLabel: this.formatBytes(Number(result.bytes) || totalBytes) };
  }

  formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  getArchiveFolder() { return this.settings.archiveFolder || "AI Archive"; }
  isLocalIndexEnabled() { return this.settings.localIndexEnabled; }
  isIndexing() { return this.indexState.indexing; }
  getIndexFolders() { return [...this.settings.localIndexFolders]; }
  getIndexIncludeSubfolders() { return this.settings.localIndexIncludeSubfolders; }
  getSemanticIncludeSubfolders() { return this.settings.semanticIncludeSubfolders; }
  openIndexSetup() { new SemanticScopeModal(this.app, this, "index").open(); }

  localIndexDescription() {
    if (!this.settings.localIndexEnabled) {
      if (this.settings.localIndexFolders.length) {
        const saved = this.settings.localIndexFolders.includes("*") ? "all folders" : `${this.settings.localIndexFolders.length} saved folders`;
        return `Paused for ${saved}. Your scope is saved and no notes are being scanned. Choose Start local search to resume the local Markdown index; it helps the Agent find relevant passages faster without sending the whole vault.`;
      }
      return "Off by default, so enabling the plugin never scans your vault. Choose folders to prepare a local Markdown keyword index. On mobile, it can find repeated topics faster and give the model a few relevant passages instead of broad file searches.";
    }
    const scope = this.settings.localIndexFolders.includes("*") ? "all folders" : this.settings.localIndexFolders.join(", ");
    return `Local keyword search is on for ${scope || "no folders"}${this.settings.localIndexIncludeSubfolders ? " and their subfolders" : " only"}. Only selected Markdown notes are indexed; new edits are added incrementally. Pause it any time.`;
  }

  private refreshOpenView() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) void (leaf.view as CompanionView).render(); }
  private refreshOpenSyncView() { for (const leaf of this.app.workspace.getLeavesOfType(SYNC_VIEW_TYPE)) void (leaf.view as SyncView).render(); }
  private refreshOpenChat() { for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) void (leaf.view as AgentChatView).refresh(); }
  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  async activateSyncView() {
    let leaf = this.app.workspace.getLeavesOfType(SYNC_VIEW_TYPE)[0];
    if (!leaf) leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: SYNC_VIEW_TYPE, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  async openChat(entryId = "") {
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view as AgentChatView;
    const selected = entryId ? await this.localStore.getHistoryEntry(entryId) : undefined;
    view.selectTask(selected?.sessionId || entryId || this.activeAgentSessionId);
    await view.render();
  }

  async getTaskActivities() {
    return (await this.localStore.getHistory(60)).filter((entry) => entry.action === "task_checkpoint" && !!entry.request);
  }

  async getFileVersions(path: string) {
    const normalized = normalizeVaultPath(path);
    const all = await this.localStore.getHistory(500);
    const aliases = this.getPathAliases(normalized, all);
    const entries = all.filter((entry) => aliases.has(entry.path) || !!entry.nextPath && aliases.has(entry.nextPath))
      .filter((entry) => entry.action !== "task_checkpoint").sort((a, b) => a.createdAt - b.createdAt);
    const versions: Array<{ id: string; label: string; text: string; current: boolean }> = [];
    for (const entry of entries) {
      const versionPath = entry.nextPath || entry.path;
      if (typeof entry.before === "string") versions.push({ id: `${entry.id}:before`, label: `Before · ${versionPath} · ${new Date(entry.createdAt).toLocaleString()}`, text: entry.before, current: false });
      if (typeof entry.after === "string") versions.push({ id: `${entry.id}:after`, label: `After · ${versionPath} · ${new Date(entry.createdAt).toLocaleString()}`, text: entry.after, current: false });
    }
    const currentPath = this.findCurrentPath(normalized, all);
    const file = this.app.vault.getAbstractFileByPath(currentPath);
    if (file instanceof TFile) versions.push({ id: "live", label: `Current · ${currentPath}`, text: await this.fullText(file), current: true });
    return versions.filter((version, index) => index === 0 || version.text !== versions[index - 1].text);
  }

  async restoreSelectedVersion(path: string, text: string, expectedCurrent?: string) {
    return this.queueMutation(async () => {
      if (!this.settings.agentWritesEnabled) throw new Error("Vault writes are disabled in Expert AI settings.");
      const normalized = normalizeVaultPath(path);
      if (!isMarkdownPath(normalized)) throw new Error("Only Markdown notes can be restored here.");
      const currentPath = this.findCurrentPath(normalized, await this.localStore.getHistory(500));
      const file = this.app.vault.getAbstractFileByPath(currentPath);
      if (!(file instanceof TFile)) throw new Error("The note is missing; restore its original create or delete operation from the activity list.");
      const before = await this.fullText(file);
      if (expectedCurrent !== undefined && before !== expectedCurrent) throw new Error("The note changed after this comparison opened. Reopen Compare versions and review the newer file before restoring.");
      if (before === text) return;
      await this.applyUpdatedText(file, before, text);
      if (this.settings.localIndexEnabled) await this.indexer.indexFile(file);
      await this.localStore.putSnapshot({ path: currentPath, text, updatedAt: Date.now() });
      await this.record({ id: crypto.randomUUID(), createdAt: Date.now(), action: "restore", path: currentPath, request: "Restored selected saved version", before, after: text, taskId: this.activeTaskId || undefined });
    });
  }

  private getPathAliases(path: string, history: HistoryEntry[]) {
    const aliases = new Set([path]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of history) {
        if (!entry.nextPath || !["move", "rename"].includes(entry.action) && entry.action !== "restore") continue;
        for (const alias of [...aliases]) {
          if (alias === entry.path || alias.startsWith(`${entry.path}/`)) {
            const mapped = `${entry.nextPath}${alias.slice(entry.path.length)}`;
            if (!aliases.has(mapped)) { aliases.add(mapped); changed = true; }
          }
          if (alias === entry.nextPath || alias.startsWith(`${entry.nextPath}/`)) {
            const mapped = `${entry.path}${alias.slice(entry.nextPath.length)}`;
            if (!aliases.has(mapped)) { aliases.add(mapped); changed = true; }
          }
        }
      }
    }
    return aliases;
  }

  private findCurrentPath(path: string, history: HistoryEntry[]) {
    let candidate = path;
    const moves = history.filter((entry) => entry.nextPath && (["move", "rename"].includes(entry.action) || entry.action === "restore")).sort((a, b) => a.createdAt - b.createdAt);
    for (const move of moves) {
      if (!move.nextPath) continue;
      if (candidate === move.path || candidate.startsWith(`${move.path}/`)) candidate = `${move.nextPath}${candidate.slice(move.path.length)}`;
    }
    if (this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    const aliases = [...this.getPathAliases(path, history)].reverse();
    return aliases.find((alias) => this.app.vault.getAbstractFileByPath(alias)) || candidate;
  }

  async openHistoryPath(historyId: string) {
    const entry = await this.localStore.getHistoryEntry(historyId);
    if (!entry) return;
    const history = await this.localStore.getHistory(500);
    await this.openVaultPath(this.findCurrentPath(entry.nextPath || entry.path, history));
  }

  async getTaskFileChanges(taskId: string) {
    return (await this.localStore.getHistory(500)).filter((entry) => entry.taskId === taskId && entry.action !== "task_checkpoint");
  }

  async sendChatMessage(entryId: string, text: string) {
    const message = text.trim().slice(0, 20_000);
    if (!message) throw new Error("Write a message before sending.");
    const entries = (await this.localStore.getHistory(100)).filter((entry) => entry.action === "task_checkpoint" && entry.sessionId === entryId).sort((a, b) => b.createdAt - a.createdAt);
    if (this.activeAgentSessionId !== entryId) throw new Error("Open this conversation in Expert AI Agent to continue it here.");
    const queued: NonNullable<HistoryEntry["pendingMessages"]>[number] = { id: crypto.randomUUID(), text: message, status: "queued" };
    const entry = entries[0];
    if (!entry) {
      const now = Date.now();
      await this.localStore.addHistory({
        id: crypto.randomUUID(), createdAt: now, action: "task_checkpoint", path: "", request: message.slice(0, 700),
        sessionId: entryId, taskStatus: "running", updatedAt: now,
        messages: [{ role: "user", text: message, updatedAt: now }], traceEvents: [], pendingMessages: [queued],
      }, this.settings.retentionDays);
      this.refreshOpenView(); this.refreshOpenChat();
      return;
    }
    await this.localStore.updateHistory(entry.id, (current) => ({
      ...current,
      taskStatus: "running",
      updatedAt: Date.now(),
      messages: [...(current.messages || [{ role: "user" as const, text: current.request || "", updatedAt: current.createdAt }]), { role: "user" as const, text: message, updatedAt: Date.now() }].slice(-40),
      pendingMessages: [...(current.pendingMessages || []), queued].slice(-10),
    }));
    this.refreshOpenChat();
  }

  getWorkspaceSnapshot() {
    const groups = new Map<object, { window: number; pane: number }>();
    const tabCounts = new Map<object, number>();
    const windows = new Map<object, number>();
    const openFiles: Array<{ path: string; active: boolean; window: number; pane: number; tab: number; mode?: string; cursorLine?: number }> = [];
    const activeFile = this.app.workspace.getActiveFile()?.path || "";
    this.app.workspace.iterateAllLeaves((leaf) => {
      const viewState = leaf.getViewState();
      const view = leaf.view as typeof leaf.view & { file?: TAbstractFile };
      const savedPath = typeof viewState.state?.file === "string" ? viewState.state.file : "";
      const file = view.file instanceof TFile ? view.file : savedPath ? this.app.vault.getAbstractFileByPath(savedPath) : null;
      if (!(file instanceof TFile)) return;
      const parent = leaf.parent as object;
      let group = groups.get(parent);
      if (!group) {
        const root = leaf.getRoot() as object;
        let window = windows.get(root);
        if (!window) { window = windows.size + 1; windows.set(root, window); }
        group = { window, pane: [...groups.values()].filter((item) => item.window === window).length + 1 };
        groups.set(parent, group);
      }
      const tab = (tabCounts.get(parent) || 0) + 1; tabCounts.set(parent, tab);
      const markdown = view instanceof MarkdownView ? view : null;
      const cursor = leaf === this.app.workspace.activeLeaf && markdown ? markdown.editor.getCursor() : null;
      openFiles.push({ path: file.path, active: leaf === this.app.workspace.activeLeaf || (!this.app.workspace.activeLeaf && file.path === activeFile), window: group.window, pane: group.pane, tab,
        ...(markdown ? { mode: markdown.getMode() } : {}), ...(cursor ? { cursorLine: cursor.line + 1 } : {}) });
    });
    if (!openFiles.some((item) => item.active) && activeFile) {
      const active = openFiles.find((item) => item.path === activeFile);
      if (active) active.active = true;
    }
    const activePath = openFiles.find((item) => item.active)?.path || activeFile;
    return { activePath, openFileCount: openFiles.length, paneCount: groups.size, openFiles: openFiles.slice(0, 40), omitted: Math.max(0, openFiles.length - 40) };
  }

  private refreshWorkspaceViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof CompanionView) leaf.view.updateWorkspace();
    }
  }

  focusWorkspaceFile(path: string) {
    let target: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (target) return;
      const state = leaf.getViewState();
      const view = leaf.view as typeof leaf.view & { file?: TAbstractFile };
      const openPath = view.file instanceof TFile ? view.file.path : typeof state.state?.file === "string" ? state.state.file : "";
      if (openPath === path) target = leaf;
    });
    if (target) this.app.workspace.setActiveLeaf(target, { focus: true });
    else void this.openVaultPath(path);
  }

  liveStatus() { return { listening: !!this.bridge?.listening, port: this.bridgePort, agentLastSeen: this.agentLastSeen || null, agentSessionId: this.activeAgentSessionId || null }; }
  async statusSummary() {
    const stats = await this.localStore.stats();
    return { ...stats, ...this.indexState, semantic: !!this.embedder, agentConnected: !!this.agentLastSeen && Date.now() - this.agentLastSeen < 90_000 };
  }

  private semanticRuntimePaths() {
    const pluginDir = this.manifest.dir || join(this.app.vault.configDir, "plugins", PLUGIN_ID);
    return {
      mjs: this.app.vault.adapter.getResourcePath(`${pluginDir}/ort-wasm-simd-threaded.asyncify.mjs`),
      wasm: this.app.vault.adapter.getResourcePath(`${pluginDir}/ort-wasm-simd-threaded.asyncify.wasm`),
    };
  }
  async getVisibleHistory() {
    const entries = await this.localStore.getHistory(500);
    const files = entries.filter((entry) => entry.action !== "task_checkpoint");
    const tasks = entries.filter((entry) => entry.action === "task_checkpoint" && !!entry.request).slice(0, 18);
    return [...files.slice(0, 60), ...tasks];
  }

  async refreshIndex() {
    if (!this.settings.localIndexEnabled) return { scanned: 0, changed: 0, removed: 0 };
    return this.runIndexSync(false);
  }

  async enableLocalIndex() {
    if (!this.settings.localIndexFolders.length) { this.openIndexSetup(); return; }
    this.settings.localIndexEnabled = true;
    this.indexer.setIndexFolders(this.settings.localIndexFolders, this.settings.localIndexIncludeSubfolders);
    this.indexer.setSemanticFolders(this.settings.semanticFolders, this.settings.semanticIncludeSubfolders);
    await this.saveSettings();
    this.setFooterStatus("Starting local search for your saved folders…");
    try {
      const result = await this.refreshIndex();
      new Notice(result.changed
        ? `Local search is ready · ${result.changed} notes prepared.`
        : "Local search is ready · your saved index is already up to date.");
    } catch (error) { new Notice(error instanceof Error ? error.message : "Local search could not start.", 10_000); }
    this.refreshOpenView();
  }

  async configureLocalIndex(folders: string[], includeSubfolders = true) {
    if (this.indexSync) { this.indexer.stop(); await this.indexSync; }
    this.settings.localIndexFolders = folders;
    this.settings.localIndexIncludeSubfolders = includeSubfolders;
    this.settings.localIndexEnabled = true;
    this.indexer.setIndexFolders(folders, includeSubfolders);
    this.indexer.setSemanticFolders(this.settings.semanticFolders, this.settings.semanticIncludeSubfolders);
    await this.saveSettings();
    this.setFooterStatus("Preparing selected folders for fast local search…");
    try {
      const result = await this.refreshIndex();
      new Notice(`Local search is ready · ${result.changed} notes prepared in ${folders.includes("*") ? "the whole vault" : `${folders.length} selected folders`}.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Local search setup failed.");
    }
    this.refreshOpenView();
  }

  async disableLocalIndex() {
    this.semanticGeneration++;
    this.indexer.stop();
    this.settings.localIndexEnabled = false;
    if (this.settings.semanticEnabled) {
      this.settings.semanticEnabled = false;
      this.embedder = null;
      this.indexer.setEmbedder(null);
    }
    await this.saveSettings();
    this.setFooterStatus("Background indexing paused; Agent file search is ready on demand.");
    this.refreshOpenView();
  }

  getSemanticFolders() { return [...this.settings.semanticFolders]; }

  semanticSearchDescription() {
    if (!this.settings.semanticEnabled) return "Meaning search can find notes about a similar idea when wording differs. It requires an optional local index and stays off until you choose folders. First setup downloads a small model and prepares only those notes locally in the background.";
    const scope = this.settings.semanticFolders.includes("*") ? "all folders" : this.settings.semanticFolders.join(", ");
    return `Meaning search is on for ${scope || "no folders"}. Only selected notes receive local embeddings. Change the folder scope here; future edits in those folders are embedded incrementally.`;
  }

  private async runIndexSync(forceAfterCurrent: boolean): Promise<{ scanned: number; changed: number; removed: number }> {
    if (this.indexSync) {
      if (forceAfterCurrent) this.indexAgain = true;
      return this.indexSync;
    }
    const task = (async () => {
      let result = { scanned: 0, changed: 0, removed: 0 };
      do {
        this.indexAgain = false;
        this.indexState = { indexing: true, indexed: 0, total: 0, currentPath: "", phase: "scanning" };
        result = await this.indexer.sync();
      } while (this.indexAgain);
      return result;
    })();
    this.indexSync = task;
    try { return await task; }
    finally { if (this.indexSync === task) this.indexSync = null; }
  }

  private updateOpenViewIndex(state: IndexProgress) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as CompanionView).updateIndexProgress(state);
  }

  private setSemanticStatus(text: string) {
    this.semanticStatusText = text;
    this.setFooterStatus(text);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as CompanionView).updateSemanticStatus(text);
  }

  private refreshAgentConnectionView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as CompanionView).updateConnection();
  }

  private async loadSemanticSearchInBackground() {
    const generation = ++this.semanticGeneration;
    this.setSemanticStatus("Loading local semantic model; keyword search remains available.");
    try {
      this.embedder = await loadLocalEmbedder((message) => this.setSemanticStatus(message), this.semanticRuntimePaths());
      if (generation !== this.semanticGeneration || !this.settings.localIndexEnabled) return;
      this.indexer.setEmbedder(this.embedder.embedBatch);
      await this.runIndexSync(true);
      this.setSemanticStatus("Local semantic search is ready.");
      this.refreshOpenView();
    } catch (error) {
      if (generation !== this.semanticGeneration) return;
      console.error("[Expert AI] semantic model failed to load", error);
      this.embedder = null;
      this.indexer.setEmbedder(null);
      this.settings.semanticEnabled = false;
      await this.saveSettings();
      this.setSemanticStatus("Semantic model unavailable; local keyword search remains ready.");
      new Notice("Local semantic search could not start. Keyword search is still available.");
    }
  }

  async configureSemanticSearch(folders: string[], includeSubfolders = true) {
    if (this.indexSync) { this.indexer.stop(); await this.indexSync; }
    const generation = ++this.semanticGeneration;
    this.settings.semanticFolders = folders;
    this.settings.semanticIncludeSubfolders = includeSubfolders;
    this.settings.localIndexFolders = folders;
    this.settings.localIndexIncludeSubfolders = includeSubfolders;
    this.settings.localIndexEnabled = true;
    this.indexer.setSemanticFolders(folders, includeSubfolders);
    this.indexer.setIndexFolders(folders, includeSubfolders);
    this.setSemanticStatus("Preparing local meaning search…");
    try {
      this.embedder = await loadLocalEmbedder((message) => this.setSemanticStatus(message), this.semanticRuntimePaths());
      if (generation !== this.semanticGeneration) return;
      this.indexer.setEmbedder(this.embedder.embedBatch);
      this.settings.semanticEnabled = true;
      await this.saveSettings();
      const result = await this.runIndexSync(true);
      this.setSemanticStatus(`Meaning search ready · ${result.changed} notes prepared`);
      new Notice(`Meaning search is ready for ${folders.includes("*") ? "the whole vault" : `${folders.length} selected folders`}.`);
    } catch (error) {
      if (generation !== this.semanticGeneration) return;
      this.embedder = null;
      this.indexer.setEmbedder(null);
      this.settings.semanticEnabled = false;
      await this.saveSettings();
      this.setSemanticStatus("Meaning search unavailable; keyword search remains ready.");
      new Notice(error instanceof Error ? `Meaning search could not start: ${error.message}` : "Meaning search could not start. Keyword search is still available.", 10_000);
    }
    this.refreshOpenView();
  }

  async disableSemanticSearch() {
    this.semanticGeneration++;
    this.embedder = null; this.indexer.setEmbedder(null);
    this.settings.semanticEnabled = false; await this.saveSettings();
    this.setFooterStatus("Local semantic search disabled; keyword search remains available.");
    this.refreshOpenView();
  }

  private setFooterStatus(text: string) {
    const item = (this as any)._eaiStatus ??= this.addStatusBarItem();
    item.setText(text.slice(0, 120));
  }

  async pruneHistory() { await this.localStore.pruneHistory(this.settings.retentionDays); }
  async clearHistory() { await this.localStore.clearHistory(); this.refreshOpenView(); }

  async confirm(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText(title);
      modal.contentEl.createEl("p", { text: message });
      const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
      buttons.createEl("button", { text: "Cancel" }).onclick = () => { resolve(false); modal.close(); };
      buttons.createEl("button", { text: "Confirm", cls: "mod-warning" }).onclick = () => { resolve(true); modal.close(); };
      modal.onClose = () => resolve(false);
      modal.open();
    });
  }

  async openVaultPath(path: string) {
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else if (file instanceof TFolder) new Notice(`Folder: ${file.path}`);
    else new Notice(`No such vault path: ${path}`);
  }

  private findAgentDataPath(): string {
    for (const candidate of agentDataCandidates()) if (this.fsExistsSync(join(candidate, "pi-server"))) return candidate;
    return "";
  }

  private fsExistsSync(path: string): boolean { try { require("node:fs").accessSync(path); return true; } catch { return false; } }

  async connectAgent() {
    if (!Platform.isDesktopApp) throw new Error("The Expert AI Agent bridge currently runs on Obsidian Desktop.");
    const appData = this.agentExtensionDir || this.findAgentDataPath();
    if (!appData) throw new Error("Expert AI Agent desktop was not found on this computer. Install and open it first.");
    this.agentExtensionDir = appData;
    await this.startBridge();
    const runtimeDir = join(appData, "pi-server");
    const extensionsDir = join(runtimeDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    const source = join(this.basePath, this.manifest.dir || join(this.app.vault.configDir, "plugins", PLUGIN_ID), "obsidian-pi-extension.mjs");
    const target = join(extensionsDir, "expert-ai-obsidian.mjs");
    await stat(source).catch(() => { throw new Error("The Pi adapter file is missing from the installed plugin package."); });
    const settingsPath = join(runtimeDir, "agent-settings.json");
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(settingsPath, "utf8")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Agent settings JSON is invalid. Back it up and repair it before connecting Obsidian.");
    }
    try {
      await stat(settingsPath);
      const backupPath = `${settingsPath}.expert-ai-backup`;
      try { await stat(backupPath); }
      catch { await copyFile(settingsPath, backupPath); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const extensions = Array.isArray(settings.extensions) ? settings.extensions.map(String) : [];
    if (!extensions.includes(target)) extensions.push(target);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(extensionsDir, "bridge.json"), JSON.stringify({ port: this.bridgePort, token: this.token, vaultPath: resolve(this.basePath) }), { encoding: "utf8", mode: 0o600 });
    await copyFile(source, target);
    await writeFile(settingsPath, JSON.stringify({ ...settings, extensions }, null, 2), { encoding: "utf8", mode: 0o600 });
    this.settings.connectedAgent = true; this.settings.appDataPath = appData;
    await this.saveSettings();
    new Notice("Obsidian tools installed. Restart the Expert AI Agent server to load them.", 9000);
    await this.activateView();
  }

  async disconnectAgent() {
    const appData = this.settings.appDataPath || this.findAgentDataPath();
    if (appData) {
      const extensionsDir = join(appData, "pi-server", "extensions");
      const target = join(extensionsDir, "expert-ai-obsidian.mjs");
      const settingsPath = join(appData, "pi-server", "agent-settings.json");
      try {
        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        settings.extensions = (Array.isArray(settings.extensions) ? settings.extensions : []).filter((entry: string) => resolve(entry) !== resolve(target));
        await writeFile(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
      } catch { /* The local Agent settings may have been removed; continue cleaning our files. */ }
      await rm(target, { force: true });
      await rm(join(extensionsDir, "bridge.json"), { force: true });
    }
    this.settings.connectedAgent = false; this.settings.appDataPath = ""; await this.saveSettings();
    await this.stopBridge(); this.refreshOpenView();
  }

  private async startBridge() {
    if (this.bridge?.listening) return;
    this.token = randomBytes(32).toString("base64url");
    this.bridge = createServer((request, response) => { void this.handleHttp(request, response); });
    this.bridge.maxHeadersCount = 30;
    this.bridge.requestTimeout = 130_000;
    this.bridge.headersTimeout = 10_000;
    await new Promise<void>((resolvePromise, reject) => {
      this.bridge!.once("error", reject);
      this.bridge!.listen(PORT, "127.0.0.1", () => { this.bridge!.off("error", reject); resolvePromise(); });
    });
    const address = this.bridge.address();
    if (!address || typeof address === "string") throw new Error("Could not determine the local Obsidian bridge port.");
    this.bridgePort = address.port;
    if (this.settings.connectedAgent && this.agentExtensionDir) await this.writeBridgeConfig();
  }

  private async writeBridgeConfig() {
    const extDir = join(this.agentExtensionDir, "pi-server", "extensions");
    await mkdir(extDir, { recursive: true });
    await writeFile(join(extDir, "bridge.json"), JSON.stringify({ port: this.bridgePort, token: this.token, vaultPath: resolve(this.basePath) }), { encoding: "utf8", mode: 0o600 });
  }

  private async stopBridge() {
    if (!this.bridge) return;
    await new Promise<void>((resolvePromise) => this.bridge!.close(() => resolvePromise()));
    this.bridge = undefined; this.bridgePort = 0; this.token = "";
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.host !== `127.0.0.1:${this.bridgePort}` && request.headers.host !== `localhost:${this.bridgePort}`) return json(response, 403, { ok: false, error: "Local bridge host rejected." });
    if (request.headers.origin) return json(response, 403, { ok: false, error: "Browser-origin requests are not allowed." });
    if (request.method === "GET" && new URL(request.url || "/", "http://127.0.0.1").pathname === "/health") return json(response, 200, { ok: true, listening: true, version: this.manifest.version });
    if (request.method !== "POST" || new URL(request.url || "/", "http://127.0.0.1").pathname !== "/v1/tool") return json(response, 404, { ok: false, error: "Route not found." });
    const received = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!this.token || !safeEqualToken(received, this.token)) return json(response, 401, { ok: false, error: "Local bridge authentication failed." });
    if (!(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return json(response, 415, { ok: false, error: "JSON is required." });
    try {
      const payload = await requestBody(request) as BridgeRequest;
      if (!payload || typeof payload.action !== "string") return json(response, 400, { ok: false, error: "Invalid tool request." });
      this.agentLastSeen = Date.now();
      this.refreshAgentConnectionView();
      const result = await this.dispatch(payload.action, payload.args || {});
      json(response, 200, { ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Obsidian operation failed.";
      json(response, message.includes("too large") ? 413 : 400, { ok: false, error: message.slice(0, 1000) });
    }
  }

  private queueMutation<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(work, work);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  private async dispatch(action: string, args: Record<string, unknown>): Promise<unknown> {
    if (action === "hello") return { connected: true, vault: this.app.vault.getName() };
    if (action === "status") return this.statusDetail();
    if (action === "workspace_context") return { enabled: this.settings.workspaceAwarenessEnabled, ...this.getWorkspaceSnapshot() };
    if (action === "git") return this.runGitAction(String(args.mode || "status"), String(args.message || ""));
    if (action === "backup") {
      const mode = String(args.mode || "status");
      if (mode === "backup") return this.backupVault(true);
      if (mode === "list") return this.listCloudBackups();
      if (mode === "restore") {
        const snapshotId = String(args.snapshotId || "");
        if (!snapshotId) throw new Error("Choose a snapshot ID from the backup list before opening its restore review.");
        const cloud = await this.listCloudBackups();
        const snapshots = Array.isArray(cloud.snapshots) ? cloud.snapshots as CloudBackupSnapshot[] : [];
        const snapshot = snapshots.find((item) => item.id === snapshotId);
        if (!snapshot) throw new Error("That cloud snapshot is no longer available. Refresh the backup list and choose another.");
        void this.openCloudRestore(snapshot);
        return { reviewOpened: true, snapshotId, message: "Restore comparison is opening in Obsidian. No files will change until you choose an option in the review." };
      }
      if (mode === "status") {
        const local = { enabled: this.settings.cloudBackupEnabled, folders: this.settings.cloudBackupFolders, includeSubfolders: this.settings.cloudBackupIncludeSubfolders, autoOnOpen: this.settings.cloudBackupAutoOnOpen, retentionDays: 7 };
        try { return { ...local, cloud: await this.listCloudBackups() }; }
        catch (error) { return { ...local, cloud: { available: false, error: error instanceof Error ? error.message : "Cloud backup status unavailable." } }; }
      }
      throw new Error("Unknown backup action. Use status, backup, list, or restore with a snapshot ID.");
    }
    if (action === "agent_session") return this.updateAgentSession(args);
    if (action === "task_start") return this.startAgentTask(args);
    if (action === "task_stream") return this.updateAgentTaskStream(args);
    if (action === "task_event") return this.recordAgentTaskEvent(args);
    if (action === "task_end") return this.finishAgentTask(args);
    if (action === "chat_next") return this.takeQueuedChatMessage(args);
    if (action === "context") return this.retrieveContext(String(args.query || ""), Number(args.maxHits) || 5);
    if (action === "capture") return this.queueMutation(() => this.captureConversation(args));
    if (action === "search") return this.search(String(args.query || ""), Number(args.limit) || 6);
    if (action === "read") return this.queueMutation(() => this.readNote(String(args.path || ""), Number(args.maxCharacters) || 40000));
    if (action === "history") return this.history(String(args.path || ""), Number(args.limit) || 20);
    if (action === "undo") return this.queueMutation<unknown>(() => args.confirm === true
      ? this.undo(String(args.historyId || ""))
      : this.previewUndo(String(args.historyId || "")));
    if (action === "workspace") return this.controlWorkspace(args);
    if (action === "write") return this.queueMutation(() => this.writeNote(args));
    if (action === "move") return this.queueMutation(() => this.movePath(args));
    if (action === "batch") return this.queueMutation(() => this.batch(args));
    throw new Error(`Unknown Obsidian action: ${action}`);
  }

  private async updateAgentSession(args: Record<string, unknown>) {
    const sessionId = String(args.sessionId || "").slice(0, 120);
    const cwd = resolve(String(args.cwd || "")).toLocaleLowerCase();
    const vault = resolve(this.basePath).toLocaleLowerCase();
    const withinVault = cwd === vault || cwd.startsWith(`${vault}${sep}`);
    this.activeAgentSessionId = withinVault ? sessionId : "";
    let linked = 0;
    const prompts = Array.isArray(args.recentPrompts) ? args.recentPrompts.map((item) => String(item || "").trim()).filter(Boolean) : [];
    if (this.activeAgentSessionId && prompts.length) {
      const recentTasks = await this.localStore.getHistory(60);
      for (const entry of recentTasks) {
        if (entry.action !== "task_checkpoint" || entry.sessionId || !entry.request) continue;
        const request = entry.request.trim();
        if (!prompts.some((prompt) => prompt.slice(0, 700) === request.slice(0, 700))) continue;
        await this.localStore.updateHistory(entry.id, (current) => ({ ...current, sessionId, messages: current.messages?.length ? current.messages : [{ role: "user" as const, text: current.request || "", updatedAt: current.createdAt }] }));
        linked++;
      }
    }
    this.refreshOpenChat();
    this.refreshOpenView();
    return { active: !!this.activeAgentSessionId, linkedTasks: linked, vault: this.app.vault.getName() };
  }

  private async startAgentTask(args: Record<string, unknown>) {
    const id = String(args.id || "").slice(0, 120);
    const request = String(args.request || "").trim().slice(0, 20_000);
    const sessionId = String(args.sessionId || "").slice(0, 120);
    if (!id || !request || !sessionId) return { saved: false };
    this.activeAgentSessionId = sessionId;
    this.activeTaskId = id;
    this.agentLastSeen = Date.now();
    if (this.settings.rememberTasks) {
      await this.localStore.addHistory({
        id, createdAt: Date.now(), action: "task_checkpoint", path: "", request: request.slice(0, 700),
        sessionId, taskStatus: "running", updatedAt: Date.now(),
        messages: [{ role: "user", text: request, updatedAt: Date.now() }], traceEvents: [], pendingMessages: [],
      }, this.settings.retentionDays);
    }
    this.refreshOpenView(); this.refreshOpenChat();
    return { saved: this.settings.rememberTasks, taskId: id };
  }

  private async updateAgentTaskStream(args: Record<string, unknown>) {
    const id = String(args.id || "");
    const text = String(args.text || "").slice(0, 20_000);
    if (!id || !text) return { updated: false };
    const now = Date.now();
    await this.localStore.updateHistory(id, (entry) => {
      const messages = [...(entry.messages || [])];
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") messages[messages.length - 1] = { ...last, text, updatedAt: now, streaming: true };
      else messages.push({ role: "assistant", text, updatedAt: now, streaming: true });
      return { ...entry, messages: messages.slice(-40), updatedAt: now, taskStatus: "running" };
    });
    this.refreshOpenChat();
    return { updated: true };
  }

  private async recordAgentTaskEvent(args: Record<string, unknown>) {
    const id = String(args.id || "");
    const kind = String(args.kind || "step").slice(0, 48);
    const label = String(args.label || "Agent activity").slice(0, 160);
    const detail = String(args.detail || "").slice(0, 2_000);
    if (!id) return { recorded: false };
    const event = { id: crypto.randomUUID(), at: Date.now(), kind, label, ...(detail ? { detail } : {}), ...(args.error === true ? { error: true } : {}) };
    await this.localStore.updateHistory(id, (entry) => ({ ...entry, updatedAt: event.at, traceEvents: [...(entry.traceEvents || []), event].slice(-100) }));
    this.refreshOpenView(); this.refreshOpenChat();
    return { recorded: true };
  }

  private async finishAgentTask(args: Record<string, unknown>) {
    const id = String(args.id || "");
    const error = args.error === true;
    const text = String(args.text || "").slice(0, 20_000);
    if (!id) return { updated: false };
    await this.localStore.updateHistory(id, (entry) => {
      const messages = [...(entry.messages || [])];
      const last = messages[messages.length - 1];
      if (text && last?.role === "assistant") messages[messages.length - 1] = { ...last, text, updatedAt: Date.now(), streaming: false };
      else if (text) messages.push({ role: "assistant", text, updatedAt: Date.now(), streaming: false });
      else if (last?.role === "assistant" && last.streaming) messages[messages.length - 1] = { ...last, streaming: false };
      return { ...entry, messages: messages.slice(-40), taskStatus: error ? "error" : "complete", updatedAt: Date.now() };
    });
    this.refreshOpenView(); this.refreshOpenChat();
    return { updated: true };
  }

  private async takeQueuedChatMessage(args: Record<string, unknown>) {
    const sessionId = String(args.sessionId || "");
    if (!sessionId || sessionId !== this.activeAgentSessionId) return null;
    const entries = await this.localStore.getHistory(60);
    for (const entry of entries) {
      if (entry.action !== "task_checkpoint" || entry.sessionId !== sessionId) continue;
      const index = entry.pendingMessages?.findIndex((message) => message.status === "queued") ?? -1;
      if (index < 0) continue;
      const pending = entry.pendingMessages![index];
      await this.localStore.updateHistory(entry.id, (current) => ({
        ...current,
        pendingMessages: (current.pendingMessages || []).map((message) => message.id === pending.id ? { ...message, status: "sent" } : message),
      }));
      return { taskId: entry.id, message: pending.text };
    }
    return null;
  }

  private async controlWorkspace(args: Record<string, unknown>) {
    const mode = String(args.mode || "");
    if (mode === "sidebar") {
      const side = args.side === "right" ? "right" : "left";
      const split = side === "right" ? this.app.workspace.rightSplit : this.app.workspace.leftSplit;
      if (args.visible === false) split.collapse(); else split.expand();
      return { ok: true, status: split.collapsed ? "hidden" : "visible", side };
    }
    if (mode !== "open_tabs" && mode !== "split_notes") throw new Error("Choose open_tabs, split_notes, or sidebar.");
    if (!Array.isArray(args.paths) || args.paths.length < 1) throw new Error("Provide one or more exact vault-relative Markdown paths.");
    const max = mode === "split_notes" ? 6 : 12;
    if (args.paths.length > max) throw new Error(`This workspace operation supports up to ${max} notes.`);
    const paths = args.paths.map((value) => normalizeVaultPath(String(value)));
    const files = paths.map((path) => {
      if (!isMarkdownPath(path)) throw new Error(`Only Markdown notes can be opened through this action: ${path}`);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`No Markdown note at ${path}.`);
      return file;
    });
    const direction = args.direction === "horizontal" ? "horizontal" : "vertical";
    const opened: string[] = [];
    for (let index = 0; index < files.length; index++) {
      const leaf = index === 0 ? this.app.workspace.getLeaf(false)
        : mode === "open_tabs" ? this.app.workspace.getLeaf("tab")
          : this.app.workspace.getLeaf("split", direction);
      await leaf.openFile(files[index], { active: true });
      opened.push(files[index].path);
    }
    return { ok: true, status: "opened", layout: mode, direction: mode === "split_notes" ? direction : undefined, count: opened.length, paths: opened, visibleInObsidian: true };
  }

  private async retrieveContext(query: string, limit: number) {
    const workspace = this.getWorkspaceSnapshot();
    const workspaceContext = this.settings.workspaceAwarenessEnabled ? [
      `Live Obsidian workspace: ${workspace.openFileCount} files open in ${workspace.paneCount} panes. Active file: ${workspace.activePath || "none"}.`,
      ...workspace.openFiles.slice(0, 20).map((item) => `- ${item.active ? "ACTIVE · " : ""}Window ${item.window}, pane ${item.pane}, tab ${item.tab}${item.mode ? `, ${item.mode}` : ""}${item.cursorLine ? `, cursor line ${item.cursorLine}` : ""}: ${item.path}`),
      ...(workspace.omitted ? [`- ${workspace.omitted} additional open files omitted from this short context; use obsidian_status for the full capped list.`] : []),
      "This is workspace metadata only; no open-file contents are included. When the user's request refers to the current/open note, start with the ACTIVE path. Read or edit only files relevant to the request.",
    ].join("\n") : "";
    const searchResult = this.settings.localIndexEnabled
      ? await this.search(query, Math.max(1, Math.min(5, limit)))
      : { hits: [], searchMode: "Agent file search (on demand)", elapsedMs: 0, indexedLocally: false };
    const hits = searchResult.hits;
    const history = this.settings.rememberTasks ? await this.localStore.getHistory(40) : [];
    const previousTask = history.find((entry) => entry.id !== this.activeTaskId && entry.action === "task_checkpoint" && entry.request);
    const contextHistory = history.filter((entry) => entry.id !== this.activeTaskId);
    const noteContext = this.settings.localIndexEnabled
      ? summarizeContext(query, hits, contextHistory)
      : `Connected Obsidian vault: ${this.app.vault.getName()}. The optional local index is paused, so no vault-wide scan is running. Search on demand with the Agent's grep/find tools, then use obsidian_read for relevant notes and Obsidian edit tools for changes.`;
    const previous = previousTask && Date.now() - previousTask.createdAt < this.settings.retentionDays * 86_400_000
      ? `\nRecent Agent task (${formatRelativeTime(previousTask.createdAt)}): ${previousTask.request?.slice(0, 400)}. Use this only if relevant; the current request takes priority.` : "";
    if (this.settings.rememberTasks && query.trim() && !history.some((entry) => entry.id === this.activeTaskId)) {
      await this.localStore.addHistory({ id: crypto.randomUUID(), createdAt: Date.now(), action: "task_checkpoint", path: "", request: query.trim().slice(0, 700) }, this.settings.retentionDays);
    }
    const scope = this.settings.localIndexEnabled
      ? `Selected-folder local index is ready for ${this.settings.localIndexFolders.includes("*") ? "all folders" : this.settings.localIndexFolders.join(", ") || "no folders"}; nested folders are ${this.settings.localIndexIncludeSubfolders ? "included" : "excluded"}. Retrieval mode: ${searchResult.searchMode}; ${hits.length} matching note(s).`
      : `Selected-folder local index is paused. Saved folders: ${this.settings.localIndexFolders.includes("*") ? "all folders" : this.settings.localIndexFolders.join(", ") || "none"}. Use obsidian_search only if the index is active; otherwise use Agent file search against the connected vault.`;
    const text = `${scope}\n${workspaceContext ? `${workspaceContext}\n\n` : ""}${noteContext}${previous}`;
    return { text, hits, includedChars: text.length, localOnly: true, workspace, index: { enabled: this.settings.localIndexEnabled, folders: this.settings.localIndexFolders, includeSubfolders: this.settings.localIndexIncludeSubfolders, mode: searchResult.searchMode, hitCount: hits.length } };
  }

  private async search(query: string, limit: number) {
    if (!query.trim()) throw new Error("Enter a search question.");
    if (!this.settings.localIndexEnabled) throw new Error("The optional local index is paused. Search the vault on demand with the Agent's grep/find tools, then use Obsidian read/edit tools for the selected note.");
    const started = performance.now();
    let queryVector: number[] | undefined;
    if (this.embedder) { try { queryVector = await this.embedder.embed(query); } catch (error) { console.warn("[Expert AI] local semantic query failed", error); } }
    const hits = await this.localStore.search(query, queryVector, Math.max(1, Math.min(12, limit)));
    return { hits, searchMode: queryVector ? "hybrid semantic + keyword" : "local keyword", elapsedMs: Math.round(performance.now() - started), indexedLocally: true };
  }

  private async readNote(rawPath: string, maxCharacters: number) {
    const path = normalizeVaultPath(rawPath);
    if (!isMarkdownPath(path)) throw new Error("Only Markdown notes can be read through this tool.");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`No Markdown note at ${path}.`);
    const text = await this.ensureVersionSnapshot(file);
    const limit = Math.max(100, Math.min(40_000, maxCharacters));
    return { path, content: text.slice(0, limit), totalCharacters: text.length, truncated: text.length > limit, modifiedAt: file.stat.mtime };
  }

  private async captureConversation(args: Record<string, unknown>) {
    if (!this.settings.agentWritesEnabled) throw new Error("Vault writes are disabled in Expert AI settings.");
    const title = String(args.title || "").trim().slice(0, 180);
    if (!title) throw new Error("Give the archived conversation a short title.");
    const source = String(args.source || "AI conversation").trim().slice(0, 120);
    const project = String(args.project || "").trim().slice(0, 120);
    const summary = String(args.summary || "").trim().slice(0, 8_000);
    const transcript = String(args.transcript || "").trim().slice(0, MAX_NOTE_CHARS - 12_000);
    const reference = String(args.reference || "").trim().slice(0, 2_000);
    const tags = Array.isArray(args.tags) ? args.tags.map((tag) => String(tag).replace(/^#/, "").trim()).filter(Boolean).slice(0, 20) : [];
    const keyPoints = Array.isArray(args.keyPoints) ? args.keyPoints.map((point) => String(point).trim()).filter(Boolean).slice(0, 40) : [];
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const safeTitle = title.normalize("NFKD").replace(/[^\p{L}\p{N} -]/gu, "").trim().replace(/\s+/g, "-").slice(0, 80) || "conversation";
    const folder = normalizeVaultPath(`${this.getArchiveFolder()}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`);
    const path = `${folder}/${date}-${safeTitle}-${now.getTime().toString(36)}.md`;
    const lines = [
      "---", `title: ${JSON.stringify(title)}`, `source: ${JSON.stringify(source)}`, `created: ${now.toISOString()}`,
      ...(project ? [`project: ${JSON.stringify(project)}`] : []),
      ...(tags.length ? [`tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`] : []),
      ...(reference ? [`reference: ${JSON.stringify(reference)}`] : []), "---", "", `# ${title}`, "",
      "## Summary", "", summary || "No summary was provided.",
      ...(keyPoints.length ? ["", "## Key points", "", ...keyPoints.map((point) => `- ${point}`)] : []),
      ...(reference ? ["", "## Source", "", reference] : []),
      ...(transcript ? ["", "## Conversation", "", transcript] : []), "",
    ];
    const content = lines.join("\n");
    const result = await this.writeNote({ mode: "create", path, content, summary: `Archived ${source} conversation: ${title}` }) as Record<string, unknown>;
    return { ...result, status: "archived", title, source, includedTranscript: !!transcript };
  }

  private currentText(file: TFile): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === file.path) return view.editor.getValue();
    return null;
  }

  private async fullText(file: TFile): Promise<string> {
    const active = this.currentText(file);
    return active ?? await this.app.vault.read(file);
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = parentPath(path);
    if (!parent) return;
    const parts = parent.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`A file blocks the folder path ${current}.`);
      await this.app.vault.createFolder(current);
    }
  }

  private async writeNote(args: Record<string, unknown>, groupId?: string): Promise<unknown> {
    if (!this.settings.agentWritesEnabled) throw new Error("Vault writes are disabled in Expert AI settings.");
    const mode = String(args.mode || "");
    const path = normalizeVaultPath(String(args.path || ""));
    if (!isMarkdownPath(path)) throw new Error("Vault note paths must end in .md.");
    const content = String(args.content || "");
    if (content.length > MAX_NOTE_CHARS) throw new Error("A single note edit is limited to 250,000 characters.");
    let file = this.app.vault.getAbstractFileByPath(path);
    let before: string | null = null;
    let after: string;
    if (mode === "create") {
      if (file) throw new Error(`A note already exists at ${path}; read it before choosing an edit.`);
      await this.ensureParent(path);
      const created = await this.app.vault.create(path, content);
      file = created;
      after = content;
      await this.localStore.putSnapshot({ path, text: after, updatedAt: created.stat.mtime || Date.now() });
      await this.app.workspace.getLeaf(false).openFile(created);
      if (this.settings.localIndexEnabled) await this.indexer.indexFile(created);
    } else {
      if (!(file instanceof TFile)) throw new Error(`No note exists at ${path}.`);
      before = await this.fullText(file);
      if (before.length > MAX_NOTE_CHARS) throw new Error("This note is too large for the automatic before-version limit. Use smaller targeted edits or edit it manually.");
      if (mode === "append") after = `${before}${before && !before.endsWith("\n") ? "\n" : ""}${content}`;
      else if (mode === "replace") {
        const matchText = String(args.matchText || "");
        if (!matchText) throw new Error("The exact passage to replace is required.");
        const first = before.indexOf(matchText);
        if (first < 0) throw new Error("The exact passage was not found. Read the current note and retry with the exact text.");
        if (before.indexOf(matchText, first + matchText.length) >= 0) throw new Error("That passage occurs more than once. Provide a larger unique passage before replacing it.");
        after = before.slice(0, first) + content + before.slice(first + matchText.length);
      } else throw new Error("Unsupported write mode.");
      await this.applyUpdatedText(file, before, after);
    await this.localStore.putSnapshot({ path, text: after, updatedAt: file.stat.mtime || Date.now() });
      if (this.settings.localIndexEnabled) await this.indexer.indexFile(file);
    }
    const entry: HistoryEntry = { id: crypto.randomUUID(), createdAt: Date.now(), action: mode, path, request: String(args.summary || ""), before, after, taskId: this.activeTaskId || undefined, ...(groupId ? { groupId } : {}) };
    await this.record(entry);
    const stat = await this.statusSummary();
    return { ok: true, status: "completed", action: mode, path, historyId: entry.id, groupId: groupId || null, bytesWritten: new TextEncoder().encode(after).length, index: `${stat.documents} notes indexed`, visibleInObsidian: true };
  }

  private async applyUpdatedText(file: TFile, before: string, after: string) {
    if (after.length > MAX_NOTE_CHARS) throw new Error("The resulting note would exceed the 250,000 character limit.");
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === file.path) {
      const current = view.editor.getValue();
      if (current !== before) throw new Error("The open note changed while the Agent was preparing this edit. Re-read the note before retrying.");
      const change = diffRange(before, after);
      view.editor.replaceRange(change.insert, offsetToPos(before, change.from), offsetToPos(before, change.to));
      if (view.editor.getValue() !== after) view.editor.setValue(after);
      await this.app.vault.modify(file, after);
      return;
    }
    await this.app.vault.process(file, (current) => {
      if (current !== before) throw new Error("The note changed since it was read. Re-read it before retrying.");
      return after;
    });
  }

  private async movePath(args: Record<string, unknown>, groupId?: string): Promise<unknown> {
    if (!this.settings.agentWritesEnabled) throw new Error("Vault writes are disabled in Expert AI settings.");
    const mode = String(args.mode || "");
    const path = normalizeVaultPath(String(args.path || ""));
    const item = this.app.vault.getAbstractFileByPath(path);
    if (!item) throw new Error(`No vault file or folder exists at ${path}.`);
    let destination: string | undefined;
    if (mode === "trash") {
      if (item instanceof TFolder) throw new Error("Folder deletion is intentionally not supported yet. Move or rename the folder, or delete individual notes using Obsidian so every note can be restored separately.");
    } else {
      const rawDestination = String(args.destination || "");
      if (!rawDestination) throw new Error("A destination path is required.");
      const normalized = normalizeVaultPath(rawDestination);
      if (mode === "rename") {
        if (normalized.includes("/")) destination = normalized;
        else destination = `${parentPath(path) ? `${parentPath(path)}/` : ""}${normalized}${item instanceof TFile && !/\.[^./]+$/.test(normalized) ? path.slice(path.lastIndexOf(".")) : ""}`;
      } else if (mode === "move") {
        const targetFolder = this.app.vault.getAbstractFileByPath(normalized);
        if (targetFolder && !(targetFolder instanceof TFolder)) throw new Error(`Destination ${normalized} is not a folder.`);
        if (!targetFolder) await this.app.vault.createFolder(normalized);
        destination = `${normalized}/${fileName(path)}`;
      } else throw new Error("Unsupported organization mode.");
      if (destination === path) return { ok: true, status: "no change", path };
      if (this.app.vault.getAbstractFileByPath(destination)) throw new Error(`A file or folder already exists at ${destination}.`);
      if (item instanceof TFolder && destination.startsWith(`${path}/`)) throw new Error("A folder cannot be moved inside itself.");
    }
    let before: string | null = null;
    let after: string | null = null;
    if (item instanceof TFile && isMarkdownPath(item.path)) before = await this.fullText(item);
    if (mode !== "trash" && before !== null) after = before;
    const mtime = Date.now();
    if (mode === "trash") await this.app.fileManager.trashFile(item);
    else {
      const moveKey = `${path}\0${destination}`;
      this.pendingVaultMoves.add(moveKey);
      try { await this.app.fileManager.renameFile(item, destination!); }
      catch (error) { this.pendingVaultMoves.delete(moveKey); throw error; }
    }
    if (mode === "trash") await this.localStore.deleteSnapshot(path);
    else if (item instanceof TFile && isMarkdownPath(item.path)) {
      await this.localStore.moveSnapshot(path, destination!);
      if (before !== null) await this.localStore.putSnapshot({ path: destination!, text: before, updatedAt: Date.now() });
    } else if (item instanceof TFolder) await this.localStore.moveSnapshotsPrefix(path, destination!);
    if (this.settings.localIndexEnabled) {
      if (mode === "trash") await this.indexer.remove(path);
      else if (item instanceof TFile && isMarkdownPath(item.path)) { await this.indexer.remove(path); const moved = this.app.vault.getAbstractFileByPath(destination!); if (moved instanceof TFile) await this.indexer.indexFile(moved); }
      else await this.indexer.sync();
    }
    const entry: HistoryEntry = { id: crypto.randomUUID(), createdAt: mtime, action: mode, path, ...(destination ? { nextPath: destination } : {}), ...(before !== null ? { before, after } : {}), taskId: this.activeTaskId || undefined, ...(groupId ? { groupId } : {}) };
    await this.record(entry);
    return { ok: true, status: "completed", action: mode, path, destination: destination || null, historyId: entry.id, groupId: groupId || null, visibleInObsidian: true };
  }

  private async batch(args: Record<string, unknown>) {
    if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 25) throw new Error("A batch needs 1–25 operations.");
    const groupId = crypto.randomUUID();
    const results: unknown[] = [];
    for (let index = 0; index < args.operations.length; index++) {
      const operation = args.operations[index] as Record<string, unknown>;
      try {
        const result = ["create", "append", "replace"].includes(String(operation.mode))
          ? await this.writeNote(operation, groupId)
          : await this.movePath(operation, groupId);
        results.push({ index: index + 1, ...result as object });
      } catch (error) {
        return { status: "partially completed", groupId, completed: results.length, total: args.operations.length, results, failedIndex: index + 1, error: error instanceof Error ? error.message : String(error), useHistoryIdToRestoreEarlierOperations: true };
      }
    }
    return { status: "completed", groupId, completed: results.length, total: args.operations.length, results };
  }

  private async getHistoryComparison(historyId: string) {
    const entry = await this.localStore.getHistoryEntry(historyId);
    if (!entry) throw new Error("That history item expired or does not exist.");
    const currentPath = this.findCurrentPath(entry.nextPath || entry.path, await this.localStore.getHistory(500));
    const item = this.app.vault.getAbstractFileByPath(currentPath);
    const currentText = item instanceof TFile ? await this.fullText(item) : null;
    return { entry, currentPath, currentText, currentKind: item instanceof TFolder ? "folder" : item instanceof TFile ? "note" : "missing" };
  }

  async getHistoryComparisonForView(historyId: string) { return this.getHistoryComparison(historyId); }

  private async previewUndo(historyId: string) {
    const comparison = await this.getHistoryComparison(historyId);
    const { entry, currentPath, currentText } = comparison;
    const previous = typeof entry.before === "string" ? entry.before : "";
    const diff = (typeof entry.before === "string" && currentText !== null)
      || (entry.action === "create" && typeof entry.after === "string")
      || (entry.action === "trash" && typeof entry.before === "string")
      ? compactDiff(previous, currentText ?? (entry.action === "create" ? String(entry.after || "") : ""), 4_000) : undefined;
    return {
      status: "preview",
      confirmationRequired: true,
      restorable: isRestorableHistoryEntry(entry),
      historyId: entry.id,
      action: entry.action,
      originalPath: entry.path,
      currentPath,
      currentKind: comparison.currentKind,
      changedAt: new Date(entry.createdAt).toISOString(),
      previousCharacters: typeof entry.before === "string" ? entry.before.length : null,
      afterOperationCharacters: typeof entry.after === "string" ? entry.after.length : null,
      currentCharacters: currentText?.length ?? null,
      currentMatchesAfterOperation: typeof entry.after === "string" ? currentText === entry.after : null,
      diff,
      message: "This is a preview only. Explain the change and wait for explicit user approval before calling obsidian_undo again with confirm=true.",
    };
  }

  private async undo(historyId: string) {
    const entry = await this.localStore.getHistoryEntry(historyId);
    if (!entry) throw new Error("That history item expired or does not exist.");
    if (entry.revertedAt) throw new Error("That history item has already been restored.");
    if (entry.action === "task_checkpoint") throw new Error("Task checkpoints do not modify notes and cannot be restored.");
    const targetPath = this.findCurrentPath(entry.nextPath || entry.path, await this.localStore.getHistory(500));
    const item = this.app.vault.getAbstractFileByPath(targetPath);
    if (entry.action === "create") {
      if (!(item instanceof TFile) || await this.fullText(item) !== entry.after) throw new Error("The created note changed after this operation; automatic restore stopped to protect newer work.");
      await this.app.fileManager.trashFile(item); await this.localStore.deleteSnapshot(targetPath); if (this.settings.localIndexEnabled) await this.indexer.remove(targetPath);
    } else if (entry.action === "rename" || entry.action === "move") {
      if (!item || this.app.vault.getAbstractFileByPath(entry.path)) throw new Error("The original path is no longer free or the moved item is missing.");
      const moveKey = `${targetPath}\0${entry.path}`;
      this.pendingVaultMoves.add(moveKey);
      try { await this.app.fileManager.renameFile(item, entry.path); }
      catch (error) { this.pendingVaultMoves.delete(moveKey); throw error; }
      if (item instanceof TFile && isMarkdownPath(entry.path)) await this.localStore.moveSnapshot(targetPath, entry.path);
      else if (item instanceof TFolder) await this.localStore.moveSnapshotsPrefix(targetPath, entry.path);
      if (this.settings.localIndexEnabled) {
        if (item instanceof TFile && isMarkdownPath(entry.path)) { await this.indexer.remove(targetPath); const moved = this.app.vault.getAbstractFileByPath(entry.path); if (moved instanceof TFile) await this.indexer.indexFile(moved); }
        else await this.indexer.sync();
      }
    } else if (entry.action === "trash") {
      if (item) throw new Error("A new item already occupies the original path; automatic restore stopped.");
      if (typeof entry.before !== "string") throw new Error("This version has no restorable content snapshot.");
      await this.ensureParent(entry.path); const restored = await this.app.vault.create(entry.path, entry.before); await this.localStore.putSnapshot({ path: entry.path, text: entry.before, updatedAt: Date.now() }); if (this.settings.localIndexEnabled) await this.indexer.indexFile(restored);
    } else if (typeof entry.before === "string" && typeof entry.after === "string") {
      if (!(item instanceof TFile) || await this.fullText(item) !== entry.after) throw new Error("The note changed after this operation; automatic restore stopped to protect newer work.");
      await this.applyUpdatedText(item, entry.after, entry.before); await this.localStore.putSnapshot({ path: item.path, text: entry.before, updatedAt: Date.now() }); if (this.settings.localIndexEnabled) await this.indexer.indexFile(item);
    } else throw new Error("This operation does not have an automatic restore path.");
    await this.localStore.markReverted(historyId);
    const restoreEntry: HistoryEntry = {
      id: crypto.randomUUID(), createdAt: Date.now(), action: "restore", path: targetPath,
      ...(["rename", "move"].includes(entry.action) ? { nextPath: entry.path } : {}),
      request: `Restored history item ${historyId}`,
    };
    await this.record(restoreEntry);
    return { ok: true, status: "restored", path: ["rename", "move"].includes(entry.action) ? entry.path : targetPath, restoredHistoryId: historyId, newHistoryId: restoreEntry.id };
  }

  private async history(path: string, limit: number) {
    const entries = await this.localStore.getHistory(Math.max(1, Math.min(50, limit)));
    return entries.filter((entry) => !path || entry.path === normalizeVaultPath(path) || entry.nextPath === normalizeVaultPath(path)).map((entry) => ({
      id: entry.id, createdAt: new Date(entry.createdAt).toISOString(), action: entry.action,
      path: entry.path, nextPath: entry.nextPath || null, revertedAt: entry.revertedAt || null,
      request: entry.request || undefined,
      diff: typeof entry.before === "string" && typeof entry.after === "string" ? compactDiff(entry.before, entry.after, 1000) : undefined,
      restorable: isRestorableHistoryEntry(entry),
    }));
  }

  private async record(entry: HistoryEntry) {
    await this.localStore.addHistory(entry, this.settings.retentionDays);
    await this.pruneHistory();
    this.refreshOpenView();
  }

  private async statusDetail() {
    const summary = await this.statusSummary();
    const history = await this.localStore.getHistory(8);
    const gitStatus = await this.gitStatusText().catch((error) => `Git status unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
    const cloudBackupStatus = await this.listCloudBackups().catch((error) => ({ available: false, error: error instanceof Error ? error.message : "Cloud backup status unavailable." }));
    const bridgeReady = !!this.bridge?.listening;
    const writeEnabled = bridgeReady && this.settings.agentWritesEnabled;
    return {
      bridge: this.bridge?.listening ? "active on this computer" : "offline",
      vault: this.app.vault.getName(),
      workspace: { enabledForAgentContext: this.settings.workspaceAwarenessEnabled, ...this.getWorkspaceSnapshot() },
      index: { mode: this.settings.localIndexEnabled ? "selected-folder local index" : "paused; use on-demand Agent file search", folders: this.settings.localIndexFolders, includeSubfolders: this.settings.localIndexIncludeSubfolders, documents: summary.documents, sections: summary.chunks, vectors: summary.vectors, semanticSearch: summary.semantic ? "ready" : this.settings.semanticEnabled ? "loading or unavailable" : "off", semanticStatus: this.semanticStatusText || undefined, semanticFolders: this.settings.semanticFolders, semanticIncludeSubfolders: this.settings.semanticIncludeSubfolders, indexing: summary.indexing, indexed: summary.indexed, total: summary.total },
      git: { configured: !!this.settings.gitRemote, remote: this.settings.gitRemote || null, status: gitStatus, startupPull: this.settings.gitStartupPull,
        supabaseBackup: this.settings.cloudBackupEnabled ? "enabled" : "disabled", cloudBackup: cloudBackupStatus },
      capabilities: {
        searchNotes: bridgeReady && summary.documents > 0,
        agentWorkspaceFileSearch: bridgeReady,
        archiveConversation: writeEnabled,
        readNotes: bridgeReady,
        createAppendEditNotes: writeEnabled,
        moveRenameTrashNotes: writeEnabled,
        batchChanges: writeEnabled,
        reviewHistoryAndRestore: bridgeReady,
        semanticSearch: summary.semantic ? "ready" : this.settings.semanticEnabled ? "loading or unavailable; keyword search remains available" : "disabled; keyword search is available",
        gitStatus: !!this.settings.gitRemote,
        gitRefreshCommitPullPush: !!this.settings.gitRemote,
        supabaseCloudBackup: this.settings.cloudBackupEnabled && (cloudBackupStatus as Record<string, unknown>).ok === true,
      },
      lastAgentRequest: this.agentLastSeen ? new Date(this.agentLastSeen).toISOString() : null,
      recentActivity: history.filter((entry) => entry.action !== "task_checkpoint").map((entry) => ({ id: entry.id, action: entry.action, path: entry.path, nextPath: entry.nextPath || null, time: new Date(entry.createdAt).toISOString(), restored: !!entry.revertedAt })),
      historyRetentionDays: this.settings.retentionDays,
    };
  }

  private async runGitAction(mode: string, message: string) {
    if (mode === "status") return { action: mode, status: await this.gitStatusText(), remote: this.settings.gitRemote || null, startupPull: this.settings.gitStartupPull };
    if (!this.settings.gitRemote) throw new Error("GitHub repository is not connected in Expert AI settings.");
    if (mode === "refresh") {
      await this.refreshGit(true);
      return { action: mode, status: await this.gitStatusText(), report: "Fetched remote refs and refreshed status; vault files were not changed." };
    }
    if (mode === "pull") {
      return this.pullGit(true);
    }
    if (mode === "commit") {
      this.gitCommitMessage = message.trim().slice(0, 200);
      return this.commitGit(true);
    }
    if (mode === "push") {
      return this.pushGit(true);
    }
    if (mode === "sync") return this.commitAndPushGit(message, true);
    throw new Error("Unknown Git action. Use status, refresh, pull, commit, push, or sync.");
  }

  async undoFromView(id: string) { return this.queueMutation(() => this.undo(id)); }
  private async getHistoryForPanel() { return this.localStore.getHistory(60); }
}
