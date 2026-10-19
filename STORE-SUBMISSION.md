# Microsoft Store submission preparation

Status checked 2026-10-19. This is a preparation checklist, not a Partner Center
submission.

## Current Windows application and package

- Expert AI Agent is an Electron desktop application (Chromium + Node.js), packaged
  as a per-user NSIS installer: `Expert AI Agent-<version>-x64.exe`.
- This is a traditional Win32 `.exe` application and installer. It is **not** MSIX,
  MSI, UWP, or a PWA.
- The installer bundles the Electron app, the Pi server, and a portable Node/Pi
  runtime. It does not download additional executables during installation.
- The app starts a local agent server and can run commands and access files within
  the workspace selected by the user. Store listing text and privacy disclosures
  must describe this clearly.
- Launch at Windows sign-in is now disabled by default. Users can opt in from the
  app's Settings. The server still starts when the user opens the app.

## Microsoft Store path: AppX/MSIX package

Use the Store package route for the first Store release. Microsoft signs AppX/MSIX
packages after certification; the publisher does not need to buy or provide a
trusted code-signing certificate. The app still needs the exact package identity
and publisher values assigned after reserving the product name in Partner Center.

The repository includes a separate `npm run build:store` path. It produces an
x64 `.appx` candidate without changing the existing NSIS `.exe` release target.
The current Partner Center product is named **Expert AI** and its identity values
are:

- `STORE_IDENTITY_NAME`: `ssv.asia.ExpertAI`
- `STORE_PUBLISHER`: `CN=26DB7536-3BFC-49C0-B130-3860C6D7A511`
- `STORE_PUBLISHER_DISPLAY_NAME`: `ssv.asia`

These are configured as repository Actions variables; they are package identity
metadata, not signing secrets. The AppX manifest display name is `Expert AI`.

The current version `0.1.5` package was built locally at
`dist/store-final-2026-10-19/Expert AI Agent-0.1.5-x64.appx`. Its manifest was
checked against the Partner Center identity and the package was successfully
unpacked by Microsoft's MakeAppx tooling. It is unsigned as expected for a Store
submission; upload it to Partner Center for its package validation and certification
checks. This local package has not yet passed Store certification.

Before submitting the candidate:

1. Keep the reserved **Expert AI** product and its exact package identity values.
2. Upload the AppX package to Partner Center and resolve any package validation
   findings. After Microsoft signs and returns the Store package, test installation
   and verify first launch, tray behavior, sign-in, pairing, local server, file and
   command tools, upgrade, and uninstall.
3. Update the public privacy policy to include the Windows desktop app's account
   and diagnostic data, local workspace/file/command access, Gateway and model
   provider processing, paired-server behavior, and retention/deletion controls.
   The current page labels its opening notice as mobile-only, so it needs a
   desktop-specific disclosure before this listing is ready.
4. Complete the Partner Center listing: description, screenshots, category,
   supported Windows versions/architectures, age rating, support contact, privacy
   URL, and data/background behavior disclosures.
5. Upload the generated `.appx` candidate and submit it for certification. Then
   verify Store installation, app launch, pairing, update, and uninstall.

The existing EXE/MSI Store route remains possible, but Microsoft does not re-sign
those installers; the publisher must sign the installer and shipped PE files and
host a versioned, standalone HTTPS installer. MSIX/AppX is the better route here.

## macOS testing artifacts

The `Build & Release` workflow builds separate `arm64` (Apple Silicon) and `x64`
(Intel) DMGs. Each includes a native Pi server for its architecture and a universal
portable Node runtime, so users do not need to install Node, Rust, or the Pi agent.
Workflow validation checks the architecture of all three binaries before artifacts
are uploaded.

The macOS test builds are currently unsigned and not notarized because Apple
Developer signing/notarization credentials are not configured in GitHub Actions.
They are suitable for controlled testing; broad consumer distribution needs the
Developer ID signing and notarization setup so Gatekeeper opens them normally.

The Mac CI job also builds the private `ssv-asia/expert-ai-phone` submodule. Its
GitHub Actions runner cannot read that repository with the default token. Before
rerunning the Mac build, add a fine-grained, read-only token with Contents: Read
access to that repository as the `EXPERT_AI_PHONE_TOKEN` Actions secret in this
repository. The token is only used by checkout to fetch the submodule.

## Store references

- [Microsoft Store distribution options for Win32 apps](https://learn.microsoft.com/en-us/windows/apps/distribute-through-store/how-to-distribute-your-win32-app-through-microsoft-store)
- [MSIX/AppX package signing for Store submission](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
