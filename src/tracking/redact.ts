const REDACTED = '***REDACTED***';

/**
 * Best-effort scrub of common secret shapes before a command line is written
 * to terminal-state-manager.json (or the debug log). Deliberately conservative --
 * only long, unambiguous flag names are matched (not bare `-p`, which is a
 * port number in half the CLIs that use it: docker -p, ssh -p, scp -P) so a
 * legitimate command isn't mangled. This is not a guarantee every secret shape
 * is caught, just a meaningful reduction in what ends up readable on disk.
 */
export function redactSecrets(command: string): string {
  let result = command;

  // KEY=value where KEY looks secret-shaped (env var prefix, or -e/--env inline
  // assignment). The keyword may be the whole name (API_KEY) or embedded in a
  // longer one (MY_API_KEY, DB_PASSWORD).
  result = result.replace(
    /\b([A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)=(\S+)/gi,
    `$1=${REDACTED}`,
  );

  // Long, unambiguous CLI flags that take a secret value.
  result = result.replace(
    /(--(?:password|passwd|token|api-?key|secret|client-secret|access-key|auth-token))(=|\s+)(\S+)/gi,
    `$1$2${REDACTED}`,
  );

  // scheme://user:password@host -- keep user/host, redact only the password.
  result = result.replace(/(:\/\/[^\s:@/]+:)([^\s@]+)(@)/g, `$1${REDACTED}$3`);

  // Authorization: Bearer <token> -- stop at a closing quote so it isn't swallowed.
  result = result.replace(/(Bearer\s+)([^\s"]+)/gi, `$1${REDACTED}`);

  return result;
}
