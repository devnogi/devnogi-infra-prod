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
  durableResult = 'SUCCESS',
  launchDisconnect = false,
  cleanupFailure = false,
  resultWithoutFinished = false,
  run = '98765-2',
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
  *nohup*deploy-prod.sh*rollout*)
    touch "$FIXTURE/launched"
    [ -z '${durableResult}' ] || printf 'DEPLOY_RESULT=%s\n' '${durableResult}' >"$FIXTURE/remote.result"
    [ -z '${durableResult}' ] || [ '${resultWithoutFinished ? 'yes' : 'no'}' = yes ] || printf 'DEPLOY_FINISHED=1\n' >"$FIXTURE/remote.finished"
    [ '${launchDisconnect ? 'yes' : 'no'}' = no ] || exit 255
    ;;
  *state/result*)
    [ ! -f "$FIXTURE/remote.result" ] || [ ! -f "$FIXTURE/remote.finished" ] || cat "$FIXTURE/remote.result"
    ;;
  *'chmod -R u+rwX'*'rm -rf --'*'test ! -e'*)
    [ '${cleanupFailure ? 'yes' : 'no'}' = no ] || exit 1
    touch "$FIXTURE/cleaned"
    ;;
  *'rm -rf'*) exit 93 ;;
esac
`);

  const command = 'if command -v cygpath >/dev/null; then FIXTURE=$(cygpath -u "$FIXTURE"); SCRIPT=$(cygpath -u "$SCRIPT"); fi; export FIXTURE SCRIPT PATH="$FIXTURE/bin:$PATH"; exec "$SCRIPT" "$SERVER" "$REVISION" "$RUN"';
  const result = spawnSync(bash, ['-c', command], {
    cwd: root,
    encoding: 'utf8',
    timeout: 25_000,
    env: {
      ...process.env,
      FIXTURE: root,
      SCRIPT: script,
      SERVER: String(server),
      REVISION: revision,
      RUN: run,
      PROD_HOST: 'example.test',
      PROD_USER: 'deploy',
      PROD_SSH_PORT: port,
      PROD_SSH_PRIVATE_KEY: 'test-private-key',
      PROD_HOST_FINGERPRINT: trusted,
      PROD_ENV_FILE: 'PASSWORD=fixture-only',
      DEPLOY_POLL_ATTEMPTS: '8',
      DEPLOY_POLL_INTERVAL_SECONDS: '0',
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
    assert.match(sshArgs, new RegExp(`prod${server}-${revision}-98765-2`));
    assert.doesNotMatch(sshArgs + scpArgs, /\/opt\/infra\/(?:incoming|incoming2)\b/);
    assert.equal(existsSync(join(root, 'launched')), true);
    assert.equal(existsSync(join(root, 'cleaned')), true);
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
  const { result } = runNative(t, { durableResult: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /without a verified durable result/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-private-key|fixture-only/);
});

test('native deployment keeps polling a durable result after launch SSH disconnects', (t) => {
  const { root, result } = runNative(t, { launchDisconnect: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, 'launched')), true);
  assert.equal(existsSync(join(root, 'cleaned')), true);
  assert.doesNotMatch(result.stdout + result.stderr, /test-private-key|fixture-only/);
});

test('native deployment fails closed when a successful stage cannot be securely deleted', (t) => {
  const { root, result } = runNative(t, { cleanupFailure: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /staging cleanup failed/);
  assert.equal(existsSync(join(root, 'cleaned')), false);
  assert.doesNotMatch(result.stdout + result.stderr, /test-private-key|fixture-only/);
});

test('failed deployment retains its protected stage for diagnosis', (t) => {
  const { root, result } = runNative(t, { durableResult: 'ROLLED_BACK' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retained for diagnosis/);
  assert.equal(existsSync(join(root, 'cleaned')), false);
});

test('native deployment never cleans up a result marker before the remote finished acknowledgement', (t) => {
  const { root, result } = runNative(t, { resultWithoutFinished: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /without a verified durable result/);
  assert.equal(existsSync(join(root, 'cleaned')), false);
});

test('Linux cleanup restores owner directory permissions before deleting read-only inputs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'infra-cleanup-permissions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = join(root, 'prod2-stage');
  mkdirSync(join(stage, 'inputs'), { recursive: true });
  writeFileSync(join(stage, 'inputs', '.env.infra2'), 'fixture-secret\n', { mode: 0o400 });
  const command = 'if command -v cygpath >/dev/null; then STAGE=$(cygpath -u "$STAGE"); fi; chmod 500 "$STAGE/inputs"; chmod -R u+rwX "$STAGE" && rm -rf -- "$STAGE" && test ! -e "$STAGE"';
  const result = spawnSync(bash, ['-c', command], { encoding: 'utf8', env: { ...process.env, STAGE: stage } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(stage), false);
});
