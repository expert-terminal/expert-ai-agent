# Expert AI

Personal Android Obsidian plugin for syncing a vault with real GitHub commits. GitHub is the only active sync source in this build.

## Setup

1. Copy the plugin files from `dist` into `.obsidian/plugins/expert-ai-mobile-sync` in the Android vault. Keep the existing `data.json` to preserve settings.
2. Enable or reload **Expert AI** in Obsidian's Community plugins settings.
3. Open the Expert AI Sync panel and tap **Connect GitHub**. Open the device page, enter the displayed code, and approve access.
4. Set the GitHub repository if it was not discovered automatically. Use the same repository and branch as the desktop vault.
5. Tap **Pull from GitHub** or **Sync GitHub**. The plugin then checks after vault open/resume, periodically, and shortly after edits.

For an old or reorganized phone vault with no prior GitHub baseline, use **Rebuild from GitHub** in the Sync panel (or its command palette command). Confirming it makes the phone match GitHub: identical files stay, unchanged content at old paths moves to its current path when the match is unique, and other local files/folders are permanently removed before missing GitHub files are downloaded. This action is intended for a disposable/stale local phone copy. Ordinary first-time Sync will not push an uninitialized phone's old files.

The public OAuth client ID is built into the plugin and is not shown as a user-editable setting. It is an identifier, not a secret; the authorization token stays in Obsidian's secret storage. The OAuth app must have Device Flow enabled. If the phone temporarily loses DNS while switching back from GitHub, the authorization code is retained and polling retries until it expires. A saved authorization is shown separately from repository verification, so you can tell whether sign-in succeeded while a network interruption still needs a repository check.

The dashboard has **Sync GitHub**, **Pull from GitHub**, and **Commit & push** buttons, plus the command palette commands **Sync vault with GitHub**, **Pull latest vault from GitHub**, and **Commit and push local vault changes to GitHub**. Each push creates a regular Git commit named `vault backup: YYYY-MM-DD HH:mm:ss`. Progress, pushed/pulled counts, commit IDs, and errors appear in the dashboard log.

Mobile sync records Obsidian create, edit, delete, and move events in a local file journal. After one full scan on upgrade (or an explicit rebuild), regular sync/push checks only journaled paths and changed GitHub paths. Use **Full scan & push** when files were changed while the plugin was unloaded or outside Obsidian.

Opening Obsidian never triggers a GitHub pull or vault scan. The mobile build defaults to manual sync; run Sync, Pull, or Push from the panel or command palette after Obsidian is open. You can optionally enable background sync after edits in settings.

Only changed files are committed. `.obsidian`, `.git`, and `.trash` are excluded. Each individual file must be 45 MiB or less. Concurrent edits are preserved as a clearly named sibling file; the plugin does not silently choose one. Files downloaded from GitHub are checked against the Git blob SHA before and after writing. Remote deletions move files to Obsidian's local trash instead of permanently deleting them. GitHub OAuth uses the public client ID configured in the plugin and stores authorization through Obsidian's secret storage. The GitHub OAuth App must have Device Flow enabled.

When an older phone reconnects after a folder move, unchanged files follow their content to the new path and now-empty old folders are removed. GitHub rename history also identifies files whose contents changed during a move. Those moves and unique-name matches appear in **Versions kept safe** with a side-by-side text comparison and three choices: keep both, keep the remote copy, or move your local copy to the new path while preserving the remote version beside it. Cross-folder file moves use Obsidian's file manager so internal links are updated. Files with renamed names and changed contents cannot be matched with certainty if neither GitHub history nor a unique filename identifies them; they remain untouched for manual review.

## Optional recovery copy

## Windows connection status

The current Windows plugin still writes its existing compressed backup snapshots. The mobile plugin uses the new per-file sync manifest API, so a matching Windows plugin build is required for Windows and Android to share this live sync state. That Windows build is a separate follow-up; this ZIP does not change the installed Windows plugin. Until that build is installed, verify the new sync between two mobile vaults or in a disposable test vault.

This mobile build uses GitHub's REST Git Data API rather than a local Git executable, which is suitable for Android. Keep your existing backup while validating it on a copy of your vault.
