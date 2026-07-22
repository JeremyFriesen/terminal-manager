# Manual UI Test Plan

Checklist for exercising Terminal State Manager through a real Extension Development Host (F5). This is a maintainer/dev-only document — it is excluded from the packaged `.vsix` (see `.vscodeignore`) since none of this is relevant to an end user. The automated unit suite (`npm test`) covers the pure decision logic, and `npm run test:integration` (see README's "Testing" section) now covers a slice of the real VS Code integration too (activation, real terminal tracking, real shell-execution classification, restore-via-command). This document remains the stand-in for everything neither of those reaches yet: a real `claude`/`docker` binary and actual Claude session correlation, an actual window reload (`Ctrl+R`) and full close+reopen, Container Tools' real "View Logs" action, multi-terminal restore ordering, the editor-buffer-clobber scenario, and UX details (icon, notifications, Command Palette wording).

Before starting a pass: clear `.vscode/terminal-state-manager.json` and `.vscode/terminal-state-manager.log` (if present) and remove `.vscode/settings.json` entirely, so you start from a truly untouched state, and reload the Extension Development Host so you're testing current code. **Also check for a sibling `.code-workspace` file** (this repo has `vscode-extension-terminal-manager.code-workspace` one directory up) and make sure its `"settings"` block doesn't have a stray `terminalManager.*` entry left over from a previous pass — `.vscode/settings.json` looking clean does *not* mean the workspace is actually clean if the project was opened via that file instead of a plain folder open. This is exactly the gap that caused a real false alarm during testing: enabling via the notification/command while the project was open through the `.code-workspace` file wrote there instead of `.vscode/settings.json`, and checking only the latter made it look like tracking had turned on with no corresponding settings anywhere.

The sections below are ordered to minimize setup/teardown churn — each one reuses whatever the previous section already set up rather than resetting from scratch. If you're only spot-checking one thing, jump straight to it; the ordering mainly matters for a full pass.

## 1. Clean-slate baseline, then turn it on via the command (not by hand)

Covers the disabled state, the fresh-project case, and the Enable command all in one pass, since they're really the same before/after transition.

- [x ] Confirm `.vscode/` has no `settings.json`, `terminal-state-manager.json`, or `terminal-state-manager.log`, **and** the sibling `.code-workspace` file (if the project has one) has no `terminalManager.*` entry in its `"settings"` block either — a truly untouched state, not just `enabled: false` explicitly set somewhere.
- [x ] Reload with that clean state — confirm the one-time "Terminal State Manager is available for this workspace but not enabled" notification appears on activation.
- [x ] Dismiss it via "Don't show again", then reload again — confirm it does *not* reappear in this workspace.
- [x ] Open a different, unrelated project (still disabled there) — confirm the notification *does* appear there, proving suppression is per-workspace (`workspaceState`), not global.
- [x ] Back in this workspace: with nothing configured, open/close/rename a terminal — confirm `.vscode/terminal-state-manager.json` is never created.
- [x ] Run each of Save/Restore/Clear from the Command Palette — confirm each just shows the "Terminal State Manager is disabled for this workspace" message and does nothing else.
- [x ] **If you opened the project as a plain folder**: run **Terminal State Manager: Enable** — confirm it creates `.vscode/settings.json` with `"terminalManager.enabled": true`, and offers a "Reload Window" button. Click it. (Or click "Enable" directly from the notification in step 2 above instead, to confirm that path also works.)
- [ ] **If you opened the project via a `.code-workspace` file instead**: run **Terminal State Manager: Enable** — confirm `"terminalManager.enabled": true` lands in *that file's* `"settings"` block, and confirm `.vscode/settings.json` is **not** created at all. Do this at least once per test pass if the project has a `.code-workspace` file, since it's a genuinely different code path (`vscode.ConfigurationTarget.Workspace` resolves to a different physical file) and easy to skip if you only ever test via plain folder opens.
- [x ] (Optional, separately) Repeat the "no settings.json at all" check in a genuinely unrelated project, to rule out any cross-project leftovers affecting the result.

## 2. Turn logging on too, then open everything you'll need for the rest of this pass

Opening everything up front — and starting the Claude session *first* — means its ~5-minute correlation wait happens in the background while you do the other checks below, instead of sitting idle waiting on it later.

- [x ] Run **Terminal State Manager: Enable Logging**, reload.
- [x ] Start `claude` in one terminal and actually send it a message right away. This is the one you'll check for exact-session resume in step 4 — leave it alone for the rest of this pass.
- [ ] In separate terminals, run each of: `docker logs -f <container>`, `docker compose logs -f <service>`, `docker-compose logs -f <service>` (if installed), `podman logs -f <container>` (if installed), `docker compose up` / `podman compose up`, `kubectl logs -f <pod>` (if you have a cluster), `kubectl port-forward svc/x 8080:80`, `tail -f <file>` (bash), `Get-Content -Path <file> -Wait` (PowerShell), `journalctl -f` (Linux/WSL), `ssh <host>`, a bare `ssh` with no target, and an unrelated command like `git status`.
- [ ] Open 2+ *more* terminals sharing the same (default or renamed) name, with different kinds (e.g. two both named "pwsh", one running `claude`, one plain) — for the same-name-collision check in step 4.
- [ ] Open enough additional plain terminals to have ~15-20+ total open, for the large-scale restore check in step 4.

## 3. While that Claude session correlates in the background: classification, redaction, rename/exit

For each command from step 2, check `.vscode/terminal-state-manager.json` shows the expected `kind`/`label`:

- [ ] `claude` → `kind: "claude"`
- [ ] `docker logs -f <container>` → `kind: "watched-command"`, `label: "docker logs"`
- [ ] `docker compose logs -f <service>` → same label
- [ ] `docker-compose logs -f <service>` (if installed) → same label
- [ ] `podman logs -f <container>` (if installed) → `label: "podman logs"`
- [ ] `docker compose up` / `podman compose up` → `label: "docker compose up"` / `"podman compose up"`
- [ ] `kubectl logs -f <pod>` → `label: "kubectl logs"`
- [ ] `kubectl port-forward svc/x 8080:80` → `label: "kubectl port-forward"`
- [ ] `tail -f <file>` (bash) → `label: "tail -f"`
- [ ] `Get-Content -Path <file> -Wait` (PowerShell) → `label: "Get-Content -Wait"`
- [ ] `journalctl -f` (Linux/WSL) → `label: "journalctl -f"`
- [ ] `ssh <host>` → `label: "ssh"`; bare `ssh` with no target → stays `plain`
- [ ] The unrelated command (`git status`) → stays `plain`
- [ ] If you have the **Container Tools** extension (`ms-azuretools.vscode-containers`): right-click a running container in its tree view → **View Logs**. This opens a terminal via a VS Code Task (shown with a wrench icon and "Task" label in the terminal dropdown, distinct from regular terminals). Confirm it's classified `kind: "watched-command"`, `label: "docker logs"` — this now happens via the actual command line (a PowerShell call-operator + absolute-path `docker.EXE` invocation, not the name), so check the Output channel / debug log shows a real `onDidStartTerminalShellExecution` line for it, not just a name-based match. Confirm restoring it later replays `docker logs -f "<container>"` in a real terminal.
- [ ] Run something like `docker logs -f web --since API_KEY=sk-test123` in a spare terminal — confirm both `.vscode/terminal-state-manager.json` and `.vscode/terminal-state-manager.log` show `***REDACTED***` in place of the fake key, not the real value.
- [ ] Rename a terminal (right-click → Rename…) — within ~2s, confirm the saved entry's `name` updates and `kind` is preserved.
- [ ] Exit a **throwaway** `claude` terminal (not the one from step 2 you're waiting on) with `/exit` — confirm it reverts to `kind: "plain"`.
- [ ] Ctrl+C a `docker logs -f` terminal — confirm it also reverts to `plain`.

## 4. One reload, several checks at once

Everything needed is already open from steps 2-3, so a single Ctrl+R covers all of these:

- [ ] No duplicate terminals appear, and each adopted terminal keeps its correct `kind` (previously a bug — reload used to reset everything to `plain`).
- [ ] The redacted secret-command entry from step 3 replays its redacted (now-broken) command on restore — this is expected, not a bug.
- [ ] The same-name terminals from step 2 are matched back to their correct kind in order, not collapsed onto one.
- [ ] If ~5 minutes have passed since starting `claude` in step 2, that entry now shows `resumeMode: "exact"` with a `sessionId`, and this reload runs `claude --resume <that-id>`, landing back in the same conversation. If it hasn't been long enough yet, leave the window open and check again after another reload later.
- [ ] **After that resumed terminal's `claude --resume <id>` actually starts running**, check `.vscode/terminal-state-manager.json` again — confirm `resumeMode` stays `"exact"` with the *same* `sessionId` (not reset to `interactive-fallback`), and check the Output channel/debug log shows no new correlation poll kicking off for it. This is the resume path specifically, distinct from the brand-new-session path above: a poll here would never succeed anyway, since resuming appends to the existing session file rather than creating a new one.
- [ ] With ~15-20+ terminals open, they reappear staggered over time (roughly `restoreStaggerMs` apart) rather than all at once, and the UI stays responsive. If you have several Claude entries pointed at the same cwd among them, confirm the Output channel shows correlation still resolves correctly for each despite sharing one poller (no cross-attribution, no missed sessions).
- [ ] Separately (doesn't need the above setup): try setting `terminalManager.restoreStaggerMs` to `0` and confirm terminals restore immediately with no stagger — confirms the setting actually takes effect either direction.
- [ ] Separately: start a *fresh* `claude` terminal and reload/restore *before* sending it any message — confirm it falls back to `claude --resume` (interactive picker) rather than hanging or guessing wrong, since no session file exists yet to correlate against.

## 5. Remaining toggle-command checks, then disable

- [ ] Run **Terminal State Manager: Disable** and **Terminal State Manager: Disable Logging** — confirm both flip their settings back to `false` (not removed) and offer a reload.
- [ ] Confirm all 4 toggle commands only ever touched *workspace* settings — check your User settings (`Ctrl+,` → User tab, or "Preferences: Open User Settings (JSON)") are untouched throughout. Remember "workspace settings" means `.vscode/settings.json` *or* the `.code-workspace` file's `"settings"` block, depending on how the project was opened — check whichever one actually applies, not just `.vscode/settings.json` by reflex.
- [ ] With no folder/workspace open at all, run any of the 4 toggle commands — confirm a clear error message, not an unhandled exception.

## 6. The big one: full close + reopen

Do this last — it's the most disruptive test (tears down the whole window), so there's no reason to do lighter checks after it.

- [ ] Re-enable and get a mix of claude/watched-command/plain terminals open and correctly classified (or reuse whatever's still open from earlier steps).
- [ ] Close the entire Extension Development Host window (not just Ctrl+R).
- [ ] Confirm `.vscode/terminal-state-manager.json` still has the pre-close data afterward (a window close must not wipe it — only "Clear Saved Terminal State" should produce an empty file).
- [ ] Reopen the same folder in a **normal, non-debug** VS Code window — confirm nothing gets auto-created (the extension isn't running there at all).
- [ ] Relaunch via F5 — confirm the missing terminals are recreated with the right resume/replay command, and anything VS Code itself revived isn't duplicated.

**Editor-buffer clobbering** (a real bug we hit): VS Code's hot-exit can preserve a dirty `terminal-state-manager.json` editor buffer across a window close and restore it on reopen, silently overwriting correct data if that buffer then gets saved.

- [ ] Open `.vscode/terminal-state-manager.json` in an editor tab, make a trivial edit (don't save), then close the whole window with terminals still open and correctly classified.
- [ ] Reopen — if that dirty buffer gets restored and saved (Auto Save, or you hit Ctrl+S), confirm the extension's `onDidSaveTextDocument` listener immediately reasserts the correct in-memory state over it (check the debug log for `"onDidSaveTextDocument matched our state file externally"`), rather than the stale content sticking.
- [ ] As a control: repeat without ever having the file open in an editor at all, and confirm the close/reopen cycle behaves normally.

## 7. Wrap-up: global state check

Given how much Claude correlation this pass just exercised, worth checking whether the version-mismatch warning ever fired and got dismissed:

- [ ] The "Don't show again" choice is stored in `context.globalState`, keyed to *you*, not this workspace — if suppressed, it silently stays suppressed in every other project too. Query `%APPDATA%\Code\User\globalStorage\state.vscdb` (SQLite) for a key containing the extension id, e.g. `sqlite3 -readonly state.vscdb "SELECT key FROM ItemTable WHERE key LIKE '%terminal-manager%'"`. There's no in-extension command to check/clear this today.

## Notes

Log anything unexpected here as you go, with enough detail to reproduce (exact commands run, order of operations, and what showed up in `.vscode/terminal-state-manager.json` / the Output channel vs. what was expected).
