# Expert AI for Obsidian

Expert AI connects an Obsidian desktop vault to the Expert AI Agent desktop app. From the Agent on your phone, you can find notes, update the note open on your computer, see which files and panes are open, capture a conversation into a dated archive note, manage Git, and request a recent cloud backup.

Note versions are stored locally in this vault's Obsidian data store. A lightweight background baseline lets the Activity view capture changes made through Expert AI or other tools while Obsidian is connected. It is separate from local search and does not create embeddings.

## Install

1. Close Obsidian or keep it open.
2. In your vault, open `.obsidian/plugins/` (create the `plugins` folder if needed).
3. Copy the contents of this package into `.obsidian/plugins/expert-ai-companion/`. The folder must contain `manifest.json`, `main.js`, `styles.css`, `icon.png`, `obsidian-pi-extension.mjs`, and the two `ort-wasm-simd-threaded.asyncify.*` runtime files directly.
4. In Obsidian, open **Settings → Community plugins**, reload plugins, then enable **Expert AI**.
5. In **Settings → Expert AI**, choose **Connect Expert AI Agent**. This installs a small Pi adapter and updates the Agent's per-user `agent-settings.json`; an original settings backup is kept beside that file as `.expert-ai-backup`.
6. Restart the Expert AI Agent server from its desktop app. Reopen Obsidian if the local bridge was stopped.

To disconnect, use **Disconnect** in the plugin settings. It removes only this plugin's adapter entry and files. Other Agent settings are preserved.

## What it does

- Indexes Markdown note titles, headings, tags, aliases, and passages locally. Search works immediately with lexical ranking.
- Fast local keyword search is the default and requires no model download. It finds notes by words, headings, tags, and aliases using a small local index. This is a good starting point for a text archive and usually feels immediate.
- Optional meaning search can find passages about a similar idea even when the query uses different words. It downloads a small model on first use and computes embeddings only in folders you select. Embeddings and note text stay on this computer. This helps retrieval; it does not give the language model automatic access to the whole vault.
- Indexing is off by default. When you opt in and choose folders, subfolders are included by default; you can turn that off in the picker. Confirming the selection starts indexing immediately. The keyword index survives restarts in local IndexedDB. Startup checks file metadata only in that scope; unchanged note contents are not reread. New and changed notes are processed incrementally in short batches, with pause/resume controls. Duplicate update notifications share one index operation.
- A saved folder scope and indexing state are separate: if indexing was paused, the Activity pane and Settings show the saved scope and offer **Start local search**. Resuming checks only selected-scope file metadata and reads changed notes.
- If a scope change would leave a large amount of out-of-scope cached search data, the plugin clears only its derived search index and rebuilds the chosen scope in batches. Notes and the separate change-history database are preserved.
- Adds Agent tools for search, read, create, append, precise replacement, move/rename, history, preview-first restore, live status, grouped changes, conversation capture, and arranging Obsidian notes in tabs or split panes plus showing/hiding sidebars.
- Adds Git actions for status, remote refresh, local commit, and conflict-aware pull/push. Sync checkpoints uncommitted local edits, fetches GitHub, merges divergent history without rebasing or force-pushing, and pushes the combined branch. Non-overlapping changes merge automatically; true file conflicts stay in Git's merge state and are listed in Sync activity so both versions remain recoverable. GitHub authentication uses the computer's Git credential manager or SSH agent; the plugin never stores GitHub credentials.
- The Sync dashboard reports changed file and commit counts for pull/push, summarizes additions/edits/removals/renames, lists a few affected paths, and records successes and failures in local activity. A zero-change result clearly says the vault is up to date.
- The live workspace map shows open files across panes and windows, the active note, tab order, and Markdown editor mode. Agent turns receive only this small path/layout summary; they read file contents only when the request needs them.
- Adds opt-in, streamed cloud snapshots through the authenticated Expert AI Gateway. All folders are selected by default, with a recursive folder picker to exclude large areas. The plugin compresses the selected archive as a stream and uploads verified 4 MiB chunks, then publishes a snapshot only after Gateway-side integrity checks pass. Snapshots are kept for 7 days. The Sync panel can compare a snapshot with the current vault, add missing files, or restore changed files after first copying their current versions under `.expert-ai-recovery`. Standard accounts have a 50 MB rolling limit per vault; verified founder accounts have no app-level rolling cap. Supabase project quota and the 250 MB uncompressed preparation limit still apply. The Gateway uses a private Supabase Storage bucket; users do not need a separate Supabase login.
- Recent Agent tasks open in a dockable chat pane inside Obsidian. New vault tasks keep their visible user/assistant messages and a local activity timeline; you can send a follow-up to the same active Pi session from the desktop pane. Old task records created before this feature do not have a session link.
- The chat timeline streams the assistant's visible reply and records concrete tool starts and results, including shell/search inputs. It does not expose or store private model reasoning.
- Conversation capture creates a dated Markdown note with title, source, project, tags, summary, key points, and supplied transcript under the configurable archive folder. To save a conversation from another AI app, share or paste its content into Expert AI Agent first; this plugin does not silently read other apps' private chat histories.
- When the Agent's current working directory is inside the connected vault, injects a small set of relevant local excerpts into that Agent turn. It does not send the whole vault as context.
- Keeps local history for 7 or 13 days, with before/after snapshots for supported text changes. Restore is never immediate: review the previous version beside the live note, then explicitly choose whether to restore it. Newer edits are protected by a content check. Agent undo calls first return a compact preview and require a second confirmed call.
- Applies edits through Obsidian APIs and the open editor, so the visible note updates as soon as the Agent's edit tool call completes. Model response time still depends on the selected model and network.

## Privacy and scope

The local HTTP bridge binds only to `127.0.0.1` and requires a random token. Index, embeddings, and history are stored in this vault's local Obsidian data. The optional model is downloaded from Hugging Face; note text stays local. Connecting to Expert AI Agent shares relevant excerpts and requested note contents with the configured Agent model, as required to answer the request. Cloud backup uploads only the selected folders after the user asks or enables automatic backup; the Gateway service key stays server-side. Cloud snapshots are not end-to-end encrypted, so the Gateway and Supabase project can access their contents.

This is an Obsidian desktop integration for knowledge work. It provides Git operations and recent cloud recovery snapshots, not continuous conflict-resolving sync between devices. Git remains the full sync and merge path. The plugin does not provide a language model, general-purpose shell/computer control, or media editing; the Agent's configured model and tools determine tasks beyond the vault operations exposed here.

## Cloud backup setup

Create a private Storage bucket named `expert-ai-vault-backups` in the second Supabase project, then configure `SUPABASE_BACKUP_URL` and `SUPABASE_BACKUP_KEY` as secrets on the Expert AI Gateway and deploy the Gateway. Never put the server-side key in this plugin, the APK, or a user-facing document. See **Settings → Expert AI → Managed storage connection → Setup instructions** for the same steps.

## Troubleshooting

- If Agent tools do not appear after connecting, restart the Agent server and check that the adapter path is listed in `%APPDATA%/expert-ai-agent/pi-server/agent-settings.json`.
- If **Open chat** says the task's session is not active, switch the Expert AI Agent to that saved session; only the active local Pi session can accept a continuation from Obsidian.
- If the vault bridge is unavailable, reopen the vault and check that the plugin is enabled.
- If meaning-search setup fails, keyword search remains available. Retry from the folder-selection dialog when the computer is online.
- The optional local semantic model downloads on first use and is cached by Obsidian on this computer. If model or runtime loading fails, the visible status reports the failure, keyword search remains available, and a retry is possible; it never silently enables a remote embeddings API.
- The plugin never edits `.obsidian` settings through its Agent tools. Use Obsidian or the plugin settings UI for configuration.
