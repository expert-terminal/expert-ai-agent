; Overrides electron-builder's default "close the running app before installing"
; behavior. The default sends a graceful WM_CLOSE to the app's main window and
; retries a few times before showing "X cannot be closed. Please close it
; manually and click Retry" — that check has no real window to signal against a
; tray-only app (Settings closes to the tray by design, it doesn't quit the
; process), so it can NEVER succeed here, even across an uninstall, since the
; still-running background process keeps holding the installed files locked the
; entire time. Force-terminating instead (with /T to also kill the pi-server.exe
; and node.exe child processes it spawns) makes install/upgrade/uninstall work
; reliably without asking a non-technical user to know they need Task Manager.
!macro customCheckAppRunning
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
  Pop $0
!macroend
