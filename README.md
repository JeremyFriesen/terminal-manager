# Terminal Manager

Saves your open terminals to a per-workspace JSON file as they change, and restores them the next time VS Code opens the workspace.

## Enabling it

Off by default, per workspace. Having the extension installed and a `.vscode/terminal-state.json` file with entries in it is deliberately **not** enough on its own — each project must opt in explicitly.

The first time the extension activates in a workspace where it's disabled, it shows a one-time notification pointing you at the **Enable** command directly, so you don't have to already know it exists. Dismissing it (or clicking "Don't show again") won't show it again in that workspace, but doesn't suppress it anywhere else — it's tracked per-workspace, not globally.

Run **Terminal Manager: Enable** from the Command Palette and click "Reload Window" when prompted (the setting is only read once at startup, so nothing happens without a reload). To turn it back off later, run **Terminal Manager: Disable**.

This writes `"terminalManager.enabled": true` to *this workspace's* configuration specifically — never Global/User settings — so enabling it for one project can't silently turn tracking/restoring on in every other workspace you happen to open.

**Where exactly "this workspace's configuration" lives depends on how you opened the project, and that trips people up:**

- Opened via **File → Open Folder...** → it's `.vscode/settings.json` inside that folder.
- Opened via **File → Open Workspace from File...** (a `.code-workspace` file) → it's the `"settings"` block *inside that `.code-workspace` file*, which usually lives *next to* the project folder, not inside it. `.vscode/settings.json` will look completely untouched in this case — that's expected, not a bug.

VS Code decides which of these "Workspace" scope means automatically based on how the window was opened; the Enable/Disable commands always target the correct one for free. If you're ever unsure where a setting landed, check `vscode.workspace.workspaceFile` (undefined for a plain folder, the `.code-workspace` URI otherwise) — or just search both locations by hand.

Equivalent by hand, if you'd rather skip the command — add this to whichever of the two files above applies to your setup:

```json
{
  "terminalManager.enabled": true
}
```

Debug logging (see `terminalManager.debugLogging` below) has the same pair of commands: **Terminal Manager: Enable Logging** / **Terminal Manager: Disable Logging**.

## What it restores

- **Claude Code sessions** — detected when a terminal runs `claude`. Two ways this resolves to an exact `resumeMode`:
  - If the command already spells out `claude --resume <session-id>` explicitly (which is exactly what restoring a previous entry sends), that id is trusted immediately — no polling needed, since we already have full information.
  - Otherwise (a bare `claude`, or `claude --resume` with no id), the terminal's working directory is correlated against Claude Code's own session files under `~/.claude/projects/` by polling in the background for up to ~5 minutes, since Claude Code only creates or touches that session file once the first message is actually exchanged (not at process launch). Two independent signals are checked, since a genuinely *new* `claude` invocation and a *resumed* one (`claude --resume` with no id, resolved via the interactive picker) behave differently on disk: a brand-new `.jsonl` file appearing (the new-session case), or an *existing* file's mtime advancing past what it was when the command started (the resumed-session case — resuming never creates a new file, it just keeps appending to whichever one the picker resolved to). Without the second check, a terminal already in `interactive-fallback` could never reach `exact` no matter how many times it was restored, since every restore replays the same id-less `--resume`, which always resumes the *same* existing file. Gives up early if the terminal closes or the command ends first.
  
  Either way, if the installed Claude Code version doesn't match what this extension was tested against, or the session can't be pinned down (or two *new* sessions started at once in the same directory, making it ambiguous), it falls back to `claude --resume` (the interactive session picker) and shows a warning.
- **Watched commands** — long-running "leave it open" commands, detected by pattern and replayed verbatim (redacted first, see below) on restore:
  - `docker logs` / `podman logs` — short form, `<engine> compose logs`, the hyphenated standalone `<engine>-compose logs`, `<engine> container logs`, any of these with global flags before the subcommand (`docker --context remote logs ...`, `podman --remote logs ...`), and invocation via a PowerShell call operator + absolute/quoted path (`& 'C:\...\docker.EXE' logs ...`) — this last form is what **Container Tools**' (`ms-azuretools.vscode-containers`) "View Logs" action actually runs under the hood (confirmed against its bundled source); it still goes through a real shell, just not as a bare `docker` command a person would type
  - `docker compose up` / `docker-compose up` / `podman compose up` / `podman-compose up`
  - `kubectl logs -f`
  - `kubectl port-forward`
  - `tail -f`
  - PowerShell's `Get-Content -Wait`
  - `journalctl -f`
  - `ssh <target>` (a bare `ssh` with no target isn't tracked, since it isn't a persistent session)
- **Plain terminals** — restored with the same name and working directory, but empty. Command history is not replayed.

There's also a name-based backup classifier (`classifyTerminalName` in `classify.ts`) for the rarer case where a terminal genuinely never produces a shell-execution event at all (no command-line to match against) — it recognizes a terminal named literally `Logs: <container>` and synthesizes a replayable `docker logs -f "<container>"`. This isn't the primary mechanism for Container Tools specifically (that goes through the command-line match above), but stays in place as a fallback for any similar tool following the same naming convention.

### Secrets are redacted before anything is written to disk

Any command classified as a watched command has its `command` text run through a best-effort redaction (`src/tracking/redact.ts`) before it's stored in `terminal-state.json` — inline `KEY=value` assignments that look secret-shaped (`API_KEY`, `*_TOKEN`, `*_PASSWORD`, etc.), long-form CLI flags (`--password`, `--api-key`, `--token`, ...), passwords embedded in `scheme://user:password@host` URLs, and `Authorization: Bearer <token>` headers all get replaced with `***REDACTED***`. The same redaction is applied to the debug log (`.vscode/terminal-manager.log`), not just the state file.

This is deliberately conservative — bare `-p` is left alone since it's a port number in half the CLIs that use it (`docker -p`, `ssh -p`), not a password — so it's a meaningful reduction in what ends up readable on disk, not a guarantee every secret shape is caught. It also means restoring a terminal whose original command contained a secret will replay a broken/incomplete command rather than a working one; that's the intended tradeoff, not a bug — never keep a secret readable on disk just to make one-click resume more convenient.

## What it does *not* do

VS Code's extension API cannot reattach to a previously running terminal process or read its scrollback. "Restore" always means *re-run the command that recreates the state*, not reopen the exact process or screen contents that existed before.

## Settings

| Setting | Default | Description |
|---|---|---|
| `terminalManager.enabled` | `false` | Enable terminal state tracking and restore for this workspace. |
| `terminalManager.autoRestoreOnStartup` | `true` | Restore saved terminals automatically after a workspace loads. |
| `terminalManager.restoreDelayMs` | `1500` | Delay before restoring, so the window has time to settle. |
| `terminalManager.restoreStaggerMs` | `150` | Delay between creating each restored terminal, so restoring many at once doesn't spawn all of their processes in one burst. |
| `terminalManager.claudeCorrelation.enabled` | `true` | Attempt exact Claude session correlation. When off, Claude terminals always restore via the interactive picker. |
| `terminalManager.debugLogging` | `false` | Also write debug logs to `.vscode/terminal-manager.log`, in addition to the always-on "Terminal Manager" Output channel. Grows unboundedly with no rotation, so leave off unless actively diagnosing an issue. |

## Commands

- **Terminal Manager: Save Terminal State Now**
- **Terminal Manager: Restore Terminal State Now**
- **Terminal Manager: Clear Saved Terminal State**

These three stay visible in the Command Palette even when `terminalManager.enabled` is off, but just point you at the setting instead of doing anything.

- **Terminal Manager: Enable** / **Terminal Manager: Disable** — sets `terminalManager.enabled` at Workspace configuration scope (`.vscode/settings.json`, or the `.code-workspace` file's `"settings"` block — see "Enabling it" above for which one applies; never Global/User either way, so this stays per-project opt-in) and offers to reload the window, since the setting is only read once at startup.
- **Terminal Manager: Enable Logging** / **Terminal Manager: Disable Logging** — same, for `terminalManager.debugLogging`.

These four always work regardless of the current `enabled` state (in particular, **Enable** has to work while currently disabled).

## Known limitations

- Requires [Shell Integration](https://code.visualstudio.com/docs/terminal/shell-integration) to be active for a terminal's shell in order to detect its working directory and commands; unsupported shells fall back to a name-only plain terminal.
- The name-based backup classifier (currently just the `Logs: <container>` convention) is a heuristic on the terminal's title, not its content — it always assumes `docker` specifically (never `podman`) since the name alone doesn't reveal which engine was actually running, so restore will fail harmlessly if the real container was podman-backed. It could also, in principle, false-positive on a terminal a user manually renamed to start with "Logs:" for an unrelated reason; the downside is limited to a harmless failed replay on restore, not incorrect data loss.
- Claude session correlation relies on Claude Code's internal, undocumented session file layout and can break across Claude Code versions — that's what the version check and interactive-picker fallback are for.
- **Concurrent Claude sessions in the same directory can be cross-attributed** — for both a genuinely new session (a bare `claude`) and a resumed one (`claude --resume` with no id). An explicit `claude --resume <id>` never polls at all, so it's unaffected either way. For the polling case: correlation diffs each terminal's own "before" snapshot (filenames *and* mtimes) against the current directory listing, with no coordination across terminals, checking for either a brand-new file or an existing file whose mtime advanced. If terminal A's session file is created (or actively written to) a few seconds before terminal B's own correlation starts polling, B can see only A's file as the changed one and wrongly claim it — most plausible when another Claude Code conversation is already open and actively being chatted with in the same cwd while a second terminal is separately trying to correlate. A real fix needs either a shared claimed-session-id set across in-flight correlations, or verifying the candidate against the session file's own `customTitle`/`agentName` field — not implemented yet.
- The Claude version check (`claude --version`) runs in the extension host's process environment, which can have a different (often more minimal) PATH than your interactive shell — a well-known cross-platform VS Code gotcha. If `claude` isn't resolvable there, correlation always falls back to interactive mode even though `claude` works fine in your actual terminals.
- `encodeCwdToProjectDirName`'s encoding (replacing `/`, `\`, `:` with `-`) isn't injective — a path containing a literal `-` and one with a path separator in the same position can encode identically. Purely theoretical today, but a real gap in a reverse-engineered, undocumented format. The macOS/Linux path convention is also unverified — only the Windows convention has been empirically confirmed (against this very project's own session file).
- VS Code persists terminal processes across a window reload by default, so a reload doesn't close and reopen them from our perspective. On reload, terminals that survived are matched back to their saved `kind` by name (not recreated); only names present in the save file but not currently open get recreated. Terminal names aren't unique, so when 2+ saved entries share a name, each terminal's OS process id (`Terminal.processId`) is checked first — VS Code persists the underlying process (and its pid) across a reload, so this is a near-certain identity match when a pid was recorded for that entry. Falls back to positional order (first-in-queue) when no pid was recorded, or none matches. This only applies to reload-adoption, not to recreating terminals from scratch after a full close — a freshly-spawned process always gets a new, unpredictable pid, so there's nothing to match there; give terminals distinct names if you want fully reliable restore across a full close+reopen specifically.
- Closing the entire window fires a close event for every terminal at once (unlike a reload, which doesn't), which looks identical to the user closing every terminal by hand. To avoid a window close silently wiping the saved state, an all-terminals-closed save is skipped rather than written — only the explicit "Clear Saved Terminal State" command produces an empty save file.
- Single-root workspaces only for now; multi-root workspace support is not yet implemented.

## Performance at scale

Restoring a large number of terminals at once is staggered (`terminalManager.restoreStaggerMs`, default 150ms between each) rather than fired off in a tight loop — each terminal is a real OS process spawn (heavier still for `claude`/`kubectl`/`ssh` entries), so creating dozens at once without pacing would spike CPU and could momentarily stall the VS Code UI. Claude session-file correlation also shares one poller per distinct working directory (`src/claude/sessionFilePoller.ts`) rather than each terminal running its own independent `readdirSync` loop, so restoring many Claude terminals into the same project no longer means redundant directory listings every 2 seconds. Debug logging (when enabled) writes asynchronously rather than blocking, so a burst of events doesn't serialize on disk I/O.

## Where state is stored

State lives at `.vscode/terminal-state.json` in the workspace (gitignored) — this is intentional, not a dev-only stand-in, so it's easy to open and inspect by hand.

**Don't leave it open in an editor tab with Auto Save on (or manually save it).** It's a generated file the extension rewrites on every change, not something to hand-edit as a matter of routine. The specific failure mode: VS Code's hot-exit feature can preserve a dirty (unsaved) editor buffer across a full window close and restore it when the window reopens; if that stale buffer then gets saved — Auto Save, or a manual Ctrl+S — it silently overwrites whatever the extension had correctly written, and since the extension isn't running during that gap, there's no way for it to have prevented it. While the extension *is* running, it does defend against this — any external save to this exact file gets immediately overwritten with its own in-memory state (see `onExternalSave` in `terminalTracker.ts`) — but that can't help for a save that happens before the window (and the extension with it) has even finished reopening.

## Testing

`npm test` runs the unit test suite (vitest, no VS Code runtime needed) — 128 tests across 8 files. Every piece of decision logic in this extension is a plain function with no `vscode` import, specifically so it's testable without mocking the VS Code API, and every one of them has direct test coverage:

- **Classification** (`tracking/classify.ts`) — `claude` vs. watched-command vs. plain, every watched-command pattern (docker/podman logs and compose-up in all their forms, kubectl, tail/Get-Content, journalctl, ssh), the `--resume <uuid>` extraction that skips correlation entirely, and the name-based backup classifier.
- **Claude correlation** (`claude/sessionCorrelator.ts`, `claude/sessionFilePoller.ts`) — the new-session-file diff decision, the version-compatibility check, the version-string parser, the `.jsonl` filename filter, the full `buildCorrelationResult` branching (version mismatch / not found+cancelled / not found+not cancelled / found), and the shared-poller subscribe/unsubscribe mechanics (via fake timers).
- **Entry transitions** (`tracking/entryTransitions.ts`) — rename, command-start classification, command-end revert-to-plain, the name-based queue matching used for both reload-adoption and restore (plus its pid-preferring disambiguation for reload-adoption specifically), and the "does this still need correlation" check.
- **State** (`state/types.ts`) — the empty-state persist guard, and `parseState`'s handling of missing/invalid/wrong-shaped/future-versioned JSON.
- **Restore planning** (`restore/restorePlan.ts`) — which saved entries to (re)create given what's already open, and what command to replay for each kind.
- **Redaction** (`tracking/redact.ts`) — every secret pattern, plus the deliberate non-matches (bare `-p`, ordinary env vars).

The thin glue that actually calls real VS Code APIs (`vscode.window.createTerminal`, `vscode.workspace.fs`, `child_process.execFile`, `fs.readdirSync`) is deliberately *not* covered by the unit suite above — `extension.ts`, `commands.ts`, `logging.ts`, `state/storage.ts`, `tracking/terminalTracker.ts`, `restore/restoreTerminals.ts`, and the outermost few lines of `sessionCorrelator.ts` (`getInstalledClaudeVersion`, `listSessionFilesSync`). Each of those is reduced to the smallest possible wrapper around a real OS/VS Code call with the decision logic already extracted out, so there's very little left to get wrong there. That "very little" is what the integration suite below covers instead.

### Integration tests (`npm run test:integration`)

Runs against a real (headless) VS Code instance via `@vscode/test-electron` / `@vscode/test-cli`, using the fixture workspace at `src/test/fixture-workspace` (which has `terminalManager.enabled: true` and `autoRestoreOnStartup: false` pre-set in its `.vscode/settings.json`, so each test controls restore explicitly rather than racing a startup timer). Source files live at `src/test/*.itest.ts` — the `.itest.ts` suffix (not `.test.ts`) is deliberate, so these are never picked up by vitest's own default include pattern and never need excluding from it, and vice versa.

- `activation.itest.ts` — the extension actually activates against the real API and reports itself active; all 7 commands are registered; the fixture workspace's `enabled` setting was read correctly.
- `lifecycle.itest.ts` — opening a real terminal is tracked and written to the real `.vscode/terminal-state.json` in the fixture workspace; closing one of several removes just that one; closing the *last* one does **not** wipe the file (the window-close guard, verified end-to-end against real `onDidOpenTerminal`/`onDidCloseTerminal` events rather than the pure function alone).
- `classification.itest.ts` — a real shell (PowerShell) command typed into a real terminal is classified correctly by the live `onDidStartTerminalShellExecution` event, for both an exact-mode Claude resume and a watched-command (`docker logs`), and reverts to plain when the command ends. Since neither `claude` nor `docker` need to actually be installed for this (classification only reads the typed command line), each command is chained with `; Start-Sleep -Seconds N` so the shell execution stays alive long enough to observe on disk before the post-command revert fires.
- `restore.itest.ts` — `terminalManager.restoreStateNow` actually creates a real terminal from a pre-seeded state file, and does not duplicate one that's already open under the same name.

Compiles via the same `tsc -p .` as the rest of the extension (no separate tsconfig), so `out/test/**` is excluded from the packaged `.vsix` in `.vscodeignore` alongside the rest of `src/`/`out/test`. First run downloads a real VS Code build into `.vscode-test/` (gitignored), which can take a minute; subsequent runs reuse it. If it fails immediately with a `vscode-updating`/mutex error, a real VS Code updater happens to be running on the machine at the same time — wait for it to finish (or close it) and retry.
