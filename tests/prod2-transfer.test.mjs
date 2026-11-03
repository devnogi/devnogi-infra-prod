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
const script = fileURLToPath(new URL('../scripts/deploy-prod-native.sh', import.meta.url));
const remoteScript = fileURLToPath(new URL('../scripts/deploy-prod.sh', import.meta.url));
const trusted = `SHA256:${'A'.repeat(43)}`;
const revision = 'b'.repeat(40);

function executable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function runNative(t, {
  server = 2,
  actualFingerprint = trusted,
  port = '46232',
  scpFailures = 0,
  deployFailure = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'infra-native-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, `docker-compose-prod${server}.yml`), 'services: {}\n');
  writeFileSync(join(root, 'scripts', 'deploy-prod.sh'), readFileSync(remoteScript));
  if (server === 2) {
    mkdirSync(join(root, 'ops', 'prod2'), { recursive: true });
    writeFileSync(join(root, 'ops', 'prod2', 'install-logging.sh'), '#!/bin/sh\n');
  }

  executable(join(bin, 'ssh-keyscan'), `#!/bin/sh
echo "[example.test]:${port} ssh-ed25519 AAAATEST"
`);
  executable(join(bin, 'ssh-keygen'), `#!/bin/sh
echo "256 ${actualFingerprint} example.test (ED25519)"
`);
  executable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'scp'), `#!/bin/sh
count=0
[ ! -f "$FIXTURE/scp.count" ] || count=$(cat "$FIXTURE/scp.count")
count=$((count + 1))
printf '%s' "$count" >"$FIXTURE/scp.count"
printf '%s\n' "$*" >>"$FIXTURE/scp.args"
[ "$count" -gt "${scpFailures}" ]
`);
  executable(join(bin, 'ssh'), `#!/bin/sh
printf '%s\n' "$*" >>"$FIXTURE/ssh.args"
case "$*" in
  *'bash '*deploy-prod.sh*)
    if [ "${deployFailure ? 'yes' : 'no'}" = yes ]; then
      echo 'simulated remote failure' >&2
      exit 1
    fi
    echo 'simulated deployment success'
    ;;
esac
`);

  const command = 'if command -v cygpath >/dev/null; then FIXTURE=$(cygpath -u "$FIXTURE"); SCRIPT=$(cygpath -u "$SCRIPT"); fi; export FIXTURE SCRIPT PATH="$FIXTURE/bin:$PATH"; exec "$SCRIPT" "$SERVER" "$REVISION"';
  const result = spawnSync(bash, ['-c', command], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      FIXTURE: root,
      SCRIPT: script,
      SERVER: String(server),
      REVISION: revision,
      PROD_HOST: 'example.test',
      PROD_USER: 'deploy',
      PROD_SSH_PORT: port,
      PROD_SSH_PRIVATE_KEY: 'test-private-key',
      PROD_HOST_FINGERPRINT: trusted,
      PROD_ENV_FILE: 'PASSWORD=fixture-only',
    },
  });
  return { root, result };
}

for (const server of [1, 2]) {
  test(`server ${server} native deployment pins all SSH operations to Ed25519`, (t) => {
    const { root, result } = runNative(t, { server });
    assert.equal(result.status, 0, result.stderr);
    const sshArgs = readFileSync(join(root, 'ssh.args'), 'utf8');
    const scpArgs = readFileSync(join(root, 'scp.args'), 'utf8');
    for (const args of [sshArgs, scpArgs]) {
      assert.match(args, /StrictHostKeyChecking=yes/);
      assert.match(args, /HostKeyAlgorithms=ssh-ed25519/);
      assert.match(args, /IdentitiesOnly=yes/);
    }
    assert.match(sshArgs, /deploy-prod\.sh/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-private-key|fixture-only/);
  });
}

test('native deployment retries transient transfer failures only', (t) => {
  const { root, result } = runNative(t, { scpFailures: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number(readFileSync(join(root, 'scp.count'), 'utf8')) >= 5);
});

test('native deployment rejects a host-key mismatch before SSH or SCP', (t) => {
  const { root, result } = runNative(t, { actualFingerprint: `SHA256:${'B'.repeat(43)}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Host key validation failed/);
  assert.equal(existsSync(join(root, 'ssh.args')), false);
  assert.equal(existsSync(join(root, 'scp.args')), false);
});

for (const port of ['0', '65536', 'not-a-port', '46232 ']) {
  test(`native deployment rejects invalid port ${JSON.stringify(port)} before network access`, (t) => {
    const { root, result } = runNative(t, { port });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid production SSH port/);
    assert.equal(existsSync(join(root, 'ssh.args')), false);
  });
}

test('native deployment reports remote failure without leaking secrets', (t) => {
  const { result } = runNative(t, { deployFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote production deployment failed/);
  assert.match(result.stderr, /simulated remote failure/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-private-key|fixture-only/);
});
