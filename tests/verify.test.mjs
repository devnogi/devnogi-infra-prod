import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));

test('--help prints usage successfully without Docker', (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'devnogi-verify-cli-test-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const emptyPath = join(sandbox, 'empty-path');
  mkdirSync(emptyPath);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  );
  Object.assign(env, { PATH: emptyPath, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox });

  const result = spawnSync(process.execPath, [script, '--help'], {
    cwd: sandbox,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `--help must not require Docker. stderr: ${result.stderr}`);
  assert.equal(result.stderr, '');
  for (const text of [
    'node scripts/verify.mjs',
    '--help',
    'Node.js 20',
    'Docker Compose',
    'compose.local.yml',
    'docker-compose-prod1.yml',
    'docker-compose-prod2.yml',
    '합성',
    '컨테이너',
  ]) {
    assert.ok(result.stdout.includes(text), `help must explain ${text}`);
  }
});
