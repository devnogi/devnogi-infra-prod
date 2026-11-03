import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const bash = process.env.DEPLOY_TEST_BASH || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe')
  : 'bash');
const script = fileURLToPath(new URL('../scripts/transfer-prod2.sh', import.meta.url));
const trusted = `SHA256:${'A'.repeat(43)}`;

function executable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function runTransfer(t, { actualFingerprint = trusted, scpFailures = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'infra-prod2-transfer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'ops', 'prod2'), { recursive: true });
  writeFileSync(join(root, 'docker-compose-prod2.yml'), 'services: {}\n');
  writeFileSync(join(root, 'ops', 'prod2', 'install-logging.sh'), '#!/bin/sh\n');

  executable(join(bin, 'ssh-keyscan'), '#!/bin/sh\necho "[example.test]:46232 ssh-ed25519 AAAATEST"\n');
  executable(join(bin, 'ssh-keygen'), `#!/bin/sh\necho "256 ${actualFingerprint} example.test (ED25519)"\n`);
  executable(join(bin, 'ssh'), '#!/bin/sh\nprintf "%s\\n" "$*" >>"$FIXTURE/ssh.args"\n');
  executable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'scp'), `#!/bin/sh
count=0
[ ! -f "$FIXTURE/scp.count" ] || count=$(cat "$FIXTURE/scp.count")
count=$((count + 1))
printf '%s' "$count" >"$FIXTURE/scp.count"
printf '%s\n' "$*" >>"$FIXTURE/scp.args"
[ "$count" -gt "${scpFailures}" ]
`);

  const command = 'if command -v cygpath >/dev/null; then FIXTURE=$(cygpath -u "$FIXTURE"); SCRIPT=$(cygpath -u "$SCRIPT"); fi; export FIXTURE SCRIPT PATH="$FIXTURE/bin:$PATH"; exec "$SCRIPT"';
  const result = spawnSync(bash, ['-c', command], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      FIXTURE: root,
      SCRIPT: script,
      PROD2_HOST: 'example.test',
      PROD2_USER: 'deploy',
      PROD2_SSH_PORT: '46232',
      PROD2_SSH_PRIVATE_KEY: 'test-private-key',
      PROD2_HOST_FINGERPRINT: trusted,
    },
  });
  return { root, result };
}

test('prod2 transfer retries a transient copy failure and keeps strict host verification', (t) => {
  const { root, result } = runTransfer(t, { scpFailures: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'scp.count'), 'utf8'), '3');
  const args = readFileSync(join(root, 'scp.args'), 'utf8');
  assert.match(args, /StrictHostKeyChecking=yes/);
  assert.match(args, /docker-compose-prod2\.yml/);
  assert.match(args, /ops[\\/]prod2/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-private-key/);
});

test('prod2 transfer refuses a host-key mismatch before opening SSH or copying', (t) => {
  const { root, result } = runTransfer(t, { actualFingerprint: `SHA256:${'B'.repeat(43)}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Host key validation failed/);
  assert.equal(existsSync(join(root, 'ssh.args')), false);
  assert.equal(existsSync(join(root, 'scp.args')), false);
});

test('prod2 transfer stops after three failed copy attempts', (t) => {
  const { root, result } = runTransfer(t, { scpFailures: 99 });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(root, 'scp.count'), 'utf8'), '3');
  assert.match(result.stderr, /Compose transfer failed after bounded retries/);
});
