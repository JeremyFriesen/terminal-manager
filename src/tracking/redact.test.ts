import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('leaves an ordinary command untouched', () => {
    expect(redactSecrets('docker logs -f my-container')).toBe('docker logs -f my-container');
  });

  it('redacts an inline env var assignment whose name looks secret-shaped', () => {
    expect(redactSecrets('API_KEY=sk-abc123 curl https://api.example.com')).toBe('API_KEY=***REDACTED*** curl https://api.example.com');
  });

  it('redacts when the keyword is embedded in a longer var name', () => {
    expect(redactSecrets('MY_API_KEY=sk-abc123 ./deploy.sh')).toBe('MY_API_KEY=***REDACTED*** ./deploy.sh');
  });

  it('redacts a -e/--env style inline assignment inside a longer command', () => {
    expect(redactSecrets('docker run -e MY_SECRET_TOKEN=abc123 myimage')).toBe('docker run -e MY_SECRET_TOKEN=***REDACTED*** myimage');
  });

  it('does not redact an ordinary, non-secret env var', () => {
    expect(redactSecrets('NODE_ENV=production npm start')).toBe('NODE_ENV=production npm start');
  });

  it('redacts a long-form --password flag', () => {
    expect(redactSecrets('mycli --password=hunter2 connect')).toBe('mycli --password=***REDACTED*** connect');
  });

  it('redacts a long-form --api-key flag', () => {
    expect(redactSecrets('curl --api-key=sk-live-abc123 https://api.example.com')).toBe(
      'curl --api-key=***REDACTED*** https://api.example.com',
    );
  });

  it('does not redact bare -p, which is a port number in many CLIs', () => {
    expect(redactSecrets('docker run -p 8080:80 myimage')).toBe('docker run -p 8080:80 myimage');
    expect(redactSecrets('ssh -p 2222 user@host')).toBe('ssh -p 2222 user@host');
  });

  it('redacts a password embedded in a connection URL, keeping user and host', () => {
    expect(redactSecrets('psql postgres://user:hunter2@localhost:5432/mydb')).toBe(
      'psql postgres://user:***REDACTED***@localhost:5432/mydb',
    );
  });

  it('redacts a token embedded in a git remote URL', () => {
    expect(redactSecrets('git clone https://user:ghp_abc123token@github.com/me/repo.git')).toBe(
      'git clone https://user:***REDACTED***@github.com/me/repo.git',
    );
  });

  it('redacts a Bearer token, keeping the "Bearer" label for context', () => {
    expect(redactSecrets('curl -H "Authorization: Bearer eyJhbGciOi.xyz.abc" https://api.example.com')).toBe(
      'curl -H "Authorization: Bearer ***REDACTED***" https://api.example.com',
    );
  });
});
