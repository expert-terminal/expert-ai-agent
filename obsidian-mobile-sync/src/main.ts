import { App, ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, WorkspaceLeaf, requestUrl } from "obsidian";
import { commitGitHubChanges, defaultCommitMessage, getGitHubBlob, getGitHubBranchInfo, getGitHubLogin, getGitHubRenames, getGitHubState, parseGitHubRepo, pollDeviceToken, refreshGitHubToken, requestDeviceCode, type GitHubChange, type GitHubFile, type GitHubState } from "./github";

const API = "https://api.ssv.asia";
const VIEW = "expert-ai-mobile-sync-view";
const PLUGIN_ID = "expert-ai-mobile-sync";
const GITHUB_ACCESS_SECRET = "expert-ai-mobile-sync-github-access";
const GITHUB_REFRESH_SECRET = "expert-ai-mobile-sync-github-refresh";
const DEFAULT_GITHUB_CLIENT_ID = "Ov23li34kznRDO4b3NWB";
const MAX_OBJECT = 45 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const EVENT_TRACKING_READY_DELAY = 8 * 1000;
const RECOVERY_FOLDER = "Expert AI Mobile Recovery";
const KEEP_PATHS = [".obsidian/", ".git/", ".trash/", `${RECOVERY_FOLDER.toLocaleLowerCase()}/`];

type RemoteFile = { deleted?: boolean; hash: string | null; size: number; mtime?: number; updatedAt?: number };
type Manifest = { format: number; version: number; updatedAt: string | null; files: Record<string, RemoteFile> };
type LocalGitItem = { file: TFile | null; sha: string; size: number; mtime: number; sig: string };
type LogEntry = { at: number; kind: "ok" | "warn" | "error" | "info"; text: string };
type VaultChange = { at: number; action: "create" | "edit" | "delete" | "move"; path: string; nextPath?: string; sha?: string };
type ConflictEntry = { id: string; path: string; alternatePath?: string; backend?: "github" | "supabase"; reason?: "move" | "deleted" | "first-pull" };
type Settings = {
  email: string; token: string; nonce: string; syncKey: string; autoSync: boolean; paused: boolean;
  version: number; base: Record<string, RemoteFile>; cache: Record<string, { sig: string; hash: string }>;
  logs: LogEntry[]; lastSync: number; lastReport: string; backupLastSync: number; backupLastReport: string; conflicts: ConflictEntry[];
  vaultChanges: VaultChange[]; pendingGitPaths: string[]; githubJournalReady: boolean;
  startupSyncDisabled033: boolean;
  githubRepoUrl: string; githubBranch: string; githubLogin: string; githubHead: string; githubRepoVerified: boolean;
  githubExpiresAt: number; githubRefreshExpiresAt: number; githubBase: Record<string, string>; githubCache: Record<string, { sig: string; sha: string }>; supabaseBackupEnabled: boolean;
};
const defaults: Settings = { email: "", token: "", nonce: "", syncKey: "", autoSync: false, paused: false, version: 0, base: {}, cache: {}, logs: [], lastSync: 0, lastReport: "Not synced yet", backupLastSync: 0, backupLastReport: "Not backed up yet", conflicts: [], vaultChanges: [], pendingGitPaths: [], githubJournalReady: false, startupSyncDisabled033: false, githubRepoUrl: "", githubBranch: "", githubLogin: "", githubHead: "", githubRepoVerified: true, githubExpiresAt: 0, githubRefreshExpiresAt: 0, githubBase: {}, githubCache: {}, supabaseBackupEnabled: false };

function validPath(path: string) {
  const lower = path.toLocaleLowerCase();
  return !!path && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => !part || part === "." || part === "..")
    && !KEEP_PATHS.some((skip) => lower.startsWith(skip));
}
function signature(file: TFile) { return `${file.stat.mtime}:${file.stat.size}`; }
function bytesToHex(bytes: ArrayBuffer) { return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join(""); }
async function digest(bytes: ArrayBuffer) { return bytesToHex(await crypto.subtle.digest("SHA-256", bytes)); }
async function stableVaultId(key: string) { return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.trim().toLowerCase()))).slice(0, 20); }
function fmtTime(at: number) { return at ? new Date(at).toLocaleString() : "Never"; }
function fmtBytes(bytes: number) { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function escPath(path: string) { return encodeURIComponent(path); }
function isTransientGitHubNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /unknownhostexception|unable to resolve host|no address associated|enotfound|eai_again|err_name_not_resolved|network request failed|failed to fetch|request failed|timed out|connection reset/i.test(message);
}

class LoginModal extends Modal {
  private plugin: MobileSyncPlugin;
  private code = "";
  constructor(app: App, plugin: MobileSyncPlugin) { super(app); this.plugin = plugin; }
  onOpen() {
    const { contentEl } = this; contentEl.createEl("h3", { text: "Connect Expert AI" });
    contentEl.createEl("p", { text: "Sign in with your Expert AI account. A six-digit code will be emailed to you." });
    const email = contentEl.createEl("input", { type: "email", placeholder: "you@example.com" }); email.addClass("eaims-input"); email.value = this.plugin.settings.email;
    const code = contentEl.createEl("input", { type: "text", placeholder: "Email code", attr: { inputmode: "numeric", maxlength: "6" } }); code.addClass("eaims-input");
    const buttons = contentEl.createDiv({ cls: "eaims-actions" });
    const send = buttons.createEl("button", { text: "Send code" });
    const verify = buttons.createEl("button", { text: "Verify and connect" });
    send.onclick = async () => {
      try { const result = await this.plugin.startLogin(email.value.trim()); code.focus(); new Notice(result); }
      catch (error) { new Notice(error instanceof Error ? error.message : "Could not send the code."); }
    };
    verify.onclick = async () => {
      try { await this.plugin.verifyLogin(email.value.trim(), code.value.trim()); new Notice("Expert AI connected."); this.close(); }
      catch (error) { new Notice(error instanceof Error ? error.message : "Could not verify the code."); }
    };
  }
  onClose() { this.contentEl.empty(); }
}

class GitHubDeviceModal extends Modal {
  userCode: string;
  verificationUri: string;
  private statusEl?: HTMLElement;
  cancelled = false;
  constructor(app: App, userCode: string, verificationUri: string) { super(app); this.userCode = userCode; this.verificationUri = verificationUri; }
  onOpen() {
    const { contentEl } = this; contentEl.createEl("h3", { text: "Connect GitHub" });
    contentEl.createEl("p", { text: "Open GitHub's device page, enter this code, then approve Expert AI Mobile Sync." });
    const codeRow = contentEl.createDiv({ cls: "eaims-device-code-row" });
    const code = codeRow.createEl("input", { type: "text", value: this.userCode, cls: "eaims-device-code", attr: { readonly: "true", "aria-label": "GitHub authorization code" } });
    code.setAttribute("autocapitalize", "characters");
    const copy = codeRow.createEl("button", { text: "Copy code" });
    copy.onclick = async () => {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(this.userCode);
        else { code.focus(); code.select(); if (!document.execCommand("copy")) throw new Error("Copy is unavailable"); }
        new Notice("GitHub code copied.");
      } catch { code.focus(); code.select(); new Notice("Code selected. Use Copy from the keyboard menu."); }
    };
    const button = contentEl.createEl("button", { text: "Open GitHub device page" }); button.onclick = () => window.open(this.verificationUri, "_blank");
    this.statusEl = contentEl.createEl("p", { cls: "eaims-subtle", text: "Waiting for approval…" });
  }
  setStatus(text: string) { this.statusEl?.setText(text); }
  onClose() { this.cancelled = true; this.contentEl.empty(); }
}

class FileCompareModal extends Modal {
  constructor(app: App, private leftTitle: string, private rightTitle: string, private leftText: string, private rightText: string, private summary: string) { super(app); }
  onOpen() {
    const { contentEl } = this; contentEl.createEl("h3", { text: "Compare versions" }); contentEl.createEl("p", { text: this.summary });
    const columns = contentEl.createDiv({ cls: "eaims-compare-columns" });
    for (const [title, text] of [[this.leftTitle, this.leftText], [this.rightTitle, this.rightText]]) {
      const panel = columns.createDiv({ cls: "eaims-compare-panel" }); panel.createEl("strong", { text: title }); panel.createEl("pre", { text });
    }
  }
  onClose() { this.contentEl.empty(); }
}

class RebuildGitHubModal extends Modal {
  constructor(app: App, private onConfirm: () => void) { super(app); }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Make this phone match GitHub?" });
    contentEl.createEl("p", { text: "GitHub will be the exact source of truth on this phone. Identical files stay in place, and unchanged files found at their new GitHub paths are moved. Other local files and folders are removed from this phone; they are not copied to a recovery folder. Nothing is changed on GitHub." });
    contentEl.createEl("p", { text: "Keep Obsidian open and online until the Sync panel reports completion. The rebuild can be retried if the network drops." });
    const buttons = contentEl.createDiv({ cls: "eaims-actions" });
    buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    buttons.createEl("button", { text: "Replace phone with GitHub", cls: "mod-warning" }).onclick = () => { this.close(); this.onConfirm(); };
  }
  onClose() { this.contentEl.empty(); }
}

class SyncView extends ItemView {
  private plugin: MobileSyncPlugin;
  constructor(leaf: WorkspaceLeaf, plugin: MobileSyncPlugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW; }
  getDisplayText() { return "Expert AI Sync"; }
  getIcon() { return "refresh-cw"; }
  async onOpen() { this.render(); }
  async onClose() {}
  render() {
    const root = this.containerEl.children[1] as HTMLElement; root.empty(); root.addClass("eaims");
    const head = root.createDiv({ cls: "eaims-head" }); const logo = head.createEl("img"); logo.src = this.plugin.getIconUrl();
    const heading = head.createDiv(); heading.createEl("strong", { text: "Expert AI Sync" }); heading.createEl("div", { cls: "eaims-subtle", text: `Mobile plugin v${this.plugin.manifest.version} · follows the folders in your GitHub vault` });
    const github = root.createDiv({ cls: "eaims-state" });
    const tokenPresent = this.plugin.hasGitHubAuthorization();
    const githubReady = tokenPresent && !!this.plugin.settings.githubLogin && !!this.plugin.settings.githubRepoUrl && this.plugin.settings.githubRepoVerified;
    github.createEl("strong", { text: githubReady ? `GitHub · ${this.plugin.settings.githubLogin} · ${this.plugin.settings.githubRepoUrl}` : tokenPresent ? `GitHub authorized · ${this.plugin.settings.githubLogin || "account"}` : this.plugin.settings.githubLogin ? "GitHub authorization missing · reconnect required" : "GitHub is the primary sync" });
    github.createEl("div", { cls: "eaims-subtle", text: githubReady ? `Branch ${this.plugin.settings.githubBranch || "default"} · ${this.plugin.settings.githubHead ? `commit ${this.plugin.settings.githubHead.slice(0, 7)}` : "not synced yet"}` : tokenPresent ? "Repository access is not verified. Tap Verify repository when the phone can reach GitHub." : this.plugin.settings.githubLogin ? "Reconnect GitHub in Settings; the saved account name alone does not authorize sync." : "Connect your repository to pull, commit, and push the vault." });
    github.createEl("div", { cls: "eaims-subtle", text: `Last GitHub sync: ${fmtTime(this.plugin.settings.lastSync)} · ${this.plugin.settings.lastReport}` });
    github.createEl("div", { cls: "eaims-subtle", text: this.plugin.settings.githubJournalReady
      ? `Change journal ready · ${this.plugin.settings.pendingGitPaths.length} local path${this.plugin.settings.pendingGitPaths.length === 1 ? "" : "s"} pending · quick sync checks changed paths`
      : "First manual sync initializes the change journal; automatic full-vault scans are disabled at startup." });
    if (!githubReady) { const connect = root.createEl("button", { text: tokenPresent ? "Verify GitHub repository" : "Connect or reconnect GitHub" }); connect.onclick = () => this.plugin.openSettings(); }
    const actions = root.createDiv({ cls: "eaims-actions" });
    const sync = actions.createEl("button", { text: this.plugin.progressText || "Sync GitHub" }); sync.disabled = this.plugin.syncing || !githubReady; sync.onclick = () => { void this.plugin.syncGitHub(true, "sync"); };
    const pull = actions.createEl("button", { text: "Pull from GitHub" }); pull.disabled = this.plugin.syncing || !githubReady; pull.onclick = () => { void this.plugin.syncGitHub(true, "pull"); };
    const rebuild = actions.createEl("button", { text: "Rebuild from GitHub" }); rebuild.disabled = this.plugin.syncing || !githubReady; rebuild.onclick = () => this.plugin.confirmGitHubRebuild();
    const push = actions.createEl("button", { text: "Commit & push" }); push.disabled = this.plugin.syncing || !githubReady; push.onclick = () => { void this.plugin.syncGitHub(true, "push"); };
    const scanPush = actions.createEl("button", { text: "Full scan & push" }); scanPush.disabled = this.plugin.syncing || !githubReady; scanPush.onclick = () => { void this.plugin.syncGitHub(true, "push", true); };
    const pause = actions.createEl("button", { text: this.plugin.settings.paused ? "Resume sync" : "Pause sync" }); pause.onclick = () => { void this.plugin.togglePause(); };
    const settings = actions.createEl("button", { text: "Settings" }); settings.onclick = () => this.plugin.openSettings();
    const progress = root.createEl("progress"); progress.max = Math.max(1, this.plugin.progressTotal); progress.value = this.plugin.progressDone; progress.style.width = "100%";
    if (this.plugin.progressText) root.createEl("div", { cls: "eaims-subtle", text: this.plugin.progressText });
    root.createEl("h4", { text: "Recent activity" });
    const log = root.createDiv({ cls: "eaims-log" });
    for (const entry of this.plugin.settings.logs.slice(0, 40)) {
      const row = log.createDiv({ cls: `eaims-log-row eaims-${entry.kind}` });
      row.createEl("div", { text: entry.text }); row.createEl("div", { cls: "eaims-subtle", text: new Date(entry.at).toLocaleTimeString() });
    }
    if (!this.plugin.settings.logs.length) log.createEl("div", { cls: "eaims-subtle", text: "Sync activity will appear here." });
    root.createEl("h4", { text: `Vault file changes · ${this.plugin.settings.pendingGitPaths.length} pending` });
    const changes = root.createDiv({ cls: "eaims-log" });
    for (const entry of this.plugin.settings.vaultChanges.slice(0, 25)) {
      const pending = this.plugin.settings.pendingGitPaths.includes(entry.path) || !!entry.nextPath && this.plugin.settings.pendingGitPaths.includes(entry.nextPath);
      const row = changes.createDiv({ cls: `eaims-log-row eaims-${pending ? "warn" : "info"}` });
      row.createEl("div", { text: `${entry.action.toLocaleUpperCase()} · ${entry.path}${entry.nextPath ? ` → ${entry.nextPath}` : ""}${pending ? " · pending GitHub sync" : " · recorded"}` });
      row.createEl("div", { cls: "eaims-subtle", text: new Date(entry.at).toLocaleString() });
    }
    if (!this.plugin.settings.vaultChanges.length) changes.createEl("div", { cls: "eaims-subtle", text: "Creates, edits, deletes, and moves in this vault will be recorded here." });
    if (this.plugin.settings.conflicts.length) {
      root.createEl("h4", { text: "Versions kept safe" });
      for (const conflict of this.plugin.settings.conflicts.slice(0, 20)) {
        const card = root.createDiv({ cls: "eaims-conflict" });
        if (conflict.reason === "move" && conflict.alternatePath) {
          card.createDiv({ text: `The remote copy moved from ${conflict.path} to ${conflict.alternatePath}. Both versions are preserved until you choose.` });
          const buttons = card.createDiv({ cls: "eaims-actions" });
          const compare = buttons.createEl("button", { text: "Compare versions" }); compare.onclick = () => { void this.plugin.compareConflict(conflict.id); };
          const both = buttons.createEl("button", { text: "Keep both" }); both.onclick = () => { void this.plugin.resolveMoveConflict(conflict.id, "both"); };
          const remote = buttons.createEl("button", { text: "Keep remote" }); remote.onclick = () => { void this.plugin.resolveMoveConflict(conflict.id, "remote"); };
          const local = buttons.createEl("button", { text: "Move my copy to new path" }); local.onclick = () => { void this.plugin.resolveMoveConflict(conflict.id, "local"); };
        } else if (conflict.reason === "deleted" || conflict.reason === "first-pull") {
          card.createDiv({ text: conflict.reason === "first-pull"
            ? `${conflict.path} exists on this phone but not in GitHub. Keep it here for now, publish it to GitHub, or move it to Obsidian trash.`
            : `${conflict.path} was removed from the remote vault, but this phone still has a local copy. Choose whether to publish it again or move it to Obsidian trash.` });
          const buttons = card.createDiv({ cls: "eaims-actions" });
          const view = buttons.createEl("button", { text: "Open local file" }); view.onclick = () => this.plugin.openConflictFile(conflict.path);
          const keep = buttons.createEl("button", { text: "Keep local on GitHub" }); keep.onclick = () => { void this.plugin.resolveDeletedConflict(conflict.id, "keep"); };
          const trash = buttons.createEl("button", { text: "Move local to trash" }); trash.onclick = () => { void this.plugin.resolveDeletedConflict(conflict.id, "trash"); };
        } else {
          card.createDiv({ text: conflict.alternatePath ? `Both devices changed ${conflict.path}. The other version is saved at ${conflict.alternatePath}.` : `A deletion conflicted with a cloud edit. Kept the available version of ${conflict.path}.` });
        }
        if (conflict.reason !== "move" && conflict.reason !== "deleted" && conflict.reason !== "first-pull" && conflict.alternatePath) {
          const buttons = card.createDiv({ cls: "eaims-actions" });
          const compare = buttons.createEl("button", { text: "Compare versions" }); compare.onclick = () => { void this.plugin.compareConflict(conflict.id); };
          const useSaved = buttons.createEl("button", { text: "Use saved version" }); useSaved.onclick = () => { void this.plugin.resolveConflict(conflict.id, "saved"); };
          const keepCurrent = buttons.createEl("button", { text: "Keep current version" }); keepCurrent.onclick = () => { void this.plugin.resolveConflict(conflict.id, "current"); };
        } else if (conflict.reason !== "move" && conflict.reason !== "deleted" && conflict.reason !== "first-pull") { const done = card.createEl("button", { text: "Got it" }); done.onclick = () => { void this.plugin.dismissConflict(conflict.id); }; }
      }
    }
  }
}

class MobileSyncSettings extends PluginSettingTab {
  plugin: MobileSyncPlugin;
  constructor(app: App, plugin: MobileSyncPlugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h2", { text: "Expert AI Mobile Sync" });
    containerEl.createEl("p", { text: "GitHub is the sync source for this personal phone vault. Connect one repository and branch, then pull, commit, and push from the Sync panel." });
    containerEl.createEl("h3", { text: "GitHub · primary" });
    new Setting(containerEl).setName("GitHub repository").setDesc("Use the same repository as your desktop vault. The plugin can prefill it from Expert AI's desktop settings when those settings are synced to this vault.").addText((text) => text.setPlaceholder("https://github.com/owner/vault.git").setValue(this.plugin.settings.githubRepoUrl).onChange(async (value) => { this.plugin.settings.githubRepoUrl = value.trim(); this.plugin.settings.githubRepoVerified = false; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Branch").setDesc("Leave blank to use the repository's default branch.").addText((text) => text.setPlaceholder("main").setValue(this.plugin.settings.githubBranch).onChange(async (value) => { this.plugin.settings.githubBranch = value.trim(); this.plugin.settings.githubRepoVerified = false; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("GitHub account").setDesc(this.plugin.settings.githubLogin || "Not connected").addButton((b) => b.setButtonText(this.plugin.settings.githubLogin ? "Reconnect" : "Connect GitHub").onClick(() => { void this.plugin.connectGitHub(); }));
    new Setting(containerEl).setName("Repository access").setDesc(this.plugin.settings.githubRepoVerified ? `Verified · ${this.plugin.settings.githubBranch || "default branch"}` : "Not verified. Check the repository URL, branch name, and GitHub account access.").addButton((b) => b.setButtonText("Verify repository").setDisabled(!this.plugin.hasGitHubAuthorization() || !this.plugin.settings.githubRepoUrl).onClick(() => { void this.plugin.verifyGitHubRepository(); }));
    new Setting(containerEl).setName("Disconnect GitHub").setDesc("Remove this device's GitHub authorization. Repository files and commits are unchanged.").addButton((b) => b.setButtonText("Disconnect").setWarning().setDisabled(!this.plugin.settings.githubLogin).onClick(() => { void this.plugin.disconnectGitHub(); }));
    new Setting(containerEl).setName("GitHub sync status").setDesc(this.plugin.settings.lastReport).addButton((b) => b.setButtonText("Open sync panel").onClick(() => this.plugin.openView()));
    new Setting(containerEl).setName("Automatic GitHub sync after edits").setDesc("Off by default on mobile to keep Obsidian startup reliable. When enabled, vault edits schedule a background sync; opening Obsidian never starts a pull.").addToggle((toggle) => toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => { this.plugin.settings.autoSync = value; await this.plugin.saveSettings(); }));
    containerEl.createEl("p", { cls: "eaims-subtle", text: "GitHub is the only sync service in this personal mobile build. It creates normal Git commits and pulls the connected branch; no Supabase backup is started from the phone." });
  }
}

export default class MobileSyncPlugin extends Plugin {
  settings: Settings = structuredClone(defaults);
  syncing = false;
  progressDone = 0;
  progressTotal = 0;
  progressText = "";
  private view?: SyncView;
  private startupTimer?: number;
  private debounce?: number;
  private journalTimer?: number;
  private vaultEventTrackingReady = false;
  private conflictRetries = 0;
  private retryAfterConflict = false;

  async onload() {
    const stored = await this.loadData() || {};
    this.settings = { ...defaults, ...stored };
    this.settings.base ||= {}; this.settings.cache ||= {}; this.settings.logs ||= []; this.settings.backupLastReport ||= "Not backed up yet";
    this.settings.conflicts = (this.settings.conflicts || []).filter((item: any) => item && typeof item === "object" && typeof item.id === "string" && item.backend !== "supabase");
    this.settings.supabaseBackupEnabled = false;
    this.settings.githubBase ||= {};
    this.settings.githubCache ||= {};
    this.settings.vaultChanges ||= [];
    this.settings.pendingGitPaths ||= [];
    if (!this.settings.startupSyncDisabled033) {
      this.settings.autoSync = false;
      this.settings.githubJournalReady = false;
      this.settings.startupSyncDisabled033 = true;
      await this.saveData(this.settings);
    }
    void this.discoverGitHubRepo();
    this.registerView(VIEW, (leaf) => { this.view = new SyncView(leaf, this); return this.view; });
    this.addRibbonIcon("refresh-cw", "Open Expert AI Sync", () => this.openView());
    this.addCommand({ id: "sync-now", name: "Sync vault with GitHub", callback: () => { void this.syncGitHub(true, "sync"); } });
    this.addCommand({ id: "sync-pull", name: "Pull latest vault from GitHub", callback: () => { void this.syncGitHub(true, "pull"); } });
    this.addCommand({ id: "sync-push", name: "Commit and push recorded vault changes to GitHub", callback: () => { void this.syncGitHub(true, "push"); } });
    this.addCommand({ id: "sync-full-scan-push", name: "Full scan and push vault changes to GitHub", callback: () => { void this.syncGitHub(true, "push", true); } });
    this.addCommand({ id: "rebuild-from-github", name: "Replace this phone's vault with GitHub", callback: () => this.confirmGitHubRebuild() });
    this.addCommand({ id: "open-sync-panel", name: "Open sync activity", callback: () => this.openView() });
    this.addCommand({ id: "pause-sync", name: "Pause or resume automatic sync", callback: () => { void this.togglePause(); } });
    this.addSettingTab(new MobileSyncSettings(this.app, this));
    this.registerEvent(this.app.workspace.on("file-menu", (_menu, file) => { if (file instanceof TFile) { /* file actions remain available from the standard menu */ } }));
    this.registerEvent(this.app.vault.on("modify", (file) => { if (this.vaultEventTrackingReady && file instanceof TFile && validPath(file.path)) { this.recordVaultChange("edit", file.path, file); this.scheduleSync(); } }));
    this.registerEvent(this.app.vault.on("create", (file) => { if (this.vaultEventTrackingReady && file instanceof TFile && validPath(file.path)) { this.recordVaultChange("create", file.path, file); this.scheduleSync(); } }));
    this.registerEvent(this.app.vault.on("delete", (file) => { if (this.vaultEventTrackingReady && validPath(file.path)) { this.recordVaultChange("delete", file.path); this.scheduleSync(); } }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (this.vaultEventTrackingReady && validPath(oldPath) && validPath(file.path)) { this.recordVaultChange("move", oldPath, file instanceof TFile ? file : undefined, file.path); if (file instanceof TFolder) void this.recordMovedFolderContents(oldPath, file.path); this.scheduleSync(); } }));
    this.app.workspace.onLayoutReady(() => {
      this.startupTimer = window.setTimeout(() => {
        this.startupTimer = undefined;
        this.vaultEventTrackingReady = true;
        this.progressText = "Ready · GitHub sync runs only when you start it";
        this.refresh();
      }, EVENT_TRACKING_READY_DELAY);
    });
  }

  onunload() { if (this.startupTimer) window.clearTimeout(this.startupTimer); if (this.debounce) window.clearTimeout(this.debounce); if (this.journalTimer) window.clearTimeout(this.journalTimer); }
  private recordVaultChange(action: VaultChange["action"], path: string, file?: TFile, nextPath?: string) {
    const at = Date.now();
    const entry: VaultChange = { at, action, path, ...(nextPath ? { nextPath } : {}) };
    this.settings.vaultChanges.unshift(entry); this.settings.vaultChanges = this.settings.vaultChanges.slice(0, 1000);
    if (action === "move") {
      this.settings.pendingGitPaths = [...new Set([...this.settings.pendingGitPaths, path, ...(nextPath ? [nextPath] : [])])];
    } else this.settings.pendingGitPaths = [...new Set([...this.settings.pendingGitPaths, path])];
    if (file) {
      void this.app.vault.readBinary(file).then((bytes) => this.gitBlobSha(bytes)).then((sha) => {
        entry.sha = sha; this.settings.githubCache[path] = { sig: signature(file), sha }; this.queueJournalSave();
      }).catch(() => this.queueJournalSave());
    } else this.queueJournalSave();
    this.refresh();
  }
  private async recordMovedFolderContents(oldPath: string, newPath: string) {
    const walk = async (directory: string): Promise<void> => {
      const listing = await this.app.vault.adapter.list(directory);
      for (const path of listing.files) {
        if (!validPath(path)) continue;
        const relative = path.slice(newPath.length).replace(/^\//, "");
        this.recordVaultChange("move", `${oldPath}/${relative}`, undefined, path);
      }
      for (const folder of listing.folders) await walk(folder);
    };
    try { await walk(newPath); } catch (error) { this.log("warn", `Could not add renamed folder files to the change journal (${newPath}): ${error instanceof Error ? error.message : String(error)}`); }
  }
  private queueJournalSave() {
    if (this.journalTimer) window.clearTimeout(this.journalTimer);
    this.journalTimer = window.setTimeout(() => { this.journalTimer = undefined; void this.saveData(this.settings); this.refresh(); }, 900);
  }
  async saveSettings() { await this.saveData(this.settings); this.refresh(); }
  getIconUrl() { return this.app.vault.adapter.getResourcePath(`${this.manifest.dir}/icon.png`); }
  refresh() { this.view?.render(); }
  hasGitHubAuthorization() { return !!this.app.secretStorage.getSecret(GITHUB_ACCESS_SECRET); }
  async openView() { const leaves = this.app.workspace.getLeavesOfType(VIEW); const leaf = leaves[0] || this.app.workspace.getRightLeaf(false); if (!leaf) return; await leaf.setViewState({ type: VIEW, active: true }); this.app.workspace.revealLeaf(leaf); }
  openLogin() { new LoginModal(this.app, this).open(); }
  openSettings() { (this.app as any).setting?.open(); (this.app as any).setting?.openTabById(PLUGIN_ID); }
  async togglePause() { this.settings.paused = !this.settings.paused; await this.saveSettings(); this.log("info", this.settings.paused ? "Automatic sync paused on this device." : "Automatic sync resumed."); this.refresh(); }
  confirmGitHubRebuild() { new RebuildGitHubModal(this.app, () => { void this.syncGitHub(true, "rebuild"); }).open(); }
  async signOut() { this.settings.token = ""; this.settings.nonce = ""; await this.saveSettings(); this.log("info", "Signed out on this device."); }
  async discoverGitHubRepo() {
    if (this.settings.githubRepoUrl) return;
    try {
      const raw = await this.app.vault.adapter.read(".obsidian/plugins/expert-ai-companion/data.json");
      const remote = String(JSON.parse(raw)?.gitRemote || "");
      parseGitHubRepo(remote);
      this.settings.githubRepoUrl = remote; await this.saveData(this.settings);
    } catch { /* Desktop plugin settings may not be synced into this vault. */ }
  }
  private async githubAccessToken() {
    let token = this.app.secretStorage.getSecret(GITHUB_ACCESS_SECRET) || "";
    if (!token) throw new Error("Connect GitHub first in Expert AI Sync settings.");
    if (this.settings.githubExpiresAt && Date.now() >= this.settings.githubExpiresAt - 60_000) {
      const refresh = this.app.secretStorage.getSecret(GITHUB_REFRESH_SECRET) || "";
      if (!refresh) throw new Error("GitHub authorization expired. Reconnect GitHub in Expert AI Sync settings.");
      const renewed = await refreshGitHubToken(DEFAULT_GITHUB_CLIENT_ID, refresh);
      this.app.secretStorage.setSecret(GITHUB_ACCESS_SECRET, renewed.accessToken);
      if (renewed.refreshToken) this.app.secretStorage.setSecret(GITHUB_REFRESH_SECRET, renewed.refreshToken);
      this.settings.githubExpiresAt = renewed.expiresIn ? Date.now() + renewed.expiresIn * 1000 : 0;
      this.settings.githubRefreshExpiresAt = renewed.refreshExpiresIn ? Date.now() + renewed.refreshExpiresIn * 1000 : 0;
      await this.saveData(this.settings); token = renewed.accessToken;
    }
    return token;
  }
  private async gitBlobSha(bytes: ArrayBuffer) {
    const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    const object = new Uint8Array(header.byteLength + bytes.byteLength); object.set(header); object.set(new Uint8Array(bytes), header.byteLength);
    return bytesToHex(await crypto.subtle.digest("SHA-1", object));
  }
  private async listAdapterDiskPaths() {
    const paths = new Set<string>();
    const walk = async (directory: string): Promise<void> => {
      let listing;
      try { listing = await this.app.vault.adapter.list(directory); } catch { return; }
      for (const path of listing.files) if (validPath(path)) paths.add(path);
      for (const path of listing.folders) {
        const name = path.slice(path.lastIndexOf("/") + 1).toLocaleLowerCase();
        if ([".obsidian", ".git", ".trash", RECOVERY_FOLDER.toLocaleLowerCase()].includes(name)) continue;
        await walk(path);
      }
    };
    await walk("");
    return [...paths];
  }
  private async listLocalGit(remotePaths: string[] = [], forceRehash = false, includeVaultFiles = true) {
    const local = new Map<string, LocalGitItem>();
    const files = includeVaultFiles ? this.app.vault.getFiles().filter((file) => validPath(file.path)).sort((a, b) => a.path.localeCompare(b.path)) : [];
    this.progressTotal = files.length; let done = 0;
    for (const file of files) {
      const sig = signature(file); const cached = this.settings.githubCache[file.path]; const journaled = this.settings.pendingGitPaths.includes(file.path); let sha = !forceRehash && !journaled && cached?.sig === sig ? cached.sha : "";
      if (!sha) { sha = await this.gitBlobSha(await this.app.vault.readBinary(file)); this.settings.githubCache[file.path] = { sig, sha }; }
      local.set(file.path, { file, sha, size: file.stat.size, mtime: file.stat.mtime, sig });
      done++; this.progressDone = done; this.progressText = `Checking GitHub files ${done} of ${files.length}`; if (done % 20 === 0) this.refresh();
    }
    // The Android vault index can lag behind adapter writes and may omit files it
    // does not recognize yet. Inventory the adapter as well so a manual push does
    // not incorrectly report zero changes for newly created on-device files.
    const extraPaths = new Set([...remotePaths, ...this.settings.pendingGitPaths, ...(includeVaultFiles ? await this.listAdapterDiskPaths() : [])]);
    for (const path of extraPaths) {
      const abstract = this.app.vault.getAbstractFileByPath(path);
      if (!validPath(path) || local.has(path) || abstract instanceof TFolder) continue;
      try {
        if (!(abstract instanceof TFile) && !(await this.app.vault.adapter.exists(path))) continue;
        const stat = abstract instanceof TFile ? abstract.stat : await this.app.vault.adapter.stat(path);
        if (!stat) continue;
        const sig = `${stat.mtime}:${stat.size}`;
        const cached = this.settings.githubCache[path];
        const journaled = this.settings.pendingGitPaths.includes(path);
        let sha = !forceRehash && !journaled && cached?.sig === sig ? cached.sha : "";
        if (!sha) sha = await this.gitBlobSha(abstract instanceof TFile ? await this.app.vault.readBinary(abstract) : await this.app.vault.adapter.readBinary(path));
        local.set(path, { file: abstract instanceof TFile ? abstract : null, sha, size: stat.size, mtime: stat.mtime, sig });
        this.settings.githubCache[path] = { sig, sha };
      } catch (error) {
        if (this.settings.pendingGitPaths.includes(path)) this.log("error", `Recorded vault change could not be read: ${path} · ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return local;
  }
  private async applyGitHubFile(path: string, file: GitHubFile | undefined, state: GitHubState, token: string, discardUntracked = false) {
    const current = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      if (current instanceof TFile) { await this.app.vault.trash(current, false); delete this.settings.githubCache[path]; this.log("info", `Moved GitHub-deleted file to Obsidian trash: ${path}`); }
      delete this.settings.githubBase[path];
      return;
    }
    if (file.size > MAX_OBJECT) throw new Error(`${path} exceeds the current 45 MiB per-file mobile sync limit.`);
    const bytes = await getGitHubBlob(state, file.sha, token);
    const downloadedSha = await this.gitBlobSha(bytes);
    if (downloadedSha !== file.sha) throw new Error(`GitHub integrity check failed for ${path}; the file was not written.`);
    if (current instanceof TFolder) {
      if (discardUntracked) await this.app.vault.delete(current, true);
      else {
        const preserved = await this.safeFolderConflictPath(path);
        await this.renameVaultItem(current, preserved, "Preserving a local folder before GitHub pull");
        this.log(`warn`, `Preserved local folder ${path} and its contents as ${preserved}; pulled the GitHub file at the original path.`);
      }
    }
    await this.ensureFolder(path, discardUntracked);
    let destination = this.app.vault.getAbstractFileByPath(path);
    const hiddenPath = path.split("/").some((part) => part.startsWith("."));
    if (discardUntracked && hiddenPath) {
      if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
      await this.app.vault.adapter.writeBinary(path, bytes);
    }
    else if (destination instanceof TFile) await this.app.vault.modifyBinary(destination, bytes);
    else if (!destination && await this.app.vault.adapter.exists(path)) {
      // Android can have a file on disk that has not entered Obsidian's file cache yet.
      // Preserve it visibly, remove the stale disk entry, then create through Vault so
      // Obsidian registers the canonical file and the next sync does not mistake it for absent.
      let diskBytes: ArrayBuffer;
      try { diskBytes = await this.app.vault.adapter.readBinary(path); }
      catch { throw new Error(`A folder or unreadable file already occupies ${path}. Use Rebuild from GitHub to preserve and reconcile it safely.`); }
      const diskSha = await this.gitBlobSha(diskBytes);
      if (diskSha !== file.sha && !discardUntracked) {
        const savedPath = await this.preserveRecoveryBytes(path, diskBytes);
        this.log("warn", `Preserved an untracked on-device file from ${path} at ${savedPath}.`);
      }
      await this.app.vault.adapter.remove(path);
      await this.app.vault.createBinary(path, bytes);
    }
    else if (!destination) await this.app.vault.createBinary(path, bytes);
    else throw new Error(`Cannot pull ${path}: another vault item occupies the destination. Local data was left unchanged.`);
    let updated = this.app.vault.getAbstractFileByPath(path);
    let writtenSha = await this.gitBlobSha(await this.app.vault.adapter.readBinary(path));
    if (writtenSha !== file.sha) {
      if (updated instanceof TFile) await this.app.vault.modifyBinary(updated, bytes);
      else await this.app.vault.adapter.writeBinary(path, bytes);
      updated = this.app.vault.getAbstractFileByPath(path);
      writtenSha = await this.gitBlobSha(await this.app.vault.adapter.readBinary(path));
    }
    if (writtenSha !== file.sha) {
      await this.app.vault.adapter.writeBinary(path, bytes);
      if (updated instanceof TFile) await this.app.vault.modifyBinary(updated, bytes);
      updated = this.app.vault.getAbstractFileByPath(path);
      writtenSha = await this.gitBlobSha(await this.app.vault.adapter.readBinary(path));
    }
    if ((!(updated instanceof TFile) && !hiddenPath) || writtenSha !== file.sha) throw new Error(`GitHub integrity check failed after two verified writes to ${path} (expected ${file.sha.slice(0, 10)}, read ${writtenSha.slice(0, 10)}). Retry after pausing other vault-sync plugins.`);
    const stat = updated instanceof TFile ? updated.stat : await this.app.vault.adapter.stat(path);
    this.settings.githubCache[path] = { sig: updated instanceof TFile ? signature(updated) : `${stat?.mtime || 0}:${stat?.size || bytes.byteLength}`, sha: file.sha };
    this.settings.githubBase[path] = file.sha;
    this.log("info", `Pulled ${path}`);
  }
  private async rebuildVaultFromGitHub(state: GitHubState, token: string, local: Map<string, LocalGitItem>) {
    const remoteEntries = Object.entries(state.files).filter(([path]) => validPath(path));
    if (!remoteEntries.length && local.size) throw new Error("GitHub returned an empty vault while this phone has local files. Rebuild stopped without changing anything; verify the repository and branch first.");
    const tooLarge = remoteEntries.filter(([, item]) => item.size > MAX_OBJECT).map(([path]) => path);
    if (tooLarge.length) throw new Error(`Rebuild stopped before changing this phone: ${tooLarge.length} GitHub file(s) exceed the 45 MiB mobile limit. First file: ${tooLarge[0]}.`);

    // A previous backup-first rebuild may have left copies from an earlier attempt.
    // This explicit GitHub-wins action is authorized to clear them too.
    await this.removeLocalPathTree(RECOVERY_FOLDER);

    const remoteHashes = new Set(remoteEntries.map(([, item]) => item.sha));
    const exactPaths = new Set(remoteEntries.map(([path, item]) => local.get(path)?.sha === item.sha ? path : "").filter(Boolean));
    const displaced = [...local].filter(([path]) => !exactPaths.has(path));
    const estimatedWork = displaced.length + remoteEntries.length;
    this.progressTotal = Math.max(1, estimatedWork); this.progressDone = 0;
    this.progressText = `Removing outdated phone files · 0 of ${estimatedWork}`; this.refresh();

    const moveCandidates = new Map<string, { file: TFile; sha: string }>();
    const localByHash = new Map<string, Array<{ path: string; file: TFile; sha: string }>>();
    for (const [path, item] of local) if (item.file instanceof TFile) localByHash.set(item.sha, [...(localByHash.get(item.sha) || []), { path, file: item.file, sha: item.sha }]);
    const remoteByHash = new Map<string, string[]>();
    for (const [path, item] of remoteEntries) remoteByHash.set(item.sha, [...(remoteByHash.get(item.sha) || []), path]);
    for (const [sha, localMatches] of localByHash) {
      const remoteMatches = remoteByHash.get(sha) || [];
      if (localMatches.length !== 1 || remoteMatches.length !== 1) continue;
      const source = localMatches[0]; const target = remoteMatches[0];
      if (source.path !== target && !exactPaths.has(source.path)) moveCandidates.set(target, { file: source.file, sha });
    }

    let removed = 0;
    for (const [path, item] of displaced) {
      if (this.settings.paused) throw new Error("Rebuild paused after removing some outdated phone files. Retry Rebuild from GitHub to finish downloading the remote vault.");
      const moveTarget = [...moveCandidates.values()].some((candidate) => candidate.file === item.file);
      if (!moveTarget) {
        const current = this.app.vault.getAbstractFileByPath(path);
        if (current instanceof TFile) await this.app.vault.delete(current, true);
        else if (!current && await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
        delete this.settings.githubCache[path];
        removed++;
      }
      this.progressDone++; this.progressText = `Removing outdated phone files · ${this.progressDone} of ${estimatedWork}`;
      if (this.progressDone % 20 === 0 || this.progressDone >= displaced.length) { await this.saveData(this.settings); this.refresh(); }
    }

    await this.pruneEmptyLocalFolders(this.remoteDirectoryPaths(remoteEntries.map(([path]) => path)));
    let relocated = 0;
    for (const [target, candidate] of moveCandidates) {
      if (this.app.vault.getAbstractFileByPath(target)) continue;
      await this.ensureFolder(target, true);
      await this.renameVaultItem(candidate.file, target, "Moving an unchanged local copy to GitHub's current path");
      relocated++;
      this.log("info", `Moved matching content to GitHub's path: ${target}`);
    }

    let pulled = 0;
    for (const [path, remote] of remoteEntries) {
      if (this.settings.paused) throw new Error("Rebuild paused while fetching GitHub files. Retry Rebuild from GitHub to finish matching the remote vault.");
      const current = this.app.vault.getAbstractFileByPath(path);
      if (!exactPaths.has(path) && !moveCandidates.has(path)) {
        if (!(current instanceof TFile) || await this.gitBlobSha(await this.app.vault.readBinary(current)) !== remote.sha) {
          await this.applyGitHubFile(path, remote, state, token, true); pulled++;
        }
      }
      this.progressDone++; this.progressText = `Matching GitHub vault · ${this.progressDone} of ${estimatedWork}`;
      if (this.progressDone % 20 === 0 || this.progressDone >= estimatedWork) { await this.saveData(this.settings); this.refresh(); }
    }
    await this.pruneEmptyLocalFolders(this.remoteDirectoryPaths(remoteEntries.map(([path]) => path)));
    return { pulled, removed, relocated };
  }

  private async pruneEmptyLocalFolders(remoteDirectories: Set<string>) {
    const protectedRoots = [".obsidian", ".trash", ".git"].map((path) => path.toLocaleLowerCase());
    const folders = this.app.vault.getAllLoadedFiles().filter((item): item is TFolder => item instanceof TFolder)
      .sort((a, b) => b.path.length - a.path.length);
    for (const folder of folders) {
      const lower = folder.path.toLocaleLowerCase();
      if (!folder.path || folder.children.length || remoteDirectories.has(folder.path)
        || protectedRoots.some((root) => lower === root || lower.startsWith(`${root}/`))) continue;
      await this.app.vault.delete(folder, true).catch(() => {});
    }
    await this.pruneEmptyHiddenDiskFolders(remoteDirectories);
  }

  private async pruneEmptyHiddenDiskFolders(remoteDirectories: Set<string>) {
    const protectedNames = new Set([".obsidian", ".git", ".trash", RECOVERY_FOLDER.toLocaleLowerCase()]);
    const removeEmpty = async (directory: string): Promise<void> => {
      let listing;
      try { listing = await this.app.vault.adapter.list(directory); } catch { return; }
      for (const child of listing.folders) {
        const name = child.slice(child.lastIndexOf("/") + 1).toLocaleLowerCase();
        if (protectedNames.has(name)) continue;
        await removeEmpty(child);
      }
      const remaining = await this.app.vault.adapter.list(directory).catch(() => null);
      if (remaining && !remaining.files.length && !remaining.folders.length && !remoteDirectories.has(directory)) {
        await this.app.vault.adapter.remove(directory).catch(() => {});
      }
    };
    const root = await this.app.vault.adapter.list("").catch(() => null);
    for (const directory of root?.folders || []) {
      const name = directory.slice(directory.lastIndexOf("/") + 1).toLocaleLowerCase();
      if (name.startsWith(".") && !protectedNames.has(name)) await removeEmpty(directory);
    }
  }

  private async removeLocalPathTree(path: string) {
    const item = this.app.vault.getAbstractFileByPath(path);
    if (item instanceof TFile) { await this.app.vault.delete(item, true); return; }
    if (item instanceof TFolder) {
      for (const child of [...item.children]) await this.removeLocalPathTree(child.path);
      await this.app.vault.delete(item, true);
      return;
    }
    if (!(await this.app.vault.adapter.exists(path))) return;
    try {
      const listing = await this.app.vault.adapter.list(path);
      for (const file of listing.files) await this.app.vault.adapter.remove(file);
      for (const folder of listing.folders) await this.removeLocalPathTree(folder);
      await this.app.vault.adapter.remove(path);
    } catch { await this.app.vault.adapter.remove(path); }
  }
  async syncGitHub(manual = true, mode: "sync" | "pull" | "push" | "rebuild" = "sync", forceFullScan = false) {
    if (this.syncing || (this.settings.paused && !manual) || (!manual && !this.settings.autoSync)) return;
    if (!manual && !this.settings.githubJournalReady && mode !== "rebuild") return;
    const connected = !!this.app.secretStorage.getSecret(GITHUB_ACCESS_SECRET);
    if (!connected || !this.settings.githubRepoUrl) { if (manual) { this.openSettings(); new Notice("Connect GitHub and choose a repository in Expert AI Sync settings."); } return; }
    if (!this.settings.githubRepoVerified) { if (manual) { this.openSettings(); new Notice("Verify the GitHub repository and branch in Expert AI Sync settings first."); } return; }
    if (mode === "sync" && !Object.keys(this.settings.githubBase).length) {
      if (manual) new Notice("This phone has no GitHub sync baseline yet. Use Rebuild from GitHub to safely align it; changed local files will be recoverable first.", 10_000);
      return;
    }
    this.retryAfterConflict = false; this.syncing = true; this.progressDone = 0; this.progressTotal = 1; this.progressText = "Connecting to GitHub…"; this.refresh();
    let pushed = 0, pulled = 0, conflicts = 0, skipped = 0;
    try {
      parseGitHubRepo(this.settings.githubRepoUrl);
      const token = await this.githubAccessToken();
      let state = await getGitHubState(this.settings.githubRepoUrl, token, this.settings.githubBranch);
      for (const path of Object.keys(state.files)) if (!validPath(path)) delete state.files[path];
      this.settings.githubBranch = state.branch; this.log("info", `Reading GitHub branch ${state.branch} at ${state.head.slice(0, 7)}.`);
      const relocatedPaths = mode === "rebuild" ? new Set<string>() : await this.prepareRemoteDestinations(Object.keys(state.files), mode, "GitHub");
      const remotePathList = Object.keys(state.files);
      const remoteDirectories = this.remoteDirectoryPaths(remotePathList);
      const baselineBeforeScan = this.settings.githubBase || {};
      const remoteChangedPaths = new Set([...Object.keys(state.files), ...Object.keys(baselineBeforeScan)]
        .filter((path) => (state.files[path]?.sha || null) !== (baselineBeforeScan[path] || null)));
      const useJournal = this.settings.githubJournalReady && !forceFullScan && mode !== "rebuild";
      const scanPaths = useJournal ? new Set([...this.settings.pendingGitPaths, ...remoteChangedPaths]) : new Set([...Object.keys(state.files), ...Object.keys(baselineBeforeScan)]);
      const local = await this.listLocalGit([...scanPaths], true, !useJournal);
      this.progressText = useJournal
        ? `Journal sync · checked ${local.size} changed files · ${this.settings.pendingGitPaths.length} pending vault events`
        : `Full vault scan complete · checked ${local.size} files · change journal initialized`;
      this.refresh();
      if (mode === "rebuild") {
        const result = await this.rebuildVaultFromGitHub(state, token, local);
        const nextCache: Settings["githubCache"] = {};
        for (const path of Object.keys(state.files)) {
          const current = this.app.vault.getAbstractFileByPath(path);
          if (current instanceof TFile) nextCache[path] = { sig: signature(current), sha: state.files[path].sha };
          else {
            const stat = await this.app.vault.adapter.stat(path);
            if (stat) nextCache[path] = { sig: `${stat.mtime}:${stat.size}`, sha: state.files[path].sha };
          }
        }
        this.settings.githubBase = Object.fromEntries(Object.entries(state.files).map(([path, item]) => [path, item.sha]));
        this.settings.githubCache = nextCache; this.settings.githubHead = state.head; this.settings.githubBranch = state.branch;
        this.settings.githubJournalReady = true; this.settings.pendingGitPaths = [];
        this.settings.conflicts = this.settings.conflicts.filter((entry) => entry.backend !== "github");
        const report = `GitHub rebuild complete · ${result.pulled} downloaded · ${result.relocated} unchanged files moved into the current layout · ${result.removed} outdated phone files removed.`;
        this.settings.lastSync = Date.now(); this.settings.lastReport = report; this.log("ok", report);
        await this.saveData(this.settings); this.progressText = report; new Notice(report, 12_000);
        return;
      }
      if (this.settings.githubHead && this.settings.githubHead !== state.head) {
        try {
          const renameInfo = await getGitHubRenames(this.settings.githubRepoUrl, token, this.settings.githubHead, state.head);
          if (renameInfo.capped) this.log("warn", "GitHub reported at least 300 changed paths; using content hashes and unique names as fallback for renames beyond that window.");
          for (const rename of renameInfo.renames) {
            if (!validPath(rename.from) || !validPath(rename.to) || !state.files[rename.to]) continue;
            const item = local.get(rename.from);
            if (!item || !(item.file instanceof TFile) || local.has(rename.to) || this.app.vault.getAbstractFileByPath(rename.to)) continue;
            if (item.sha !== state.files[rename.to].sha) {
              this.addConflict({ id: crypto.randomUUID(), path: rename.from, alternatePath: rename.to, backend: "github", reason: "move" });
              this.log("warn", `GitHub moved ${rename.from} to ${rename.to}, and the file contents differ. Both versions are kept for your review.`);
              relocatedPaths.add(rename.to);
              continue;
            }
            await this.ensureFolder(rename.to);
            await this.renameVaultItem(item.file, rename.to, "Following a GitHub-recorded rename");
            local.delete(rename.from);
            const moved = this.app.vault.getAbstractFileByPath(rename.to);
            if (moved instanceof TFile) { local.set(rename.to, { ...item, file: moved, sig: signature(moved) }); this.settings.githubCache[rename.to] = { sig: signature(moved), sha: item.sha }; }
            await this.pruneEmptyParents(rename.from, remoteDirectories, "GitHub");
            this.log("info", `Followed GitHub rename ${rename.from} → ${rename.to}.`);
          }
        } catch (error) {
          this.log("warn", `Could not read GitHub rename metadata; content-hash and unique-name matching will continue: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const remoteHashPaths = new Map<string, string[]>();
      for (const [path, entry] of Object.entries(state.files)) remoteHashPaths.set(entry.sha, [...(remoteHashPaths.get(entry.sha) || []), path]);
      for (const [oldPath, item] of [...local]) {
        const destinations = remoteHashPaths.get(item.sha) || [];
        if (!(item.file instanceof TFile) || !destinations.length || destinations.includes(oldPath) || state.files[oldPath]) continue;
        const target = destinations.find((path) => !local.has(path) && !this.app.vault.getAbstractFileByPath(path)); if (!target) continue;
        await this.ensureFolder(target); await this.renameVaultItem(item.file, target, "Following a GitHub file move"); local.delete(oldPath);
        const moved = this.app.vault.getAbstractFileByPath(target);
        if (moved instanceof TFile) { local.set(target, { file: moved, sha: item.sha, size: moved.stat.size, mtime: moved.stat.mtime, sig: signature(moved) }); this.settings.githubCache[target] = { sig: signature(moved), sha: item.sha }; }
        this.log("info", `Recognized GitHub move: ${oldPath} → ${target}`);
        relocatedPaths.add(target); await this.pruneEmptyParents(oldPath, remoteDirectories, "GitHub");
      }
      const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLocaleLowerCase();
      const remoteNames = new Map<string, string[]>();
      for (const path of Object.keys(state.files)) remoteNames.set(basename(path), [...(remoteNames.get(basename(path)) || []), path]);
      const localNames = new Map<string, string[]>();
      for (const path of local.keys()) localNames.set(basename(path), [...(localNames.get(basename(path)) || []), path]);
      for (const [oldPath, item] of [...local]) {
        const matches = remoteNames.get(basename(oldPath)) || [];
        if (matches.length !== 1 || matches[0] === oldPath || local.has(matches[0]) || this.app.vault.getAbstractFileByPath(matches[0]) || state.files[oldPath]) continue;
        const knownOldLocation = !!this.settings.githubBase[oldPath]; const freshDevice = !Object.keys(this.settings.githubBase).length;
        if (!knownOldLocation && !freshDevice || (localNames.get(basename(oldPath)) || []).length !== 1) continue;
        const target = matches[0];
        this.addConflict({ id: crypto.randomUUID(), path: oldPath, alternatePath: target, backend: "github", reason: "move" });
        relocatedPaths.add(target);
        this.log("warn", `Possible move ${oldPath} → ${target}; both versions are kept for your review.`);
      }

      const base = this.settings.githubBase || {}; const allPaths = useJournal ? scanPaths : new Set([...Object.keys(local), ...Object.keys(state.files), ...Object.keys(base)]);
      const plan: Array<{ path: string; action: "push" | "pull" | "delete" | "conflict"; remote?: GitHubFile; local?: NonNullable<ReturnType<typeof local.get>> }> = [];
      for (const path of allPaths) {
        if (!validPath(path) || this.settings.conflicts.some((conflict) => conflict.backend === "github" && conflict.path === path)) continue;
        const l = local.get(path), r = state.files[path], b = base[path] || null;
        const localSha = l?.sha || null, remoteSha = r?.sha || null;
        const baseSha = relocatedPaths.has(path) ? null : b;
        if (mode === "pull" && !baseSha && l && !r) {
          this.addConflict({ id: crypto.randomUUID(), path, backend: "github", reason: "first-pull" });
          conflicts++;
          this.log("warn", `First pull kept this local-only file for review: ${path}. Choose whether to publish it or move it to Obsidian trash.`);
          continue;
        }
        const localChanged = localSha !== baseSha, remoteChanged = remoteSha !== baseSha;
        if (localSha === remoteSha) continue;
        if (!localChanged && remoteChanged) plan.push({ path, action: "pull", remote: r });
        else if (localChanged && !remoteChanged) plan.push({ path, action: l ? "push" : "delete", local: l });
        else if (localChanged && remoteChanged) plan.push({ path, action: "conflict", remote: r, local: l });
      }
      const localJournalDiffs = this.settings.pendingGitPaths.filter((path) => (local.get(path)?.sha || null) !== (state.files[path]?.sha || null));
      if (manual && mode === "push") {
        this.log(localJournalDiffs.length ? "info" : "warn", `Push preflight · ${this.settings.pendingGitPaths.length} journaled paths · ${localJournalDiffs.length} differ from GitHub${localJournalDiffs.length ? ` · ${localJournalDiffs.slice(0, 12).join(", ")}` : ""}`);
      }
      this.progressTotal = Math.max(1, plan.length); this.progressDone = 0; this.progressText = plan.length ? `Reconciling ${plan.length} GitHub changes…` : "Comparing GitHub and this vault…"; this.refresh();
      const staged = new Map<string, GitHubChange>(); const keepBasePaths = new Set<string>();
      for (const item of plan) {
        if (this.settings.paused) throw new Error("Sync paused. Local files and GitHub commits are preserved; resume to continue.");
        try {
          if (mode === "pull" && (item.action === "push" || item.action === "delete")) { keepBasePaths.add(item.path); }
          else if (mode === "push" && item.action === "pull") { keepBasePaths.add(item.path); }
          else if (item.action === "pull") { await this.applyGitHubFile(item.path, item.remote, state, token); if (item.remote) pulled++; }
          else if (item.action === "push" && item.local) { staged.set(item.path, { path: item.path, sha: item.local.sha }); pushed++; }
          else if (item.action === "delete") { staged.set(item.path, { path: item.path, deleted: true }); pushed++; }
          else if (item.action === "conflict") {
            if (item.local && item.remote) {
              const alternatePath = await this.safeConflictPath(item.path); const cloudBytes = await getGitHubBlob(state, item.remote.sha, token);
              if (await this.gitBlobSha(cloudBytes) !== item.remote.sha) throw new Error(`GitHub integrity check failed for the other version of ${item.path}.`);
              await this.ensureFolder(alternatePath); await this.app.vault.createBinary(alternatePath, cloudBytes);
              const alternateFile = this.app.vault.getAbstractFileByPath(alternatePath);
              if (alternateFile instanceof TFile) {
                const sha = await this.gitBlobSha(cloudBytes); this.settings.githubCache[alternatePath] = { sig: signature(alternateFile), sha };
                if (mode !== "pull") { staged.set(alternatePath, { path: alternatePath, sha }); pushed++; }
              }
              if (mode !== "pull") { staged.set(item.path, { path: item.path, sha: item.local.sha }); pushed++; }
              this.addConflict({ id: crypto.randomUUID(), path: item.path, alternatePath, backend: "github" });
              conflicts++; pulled++; this.log("warn", `Both devices changed ${item.path}; saved the GitHub version as ${alternatePath}.`);
            } else if (!item.local && item.remote) {
              await this.applyGitHubFile(item.path, item.remote, state, token);
              this.addConflict({ id: crypto.randomUUID(), path: item.path, backend: "github" }); conflicts++; pulled++;
              this.log("warn", `A local deletion conflicted with a GitHub edit. Kept the GitHub file ${item.path}.`);
            } else if (item.local && !item.remote) {
              this.addConflict({ id: crypto.randomUUID(), path: item.path, backend: "github", reason: "deleted" }); conflicts++;
              this.log("warn", `GitHub no longer has ${item.path}, but this phone still has a changed local copy. Waiting for your choice.`);
            }
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("45 MiB")) { skipped++; keepBasePaths.add(item.path); this.log("warn", error.message); }
          else throw new Error(`GitHub ${item.action} failed for ${item.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.progressDone++; this.progressText = `Updated ${this.progressDone} of ${this.progressTotal} · ${pushed} to GitHub · ${pulled} pulled`;
        if (this.progressDone % 10 === 0 || this.progressDone === this.progressTotal) await this.saveData(this.settings);
        if (this.progressDone % 5 === 0 || this.progressDone === this.progressTotal) this.refresh();
      }
      if (staged.size) {
        const commit = await commitGitHubChanges(state, token, [...staged.values()], defaultCommitMessage(), async (path) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) return this.app.vault.readBinary(file);
          if (await this.app.vault.adapter.exists(path)) return this.app.vault.adapter.readBinary(path);
          throw new Error(`Could not commit ${path}; it is no longer in the vault.`);
        });
        this.log("ok", `GitHub commit created · ${staged.size} files · ${commit.message} · ${commit.commitSha.slice(0, 7)}`);
        state = await getGitHubState(this.settings.githubRepoUrl, token, state.branch);
      }
      const journalPathsAtFinalize = new Set(this.settings.pendingGitPaths);
      const finalLocal = useJournal
        ? await this.listLocalGit([...new Set([...scanPaths, ...journalPathsAtFinalize])], true, false)
        : await this.listLocalGit(Object.keys(state.files));
      const nextBase = Object.fromEntries(Object.entries(state.files).map(([path, entry]) => [path, entry.sha]));
      for (const path of keepBasePaths) { if (base[path]) nextBase[path] = base[path]; else delete nextBase[path]; }
      this.settings.githubBase = nextBase; this.settings.githubHead = state.head; this.settings.githubBranch = state.branch;
      for (const [path, item] of finalLocal) this.settings.githubCache[path] = { sig: item.sig, sha: item.sha };
      if (!useJournal) this.settings.githubJournalReady = true;
      this.settings.pendingGitPaths = this.settings.pendingGitPaths.filter((path) => {
        if (!journalPathsAtFinalize.has(path)) return true;
        return (finalLocal.get(path)?.sha || null) !== (state.files[path]?.sha || null);
      });
      const pendingReviews = this.settings.conflicts.filter((conflict) => conflict.backend === "github" && (conflict.reason === "move" || conflict.reason === "deleted" || conflict.reason === "first-pull")).length;
      const report = pushed === 0 && pulled === 0 && conflicts === 0 && skipped === 0 && relocatedPaths.size === 0 && pendingReviews === 0
        ? mode === "push" ? useJournal ? `No changed files to commit · checked ${local.size} journaled or remotely changed paths; ${this.settings.pendingGitPaths.length} local change paths remain pending.` : `No local changes to commit or push · full scan checked ${local.size} files; future pushes will use the file-change journal.` : mode === "pull" ? "No newer GitHub files to pull." : "GitHub vault is up to date."
        : `${pushed} committed/pushed · ${pulled} pulled${conflicts ? ` · ${conflicts} conflict${conflicts === 1 ? "" : "s"} preserved` : ""}${pendingReviews ? ` · ${pendingReviews} item${pendingReviews === 1 ? "" : "s"} awaiting your review` : ""}${relocatedPaths.size ? ` · ${relocatedPaths.size} path${relocatedPaths.size === 1 ? "" : "s"} reconciled with local data preserved` : ""}${skipped ? ` · ${skipped} skipped` : ""}`;
      this.settings.lastSync = Date.now(); this.settings.lastReport = report; this.log(skipped ? "warn" : "ok", report);
      await this.saveData(this.settings); this.progressText = report; new Notice(report);
    } catch (error) {
      const message = error instanceof Error ? error.message : "GitHub sync did not finish.";
      this.settings.lastReport = message; this.log("error", message); await this.saveData(this.settings); new Notice(message);
    } finally {
      this.syncing = false; this.progressText = this.settings.lastReport; this.refresh();
    }
  }
  async connectGitHub() {
    const clientId = DEFAULT_GITHUB_CLIENT_ID;
    if (!clientId) { this.openSettings(); new Notice("Add the Expert AI GitHub App client ID in settings first."); return; }
    try { parseGitHubRepo(this.settings.githubRepoUrl); }
    catch (error) { this.openSettings(); new Notice(error instanceof Error ? error.message : "Enter your GitHub repository first."); return; }
    let modal: GitHubDeviceModal | undefined;
    try {
      const device = await requestDeviceCode(clientId);
      modal = new GitHubDeviceModal(this.app, device.userCode, device.verificationUri); modal.open();
      modal.setStatus("Enter the code on GitHub. This screen will connect automatically after approval.");
      const deadline = Date.now() + device.expiresIn * 1000; let interval = device.interval; let networkRetries = 0;
      while (Date.now() < deadline && !modal.cancelled) {
        await this.waitForDevicePoll(interval * 1000, modal);
        if (modal.cancelled) break;
        let result;
        try { result = await pollDeviceToken(clientId, device.deviceCode); }
        catch (error) {
          if (!isTransientGitHubNetworkError(error)) throw error;
          networkRetries++;
          interval = Math.min(30, Math.max(interval + 5, interval * 2));
          modal.setStatus(`The phone temporarily cannot reach GitHub (network/DNS). Keeping this code and retrying in ${interval}s · attempt ${networkRetries}.`);
          this.log("warn", `GitHub authorization network retry ${networkRetries}: ${error instanceof Error ? error.message : "temporary network error"}`);
          continue;
        }
        if (result.pending) {
          const recovered = networkRetries > 0; networkRetries = 0; interval = result.interval || interval;
          modal.setStatus(recovered ? "GitHub is reachable again. Still waiting for approval; this code remains active." : "Waiting for GitHub approval…"); continue;
        }
        this.app.secretStorage.setSecret(GITHUB_ACCESS_SECRET, result.accessToken);
        if (result.refreshToken) this.app.secretStorage.setSecret(GITHUB_REFRESH_SECRET, result.refreshToken);
        this.settings.githubExpiresAt = result.expiresIn ? Date.now() + result.expiresIn * 1000 : 0;
        this.settings.githubRefreshExpiresAt = result.refreshExpiresIn ? Date.now() + result.refreshExpiresIn * 1000 : 0;
        this.settings.githubLogin ||= "GitHub account";
        this.settings.githubRepoVerified = false;
        await this.saveSettings(); this.refresh();
        modal.setStatus("GitHub approved. Confirming the account and checking repository access…");
        try {
          const login = await this.retryGitHubRequest("Identifying your GitHub account", modal, () => getGitHubLogin(result.accessToken));
          this.settings.githubLogin = login || "GitHub account";
          await this.saveSettings(); this.refresh();
          modal.setStatus(`GitHub approved as ${this.settings.githubLogin}. Checking ${this.settings.githubRepoUrl}…`);
          const repoState = await getGitHubBranchInfo(this.settings.githubRepoUrl, result.accessToken, this.settings.githubBranch);
          this.settings.githubBranch = repoState.branch; this.settings.githubHead = repoState.head; this.settings.githubRepoVerified = true;
          await this.saveSettings(); modal.close(); this.log("ok", `GitHub connected · ${this.settings.githubLogin} · ${this.settings.githubRepoUrl} · ${repoState.branch}`); new Notice("GitHub connected.");
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Could not read the repository branch.";
          this.settings.githubRepoVerified = false; await this.saveSettings(); this.refresh();
          modal.setStatus(isTransientGitHubNetworkError(error)
            ? `GitHub authorization is saved${this.settings.githubLogin === "GitHub account" ? "" : ` for ${this.settings.githubLogin}`}, but the phone cannot reach GitHub to finish verification: ${detail} Reconnect to the internet and tap Verify repository in Settings.`
            : `GitHub is connected as ${this.settings.githubLogin}, but repository access needs attention: ${detail}`);
          this.log("error", `GitHub account connected, repository check failed: ${detail}`);
          new Notice(isTransientGitHubNetworkError(error) ? `GitHub sign-in saved; network interrupted repository verification. Retry Verify repository when online.` : `GitHub account connected; repository check failed: ${detail}`, 10_000);
        }
        return;
      }
      if (!modal.cancelled) { const message = "This GitHub code expired. Tap Connect GitHub to request another."; modal.setStatus(message); new Notice(message); }
    } catch (error) {
      const message = error instanceof Error ? error.message : "GitHub connection failed.";
      if (modal && !modal.cancelled) modal.setStatus(`GitHub connection failed: ${message}`);
      this.log("error", `GitHub connection failed: ${message}`); this.refresh(); new Notice(message, 10_000);
    }
  }
  async verifyGitHubRepository() {
    try {
      parseGitHubRepo(this.settings.githubRepoUrl);
      const token = await this.githubAccessToken();
      const login = await getGitHubLogin(token);
      const state = await getGitHubBranchInfo(this.settings.githubRepoUrl, token, this.settings.githubBranch);
      this.settings.githubLogin = login || this.settings.githubLogin; this.settings.githubBranch = state.branch; this.settings.githubHead = state.head; this.settings.githubRepoVerified = true;
      await this.saveSettings(); this.log("ok", `GitHub repository verified · ${this.settings.githubRepoUrl} · ${state.branch}`); new Notice(`Repository verified · ${state.branch}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not verify repository access.";
      this.settings.githubRepoVerified = false; await this.saveSettings(); this.log("error", `GitHub repository check failed: ${message}`); new Notice(message, 10_000);
    }
    this.refresh();
  }
  private async retryGitHubRequest<T>(label: string, modal: GitHubDeviceModal, request: () => Promise<T>) {
    let delayMs = 2000;
    for (let attempt = 1; ; attempt++) {
      try { return await request(); }
      catch (error) {
        if (!isTransientGitHubNetworkError(error) || attempt >= 8 || modal.cancelled) throw error;
        modal.setStatus(`${label} hit a temporary network/DNS error. Retrying in ${Math.round(delayMs / 1000)}s · attempt ${attempt}/8…`);
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        delayMs = Math.min(15_000, delayMs * 2);
      }
    }
  }
  private waitForDevicePoll(intervalMs: number, modal: GitHubDeviceModal) {
    return new Promise<void>((resolve) => {
      let finished = false;
      const dueAt = Date.now() + intervalMs;
      let timer: number;
      const finish = () => {
        if (finished) return; finished = true;
        window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); resolve();
      };
      const checkDue = () => {
        if (modal.cancelled || Date.now() >= dueAt) { finish(); return; }
        timer = window.setTimeout(checkDue, Math.max(100, dueAt - Date.now()));
      };
      const onVisibility = () => { if (document.visibilityState === "visible") checkDue(); };
      timer = window.setTimeout(checkDue, intervalMs);
      document.addEventListener("visibilitychange", onVisibility);
      if (modal.cancelled) finish();
    });
  }
  async disconnectGitHub() {
    this.app.secretStorage.setSecret(GITHUB_ACCESS_SECRET, ""); this.app.secretStorage.setSecret(GITHUB_REFRESH_SECRET, "");
    this.settings.githubLogin = ""; this.settings.githubRepoVerified = false; this.settings.githubExpiresAt = 0; this.settings.githubRefreshExpiresAt = 0;
    await this.saveSettings(); this.log("info", "GitHub disconnected on this device.");
  }
  async startLogin(email: string) {
    if (!email.includes("@")) throw new Error("Enter a valid email address.");
    const result = await this.call("/auth/native/email/start", { method: "POST", body: JSON.stringify({ email }) });
    if (!result.nonce) throw new Error(result.error || "Could not start sign-in.");
    this.settings.email = email.toLowerCase(); this.settings.nonce = result.nonce; await this.saveSettings(); return `Code sent to ${email}.`;
  }
  async verifyLogin(email: string, code: string) {
    if (!this.settings.nonce) throw new Error("Request a code first.");
    const result = await this.call("/auth/native/email/verify", { method: "POST", body: JSON.stringify({ nonce: this.settings.nonce, code }) });
    if (!result.token) throw new Error(result.error || "Could not verify sign-in.");
    this.settings.email = email.toLowerCase(); this.settings.token = result.token; this.settings.nonce = ""; await this.saveSettings(); this.log("ok", "Connected to Expert AI.");
  }
  private async call(path: string, init: { method?: string; body?: string | ArrayBuffer; headers?: Record<string, string> } = {}) {
    const response = await requestUrl({ url: `${API}${path}`, method: init.method || "GET", body: init.body, contentType: typeof init.body === "string" ? "application/json" : undefined, headers: { ...(this.settings.token ? { authorization: `Bearer ${this.settings.token}` } : {}), ...(init.headers || {}) }, throw: false });
    const data = response.json as Record<string, any>;
    if (response.status < 200 || response.status >= 300) throw new Error(data?.error || `Sync request failed (${response.status}).`);
    return data;
  }
  private async vaultId() {
    const key = this.settings.syncKey.trim();
    if (!key) throw new Error("Set a Sync vault key in Expert AI Sync settings. Use the same key on your other devices.");
    return stableVaultId(key);
  }
  private async getManifest(vaultId: string): Promise<Manifest> { const r = await this.call(`/v1/vault/sync/manifest?vaultId=${vaultId}`); return r.manifest; }
  private async listLocal() {
    const out = new Map<string, { file: TFile; hash: string; size: number; mtime: number }>();
    const files = this.app.vault.getFiles().filter((file) => validPath(file.path)).sort((a, b) => a.path.localeCompare(b.path));
    this.progressTotal = files.length; let done = 0;
    for (const file of files) {
      const sig = signature(file); const cached = this.settings.cache[file.path]; let hash = cached?.sig === sig ? cached.hash : "";
      if (!hash) { const raw = await this.app.vault.readBinary(file); hash = await digest(raw); this.settings.cache[file.path] = { sig, hash }; }
      out.set(file.path, { file, hash, size: file.stat.size, mtime: file.stat.mtime }); done++;
      this.progressDone = done; this.progressText = `Checking files ${done} of ${files.length}`; if (done % 20 === 0) this.refresh();
    }
    return out;
  }
  private async ensureFolder(path: string, discardUntracked = false) {
    const parts = path.split("/"); parts.pop(); let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      let existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) {
        if (!discardUntracked) throw new Error(`Cannot create destination folder ${current}: a note already uses that path. The note and synced files were left unchanged.`);
        await this.app.vault.delete(existing, true);
        existing = null;
      }
      if (!existing) {
        if (await this.app.vault.adapter.exists(current)) {
          try { await this.app.vault.adapter.list(current); continue; }
          catch {
            if (!discardUntracked) throw new Error(`A file already occupies folder path ${current} on this device. Use Rebuild from GitHub to replace local content safely.`);
            await this.app.vault.adapter.remove(current);
          }
        }
        try { await this.app.vault.createFolder(current); }
        catch (error) {
          if (await this.app.vault.adapter.exists(current)) {
            try { await this.app.vault.adapter.list(current); continue; } catch { /* report the original create error */ }
          }
          throw error;
        }
      }
    }
  }
  private async renameVaultItem(item: TFile | TFolder, destination: string, reason: string) {
    const source = item.path;
    try { await this.app.fileManager.renameFile(item, destination); }
    catch (error) { throw new Error(`${reason} failed (${source} → ${destination}): ${error instanceof Error ? error.message : String(error)}`); }
  }
  private remoteDirectoryPaths(paths: string[]) {
    const directories = new Set<string>();
    for (const path of paths) {
      let index = path.indexOf("/");
      while (index >= 0) { directories.add(path.slice(0, index)); index = path.indexOf("/", index + 1); }
    }
    return directories;
  }
  private async pruneEmptyParents(filePath: string, remoteDirectories: Set<string>, backend: "GitHub" | "Supabase") {
    let folderPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    while (folderPath) {
      if (remoteDirectories.has(folderPath)) break;
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (!(folder instanceof TFolder) || folder.children.length) break;
      try { await this.app.vault.delete(folder, false); }
      catch (error) { this.log("warn", `Could not remove empty old folder ${folderPath}: ${error instanceof Error ? error.message : String(error)}`); break; }
      this.log("info", `Removed empty old folder ${folderPath} after ${backend} move.`);
      folderPath = folderPath.includes("/") ? folderPath.slice(0, folderPath.lastIndexOf("/")) : "";
    }
  }
  private async safeConflictPath(path: string, kind = "Cloud conflict") {
    const dot = path.lastIndexOf("."); const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path; const ext = stem === path ? "" : path.slice(dot);
    const label = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    let candidate = `${stem} (${kind} ${label})${ext}`; let n = 2;
    while (this.app.vault.getAbstractFileByPath(candidate) || await this.app.vault.adapter.exists(candidate)) candidate = `${stem} (${kind} ${label} ${n++})${ext}`;
    return candidate;
  }
  private async preserveRecoveryBytes(originalPath: string, bytes: ArrayBuffer) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\.\d{3}Z$/, "Z");
    let target = `${RECOVERY_FOLDER}/${stamp}/${originalPath}`; let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(target) || await this.app.vault.adapter.exists(target)) {
      target = `${RECOVERY_FOLDER}/${stamp}-${suffix++}/${originalPath}`;
    }
    await this.ensureFolder(target);
    await this.app.vault.createBinary(target, bytes);
    const saved = this.app.vault.getAbstractFileByPath(target);
    if (!(saved instanceof TFile) || await this.gitBlobSha(await this.app.vault.readBinary(saved)) !== await this.gitBlobSha(bytes)) {
      throw new Error(`Could not verify the local recovery copy of ${originalPath}; no source file was removed.`);
    }
    return target;
  }
  private async safeFolderConflictPath(path: string, kind = "Local folder") {
    const slash = path.lastIndexOf("/"); const parent = slash < 0 ? "" : path.slice(0, slash + 1); const name = slash < 0 ? path : path.slice(slash + 1);
    const label = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    let candidate = `${parent}${name} (${kind} ${label})`; let n = 2;
    while (this.app.vault.getAbstractFileByPath(candidate) || await this.app.vault.adapter.exists(candidate)) candidate = `${parent}${name} (${kind} ${label} ${n++})`;
    return candidate;
  }
  private async prepareRemoteDestinations(remotePaths: string[], mode: "sync" | "pull" | "push" | "rebuild", backend: "GitHub" | "Supabase") {
    const relocated = new Set<string>();
    if (mode === "push") return relocated;
    const paths = remotePaths.filter(validPath).sort((a, b) => a.length - b.length);
    const prepared = new Set<string>();
    for (const path of paths) {
      const parts = path.split("/"); let parent = "";
      for (const part of parts.slice(0, -1)) {
        parent = parent ? `${parent}/${part}` : part;
        if (prepared.has(parent)) continue;
        prepared.add(parent);
        const existing = this.app.vault.getAbstractFileByPath(parent);
        if (existing instanceof TFile) {
          const preserved = await this.safeConflictPath(parent, "Local file");
          await this.renameVaultItem(existing, preserved, `Preserving a local file for ${backend} sync`);
          this.log("warn", `Preserved local file ${parent} as ${preserved}; ${backend} needs the original path for a folder.`);
          for (const remotePath of paths) if (remotePath.startsWith(`${parent}/`)) relocated.add(remotePath);
        }
      }
      const target = this.app.vault.getAbstractFileByPath(path);
      if (target instanceof TFolder) {
        const preserved = await this.safeFolderConflictPath(path);
        await this.renameVaultItem(target, preserved, `Preserving a local folder for ${backend} sync`);
        relocated.add(path);
        this.log("warn", `Preserved local folder ${path} and its contents as ${preserved}; ${backend} has a file at the original path.`);
      }
    }
    return relocated;
  }
  private async downloadBinary(path: string, remote: RemoteFile, vaultId: string): Promise<ArrayBuffer> {
    const response = await requestUrl({ url: `${API}/v1/vault/sync/file?vaultId=${vaultId}&hash=${remote.hash}`, headers: { authorization: `Bearer ${this.settings.token}` }, throw: false });
    if (response.status < 200 || response.status >= 300) throw new Error(`Could not download ${path} (${response.status}).`);
    return response.arrayBuffer;
  }
  private async applyRemote(path: string, remote: RemoteFile, vaultId: string) {
    const current = this.app.vault.getAbstractFileByPath(path);
    if (remote.deleted) {
      if (current instanceof TFile) { await this.app.vault.trash(current, false); delete this.settings.cache[path]; this.log("info", `Moved recovery-copy deletion to Obsidian trash: ${path}`); }
      delete this.settings.base[path];
      return;
    }
    const bytes = await this.downloadBinary(path, remote, vaultId);
    if (await digest(bytes) !== remote.hash) throw new Error(`Recovery-copy integrity check failed for ${path}; the file was not written.`);
    if (current instanceof TFolder) {
      const preserved = await this.safeFolderConflictPath(path);
      await this.renameVaultItem(current, preserved, "Preserving a local folder before recovery pull");
      this.log("warn", `Preserved local folder ${path} and its contents as ${preserved} before pulling the recovery copy.`);
    }
    await this.ensureFolder(path);
    const destination = this.app.vault.getAbstractFileByPath(path);
    if (destination instanceof TFile) await this.app.vault.modifyBinary(destination, bytes);
    else if (!destination) await this.app.vault.createBinary(path, bytes);
    else throw new Error(`Cannot restore ${path}: another vault item occupies the destination. Local data was left unchanged.`);
    const updated = this.app.vault.getAbstractFileByPath(path);
    if (!(updated instanceof TFile) || await digest(await this.app.vault.readBinary(updated)) !== remote.hash) throw new Error(`Recovery-copy integrity check failed after writing ${path}; the sync checkpoint was not advanced.`);
    this.settings.cache[path] = { sig: signature(updated), hash: remote.hash! };
    this.settings.base[path] = remote;
    this.log("info", `Pulled ${path}`);
  }
  private async upload(path: string, local: { file: TFile; hash: string; size: number; mtime: number }, vaultId: string) {
    if (local.size > MAX_OBJECT) throw new Error(`Skipped ${path}: this file is over the current 45 MiB per-file storage limit.`);
    const raw = await this.app.vault.readBinary(local.file);
    const response = await requestUrl({
      url: `${API}/v1/vault/sync/file?vaultId=${vaultId}&hash=${local.hash}`,
      method: "POST", contentType: "application/octet-stream", body: raw, headers: { authorization: `Bearer ${this.settings.token}` }, throw: false,
    });
    const data = response.json as Record<string, any>;
    if (response.status < 200 || response.status >= 300) throw new Error(data?.error || `Could not upload ${path} (${response.status}).`);
    const updated = this.app.vault.getAbstractFileByPath(path); if (updated instanceof TFile) this.settings.cache[path] = { sig: signature(updated), hash: local.hash };
    this.log("info", `Uploaded ${path}; saved in the pending sync update.`);
  }

  async syncNow(manual = true, mode: "sync" | "pull" | "push" = "sync") {
    if (this.syncing || (this.settings.paused && !manual) || (!manual && !this.settings.autoSync)) return;
    if (!this.settings.token) { if (manual) this.openView(); return; }
    if (!this.settings.syncKey.trim()) { this.openSettings(); new Notice("Choose a Sync vault key in Expert AI Sync settings first."); return; }
    this.retryAfterConflict = false; this.syncing = true; this.progressDone = 0; this.progressTotal = 1; this.progressText = "Connecting…"; this.refresh();
    let pushed = 0, pulled = 0, conflicts = 0, skipped = 0;
    try {
      const vaultId = await this.vaultId(); this.log("info", "Checking this device against the latest cloud vault.");
      let remote = await this.getManifest(vaultId);
      const remotePathList = Object.entries(remote.files).filter(([, item]) => !item.deleted).map(([path]) => path);
      const remoteDirectories = this.remoteDirectoryPaths(remotePathList);
      const relocatedPaths = await this.prepareRemoteDestinations(remotePathList, mode, "Supabase");
      const local = await this.listLocal();

      // A file that changed path but not content is treated as a move. This is especially
      // helpful when an older phone reconnects after another device reorganized folders.
      const remoteByHash = new Map<string, string[]>();
      for (const [path, entry] of Object.entries(remote.files)) if (!entry.deleted && entry.hash) remoteByHash.set(entry.hash, [...(remoteByHash.get(entry.hash) || []), path]);
      for (const [oldPath, item] of [...local]) {
        const destinations = remoteByHash.get(item.hash) || [];
        if (!destinations.length || destinations.includes(oldPath) || Object.hasOwn(remote.files, oldPath) && !remote.files[oldPath].deleted) continue;
        const target = destinations.find((path) => !local.has(path) && !this.app.vault.getAbstractFileByPath(path)); if (!target) continue;
        await this.ensureFolder(target); await this.renameVaultItem(item.file, target, "Following a cloud file move"); local.delete(oldPath);
        const moved = this.app.vault.getAbstractFileByPath(target);
        if (moved instanceof TFile) { local.set(target, { file: moved, hash: item.hash, size: moved.stat.size, mtime: moved.stat.mtime }); this.settings.cache[target] = { sig: signature(moved), hash: item.hash }; }
        this.log("info", `Recognized folder move: ${oldPath} → ${target}`);
        relocatedPaths.add(target); await this.pruneEmptyParents(oldPath, remoteDirectories, "Supabase");
      }

      // A phone may reconnect with no saved sync baseline after a folder reorganization.
      // Exact hashes handle unchanged moves; a unique same-name match preserves an edited
      // phone copy beside the cloud version and lets the cloud path become canonical.
      const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLocaleLowerCase();
      const remoteNames = new Map<string, string[]>();
      for (const [path, entry] of Object.entries(remote.files)) if (!entry.deleted) remoteNames.set(basename(path), [...(remoteNames.get(basename(path)) || []), path]);
      const localNames = new Map<string, string[]>();
      for (const path of local.keys()) localNames.set(basename(path), [...(localNames.get(basename(path)) || []), path]);
      for (const [oldPath, item] of [...local]) {
        const matches = remoteNames.get(basename(oldPath)) || [];
        if (matches.length !== 1 || matches[0] === oldPath || local.has(matches[0]) || this.app.vault.getAbstractFileByPath(matches[0])) continue;
        const previousRemote = remote.files[oldPath];
        const knownOldLocation = !!this.settings.base?.[oldPath] || !!previousRemote?.deleted;
        const freshDevice = !this.settings.version && !Object.keys(this.settings.base || {}).length;
        if (!knownOldLocation && !freshDevice) continue;
        if ((localNames.get(basename(oldPath)) || []).length !== 1) continue;
        const target = matches[0];
        this.addConflict({ id: crypto.randomUUID(), path: oldPath, alternatePath: target, backend: "supabase", reason: "move" });
        relocatedPaths.add(target);
        this.log("warn", `Possible move ${oldPath} → ${target}; both versions are kept for your review.`);
      }

      const base = this.settings.base || {}; const paths = new Set([...Object.keys(local), ...Object.keys(remote.files), ...Object.keys(base)]);
      const plan: Array<{ path: string; action: "push" | "pull" | "delete" | "conflict"; remote?: RemoteFile; local?: NonNullable<ReturnType<typeof local.get>> }> = [];
      for (const path of paths) {
        if (!validPath(path)) continue;
        if (this.settings.conflicts.some((conflict) => conflict.path === path)) continue;
        const l = local.get(path); const r = remote.files[path]; const b = base[path];
        const localHash = l?.hash || null; const remoteHash = r?.deleted ? null : r?.hash || null; const baseHash = b?.deleted ? null : b?.hash || null;
        const compareBaseHash = relocatedPaths.has(path) ? null : baseHash;
        const localChanged = localHash !== compareBaseHash;
        const remoteChanged = remoteHash !== compareBaseHash;
        if (localHash === remoteHash) continue;
        if (!localChanged && remoteChanged) { plan.push({ path, action: "pull", remote: r }); continue; }
        if (localChanged && !remoteChanged) { plan.push({ path, action: l ? "push" : "delete", local: l }); continue; }
        if (localChanged && remoteChanged) {
          if (l && (!r || r.deleted)) {
            this.addConflict({ id: crypto.randomUUID(), path, backend: "supabase", reason: "deleted" });
            this.log("warn", `The recovery copy no longer has ${path}, but this phone still has a changed local copy. Waiting for your choice.`);
            continue;
          }
          // A cloud rename has a tombstone for the old path and a live entry at the new path.
          // Preserve this phone's changed content under a conflict name before honoring the move.
          plan.push({ path, action: "conflict", remote: r, local: l });
        }
      }
      this.progressTotal = Math.max(1, plan.length); this.progressDone = 0; this.progressText = plan.length ? `Syncing ${plan.length} changed files…` : "Comparing vaults…"; this.refresh();
      const staged = new Map<string, Record<string, unknown>>();
      const keepBasePaths = new Set<string>();
      for (const operation of plan) {
        if (this.settings.paused) throw new Error("Sync paused. Local and cloud changes are preserved; resume to continue.");
        const { path, action, remote: r, local: l } = operation;
        try {
          if (mode === "pull" && (action === "push" || action === "delete")) { keepBasePaths.add(path); this.progressDone++; this.progressText = `Pulling cloud updates · ${this.progressDone} of ${this.progressTotal}`; continue; }
          if (mode === "push" && action === "pull") { keepBasePaths.add(path); this.progressDone++; this.progressText = `Pushing local updates · ${this.progressDone} of ${this.progressTotal}`; continue; }
          if (action === "pull") {
            if (r) { await this.applyRemote(path, r, vaultId); if (!r.deleted) pulled++; }
          } else if (action === "push" && l) { await this.upload(path, l, vaultId); staged.set(path, { path, hash: l.hash, size: l.size, mtime: l.mtime }); pushed++; }
          else if (action === "delete") { staged.set(path, { path, deleted: true }); }
          else if (action === "conflict") {
            if (l) {
              const conflictPath = await this.safeConflictPath(path); const current = this.app.vault.getAbstractFileByPath(path);
              if (r && !r.deleted) { const cloudBytes = await this.downloadBinary(path, r, vaultId); if (await digest(cloudBytes) !== r.hash) throw new Error(`Recovery-copy integrity check failed for ${path}.`); await this.ensureFolder(conflictPath); await this.app.vault.createBinary(conflictPath, cloudBytes); const conflictFile = this.app.vault.getAbstractFileByPath(conflictPath); if (conflictFile instanceof TFile) { const h = await digest(cloudBytes); this.settings.cache[conflictPath] = { sig: signature(conflictFile), hash: h }; if (mode !== "pull") { await this.upload(conflictPath, { file: conflictFile, hash: h, size: conflictFile.stat.size, mtime: conflictFile.stat.mtime }, vaultId); staged.set(conflictPath, { path: conflictPath, hash: h, size: conflictFile.stat.size, mtime: conflictFile.stat.mtime }); pushed++; } pulled++; } }
              if ((!r || r.deleted) && mode !== "pull") { await this.upload(path, l, vaultId); staged.set(path, { path, hash: l.hash, size: l.size, mtime: l.mtime }); pushed++; }
              else if (r && !r.deleted && mode !== "pull") {
                // Replace cloud's original path with this device's version after preserving cloud copy.
                await this.upload(path, l, vaultId); staged.set(path, { path, hash: l.hash, size: l.size, mtime: l.mtime }); pushed++;
              }
              this.addConflict({ id: crypto.randomUUID(), path, ...(r && !r.deleted ? { alternatePath: conflictPath } : {}), backend: "supabase" }); conflicts++;
              this.log("warn", `Both devices changed ${path}; saved the other version as ${conflictPath}`);
            } else if (r && !r.deleted) {
              // Restore the cloud edit on this device. It remains available, and its contents are not deleted by the stale local tombstone.
              await this.applyRemote(path, r, vaultId); this.addConflict({ id: crypto.randomUUID(), path, backend: "supabase" }); conflicts++; this.log("warn", `A local deletion conflicted with a cloud edit. Kept the cloud version of ${path}.`);
            }
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("45 MiB")) { skipped++; keepBasePaths.add(path); this.log("warn", error.message); }
          else throw new Error(`Supabase ${action} failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.progressDone++; this.progressText = `Updated ${this.progressDone} of ${this.progressTotal} · ${pushed} pushed · ${pulled} pulled`;
        if (this.progressDone % 10 === 0 || this.progressDone === this.progressTotal) await this.saveData(this.settings);
        if (this.progressDone % 5 === 0 || this.progressDone === this.progressTotal) this.refresh();
      }
      if (staged.size) {
        this.progressText = `Saving ${staged.size} file updates…`; this.refresh();
        const response = await requestUrl({ url: `${API}/v1/vault/sync/commit?vaultId=${vaultId}`, method: "POST", contentType: "application/json", body: JSON.stringify({ vaultId, expectedVersion: remote.version, changes: [...staged.values()] }), headers: { authorization: `Bearer ${this.settings.token}` }, throw: false });
        const data = response.json as Record<string, any>;
        if (response.status === 409) {
          if (this.conflictRetries < 2) { this.conflictRetries++; this.retryAfterConflict = true; throw new Error("Another device synced at the same time; refreshing the latest vault now."); }
          throw new Error("Another device is still syncing. Your files are safe; tap Sync now to retry.");
        }
        if (response.status < 200 || response.status >= 300) throw new Error(data?.error || `Could not save the sync update (${response.status}).`);
        remote = data.manifest as Manifest;
        for (const [path] of staged) this.log("ok", `Synced ${path}`);
        this.log("ok", `Cloud checkpoint ${remote.version} saved · ${staged.size} files.`);
      }
      remote = await this.getManifest(vaultId);
      const finalLocal = await this.listLocal();
      const nextBase = { ...remote.files };
      for (const path of keepBasePaths) { if (base[path]) nextBase[path] = base[path]; else delete nextBase[path]; }
      this.settings.base = nextBase; this.settings.version = remote.version;
      for (const [path, item] of finalLocal) this.settings.cache[path] = { sig: signature(item.file), hash: item.hash };
      const pendingReviews = this.settings.conflicts.filter((conflict) => conflict.backend === "supabase" && (conflict.reason === "move" || conflict.reason === "deleted")).length;
      const report = pushed === 0 && pulled === 0 && conflicts === 0 && skipped === 0 && relocatedPaths.size === 0 && pendingReviews === 0
        ? mode === "push" ? "No local changes to push." : mode === "pull" ? "No newer cloud files to pull." : "Vault is up to date."
        : `${pushed} pushed · ${pulled} pulled${conflicts ? ` · ${conflicts} conflict${conflicts === 1 ? "" : "s"} preserved` : ""}${pendingReviews ? ` · ${pendingReviews} item${pendingReviews === 1 ? "" : "s"} awaiting your review` : ""}${relocatedPaths.size ? ` · ${relocatedPaths.size} path${relocatedPaths.size === 1 ? "" : "s"} reconciled with local data preserved` : ""}${skipped ? ` · ${skipped} file${skipped === 1 ? "" : "s"} skipped` : ""}`;
      this.conflictRetries = 0; this.settings.backupLastSync = Date.now(); this.settings.backupLastReport = report; this.log(skipped ? "warn" : "ok", `Supabase recovery: ${report}`); await this.saveData(this.settings); this.progressText = report; new Notice(`Supabase recovery: ${report}`); 
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync did not finish.";
      if (this.retryAfterConflict) { this.settings.backupLastReport = "A newer cloud update arrived; refreshing and reconciling…"; this.log("info", this.settings.backupLastReport); await this.saveData(this.settings); }
      else { this.conflictRetries = 0; this.settings.backupLastReport = message; this.log("error", `Supabase recovery: ${message}`); await this.saveData(this.settings); new Notice(`Supabase recovery: ${message}`); }
    } finally {
      const retry = this.retryAfterConflict; this.syncing = false; this.progressText = this.settings.backupLastReport; this.refresh();
      if (retry) window.setTimeout(() => { void this.syncNow(true, mode); }, 900);
    }
  }
  private scheduleSync() {
    if (!this.settings.autoSync || this.settings.paused || !this.app.secretStorage.getSecret(GITHUB_ACCESS_SECRET)) return;
    if (this.debounce) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => { if (!this.syncing) void this.syncGitHub(false, "sync"); }, 7000);
  }
  async resolveConflict(id: string, choice: "saved" | "current") {
    const conflict = this.settings.conflicts.find((entry) => entry.id === id); if (!conflict) return;
    try {
      const current = this.app.vault.getAbstractFileByPath(conflict.path);
      const alternate = conflict.alternatePath ? this.app.vault.getAbstractFileByPath(conflict.alternatePath) : null;
      if (choice === "saved" && current instanceof TFile && alternate instanceof TFile) {
        const localBytes = await this.app.vault.readBinary(current); const localCopy = await this.safeConflictPath(conflict.path, "Local version");
        await this.ensureFolder(localCopy); await this.app.vault.createBinary(localCopy, localBytes);
        await this.app.vault.modifyBinary(current, await this.app.vault.readBinary(alternate));
        await this.app.vault.delete(alternate, true); delete this.settings.cache[conflict.alternatePath!];
        this.log("info", `Kept the saved cloud version at ${conflict.path}; this device's previous copy remains at ${localCopy}.`);
      } else if (choice === "current" && alternate instanceof TFile) {
        await this.app.vault.delete(alternate, true); delete this.settings.cache[conflict.alternatePath!];
        this.log("info", `Kept the current version of ${conflict.path}; the other version remains in seven-day cloud history.`);
      }
      this.settings.conflicts = this.settings.conflicts.filter((entry) => entry.id !== id); await this.saveData(this.settings); this.refresh();
      if (conflict.backend === "github") await this.syncGitHub(true, "sync"); else await this.syncNow(true, "sync");
    } catch (error) { new Notice(error instanceof Error ? error.message : "Could not resolve this version choice."); }
  }
  async dismissConflict(id: string) { this.settings.conflicts = this.settings.conflicts.filter((entry) => entry.id !== id); await this.saveData(this.settings); this.refresh(); }
  private addConflict(conflict: ConflictEntry) {
    if (this.settings.conflicts.some((entry) => entry.path === conflict.path && entry.alternatePath === conflict.alternatePath && entry.backend === conflict.backend && entry.reason === conflict.reason)) return;
    this.settings.conflicts.unshift(conflict);
  }
  async compareConflict(id: string) {
    const conflict = this.settings.conflicts.find((entry) => entry.id === id); if (!conflict?.alternatePath) return;
    const leftPath = conflict.path, rightPath = conflict.alternatePath;
    const left = this.app.vault.getAbstractFileByPath(leftPath), right = this.app.vault.getAbstractFileByPath(rightPath);
    if (!(left instanceof TFile) || !(right instanceof TFile)) { new Notice("Both files must be present in the vault before they can be compared."); return; }
    const textExtensions = new Set(["md", "txt", "canvas", "json", "yaml", "yml", "csv", "tsv", "html", "css", "js", "ts", "xml", "svg"]);
    if (left.stat.size > 2 * 1024 * 1024 || right.stat.size > 2 * 1024 * 1024) {
      new FileCompareModal(this.app, leftPath, rightPath, `File is ${fmtBytes(left.stat.size)}. Preview is limited to 2 MB per file.`, `File is ${fmtBytes(right.stat.size)}. Preview is limited to 2 MB per file.`, "Large files are not loaded into the comparison view.").open(); return;
    }
    if (!textExtensions.has(left.extension.toLowerCase()) || !textExtensions.has(right.extension.toLowerCase())) {
      const [leftHash, rightHash] = await Promise.all([digest(await this.app.vault.readBinary(left)), digest(await this.app.vault.readBinary(right))]);
      new FileCompareModal(this.app, leftPath, rightPath, `Binary file · ${fmtBytes(left.stat.size)}\nSHA-256 ${leftHash}`, `Binary file · ${fmtBytes(right.stat.size)}\nSHA-256 ${rightHash}`, leftHash === rightHash ? "The file contents are identical." : "The file contents differ. Binary contents are not rendered as text.").open(); return;
    }
    const [leftText, rightText] = await Promise.all([this.app.vault.read(left), this.app.vault.read(right)]);
    new FileCompareModal(this.app, leftPath, rightPath, leftText, rightText, leftText === rightText ? "The file contents are identical." : "The file contents differ.").open();
  }
  async openConflictFile(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice(`The local file is no longer at ${path}.`); return; }
    await this.app.workspace.getLeaf(true).openFile(file);
  }
  async resolveDeletedConflict(id: string, choice: "keep" | "trash") {
    const conflict = this.settings.conflicts.find((entry) => entry.id === id && (entry.reason === "deleted" || entry.reason === "first-pull")); if (!conflict) return;
    try {
      const file = this.app.vault.getAbstractFileByPath(conflict.path);
      if (choice === "trash" && file instanceof TFile) {
        await this.app.vault.trash(file, false);
        await this.pruneEmptyParents(conflict.path, new Set<string>(), conflict.backend === "github" ? "GitHub" : "Supabase");
      }
      this.settings.conflicts = this.settings.conflicts.filter((entry) => entry.id !== id);
      this.log("info", choice === "keep" ? `Kept local file ${conflict.path}; syncing it back to the remote vault.` : `Moved ${conflict.path} to Obsidian trash.`);
      await this.saveSettings();
      if (conflict.backend === "github") await this.syncGitHub(true, "sync"); else await this.syncNow(true, "sync");
    } catch (error) { new Notice(error instanceof Error ? error.message : "Could not resolve the remote deletion.", 10_000); }
  }
  async resolveMoveConflict(id: string, choice: "both" | "remote" | "local") {
    const conflict = this.settings.conflicts.find((entry) => entry.id === id && entry.reason === "move"); if (!conflict?.alternatePath) return;
    const source = this.app.vault.getAbstractFileByPath(conflict.path);
    const target = this.app.vault.getAbstractFileByPath(conflict.alternatePath);
    try {
      if (choice === "remote") {
        if (source instanceof TFile) {
          await this.app.vault.trash(source, false);
          await this.pruneEmptyParents(conflict.path, new Set<string>(), conflict.backend === "github" ? "GitHub" : "Supabase");
        }
      } else if (choice === "local") {
        if (!(source instanceof TFile) || !(target instanceof TFile)) throw new Error("The old and new files must both exist before choosing this option.");
        const remoteCopy = await this.safeConflictPath(conflict.alternatePath, "Remote version");
        await this.renameVaultItem(target, remoteCopy, "Saving the remote version before moving the local copy");
        await this.renameVaultItem(source, conflict.alternatePath, "Moving the local copy to GitHub's current path");
        await this.pruneEmptyParents(conflict.path, new Set<string>(), conflict.backend === "github" ? "GitHub" : "Supabase");
      }
      this.settings.conflicts = this.settings.conflicts.filter((entry) => entry.id !== id);
      this.log("info", choice === "both" ? `Kept both versions at ${conflict.path} and ${conflict.alternatePath}.` : choice === "remote" ? `Kept the remote version at ${conflict.alternatePath}; moved the old local copy to Obsidian trash.` : `Moved the local copy to ${conflict.alternatePath}; saved the remote version beside it.`);
      await this.saveSettings();
      if (conflict.backend === "github") await this.syncGitHub(true, "sync"); else await this.syncNow(true, "sync");
    } catch (error) { new Notice(error instanceof Error ? error.message : "Could not resolve this moved file.", 10_000); }
  }
  private log(kind: LogEntry["kind"], text: string) { this.settings.logs.unshift({ at: Date.now(), kind, text }); this.settings.logs = this.settings.logs.slice(0, 100); if (!this.syncing) { void this.saveData(this.settings); this.refresh(); } }
}

