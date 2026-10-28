import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const bash = process.env.DEPLOY_TEST_BASH || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe') : 'bash');
for (const server of [1, 2]) {
  const workflow = readFileSync(new URL(`../.github/workflows/deploy-prod${server}.yml`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const script = workflow.split('          script: |\n')[1]?.replace(/^ {12}/gm, '');
  assert.ok(script);
  function run(t, scenario) {
    const root = mkdtempSync(join(tmpdir(), 'infra-deploy-fixture-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, `incoming${server}`));
    writeFileSync(join(root, `docker-compose-prod${server}.yml`), 'old-compose');
    writeFileSync(join(root, `.env.infra${server}`), 'old-env');
    writeFileSync(join(root, `incoming${server}`, `docker-compose-prod${server}.yml`), 'new-compose');
    writeFileSync(join(root, 'bin', 'docker'), `#!/bin/sh\ncase "$*" in\n *'config --services'*) echo app ;;\n *'config --images'*) echo image:tag ;;\n *'ps --all -q'*) echo container ;;\n 'inspect --format '*Health*) if [ "$SCENARIO" = no-health ]; then echo missing; elif [ "$SCENARIO" = recovery-unhealthy ] && [ -f "$FIXTURE/rollback-complete" ]; then echo unhealthy; else echo healthy; fi ;;\n 'inspect --format '*) echo sha256:old ;;\n 'image inspect --format '*) if [ "$SCENARIO" = missing ]; then exit 0; fi; echo image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;\n *'up -d --wait --pull never'*) if [ ! -f "$FIXTURE/started" ]; then touch "$FIXTURE/started"; if [ "$SCENARIO" != success ]; then exit 1; fi; elif [ "$SCENARIO" = rollback-fail ]; then exit 1; else touch "$FIXTURE/rollback-complete"; fi ;;\n *) exit 1 ;;\nesac\n`, { mode: 0o755 });
    const body = script.replace('mkdir -p /opt/infra', ':').replace('cd /opt/infra', `cd '${root.replaceAll('\\', '/')}'`)
      .replaceAll('--project-directory /opt/infra', '--project-directory .')
      .replaceAll(`\${{ secrets.PROD${server}_ENV_FILE }}`, 'new-env').replaceAll('${{ github.sha }}', 'fixture-sha');
    const result = spawnSync(bash, ['-c', `if command -v cygpath >/dev/null; then FIXTURE=$(cygpath -u "$FIXTURE"); fi\nexport FIXTURE PATH="$FIXTURE/bin:$PATH"\n${body}`], {
      env: { ...process.env, FIXTURE: root.replaceAll('\\', '/'), SCENARIO: scenario }, encoding: 'utf8', timeout: 15000,
    });
    return { root, result };
  }
  test(`server ${server} refuses a missing digest before modifying active compose`, (t) => {
    const { root, result } = run(t, 'missing');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'old-compose');
  });
  test(`server ${server} refuses a service without readiness before modifying active compose`, (t) => {
    const { root, result } = run(t, 'no-health');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'old-compose');
  });
  test(`server ${server} restores compose and environment after a failed start`, (t) => {
    const { root, result } = run(t, 'start-fail');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'old-compose');
    assert.equal(readFileSync(join(root, `.env.infra${server}`), 'utf8'), 'old-env');
    assert.doesNotMatch(result.stderr, /Rollback failed/);
    assert.match(result.stdout, /Rollback health verification passed/);
  });
  test(`server ${server} reports a rollback failure`, (t) => {
    const { result } = run(t, 'rollback-fail');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Rollback failed/);
  });
  test(`server ${server} reports unhealthy recovery even when rollback up succeeds`, (t) => {
    const { root, result } = run(t, 'recovery-unhealthy');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Rollback health verification failed/);
    assert.doesNotMatch(result.stderr, /^Rollback failed$/m);
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'old-compose');
    assert.equal(readFileSync(join(root, `.env.infra${server}`), 'utf8'), 'old-env');
  });
  test(`server ${server} applies its immutable image override`, (t) => {
    const { root, result } = run(t, 'success');
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, `.previous-images-prod${server}.yml`), 'utf8'), /@sha256:[0-9a-f]{64}/);
    assert.equal(readFileSync(join(root, `.last-deployed-prod${server}-sha`), 'utf8').trim(), 'fixture-sha');
  });
}
