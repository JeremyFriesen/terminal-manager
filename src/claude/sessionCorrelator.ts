import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { subscribeToSessionFiles } from './sessionFilePoller';

const execFileAsync = promisify(execFile);

/**
 * The Claude Code version this extension's session-directory correlation
 * logic was verified against. Claude Code's on-disk session layout
 * (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl) is an internal,
 * undocumented convention -- it can change without notice. If the installed
 * version's major version differs from this, treat correlation as unreliable.
 */
export const TESTED_CLAUDE_VERSION = '2.1.216';

// Claude Code doesn't create its session file at process launch -- only once
// the first message actually gets exchanged. In testing, that took ~95s
// while busy doing other things (renaming terminals) before typing a first
// prompt, so this needs real headroom, not a "just in case" few seconds.
const GIVE_UP_AFTER_MS = 5 * 60 * 1000;

export interface ClaudeCorrelationResult {
  sessionId?: string;
  resumeMode: 'exact' | 'interactive-fallback';
  warning?: string;
}

/** Lets the caller stop an in-flight poll early once it's known to be moot (terminal closed, command ended). */
export interface CorrelationCancelToken {
  cancelled: boolean;
}

export function createCancelToken(): CorrelationCancelToken {
  return { cancelled: false };
}

export function encodeCwdToProjectDirName(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-');
}

/** The actual filtering decision, separated from the directory read itself so it's testable without real files. */
export function filterSessionFiles(filenames: readonly string[]): Set<string> {
  return new Set(filenames.filter((f) => f.endsWith('.jsonl')));
}

/**
 * Synchronous by design: called right as a `claude` shell execution is
 * detected, so it must capture the "before" picture immediately, without
 * yielding to the event loop first -- an await here could let Claude's own
 * process create or touch its session file before we've taken the snapshot,
 * making it look like it was already in that state.
 *
 * Captures each file's mtime alongside its name, not just the set of names --
 * needed to detect a *resumed* session (see pickCorrelatedSessionFile), which
 * never creates a new file, only touches an existing one.
 */
export function listSessionFilesSync(cwd: string): Map<string, number> {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwdToProjectDirName(cwd));
  const result = new Map<string, number>();
  try {
    for (const filename of filterSessionFiles(fsSync.readdirSync(dir))) {
      try {
        result.set(filename, fsSync.statSync(path.join(dir, filename)).mtimeMs);
      } catch {
        // Disappeared between readdir and stat -- skip it rather than fail the whole snapshot.
      }
    }
  } catch {
    // Directory doesn't exist yet (e.g. Claude Code has never run in this cwd) -- empty snapshot.
  }
  return result;
}

/** Pulled out so the version-extraction regex is testable without a real `claude` binary. */
export function parseClaudeVersionOutput(stdout: string): string | undefined {
  return stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
}

export async function getInstalledClaudeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version']);
    return parseClaudeVersionOutput(stdout);
  } catch {
    return undefined;
  }
}

export function isCompatibleClaudeVersion(installed: string | undefined): boolean {
  if (!installed) {
    return false;
  }
  return installed.split('.')[0] === TESTED_CLAUDE_VERSION.split('.')[0];
}

export type NewSessionOutcome =
  | { status: 'found'; sessionId: string }
  | { status: 'ambiguous' }
  | { status: 'none-yet' };

function stripJsonlExt(filename: string): string {
  return filename.slice(0, -'.jsonl'.length);
}

/**
 * The actual decision at each poll tick, pulled out of findNewSessionId so it
 * can be tested without real files or timers.
 *
 * Two independent signals, checked in order:
 *
 * 1. A brand-new filename appeared since `beforeFiles` -- a genuinely new
 *    `claude` invocation (no `--resume` at all) creates its session file only
 *    once the first message is exchanged, never at process launch.
 * 2. Failing that, an *existing* file's mtime advanced past its `beforeFiles`
 *    value -- a *resumed* session (`claude --resume` with no id, resolved via
 *    the interactive picker) never creates a new file; it keeps appending to
 *    whichever existing file the user picked. Without this second check, a
 *    terminal already stuck in `interactive-fallback` could never correlate
 *    at all: every future restore replays the same id-less `--resume`, which
 *    always resumes the *same* existing file, so "wait for a new file" would
 *    time out on every single attempt, forever.
 *
 * Both checks compare each file only against *its own* prior state (never a
 * cross-file "most recently modified" comparison) specifically so a
 * concurrently active, unrelated session elsewhere in the same cwd can't win
 * by virtue of being touched more recently than everything else. The
 * remaining risk this doesn't close -- a *different* already-existing
 * session in the same cwd that happens to also be actively chatting during
 * this same poll window -- is the same class of accepted ambiguity already
 * documented for concurrent new sessions, just extended to cover resumed
 * ones too (see README's "Known limitations").
 */
export function pickCorrelatedSessionFile(
  currentFiles: ReadonlyMap<string, number>,
  beforeFiles: ReadonlyMap<string, number>,
): NewSessionOutcome {
  const newFiles = [...currentFiles.keys()].filter((f) => !beforeFiles.has(f));
  if (newFiles.length === 1) {
    return { status: 'found', sessionId: stripJsonlExt(newFiles[0]) };
  }
  if (newFiles.length > 1) {
    return { status: 'ambiguous' }; // more than one session started at once in this cwd
  }

  const touched = [...currentFiles.entries()].filter(([name, mtime]) => {
    const before = beforeFiles.get(name);
    return before !== undefined && mtime > before;
  });
  if (touched.length === 1) {
    return { status: 'found', sessionId: stripJsonlExt(touched[0][0]) };
  }
  if (touched.length > 1) {
    return { status: 'ambiguous' }; // more than one existing session was actively written to at once
  }

  return { status: 'none-yet' };
}

/**
 * Subscribes to the shared per-cwd poller (see sessionFilePoller.ts) rather
 * than running its own independent readdirSync loop -- multiple claude
 * terminals restoring into the same cwd share one underlying poll instead of
 * each doing redundant directory listings every 2s.
 */
function findNewSessionId(cwd: string, beforeFiles: ReadonlyMap<string, number>, cancelToken: CorrelationCancelToken): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(giveUpTimer);
      unsubscribe();
      resolve(result);
    };

    const giveUpTimer = setTimeout(() => finish(undefined), GIVE_UP_AFTER_MS);

    const unsubscribe = subscribeToSessionFiles(
      cwd,
      (files) => {
        if (cancelToken.cancelled) {
          finish(undefined);
          return;
        }
        const outcome = pickCorrelatedSessionFile(files, beforeFiles);
        if (outcome.status === 'found') {
          finish(outcome.sessionId);
        } else if (outcome.status === 'ambiguous') {
          finish(undefined);
        }
        // 'none-yet' -- keep waiting for the next shared poll tick.
      },
      listSessionFilesSync,
    );
  });
}

/**
 * The actual decision, given the 3 inputs that determine it -- pulled out so
 * it's testable without a real `claude` binary, real files, or real timers.
 * `correlateClaudeSession` below is just async plumbing that gathers these
 * three things and hands them here.
 */
export function buildCorrelationResult(
  installedVersion: string | undefined,
  sessionId: string | undefined,
  wasCancelled: boolean,
): ClaudeCorrelationResult {
  if (!isCompatibleClaudeVersion(installedVersion)) {
    return {
      resumeMode: 'interactive-fallback',
      warning:
        `Installed Claude Code version (${installedVersion ?? 'unknown'}) differs from the version ` +
        `Terminal State Manager was tested against (${TESTED_CLAUDE_VERSION}). Session auto-resume may be ` +
        'unreliable, so this terminal will fall back to the interactive --resume picker. ' +
        'Terminal State Manager may need an update to support this Claude Code version.',
    };
  }

  if (!sessionId) {
    return {
      resumeMode: 'interactive-fallback',
      // No warning if this was cancelled (terminal closed / command ended before a
      // session file turned up) -- that's not a correlation failure worth surfacing,
      // just moot at this point.
      warning: wasCancelled
        ? undefined
        : 'Could not uniquely identify the new Claude Code session file for a terminal (none appeared, or ' +
          'more than one did); falling back to the interactive --resume picker for it.',
    };
  }

  return { sessionId, resumeMode: 'exact' };
}

/** Cached for the lifetime of the extension host -- the installed CLI version won't change mid-session. */
let cachedVersionCheck: Promise<string | undefined> | undefined;

export async function correlateClaudeSession(
  cwd: string,
  beforeFiles: ReadonlyMap<string, number>,
  cancelToken: CorrelationCancelToken,
): Promise<ClaudeCorrelationResult> {
  if (!cachedVersionCheck) {
    cachedVersionCheck = getInstalledClaudeVersion();
  }
  const installedVersion = await cachedVersionCheck;
  if (!isCompatibleClaudeVersion(installedVersion)) {
    return buildCorrelationResult(installedVersion, undefined, cancelToken.cancelled);
  }

  const sessionId = await findNewSessionId(cwd, beforeFiles, cancelToken);
  return buildCorrelationResult(installedVersion, sessionId, cancelToken.cancelled);
}
