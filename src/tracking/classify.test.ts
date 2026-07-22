import { describe, it, expect } from 'vitest';
import { classifyCommand, classifyTerminalName, extractResumeSessionId } from './classify';

describe('classifyCommand', () => {
  it('classifies a bare claude invocation', () => {
    expect(classifyCommand('claude')).toEqual({ kind: 'claude' });
  });

  it('classifies claude with arguments', () => {
    expect(classifyCommand('claude --resume abc-123')).toEqual({ kind: 'claude' });
  });

  it('is case-insensitive for claude', () => {
    expect(classifyCommand('Claude')).toEqual({ kind: 'claude' });
  });

  it('does not match "claude" as a prefix of another word', () => {
    expect(classifyCommand('claudex --foo')).toEqual({ kind: 'plain' });
  });

  it('does not match an unrelated tool merely prefixed with "claude-"', () => {
    expect(classifyCommand('claude-monitor --watch')).toEqual({ kind: 'plain' });
  });

  it('tolerates leading whitespace', () => {
    expect(classifyCommand('   claude')).toEqual({ kind: 'claude' });
  });

  it('falls back to plain for unrelated commands', () => {
    expect(classifyCommand('git status')).toEqual({ kind: 'plain' });
  });

  describe('docker logs', () => {
    it('classifies the short form', () => {
      expect(classifyCommand('docker logs -f my-container')).toEqual({ kind: 'watched-command', label: 'docker logs' });
    });

    it('classifies the "docker compose logs" subcommand form', () => {
      expect(classifyCommand('docker compose logs -f web')).toEqual({ kind: 'watched-command', label: 'docker logs' });
    });

    it('classifies the hyphenated standalone "docker-compose logs" binary', () => {
      expect(classifyCommand('docker-compose logs -f web')).toEqual({ kind: 'watched-command', label: 'docker logs' });
    });

    it('classifies the long "docker container logs" form', () => {
      expect(classifyCommand('docker container logs -f web')).toEqual({ kind: 'watched-command', label: 'docker logs' });
    });

    it('classifies through global docker flags before the subcommand', () => {
      expect(classifyCommand('docker --context remote logs -f web')).toEqual({ kind: 'watched-command', label: 'docker logs' });
    });

    it('is case-insensitive', () => {
      expect(classifyCommand('Docker Logs -f my-container')).toEqual({ kind: 'watched-command', label: 'docker logs' });
    });

    it('falls back to plain for a bare docker command with no logs subcommand', () => {
      expect(classifyCommand('docker ps')).toEqual({ kind: 'plain' });
    });

    it('does not false-positive on "logs" appearing inside an unrelated argument', () => {
      expect(classifyCommand('docker build --tag logs-app .')).toEqual({ kind: 'plain' });
    });

    it('classifies a PowerShell call-operator invocation of an absolute, quoted docker.EXE path (Container Tools\' "View Logs")', () => {
      const real = String.raw`& 'C:\Program Files\Docker\Docker\resources\bin\docker.EXE' logs --tail 1000 -f 26c5fbc747513908c5f07559dc93b849e62474dd44df61177db99df69458c190`;
      expect(classifyCommand(real)).toEqual({ kind: 'watched-command', label: 'docker logs' });
    });

    it('classifies an unquoted absolute path invocation too', () => {
      expect(classifyCommand('/usr/local/bin/docker logs -f web')).toEqual({ kind: 'watched-command', label: 'docker logs' });
    });
  });

  it('classifies "docker compose up"', () => {
    expect(classifyCommand('docker compose up')).toEqual({ kind: 'watched-command', label: 'docker compose up' });
  });

  it('classifies "docker-compose up -d"', () => {
    expect(classifyCommand('docker-compose up -d')).toEqual({ kind: 'watched-command', label: 'docker compose up' });
  });

  describe('podman logs', () => {
    it('classifies the short form', () => {
      expect(classifyCommand('podman logs -f my-container')).toEqual({ kind: 'watched-command', label: 'podman logs' });
    });

    it('classifies "podman compose logs"', () => {
      expect(classifyCommand('podman compose logs -f web')).toEqual({ kind: 'watched-command', label: 'podman logs' });
    });

    it('classifies the hyphenated standalone "podman-compose logs"', () => {
      expect(classifyCommand('podman-compose logs -f web')).toEqual({ kind: 'watched-command', label: 'podman logs' });
    });

    it('classifies through global podman flags before the subcommand', () => {
      expect(classifyCommand('podman --remote logs -f web')).toEqual({ kind: 'watched-command', label: 'podman logs' });
    });

    it('falls back to plain for a bare podman command with no logs subcommand', () => {
      expect(classifyCommand('podman ps')).toEqual({ kind: 'plain' });
    });
  });

  it('classifies "podman compose up"', () => {
    expect(classifyCommand('podman compose up')).toEqual({ kind: 'watched-command', label: 'podman compose up' });
  });

  it('classifies "podman-compose up -d"', () => {
    expect(classifyCommand('podman-compose up -d')).toEqual({ kind: 'watched-command', label: 'podman compose up' });
  });

  it('classifies "kubectl logs -f"', () => {
    expect(classifyCommand('kubectl logs -f my-pod')).toEqual({ kind: 'watched-command', label: 'kubectl logs' });
  });

  it('classifies "kubectl port-forward"', () => {
    expect(classifyCommand('kubectl port-forward svc/my-svc 8080:80')).toEqual({
      kind: 'watched-command',
      label: 'kubectl port-forward',
    });
  });

  it('classifies "tail -f"', () => {
    expect(classifyCommand('tail -f /var/log/app.log')).toEqual({ kind: 'watched-command', label: 'tail -f' });
  });

  it('classifies "tail -f" with other flags in between', () => {
    expect(classifyCommand('tail -n 100 -f app.log')).toEqual({ kind: 'watched-command', label: 'tail -f' });
  });

  it('classifies PowerShell\'s "Get-Content -Wait"', () => {
    expect(classifyCommand('Get-Content -Path app.log -Wait')).toEqual({ kind: 'watched-command', label: 'Get-Content -Wait' });
  });

  it('classifies "journalctl -f"', () => {
    expect(classifyCommand('journalctl -u myservice -f')).toEqual({ kind: 'watched-command', label: 'journalctl -f' });
  });

  it('classifies "ssh" with a target', () => {
    expect(classifyCommand('ssh user@myhost.example.com')).toEqual({ kind: 'watched-command', label: 'ssh' });
  });

  it('does not classify a bare "ssh" with no target', () => {
    expect(classifyCommand('ssh')).toEqual({ kind: 'plain' });
  });
});

describe('classifyTerminalName', () => {
  it('matches Container Tools\' "View Logs" naming convention', () => {
    expect(classifyTerminalName('Logs: app-postgres')).toEqual({
      label: 'docker logs',
      command: 'docker logs -f "app-postgres"',
    });
  });

  it('matches the singular "Log:" form too', () => {
    expect(classifyTerminalName('Log: my-container')).toEqual({
      label: 'docker logs',
      command: 'docker logs -f "my-container"',
    });
  });

  it('is case-insensitive', () => {
    expect(classifyTerminalName('logs: lowercase-test')).toEqual({
      label: 'docker logs',
      command: 'docker logs -f "lowercase-test"',
    });
  });

  it('tolerates an unknown prefix before "Logs:"', () => {
    expect(classifyTerminalName('Task - Logs: web')).toEqual({
      label: 'docker logs',
      command: 'docker logs -f "web"',
    });
  });

  it('does not match a mid-word false positive like "Analogs:"', () => {
    expect(classifyTerminalName('Analogs: not-a-log-viewer')).toBeUndefined();
  });

  it('does not match plain shell/terminal names', () => {
    expect(classifyTerminalName('bash')).toBeUndefined();
    expect(classifyTerminalName('pwsh')).toBeUndefined();
    expect(classifyTerminalName('my custom terminal')).toBeUndefined();
  });

  it('does not match "Logs:" with nothing after it', () => {
    expect(classifyTerminalName('Logs:')).toBeUndefined();
    expect(classifyTerminalName('Logs:   ')).toBeUndefined();
  });
});

describe('extractResumeSessionId', () => {
  it('extracts the id from an explicit --resume <uuid>', () => {
    expect(extractResumeSessionId('claude --resume 68b141fc-fb9e-46ce-bb39-3b68f8e1ed98')).toBe(
      '68b141fc-fb9e-46ce-bb39-3b68f8e1ed98',
    );
  });

  it('returns undefined for --resume with no id (interactive picker)', () => {
    expect(extractResumeSessionId('claude --resume')).toBeUndefined();
  });

  it('returns undefined for a bare claude invocation', () => {
    expect(extractResumeSessionId('claude')).toBeUndefined();
  });

  it('returns undefined for a non-UUID-shaped value', () => {
    expect(extractResumeSessionId('claude --resume abc-not-a-uuid')).toBeUndefined();
  });
});
