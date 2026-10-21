import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, 'docker', 'local', 'mysql', '20-auth-schema.sh');
const shell = process.platform === 'win32'
  ? resolve(execFileSync('git', ['-C', root, '--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..', 'bin', 'bash.exe')
  : 'bash';

const mock = `
mysql() {
  printf '%s\\n' "$*" >> "$CALL_LOG"
  [ "$MYSQL_PWD" = "$MYSQL_ROOT_PASSWORD" ] || return 22
  statement=$(cat)
  printf '%s\\n' "$statement" >> "$SQL_LOG"
  case "$statement" in
    'SELECT COUNT(*)'*)
      if [ "$MOCK_MODE" = query-fails ]; then
        printf 'mysql error user=%s password=%s\\n' "$MYSQL_USER" "$MYSQL_ROOT_PASSWORD" >&2
        return 7
      fi
      if [ "$MOCK_MODE" = missing-user ]; then printf '0\\n'; else printf '1\\n'; fi
      ;;
    *)
      if [ "$MOCK_MODE" = grant-fails ]; then
        printf 'mysql error user=%s password=%s\\n' "$MYSQL_USER" "$MYSQL_ROOT_PASSWORD" >&2
        return 8
      fi
      ;;
  esac
}
. "$BOOTSTRAP_SCRIPT"
`;

function invoke(t, overrides = {}, repeat = false) {
  const directory = mkdtempSync(join(tmpdir(), 'devnogi-auth-bootstrap-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const callLog = join(directory, 'calls.txt');
  const sqlLog = join(directory, 'sql.txt');
  const result = spawnSync(shell, ['--noprofile', '--norc', '-c', repeat ? `${mock}\n. "$BOOTSTRAP_SCRIPT"` : mock], {
    env: { ...process.env, BOOTSTRAP_SCRIPT: script.replaceAll('\\', '/'), CALL_LOG: callLog.replaceAll('\\', '/'), SQL_LOG: sqlLog.replaceAll('\\', '/'), DEVNOGI_LOCAL_BOOTSTRAP: '1', MYSQL_USER: 'test_app', MYSQL_ROOT_PASSWORD: 'synthetic-root-password', MOCK_MODE: 'success', ...overrides },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...result, calls: existsSync(callLog) ? readFileSync(callLog, 'utf8') : '', sql: existsSync(sqlLog) ? readFileSync(sqlLog, 'utf8') : '' };
}

test('bootstrap grants only auth to an existing app account without credentials in argv/output', (t) => {
  const result = invoke(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.sql, /SELECT COUNT\(\*\) FROM mysql\.user WHERE User = 'test_app' AND Host = '%';/);
  assert.match(result.sql, /CREATE DATABASE IF NOT EXISTS auth;/);
  assert.match(result.sql, /GRANT ALL PRIVILEGES ON auth\.\* TO 'test_app'@'%';/);
  assert.doesNotMatch(result.sql, /DROP|ALTER|CREATE USER|REVOKE|IDENTIFIED|devnogi/);
  assert.equal(result.calls.trim().split('\n').length, 2);
  for (const call of result.calls.trim().split('\n')) assert.match(call, /--protocol=socket --user=root --batch/);
  assert.doesNotMatch(result.calls + result.stdout + result.stderr, /synthetic-root-password|test_app/);
});

test('reapplying bootstrap uses additive idempotent SQL without resetting an account', (t) => {
  const result = invoke(t, {}, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.sql.match(/CREATE DATABASE IF NOT EXISTS auth;/g) ?? []).length, 2);
  assert.equal((result.sql.match(/GRANT ALL PRIVILEGES ON auth\.\*/g) ?? []).length, 2);
  assert.doesNotMatch(result.sql, /DROP|ALTER|CREATE USER|REVOKE|IDENTIFIED/);
});

for (const user of ['', 'root', "x'; DROP DATABASE auth; --", 'app-user', 'u'.repeat(33)]) {
  test(`invalid account ${JSON.stringify(user)} is rejected before any SQL`, (t) => {
    const result = invoke(t, { MYSQL_USER: user });
    assert.equal(result.status, 1);
    assert.equal(result.calls, '');
    assert.equal(result.sql, '');
    assert.match(result.stderr, /Local auth bootstrap:/);
    assert.doesNotMatch(result.stderr, /DROP DATABASE|synthetic-root-password/);
  });
}

test('missing root password stops before querying MySQL', (t) => {
  const result = invoke(t, { MYSQL_ROOT_PASSWORD: '' });
  assert.equal(result.status, 1);
  assert.equal(result.calls, '');
  assert.match(result.stderr, /MYSQL_ROOT_PASSWORD is required/);
});

test('a container without the local-only marker is rejected before SQL', (t) => {
  const result = invoke(t, { DEVNOGI_LOCAL_BOOTSTRAP: '' });
  assert.equal(result.status, 1);
  assert.equal(result.calls, '');
  assert.match(result.stderr, /not configured for local bootstrap/);
});

for (const mode of ['missing-user', 'query-fails', 'grant-fails']) {
  test(`${mode} is a failure with redacted diagnostics`, (t) => {
    const result = invoke(t, { MOCK_MODE: mode });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Local auth bootstrap:/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /test_app|synthetic-root-password/);
    if (mode !== 'grant-fails') assert.doesNotMatch(result.sql, /CREATE DATABASE|GRANT/);
  });
}

test('bootstrap is LF-only and mounted only in the local Compose', () => {
  assert.equal(readFileSync(script, 'utf8').includes('\r'), false);
  const local = readFileSync(join(root, 'compose.local.yml'), 'utf8');
  assert.match(local, /source: \.\/docker\/local\/mysql\/20-auth-schema\.sh/);
  assert.match(local, /target: \/docker-entrypoint-initdb.d\/20-auth-schema\.sh/);
  assert.match(local, /create_host_path: false/);
  for (const name of ['docker-compose-prod1.yml', 'docker-compose-prod2.yml']) {
    assert.doesNotMatch(readFileSync(join(root, name), 'utf8'), /20-auth-schema|docker-entrypoint-initdb/);
  }
});
