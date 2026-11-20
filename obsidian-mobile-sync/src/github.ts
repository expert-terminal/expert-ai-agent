import { requestUrl } from "obsidian";

export type GitHubFile = { path: string; sha: string; size: number; mode: string };
export type GitHubState = { owner: string; repo: string; branch: string; head: string; treeSha: string; files: Record<string, GitHubFile> };
export type GitHubChange = { path: string; sha?: string; deleted?: boolean; mode?: string };
const API = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";
const TRANSIENT_NETWORK_ERROR = /unknownhostexception|unable to resolve host|no address associated|enotfound|eai_again|network request failed|failed to fetch|timed out|connection reset/i;

async function requestWithNetworkRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  let delayMs = 1200;
  for (let attempt = 1; ; attempt++) {
    try { return await run(); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!TRANSIENT_NETWORK_ERROR.test(detail) || attempt >= 4) {
        if (TRANSIENT_NETWORK_ERROR.test(detail)) throw new Error(`${label} could not reach GitHub after ${attempt} attempts. Check the phone's connection, then retry; the GitHub repository was not changed.`);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(7000, delayMs * 2);
    }
  }
}

export function parseGitHubRepo(input: string) {
  const value = input.trim();
  const match = value.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (!match) throw new Error("Enter a GitHub repository URL, such as https://github.com/owner/vault.git");
  return { owner: match[1], repo: match[2] };
}

async function jsonRequest(url: string, token: string, method = "GET", body?: unknown) {
  const response = await requestWithNetworkRetry("GitHub request", () => requestUrl({
    url, method, contentType: body === undefined ? undefined : "application/json",
    headers: { accept: ACCEPT, authorization: `Bearer ${token}`, "x-github-api-version": API_VERSION, "user-agent": "Expert-AI-Obsidian-Mobile-Sync" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), throw: false,
  }));
  let data: Record<string, any> = {};
  try { data = response.json as Record<string, any>; } catch { /* report status below */ }
  if (response.status < 200 || response.status >= 300) {
    const message = typeof data.message === "string" ? data.message : `GitHub returned HTTP ${response.status}.`;
    if (response.status === 401) throw new Error("GitHub sign-in expired. Reconnect GitHub in Expert AI Sync settings.");
    if (response.status === 403 && /rate limit/i.test(message)) throw new Error("GitHub rate limit reached. Wait a little, then retry.");
    throw new Error(message);
  }
  return data;
}

export async function requestDeviceCode(clientId: string) {
  const response = await requestUrl({
    url: "https://github.com/login/device/code", method: "POST", contentType: "application/json",
    headers: { accept: "application/json", "user-agent": "Expert-AI-Obsidian-Mobile-Sync" },
    body: JSON.stringify({ client_id: clientId, scope: "repo offline_access" }), throw: false,
  });
  const data = response.json as Record<string, any>;
  if (response.status < 200 || response.status >= 300 || data.error) throw new Error(data.error_description || data.error || "GitHub could not start device authorization.");
  return { deviceCode: String(data.device_code), userCode: String(data.user_code), verificationUri: String(data.verification_uri), interval: Math.max(5, Number(data.interval) || 5), expiresIn: Math.max(60, Number(data.expires_in) || 900) };
}

export async function pollDeviceToken(clientId: string, deviceCode: string) {
  const response = await requestUrl({
    url: "https://github.com/login/oauth/access_token", method: "POST", contentType: "application/json",
    headers: { accept: "application/json", "user-agent": "Expert-AI-Obsidian-Mobile-Sync" },
    body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }), throw: false,
  });
  const data = response.json as Record<string, any>;
  if (data.error === "authorization_pending") return { pending: true as const };
  if (data.error === "slow_down") return { pending: true as const, interval: Math.max(5, Number(data.interval) || 10) };
  if (response.status < 200 || response.status >= 300 || data.error) throw new Error(data.error_description || data.error || `GitHub authorization returned HTTP ${response.status}.`);
  if (!data.access_token) throw new Error("GitHub did not return an access token.");
  return { pending: false as const, accessToken: String(data.access_token), refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "", expiresIn: Number(data.expires_in) || 0, refreshExpiresIn: Number(data.refresh_token_expires_in) || 0 };
}

export async function refreshGitHubToken(clientId: string, refreshToken: string) {
  const response = await requestUrl({
    url: "https://github.com/login/oauth/access_token", method: "POST", contentType: "application/json",
    headers: { accept: "application/json", "user-agent": "Expert-AI-Obsidian-Mobile-Sync" },
    body: JSON.stringify({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }), throw: false,
  });
  const data = response.json as Record<string, any>;
  if (response.status < 200 || response.status >= 300 || data.error || !data.access_token) throw new Error(data.error_description || data.error || "GitHub sign-in expired. Reconnect GitHub.");
  return { accessToken: String(data.access_token), refreshToken: String(data.refresh_token || refreshToken), expiresIn: Number(data.expires_in) || 0, refreshExpiresIn: Number(data.refresh_token_expires_in) || 0 };
}

export async function getGitHubState(repoUrl: string, token: string, branchHint = ""): Promise<GitHubState> {
  const { owner, repo } = parseGitHubRepo(repoUrl);
  const repoData = await jsonRequest(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
  const branch = branchHint.trim() || String(repoData.default_branch || "main");
  const ref = await jsonRequest(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  const head = String(ref.object?.sha || "");
  if (!head) throw new Error("GitHub did not return the branch head.");
  const commit = await jsonRequest(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${head}`, token);
  const treeSha = String(commit.tree?.sha || "");
  if (!treeSha) throw new Error("GitHub did not return the repository tree.");
  const tree = await jsonRequest(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${treeSha}?recursive=1`, token);
  if (tree.truncated) throw new Error("This GitHub repository tree is too large for a single mobile sync. Reduce unrelated repository files or use a dedicated vault repository.");
  const files: Record<string, GitHubFile> = {};
  for (const entry of Array.isArray(tree.tree) ? tree.tree : []) {
    if (entry?.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string") {
      files[entry.path] = { path: entry.path, sha: entry.sha, size: Number(entry.size) || 0, mode: String(entry.mode || "100644") };
    }
  }
  return { owner, repo, branch, head, treeSha, files };
}

export async function getGitHubLogin(token: string) {
  const user = await jsonRequest(`${API}/user`, token);
  return String(user.login || "");
}

export async function getGitHubBranchInfo(repoUrl: string, token: string, branchHint = "") {
  const { owner, repo } = parseGitHubRepo(repoUrl);
  const repository = await jsonRequest(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
  const branch = branchHint.trim() || String(repository.default_branch || "main");
  const ref = await jsonRequest(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  const head = String(ref.object?.sha || "");
  if (!head) throw new Error(`GitHub did not return the head for branch “${branch}”.`);
  return { branch, head };
}

export async function getGitHubRenames(repoUrl: string, token: string, base: string, head: string) {
  if (!base || !head || base === head) return { renames: [] as Array<{ from: string; to: string }>, capped: false };
  const { owner, repo } = parseGitHubRepo(repoUrl);
  const comparison = await jsonRequest(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`, token);
  const files = Array.isArray(comparison.files) ? comparison.files as Array<Record<string, unknown>> : [];
  return {
    renames: files.flatMap((file) => file.status === "renamed" && typeof file.previous_filename === "string" && typeof file.filename === "string"
      ? [{ from: file.previous_filename, to: file.filename }]
      : []),
    capped: files.length >= 300,
  };
}

export async function getGitHubBlob(state: GitHubState, sha: string, token: string): Promise<ArrayBuffer> {
  const response = await requestWithNetworkRetry("GitHub file download", () => requestUrl({
    url: `${API}/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/git/blobs/${sha}`,
    headers: { accept: "application/vnd.github.raw+json", authorization: `Bearer ${token}`, "x-github-api-version": API_VERSION, "user-agent": "Expert-AI-Obsidian-Mobile-Sync" },
    throw: false,
  }));
  if (response.status < 200 || response.status >= 300) throw new Error(`Could not download a GitHub file (${response.status}).`);
  return response.arrayBuffer;
}

function encodeBase64(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes); let binary = "";
  for (let offset = 0; offset < view.length; offset += 0x8000) binary += String.fromCharCode(...view.subarray(offset, Math.min(offset + 0x8000, view.length)));
  return btoa(binary);
}

export async function commitGitHubChanges(state: GitHubState, token: string, changes: GitHubChange[], message: string, readFile: (path: string) => Promise<ArrayBuffer>) {
  const entries: Array<Record<string, unknown>> = [];
  for (const change of changes) {
    if (change.deleted) { entries.push({ path: change.path, mode: change.mode || "100644", type: "blob", sha: null }); continue; }
    const bytes = await readFile(change.path);
    if (bytes.byteLength > 45 * 1024 * 1024) throw new Error(`${change.path} exceeds the 45 MiB mobile sync per-file limit.`);
    const blob = await jsonRequest(`${API}/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/git/blobs`, token, "POST", { content: encodeBase64(bytes), encoding: "base64" });
    entries.push({ path: change.path, mode: change.mode || "100644", type: "blob", sha: String(blob.sha) });
  }
  const tree = await jsonRequest(`${API}/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/git/trees`, token, "POST", { base_tree: state.treeSha, tree: entries });
  const commit = await jsonRequest(`${API}/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/git/commits`, token, "POST", { message, tree: tree.sha, parents: [state.head] });
  const ref = await requestUrl({
    url: `${API}/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/git/refs/heads/${encodeURIComponent(state.branch)}`,
    method: "PATCH", contentType: "application/json",
    headers: { accept: ACCEPT, authorization: `Bearer ${token}`, "x-github-api-version": API_VERSION, "user-agent": "Expert-AI-Obsidian-Mobile-Sync" },
    body: JSON.stringify({ sha: commit.sha, force: false }), throw: false,
  });
  if (ref.status < 200 || ref.status >= 300) {
    const data = ref.json as Record<string, any>;
    if (ref.status === 422 || ref.status === 409) throw new Error("GitHub changed while this commit was being prepared. No remote commit was applied; refresh and retry.");
    throw new Error(data.message || `Could not move the GitHub branch (${ref.status}).`);
  }
  return { commitSha: String(commit.sha), commitUrl: String(commit.html_url || ""), message };
}

export function defaultCommitMessage() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `vault backup: ${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}
