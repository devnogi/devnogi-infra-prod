import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const bash = process.env.DEPLOY_TEST_BASH || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe')
  : 'bash');
const script = fileURLToPath(new URL('../scripts/deploy-prod.sh', import.meta.url));
const revision = 'a'.repeat(40);

function executable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function runDeployment(t, server, scenario) {
  const root = mkdtempSync(join(tmpdir(), `infra-prod${server}-deploy-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const incoming = join(root, `incoming${server}`);
  mkdirSync(bin);
  mkdirSync(incoming);
  if (server === 2) {
    mkdirSync(join(incoming, 'ops', 'prod2'), { recursive: true });
    writeFileSync(join(incoming, 'ops', 'prod2', 'install-logging.sh'), '#!/bin/sh\n');
  }
  writeFileSync(join(root, `docker-compose-prod${server}.yml`), 'old-compose\n');
  writeFileSync(join(root, `.env.infra${server}`), 'old-env\n');
  writeFileSync(join(incoming, `docker-compose-prod${server}.yml`), 'new-compose\n');
  writeFileSync(join(incoming, `.next-env-infra${server}`), 'new-env\n');
  executable(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'docker'), `#!/bin/sh
set -eu
case "$*" in
  *'compose '*' config --services'*) echo app ;;
  *'compose '*' config --images'*) echo image:tag ;;
  *'compose '*' ps --all -q'*) echo container ;;
  'inspect --format {{.State.Status}} container')
    if [ "$SCENARIO" = prior-stopped ] && [ ! -f "$FIXTURE/started" ]; then echo exited; else echo running; fi
    ;;
  'inspect --format {{json .Config}} container')
    if [ ! -f "$FIXTURE/started" ]; then
      case "$SCENARIO" in prior-no-health-success|start-fail-no-health) echo '{}' ;; *) echo '{"Healthcheck":{}}' ;; esac
    elif [ -f "$FIXTURE/rollback-complete" ]; then
      if [ "$SCENARIO" = start-fail-no-health ]; then echo '{}'; else echo '{"Healthcheck":{}}'; fi
    elif [ "$SCENARIO" = candidate-no-health-success ]; then
      echo '{}'
    else
      echo '{"Healthcheck":{}}'
    fi
    ;;
  'inspect --format {{json .State}} container')
    if [ ! -f "$FIXTURE/started" ]; then
      case "$SCENARIO" in
        prior-no-health-success|start-fail-no-health) echo '{"Status":"running"}' ;;
        prior-unhealthy) echo '{"Status":"running","Health":{"Status":"unhealthy"}}' ;;
        *) echo '{"Status":"running","Health":{"Status":"healthy"}}' ;;
      esac
    elif [ -f "$FIXTURE/rollback-complete" ]; then
      if [ "$SCENARIO" = recovery-unhealthy ]; then
        echo '{"Status":"running","Health":{"Status":"unhealthy"}}'
      elif [ "$SCENARIO" = start-fail-no-health ]; then
        echo '{"Status":"running"}'
      else
        echo '{"Status":"running","Health":{"Status":"healthy"}}'
      fi
    elif [ "$SCENARIO" = candidate-no-health-success ]; then
      echo '{"Status":"running"}'
    elif [ "$SCENARIO" = candidate-unhealthy ]; then
      echo '{"Status":"running","Health":{"Status":"unhealthy"}}'
    else
      echo '{"Status":"running","Health":{"Status":"healthy"}}'
    fi
    ;;
  'inspect --format {{.State.Health.Status}} container')
    state=$("$0" inspect --format '{{json .State}}' container)
    case "$state" in
      *'"Status":"healthy"'*) echo healthy ;;
      *'"Status":"unhealthy"'*) echo unhealthy ;;
      *) exit 1 ;;
    esac
    ;;
  'inspect --format {{.Image}} container') echo sha256:old ;;
  'image inspect --format {{range .RepoDigests}}{{println .}}{{end}} sha256:old')
    [ "$SCENARIO" != missing-digest ] && echo image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    ;;
  *'up -d --wait --pull never'*)
    if [ ! -f "$FIXTURE/started" ]; then
      touch "$FIXTURE/started"
      case "$SCENARIO" in start-fail-no-health|rollback-fail|recovery-unhealthy) exit 1 ;; esac
    else
      [ "$SCENARIO" != rollback-fail ] || exit 1
      touch "$FIXTURE/rollback-complete"
    fi
    ;;
  *' compose '*|'compose '*) exit 1 ;;
  *) echo "unexpected docker args: $*" >&2; exit 91 ;;
esac
`);

  const command = 'if command -v cygpath >/dev/null; then FIXTURE=$(cygpath -u "$FIXTURE"); DEPLOY_ROOT=$(cygpath -u "$DEPLOY_ROOT"); SCRIPT=$(cygpath -u "$SCRIPT"); fi; export FIXTURE DEPLOY_ROOT SCRIPT PATH="$FIXTURE/bin:$PATH"; exec "$SCRIPT" "$SERVER" "$REVISION"';
  const result = spawnSync(bash, ['-c', command], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      FIXTURE: root,
      DEPLOY_ROOT: root,
      SCRIPT: script,
      SERVER: String(server),
      REVISION: revision,
      SCENARIO: scenario,
    },
  });
  return { root, result };
}

for (const server of [1, 2]) {
  test(`server ${server} bootstraps from a running container without a healthcheck`, (t) => {
    const { root, result } = runDeployment(t, server, 'prior-no-health-success');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, `.previous-readiness-prod${server}`), 'utf8'), 'app|running\n');
    assert.equal(readFileSync(join(root, `.last-deployed-prod${server}-sha`), 'utf8').trim(), revision);
  });

  test(`server ${server} accepts a running candidate without a healthcheck`, (t) => {
    const { result } = runDeployment(t, server, 'candidate-no-health-success');
    assert.equal(result.status, 0, result.stderr);
  });

  test(`server ${server} rejects an unhealthy prior container before mutation`, (t) => {
    const { root, result } = runDeployment(t, server, 'prior-unhealthy');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Prior container is unhealthy/);
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'old-compose\n');
    assert.equal(existsSync(join(root, 'started')), false);
  });

  test(`server ${server} rejects a stopped prior container before mutation`, (t) => {
    const { root, result } = runDeployment(t, server, 'prior-stopped');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Prior container is not running/);
    assert.equal(existsSync(join(root, 'started')), false);
  });

  test(`server ${server} refuses a missing digest before mutation`, (t) => {
    const { root, result } = runDeployment(t, server, 'missing-digest');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'old-compose\n');
    assert.equal(existsSync(join(root, 'started')), false);
  });

  test(`server ${server} restores a prior running-only service after failed start`, (t) => {
    const { root, result } = runDeployment(t, server, 'start-fail-no-health');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Rollback readiness verification passed/);
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'old-compose\n');
    assert.equal(readFileSync(join(root, `.env.infra${server}`), 'utf8'), 'old-env\n');
  });

  test(`server ${server} rolls back an unhealthy candidate`, (t) => {
    const { root, result } = runDeployment(t, server, 'candidate-unhealthy');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Rollback readiness verification passed/);
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'old-compose\n');
  });

  test(`server ${server} reports rollback command failure`, (t) => {
    const { result } = runDeployment(t, server, 'rollback-fail');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Rollback failed/);
  });

  test(`server ${server} reports unhealthy rollback for a previously healthy service`, (t) => {
    const { result } = runDeployment(t, server, 'recovery-unhealthy');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Rollback readiness verification failed/);
  });
}
