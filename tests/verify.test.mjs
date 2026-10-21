import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../scripts/verify.mjs';

const script = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));

function isolatedEnvironment(t) {
  const sandbox = mkdtempSync(join(tmpdir(), 'devnogi-verify-cli-test-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const emptyPath = join(sandbox, 'empty-path');
  mkdirSync(emptyPath);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  );
  const temp = join(sandbox, 'temp');
  mkdirSync(temp);
  Object.assign(env, { PATH: emptyPath, TMPDIR: temp, TEMP: temp, TMP: temp });
  return { sandbox, env, temp };
}

function invoke(nodeArgs, environment) {
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: environment.sandbox,
    env: environment.env,
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function output() {
  const captured = { stdout: '', stderr: '' };
  return {
    captured,
    stdout: { write: (text) => { captured.stdout += text; } },
    stderr: { write: (text) => { captured.stderr += text; } },
  };
}

test('--help prints usage successfully without Docker', (t) => {
  const environment = isolatedEnvironment(t);
  const result = invoke([script, '--help'], environment);
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
  assert.deepEqual(readdirSync(environment.temp), []);
});

for (const args of [['--unknown'], ['--help', 'extra'], ['--help', '--help'], ['-h']]) {
  test(`${args.join(' ')} reports invalid arguments without Docker`, (t) => {
    const environment = isolatedEnvironment(t);
    const result = invoke([script, ...args], environment);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(args.join(' ')));
    assert.ok(result.stderr.includes('알 수 없는 인수'));
    assert.ok(result.stderr.includes('--help'));
    assert.deepEqual(readdirSync(environment.temp), []);
  });
}

test('help and invalid arguments do not invoke the Docker runner', () => {
  let calls = 0;
  for (const [args, expected] of [[['--help'], 0], [['--unknown'], 2], [['--help', 'extra'], 2]]) {
    const streams = output();
    const status = run(args, { ...streams, runDocker: () => { calls += 1; return { status: 0 }; } });
    assert.equal(status, expected);
  }
  assert.equal(calls, 0);
});

test('help and invalid arguments need neither fixture files nor a usable temp directory', (t) => {
  const environment = isolatedEnvironment(t);
  const isolatedScript = join(environment.sandbox, 'scripts', 'verify.mjs');
  mkdirSync(dirname(isolatedScript));
  copyFileSync(script, isolatedScript);
  const unavailableTemp = join(environment.sandbox, 'missing-parent', 'temp');
  Object.assign(environment.env, { TMPDIR: unavailableTemp, TEMP: unavailableTemp, TMP: unavailableTemp });
  for (const [args, expected] of [[['--help'], 0], [['--unknown'], 2], [['--help', 'extra'], 2]]) {
    const result = invoke([isolatedScript, ...args], environment);
    assert.equal(result.status, expected, result.stderr);
    assert.deepEqual(readdirSync(environment.temp), []);
    assert.equal(existsSync(unavailableTemp), false);
  }
});

test('importing the module starts no verification or filesystem work', (t) => {
  const environment = isolatedEnvironment(t);
  const isolatedScript = join(environment.sandbox, 'scripts', 'verify.mjs');
  mkdirSync(dirname(isolatedScript));
  copyFileSync(script, isolatedScript);
  const unavailableTemp = join(environment.sandbox, 'missing-parent', 'temp');
  Object.assign(environment.env, { TMPDIR: unavailableTemp, TEMP: unavailableTemp, TMP: unavailableTemp });
  const source = `await import(${JSON.stringify(pathToFileURL(isolatedScript).href)});`;
  const result = invoke(['--input-type=module', '--eval', source], environment);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(readdirSync(environment.temp), []);
  assert.equal(existsSync(unavailableTemp), false);
});

test('no arguments checks all Compose files in order with synthetic environment and cleans up', () => {
  const streams = output();
  const files = ['compose.local.yml', 'docker-compose-prod1.yml', 'docker-compose-prod2.yml'];
  const fixture = join(dirname(dirname(script)), 'tests', 'compose.env');
  const calls = [];
  let temp;
  const status = run([], {
    ...streams,
    runDocker: (command, args, options) => {
      calls.push(basename(args[6]));
      temp ??= args[2];
      assert.equal(command, 'docker');
      assert.deepEqual(args, ['compose', '--project-directory', temp, '--env-file', fixture, '-f', join(temp, files[calls.length - 1]), 'config', '--quiet']);
      assert.equal(options.stdio, 'inherit');
      assert.equal(options.shell, undefined);
      assert.equal(options.env.DB_USER, 'fixture');
      assert.equal(options.env.DB_PASSWORD, 'fixture-only');
      assert.equal(options.env.KAFKA_EXTERNAL_HOST, 'localhost');
      assert.equal(options.env.KAFKA_UI_SASL_JAAS_CONFIG, '');
      assert.equal(readFileSync(join(temp, '.env.infra2'), 'utf8'), readFileSync(fixture, 'utf8'));
      assert.equal(readFileSync(args[6], 'utf8'), readFileSync(join(dirname(dirname(script)), files[calls.length - 1]), 'utf8'));
      return { status: 0 };
    },
  });
  assert.equal(status, 0, streams.captured.stderr);
  assert.deepEqual(calls, files);
  assert.equal(streams.captured.stdout, files.map((file) => `PASS ${file}\n`).join(''));
  assert.equal(streams.captured.stderr, '');
  assert.equal(existsSync(temp), false);
});

test('second Compose failure stops before the third file and cleans up', () => {
  const streams = output();
  const calls = [];
  let temp;
  const status = run([], {
    ...streams,
    runDocker: (_command, args) => {
      temp = args[2];
      calls.push(basename(args[6]));
      return { status: calls.length === 2 ? 7 : 0 };
    },
  });
  assert.equal(status, 1);
  assert.deepEqual(calls, ['compose.local.yml', 'docker-compose-prod1.yml']);
  assert.equal(streams.captured.stdout, 'PASS compose.local.yml\n');
  assert.match(streams.captured.stderr, /docker-compose-prod1\.yml: 설정 검증 실패 \(exit 7\)/);
  assert.equal(existsSync(temp), false);
});

test('Docker spawn failure reports the environment error and cleans up', () => {
  const streams = output();
  let calls = 0;
  let temp;
  const status = run([], {
    ...streams,
    runDocker: (_command, args) => {
      calls += 1;
      temp = args[2];
      return { error: new Error('spawnSync docker ENOENT'), status: null };
    },
  });
  assert.equal(status, 1);
  assert.equal(calls, 1);
  assert.equal(streams.captured.stdout, '');
  assert.match(streams.captured.stderr, /Docker Compose 실행 환경을 확인하세요: spawnSync docker ENOENT/);
  assert.equal(existsSync(temp), false);
});
