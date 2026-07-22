import * as vscode from 'vscode';
import * as os from 'os';
import { StateRepository } from '../state/storage';
import { TerminalStateEntry, WorkspaceTerminalState, emptyState, shouldPersist } from '../state/types';
import { correlateClaudeSession, listSessionFilesSync, createCancelToken, CorrelationCancelToken } from '../claude/sessionCorrelator';
import {
  buildNameQueues,
  buildEntryForCommand,
  buildEntryForNewTerminal,
  revertToPlainOnCommandEnd,
  renamedEntry,
  needsClaudeCorrelation,
  pickBestAdoptionMatch,
} from './entryTransitions';
import { redactSecrets } from './redact';
import { log } from '../logging';

const SAVE_DEBOUNCE_MS = 500;
const RENAME_POLL_MS = 2000;
const SUPPRESS_CLAUDE_WARNING_KEY = 'terminalManager.suppressClaudeVersionWarning';

function bestEffortCwd(terminal: vscode.Terminal): string {
  const opts = terminal.creationOptions as vscode.TerminalOptions | undefined;
  if (opts?.cwd) {
    return typeof opts.cwd === 'string' ? opts.cwd : opts.cwd.fsPath;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

export class TerminalTracker implements vscode.Disposable {
  private readonly entries = new Map<vscode.Terminal, TerminalStateEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingCorrelations = new Map<vscode.Terminal, CorrelationCancelToken>();
  private readonly pids = new Map<vscode.Terminal, number>();
  private saveTimer: NodeJS.Timeout | undefined;
  private renamePollTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repository: StateRepository,
  ) {}

  /**
   * `initialState` is the state saved *before* this activation, used to
   * re-recognize terminals that survived a window reload (VS Code persists
   * terminal processes across reloads by default, so these show up in
   * `vscode.window.terminals` already-open rather than via onDidOpenTerminal).
   * Matched primarily by name (the one thing guaranteed to survive), with the
   * terminal's live pid as a disambiguator when 2+ saved entries share a name
   * -- see pickBestAdoptionMatch's doc comment for why pid is a near-certain
   * signal here specifically (not for restoring fresh terminals elsewhere).
   */
  async start(initialState: WorkspaceTerminalState): Promise<void> {
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => this.onOpen(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => this.onClose(terminal)),
      vscode.window.onDidChangeTerminalShellIntegration((e) => this.onShellIntegrationChange(e)),
      vscode.window.onDidStartTerminalShellExecution((e) => this.onCommandStart(e)),
      vscode.window.onDidEndTerminalShellExecution((e) => this.onCommandEnd(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onExternalSave(doc)),
    );

    const byName = buildNameQueues(initialState.terminals);
    const terminals = vscode.window.terminals;
    const resolvedPids = await Promise.all(terminals.map((t) => t.processId));
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i];
      const pid = resolvedPids[i];
      const adopt = pickBestAdoptionMatch(byName.get(terminal.name), pid);
      this.onOpen(terminal, adopt);
      if (pid !== undefined) {
        this.pids.set(terminal, pid);
      }
    }

    // VS Code has no onDidChangeTerminalName event, so a manual "Rename..."
    // is invisible to us except by polling Terminal.name.
    this.renamePollTimer = setInterval(() => this.checkForRenames(), RENAME_POLL_MS);
  }

  /** Resolves and caches a newly-opened terminal's pid, merging it into whatever entry exists once known. */
  private capturePid(terminal: vscode.Terminal): void {
    void terminal.processId.then((pid) => {
      if (pid === undefined || this.pids.has(terminal)) {
        return;
      }
      this.pids.set(terminal, pid);
      const current = this.entries.get(terminal);
      if (current) {
        this.entries.set(terminal, { ...current, pid });
        this.scheduleSave();
      }
    });
  }

  /** Name -> how many currently-open terminals have it -- used by restoreTerminals to avoid duplicating survivors of a reload. */
  currentNameCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of this.entries.values()) {
      counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    }
    return counts;
  }

  /** Cancels any pending debounce and writes immediately -- used on deactivate(). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.saveNow();
  }

  dispose(): void {
    if (this.renamePollTimer) {
      clearInterval(this.renamePollTimer);
    }
    for (const token of this.pendingCorrelations.values()) {
      token.cancelled = true;
    }
    this.pendingCorrelations.clear();
    this.disposables.forEach((d) => d.dispose());
  }

  private checkForRenames(): void {
    let changed = false;
    for (const [terminal, entry] of this.entries) {
      const renamed = renamedEntry(terminal.name, entry);
      if (renamed) {
        this.entries.set(terminal, renamed);
        changed = true;
      }
    }
    if (changed) {
      this.scheduleSave();
    }
  }

  private onOpen(terminal: vscode.Terminal, adopt?: TerminalStateEntry): void {
    if (adopt) {
      // Adopting a rediscovered terminal doesn't teach us anything the file
      // doesn't already know, so don't save here. Saving immediately would
      // shrink the on-disk state down to just what happens to already be
      // open right now, clobbering it before restoreTerminals() gets a
      // chance to read the *pre-shrink* state and recreate what's missing.
      log(`onDidOpenTerminal name="${terminal.name}" adopting previously saved kind="${adopt.kind}"`);
      this.entries.set(terminal, { ...adopt, name: terminal.name });
      return;
    }
    const entry = buildEntryForNewTerminal(terminal.name, bestEffortCwd(terminal));
    log(`onDidOpenTerminal name="${terminal.name}" classifiedAs="${entry.kind}"`);
    this.entries.set(terminal, entry);
    this.scheduleSave();
    this.capturePid(terminal);
  }

  /**
   * The state file is deliberately kept in the visible workspace so it's easy
   * to open and inspect by hand -- but that means it can also get left open
   * in an editor tab. If that tab holds stale content (e.g. VS Code's hot-exit
   * restored a dirty buffer from before a window close) and gets saved --
   * manually, or via Auto Save -- it silently overwrites whatever we last
   * wrote, with no way for us to have prevented it since our own code wasn't
   * running yet at that point. This can't fully close that gap (we're not
   * running during it either), but it does mean that *while* we're running,
   * any external save to this exact file gets immediately overwritten with
   * our own in-memory truth, rather than leaving the stale content in place
   * until the next real state change happens to trigger a save.
   */
  private onExternalSave(doc: vscode.TextDocument): void {
    const ourUri = this.repository.fileUri();
    if (!ourUri || doc.uri.toString() !== ourUri.toString()) {
      return;
    }
    log(`onDidSaveTextDocument matched our state file externally -- reasserting in-memory state over it`);
    void this.saveNow();
  }

  private onClose(terminal: vscode.Terminal): void {
    const entry = this.entries.get(terminal);
    log(`onDidCloseTerminal name="${terminal.name}" kind="${entry?.kind}"`);
    this.cancelPendingCorrelation(terminal);
    this.entries.delete(terminal);
    this.pids.delete(terminal);
    this.scheduleSave();
  }

  private cancelPendingCorrelation(terminal: vscode.Terminal): void {
    const token = this.pendingCorrelations.get(terminal);
    if (token) {
      token.cancelled = true;
      this.pendingCorrelations.delete(terminal);
    }
  }

  private onShellIntegrationChange(e: vscode.TerminalShellIntegrationChangeEvent): void {
    log(`onDidChangeTerminalShellIntegration name="${e.terminal.name}" cwd="${e.terminal.shellIntegration?.cwd?.fsPath}"`);
    const existing = this.entries.get(e.terminal);
    const cwd = e.terminal.shellIntegration?.cwd?.fsPath;
    if (existing && cwd) {
      this.entries.set(e.terminal, { ...existing, cwd });
      this.scheduleSave();
    }
  }

  private onCommandStart(e: vscode.TerminalShellExecutionStartEvent): void {
    const commandLine = e.execution.commandLine.value;
    const cwd = e.execution.cwd?.fsPath ?? bestEffortCwd(e.terminal);
    const name = e.terminal.name;

    const entry = buildEntryForCommand(commandLine, name, cwd);
    // Redacted here too, not just in the stored entry -- this log line would
    // otherwise be a second place a secret ends up readable on disk.
    log(`onDidStartTerminalShellExecution name="${name}" commandLine="${redactSecrets(commandLine)}" classifiedAs="${entry.kind}"`);
    this.entries.set(e.terminal, entry);
    this.scheduleSave();

    if (needsClaudeCorrelation(entry)) {
      // Captured synchronously, before the claude process has had a chance to
      // create its session file -- see listSessionFilesSync's doc comment.
      const beforeFiles = listSessionFilesSync(cwd);
      this.cancelPendingCorrelation(e.terminal); // in case a prior claude invocation in this terminal is still polling
      const cancelToken = createCancelToken();
      this.pendingCorrelations.set(e.terminal, cancelToken);
      this.correlateInBackground(e.terminal, cwd, beforeFiles, cancelToken);
    }
  }

  private onCommandEnd(e: vscode.TerminalShellExecutionEndEvent): void {
    log(`onDidEndTerminalShellExecution name="${e.terminal.name}" exitCode=${e.exitCode}`);
    const reverted = revertToPlainOnCommandEnd(this.entries.get(e.terminal), e.terminal.name);
    if (reverted) {
      this.cancelPendingCorrelation(e.terminal); // claude exited, no point still hunting for its session file
      this.entries.set(e.terminal, reverted);
      this.scheduleSave();
    }
  }

  private async correlateInBackground(
    terminal: vscode.Terminal,
    cwd: string,
    beforeFiles: ReadonlyMap<string, number>,
    cancelToken: CorrelationCancelToken,
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('terminalManager');
    if (!config.get<boolean>('claudeCorrelation.enabled', true)) {
      return;
    }

    const result = await correlateClaudeSession(cwd, beforeFiles, cancelToken);
    // Only clear our own token's slot -- a newer claude invocation in this same
    // terminal may have already replaced it with its own pending correlation.
    if (this.pendingCorrelations.get(terminal) === cancelToken) {
      this.pendingCorrelations.delete(terminal);
    }

    const current = this.entries.get(terminal);
    if (!current || current.kind !== 'claude') {
      return;
    }
    this.entries.set(terminal, {
      ...current,
      sessionId: result.sessionId,
      resumeMode: result.resumeMode,
    });
    this.scheduleSave();

    if (result.warning) {
      this.showClaudeWarningOnce(result.warning);
    }
  }

  private showClaudeWarningOnce(message: string): void {
    if (this.context.globalState.get<boolean>(SUPPRESS_CLAUDE_WARNING_KEY)) {
      return;
    }
    void vscode.window.showWarningMessage(message, "Don't show again").then((choice) => {
      if (choice === "Don't show again") {
        void this.context.globalState.update(SUPPRESS_CLAUDE_WARNING_KEY, true);
      }
    });
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private async saveNow(): Promise<void> {
    const state = emptyState();
    state.terminals = Array.from(this.entries.values());

    if (!shouldPersist(state)) {
      log('saveNow: 0 entries -- skipping write to avoid clobbering saved state on window close');
      return;
    }

    log(`saveNow: writing ${state.terminals.length} entries [${state.terminals.map((t) => `${t.name}:${t.kind}`).join(', ')}]`);
    await this.repository.save(state);
  }
}
