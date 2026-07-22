export type ClassificationResult =
  | { kind: 'claude' }
  | { kind: 'watched-command'; label: string }
  | { kind: 'plain' };

// (?=\s|$) instead of \b at the end of a command name: \b treats a hyphen as a
// word boundary too, so `\bclaude\b` would wrongly match `claude-monitor` (an
// unrelated tool) as a claude invocation. Requiring whitespace-or-end instead
// only matches when the token is genuinely complete.
const CLAUDE_COMMAND_RE = /^\s*claude(?=\s|$)/i;

interface WatchedCommandPattern {
  label: string;
  regex: RegExp;
}

/**
 * Matches `<engine> <subcommand>`, `<engine> compose <subcommand>`, the
 * hyphenated standalone `<engine>-compose <subcommand>`, `<engine> container
 * <subcommand>`, and forms with global flags in between (`docker --context
 * remote logs`) via the flexible (?:\s+\S+)*? middle. Shared between docker
 * and podman since podman's CLI is intentionally Docker-compatible.
 *
 * Also tolerates a leading PowerShell call operator (`&`) and the engine
 * being invoked via a quoted absolute path (`& 'C:\...\docker.EXE' logs ...`)
 * -- confirmed this is exactly what Container Tools' "View Logs" action
 * actually runs under the hood. A real onDidStartTerminalShellExecution
 * event *does* fire for it (contrary to earlier assumption); it just wasn't
 * being recognized by the old bare-`docker` prefix match.
 */
function enginePattern(engine: 'docker' | 'podman', subcommand: 'logs' | 'up', label: string): WatchedCommandPattern {
  return {
    label,
    regex: new RegExp(`^\\s*(?:&\\s*)?(['"]?)(?:[^'"]*[\\\\/])?${engine}(?:\\.exe)?\\1(?:-compose)?(?:\\s+\\S+)*?\\s+${subcommand}(?=\\s|$)`, 'i'),
  };
}

const WATCHED_COMMAND_PATTERNS: WatchedCommandPattern[] = [
  enginePattern('docker', 'logs', 'docker logs'),
  enginePattern('podman', 'logs', 'podman logs'),
  enginePattern('docker', 'up', 'docker compose up'),
  enginePattern('podman', 'up', 'podman compose up'),
  { label: 'kubectl logs', regex: /^\s*kubectl(?:\s+\S+)*?\s+logs(?=\s|$)/i },
  { label: 'kubectl port-forward', regex: /^\s*kubectl(?:\s+\S+)*?\s+port-forward(?=\s|$)/i },
  { label: 'tail -f', regex: /^\s*tail\s+.*-f(?=\s|$)/i },
  { label: 'Get-Content -Wait', regex: /^\s*Get-Content\b.*-Wait(?=\s|$)/i },
  { label: 'journalctl -f', regex: /^\s*journalctl\s+.*-f(?=\s|$)/i },
  // Requires an argument (e.g. user@host) so bare "ssh" (which just prints
  // usage and exits, not a persistent session) doesn't get tracked.
  { label: 'ssh', regex: /^\s*ssh\s+\S+/i },
];

// Matches the exact form we (and a user resuming by hand) would run:
// `claude --resume <session-id>`. Session ids are UUIDs, per every one
// observed from Claude Code's own session file names.
const RESUME_WITH_ID_RE = /--resume\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

/**
 * When a `claude` command already spells out `--resume <id>` explicitly, we
 * already have full, certain information -- no need to poll for a "new"
 * session file the way a bare `claude` (or `claude --resume` with no id, the
 * interactive picker) does. That poll would never succeed for a resumed
 * session anyway: resuming appends to the *existing* session file rather
 * than creating a new one, so the "what's new since this terminal started"
 * diff it relies on would never find anything and always time out.
 */
export function extractResumeSessionId(commandLine: string): string | undefined {
  return RESUME_WITH_ID_RE.exec(commandLine)?.[1];
}

export function classifyCommand(commandLine: string): ClassificationResult {
  if (CLAUDE_COMMAND_RE.test(commandLine)) {
    return { kind: 'claude' };
  }
  for (const pattern of WATCHED_COMMAND_PATTERNS) {
    if (pattern.regex.test(commandLine)) {
      return { kind: 'watched-command', label: pattern.label };
    }
  }
  return { kind: 'plain' };
}

/**
 * Backup classification for when the command-line regexes above still don't
 * match -- e.g. a shell/task type where no shell-execution event fires at
 * all, or a future command-line shape not yet accounted for. Confirmed
 * against Container Tools' (ms-azuretools.vscode-containers) bundled source
 * that its "View Logs" action names the task/terminal literally "Logs:
 * <container>", so that's checked directly from the terminal's name at open
 * time. The \b (not ^) tolerates an unknown prefix before "Logs:" while
 * still rejecting a mid-word false positive like "Analogs:".
 */
const NAMED_LOGS_TERMINAL_RE = /\bLogs?:\s*(.+)$/i;

export interface NamedTerminalMatch {
  label: string;
  command: string;
}

export function classifyTerminalName(name: string): NamedTerminalMatch | undefined {
  const target = NAMED_LOGS_TERMINAL_RE.exec(name)?.[1]?.trim();
  if (!target) {
    return undefined;
  }
  return { label: 'docker logs', command: `docker logs -f "${target}"` };
}
