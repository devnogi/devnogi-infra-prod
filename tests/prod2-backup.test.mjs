import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { dump, eligible, upload } from '../ops/prod2/backup.mjs';

const at = new Date('2026-10-01T00:00:00Z');
const later = Date.parse('2026-11-02T00:00:00Z');
const content = ['auth', 'dcs', 'open-api-batch'].map((schema) => `-- Current Database: \`${schema}\`\nCREATE TABLE test (id int);\n`).join('');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memonogi-backup-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { backup: join(root, 'mysql'), logs: join(root, 'logs'), state: join(root, 'state'), config: 'fixture.conf', compose: 'fixture.yml' };
}
function fakeDump(output = content, code = 0) {
  return (command, args) => {
    assert.equal(command, 'docker');
    assert.ok(args.includes('--single-transaction'));
    assert.deepEqual(args.slice(-3), ['auth', 'dcs', 'open-api-batch']);
    const process = new EventEmitter();
    process.stdout = Readable.from([output]);
    setImmediate(() => process.emit('close', code));
    return process;
  };
}
function logFile(p, service, name, age = at) {
  const dir = join(p.logs, service);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, 'synthetic');
  utimesSync(file, age, age);
  return file;
}

test('dump finalizes validated content and paired checksum', async (t) => {
  const p = fixture(t);
  const file = await dump(p, at, fakeDump());
  assert.deepEqual(readdirSync(p.backup).sort(), ['mysql-20261001T000000Z.sql.gz', 'mysql-20261001T000000Z.sql.gz.sha256']);
  assert.match(readFileSync(`${file}.sha256`, 'utf8'), /^[a-f0-9]{64}  mysql-20261001T000000Z\.sql\.gz\n$/);
});

test('failed process and invalid schemas never promote backup', async (t) => {
  for (const fake of [fakeDump(content, 1), fakeDump('-- Current Database: `auth`\n')]) {
    const p = fixture(t);
    await assert.rejects(dump(p, at, fake));
    assert.deepEqual(readdirSync(p.backup), []);
  }
});

test('verified upload filters active/partial files and prunes only old verified sources', async (t) => {
  const p = fixture(t);
  const file = await dump(p, at, fakeDump());
  utimesSync(file, at, at); utimesSync(`${file}.sha256`, at, at);
  const old = logFile(p, 'auth', 'application.log-20261001.gz');
  const active = logFile(p, 'auth', 'application.log');
  const partial = logFile(p, 'auth', 'application.log-20261001.gz.partial');
  const young = logFile(p, 'react', 'application.log-20261031.gz', new Date(later - 2 * 86400000));
  assert.equal(eligible(p).length, 4);
  const calls = [];
  await upload(p, later, (_command, args) => calls.push(args));
  assert.deepEqual(calls.map((args) => args[2]), ['copy', 'cryptcheck', 'delete']);
  assert.ok(calls[1].includes('--one-way'));
  assert.ok(calls[2].includes('56d'));
  assert.deepEqual(readdirSync(join(p.logs, 'auth')).sort(), ['application.log', 'application.log-20261001.gz.partial']);
  assert.ok(readFileSync(young)); assert.ok(readFileSync(active)); assert.ok(readFileSync(partial));
  assert.deepEqual(readdirSync(p.backup), []);
  assert.ok(JSON.parse(readFileSync(join(p.state, 'verified.json'), 'utf8'))['logs/auth/application.log-20261001.gz']);
  assert.ok(old);
});

test('upload or verification failure preserves originals and avoids cleanup', async (t) => {
  for (const fail of ['copy', 'cryptcheck', 'delete']) {
    const p = fixture(t);
    const file = await dump(p, at, fakeDump());
    utimesSync(file, at, at); utimesSync(`${file}.sha256`, at, at);
    const old = logFile(p, 'auth', 'application.log-20261001.gz');
    const calls = [];
    await assert.rejects(upload(p, later, (_command, args) => { calls.push(args[2]); if (args[2] === fail) throw new Error('fixture failure'); }));
    assert.ok(readFileSync(file)); assert.ok(readFileSync(old));
    if (fail !== 'delete') assert.ok(!calls.includes('delete'));
  }
});

test('damaged dump blocks upload and old pending files defer remote pruning', async (t) => {
  const p = fixture(t);
  const file = await dump(p, at, fakeDump());
  writeFileSync(file, 'corrupt');
  let calls = 0;
  await assert.rejects(upload(p, later, () => { calls++; }));
  assert.equal(calls, 0);
  const p2 = fixture(t);
  await dump(p2, at, fakeDump());
  logFile(p2, 'auth', 'application.log-20260101.gz', new Date('2026-01-01T00:00:00Z'));
  const commands = [];
  await upload(p2, later, (_command, args) => commands.push(args[2]));
  assert.deepEqual(commands, ['copy', 'cryptcheck']);
});
