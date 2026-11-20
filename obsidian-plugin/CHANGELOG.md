# Changelog

## 0.5.6 — Reconcile divergent Git history safely

- Replaced fast-forward-only pull behavior with checkpoint, fetch, and merge. Local uncommitted changes are committed to a timestamped checkpoint before remote history is integrated.
- **Sync** now checkpoints local changes, merges incoming GitHub commits without rewriting history, then pushes the combined branch. Pull and Push use the same safe reconciliation path.
- Push retries a bounded number of times when GitHub advances during the operation; each retry fetches and merges again rather than force-pushing.
- When Git reports actual file conflicts, the operation stops and lists those paths. Local and remote commits remain in Git, the conflicted merge is left available for resolution, and a later Sync continues only after the files are resolved and staged.
- Updated desktop Sync labels and settings copy to describe checkpoint, merge, and conflict behavior.

## 0.5.5 — Always-on vault context for the Agent

- The Pi Agent bridge now retrieves compact, query-specific context from the connected Obsidian plugin on every Agent request, even when the Agent working directory is outside the vault.
- Context reports the active local-index scope so the Agent can use selected folders, recognize coverage gaps, and fall back to file search when needed.
- Added explicit guidance to cite retrieved notes with Obsidian links, read before editing, and route individual and batch changes through Obsidian tools.

## 0.5.4 — Streamed and verified cloud backups

- Cloud snapshots are gzip-streamed from the vault instead of building the complete JSON archive in memory, and uploaded in 4 MiB chunks.
- The Gateway verifies every chunk checksum and size, then publishes a snapshot manifest only after all chunks are present. Incomplete uploads stay out of the backup list and expire with the existing 7-day retention cleanup.
- Added cloud snapshot restore review: compare a saved snapshot to the current vault, add missing files, or restore differences after current versions have been copied under `.expert-ai-recovery`. Restore never deletes files absent from a snapshot.
- The Sync dashboard and activity log report file count, verified chunk count, size, and progress. Existing single-object snapshots remain readable.
- Keeps the existing 250 MiB uncompressed preparation cap, 50 MiB standard-account rolling vault quota, verified founder app-cap exception, and Supabase project quota behavior.

## 0.5.3 — Clear sync reports and live workspace awareness

- Git pull and push now report exact changed file counts, change types, commit counts, and a short list of paths; zero-change operations explicitly say the vault is up to date.
- Git operation results and failures are shown in the Obsidian notice and saved sync activity log; the Agent Git tool returns the same detailed report.
- The Activity pane and Agent status now show open files, active note, window/pane/tab, and editor mode. Agent context receives this small workspace map without automatically sending open-note contents.
- Fixed the mobile GitHub Device Flow experience with a copyable code, temporary DNS/network retry, separate account and repository verification, and no editable client-ID setting.

## 0.5.2 — Vault Sync dashboard

- Added a dedicated Sync sidebar view and ribbon button with Git status, changed files, commit/pull/push/commit-and-push controls, and a direct link to Obsidian Git's Source Control View.
- Added Ctrl+P commands for opening and refreshing Sync, committing with the timestamped `vault backup: YYYY-MM-DD HH:mm:ss` default, safe pull, push, commit-and-push, and cloud backup.
- Added a persistent local operation log for Git and cloud backup successes and failures, plus live seven-day Supabase snapshot usage/status.
- Updated the Agent Git tool to support one-step commit-and-push and the same default timestamp message.

## 0.5.1 — Founder backup quota

- Removed the Gateway's 50 MB rolling per-vault cap for verified founder accounts; standard accounts remain capped at 50 MB.
- Exposed live cloud backup quota and availability in the Agent backup status response.
- Clarified that Supabase project quota and per-snapshot limits still apply.

## 0.5.0 — Mobile Git and private cloud recovery

- Renamed the visible Obsidian plugin to **Expert AI** while preserving the existing plugin ID and local history.
- Added mobile Agent tools for Git status, refresh, fast-forward-only pull, commit, and push. Git credentials remain in the OS credential manager or SSH agent; unsafe pulls stop without overwriting local edits.
- Added selectable cloud backup folders (all folders by default), optional subfolders, on-demand mobile backup, and optional backup-on-open.
- Added Gateway-backed private Supabase snapshots with a 7-day retention window. Standard accounts have a 50 MB rolling limit per vault; verified founder accounts bypass that app-level rolling cap. Supabase project quota and per-snapshot limits still apply.
- Cloud backup requires the private bucket and Gateway secrets to be configured; no Supabase service key is bundled into the plugin.

## 0.4.4 — Readable version diffs

- Added a dedicated unified line diff with line numbers, colored additions/removals, and nearby context in the comparison window and activity cards.
- Version selector labels make the compared snapshots clear; both full versions remain available below the diff.
- The plugin package uses JavaScript and WebAssembly assets and is not built for a particular CPU architecture.

## 0.4.3 — Fix existing-vault database upgrade

- Fixed plugin startup for existing vaults by preserving existing IndexedDB stores and adding only missing stores/indexes during migration.
- This keeps existing history and local search data available while adding version snapshots.

## 0.4.2 — Track note versions across Agent edits and moves

- Added a lightweight local note snapshot baseline, separate from search indexing and embeddings. It seeds in the background, captures edits observed by Obsidian (including edits made by other tools), and records changes made while the plugin was closed when it starts again.
- File edit records are linked to the active Agent task and appear in the dedicated File changes section.
- Move and rename records retain note contents; version history follows files across repeated moves and folders. Compare shows both full selected versions, and restore checks that the live note has not changed since review.
- IndexedDB history schema now migrates to add local note snapshots; existing search data and history are preserved.

## 0.4.0 — Continue Agent chats inside Obsidian

- Recent task cards now open a dockable Expert AI Chat pane, and task details include a direct continue-in-chat action.
- The pane links new vault tasks to the active Pi session, retains the local conversation text, and accepts follow-up messages without switching to the phone.
- Added live assistant text streaming and a readable timeline of tool starts and results, including bounded shell/search inputs. Private model reasoning is not recorded or displayed.
- Chat task records and progress stay in the local Obsidian history store and follow the existing 7/13-day retention setting.
- The desktop Agent adapter must be restarted once to load the new event hooks and local chat handoff.

## 0.3.0 — Recursive fast search and review-first versions

- Folder selection now includes descendants by default, with an explicit option for direct-folder-only indexing. Saved paused scopes have a clear one-click resume action; selecting folders and confirming starts local indexing immediately.
- Large scope changes clear only derived local search data in one IndexedDB transaction, then rebuild the selected folders. This avoids thousands of slow per-note deletions and preserves notes and version history.
- Restore controls now open a side-by-side preview of the previous and live note, show the saved after-change version, and require an explicit restore click. Agent restore calls first return a preview and require a second confirmed call. History marks only actually restorable actions as restorable.
- Bundled the optional embedding loader into the plugin bundle to avoid runtime module fetch failures. Local model download progress is shown, failed model loads can retry, and lexical search remains available if embeddings are unavailable.
- Added Agent workspace controls for opening notes in tabs or split panes and showing/hiding Obsidian sidebars.
- Plugin package is desktop-only and operates on the connected local vault; the paired Expert AI Agent runtime must be restarted after adapter changes.

## 0.2.0 — Opt-in local search and pocket archive

- Disabled automatic vault scans on plugin startup. Local indexing is opt-in, scoped to folders selected by the user, and pausable; Agent file tools remain available for on-demand search when the index is off.
- Added clear setup guidance describing mobile search benefits, supported Markdown notes, local processing, and the first-time work involved.
- Added dated conversation/research capture into a configurable Obsidian archive folder, including source, project, tags, summary, key points, and any supplied transcript.
- Reduced duplicate note indexing and history reads. Fixed the bundled semantic runtime path; embeddings remain off unless explicitly enabled for selected folders.
- Verification: TypeScript check and 10/10 plugin tests passed; production bundle built and installed in `archive.ssv.asia`.
- Activation: reload Expert AI in Obsidian. Restart the Expert AI Agent server to load the new `obsidian_capture` tool.
# 0.4.1 — Simpler chat and version history

- Chat now shows a single Pi session conversation across Agent turns, with one simple message box.
- Recent activity separates file changes from Agent tasks so file edits remain easy to find.
- Version review can compare saved file snapshots and restore a selected snapshot; the restore itself is recorded.

