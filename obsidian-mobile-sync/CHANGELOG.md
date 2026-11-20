# Changelog

## 0.3.2 — Manual sync only at startup

- Removed all automatic GitHub syncs on startup, app resume, and periodic timers. Opening Obsidian no longer triggers an automatic pull or full scan.
- Existing installs migrate to manual sync mode once; automatic sync after later file edits can be explicitly re-enabled in settings.
- Vault event journaling waits eight seconds after Obsidian's layout is ready, avoiding work during initial vault/plugin loading.
- The one-time journal initialization/full scan now runs only after the user starts Sync, Pull, Push, or Full scan from the panel or command palette.

## 0.3.1 — Prevent startup scan crashes

- Removed the automatic full-vault sync scan during Obsidian startup. On an uninitialized journal, the dashboard now asks for a manual first scan rather than scanning thousands of files while the app is loading.
- Deferred lightweight automatic sync until 15 seconds after layout readiness, and only when the journal has already been initialized.
- Visibility and periodic automatic syncs are gated on journal readiness; they no longer trigger an uninitialized full scan.

## 0.3.0 — Journal-driven mobile Git sync

- Added a persistent vault file journal for Obsidian create, edit, delete, file rename, and folder rename events. Renamed folders expand into per-file move records.
- Quick sync and push use pending journal paths plus changed GitHub paths after the journal is initialized, avoiding repeated hashing of the full 9,000+ file vault.
- The first sync after upgrading performs one full scan to establish journal readiness and catch older unrecorded changes. Rebuild from GitHub marks the journal ready immediately.
- Added **Full scan & push** for manual reconciliation and exact push preflight entries that name recorded local paths and differences.
- Journaled paths are re-hashed, included in sync inventory, and retained as pending when they cannot be read or still differ from GitHub.

## 0.2.9 — Detect and commit Android-created files

- Manual Sync and Commit & Push now re-hash local file contents instead of relying on modification-time and size cache entries, avoiding missed edits when Android reports coarse or unchanged timestamps.
- Local inventory also scans the vault adapter for files not yet registered in Obsidian's in-memory index, so newly created files are included in GitHub commits.

## 0.2.8 — Hidden GitHub files on Android

- Files under dot-folders such as `.claude/` are read and verified through Obsidian's adapter even when Obsidian does not register them as visible `TFile` entries.
- Rebuild writes hidden files directly to the adapter and retains them in later Git comparisons, preventing a false “did not register” failure or accidental deletion on the next sync.
- Rebuild removes empty stale hidden folders after clearing old files.

## 0.2.7 — GitHub-wins phone rebuild

- Rebuild now keeps files whose Git blob hashes already match, follows unique unchanged content to its new path, and permanently removes other local phone files/folders before downloading the GitHub tree. No recovery copy is made, per the personal-use reset request.
- Rebuild skips the usual path-relocation preflight so stale folders cannot block canonical remote paths; empty obsolete directories are removed.
- GitHub file requests retry temporary DNS/network failures. Post-write verification reads from the vault adapter and retries through both Vault and adapter writes before reporting an integrity mismatch.
- Ordinary first-time Sync remains blocked from pushing a phone's stale files; use the explicit rebuild action.
- Removed the mobile Supabase UI and disabled its migration path in this personal build; the phone exposes only GitHub pull, push, and sync controls.

## 0.2.6 — Personal GitHub vault rebuild

- Added a confirmed **Rebuild from GitHub** action that backs up changed/local-only files into `Expert AI Mobile Recovery`, moves stale local paths to Obsidian trash, and brings the phone into GitHub's current layout.
- Unchanged files found at old paths are moved to their current GitHub paths when the match is unique by content.
- Ordinary automatic Sync no longer pushes an uninitialized phone's stale local vault. A first Pull exposes local-only files for review.
- File and folder collision handling checks the on-disk adapter as well as Obsidian's in-memory file cache, preserving untracked disk files before replacing them.
- Removed automatic Supabase uploads after GitHub sync. Mobile Supabase recovery remains an explicit, separate action.
