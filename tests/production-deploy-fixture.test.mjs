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
const imageApp = `sha256:${'1'.repeat(64)}`;
const imageCache = `sha256:${'2'.repeat(64)}`;

function executable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function setupFixture(t, server, scenario, run = '123-1') {
  const root = mkdtempSync(join(tmpdir(), `infra-prod${server}-deploy-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const stage = join(root, '.deploy-staging', `prod${server}-${revision}-${run}`);
  const inputs = join(stage, 'inputs');
  const state = join(stage, 'state');
  const staleInputs = join(root, '.deploy-staging', `prod${server}-${revision}-122-1`, 'inputs');
  mkdirSync(bin);
  mkdirSync(inputs, { recursive: true });
  mkdirSync(state);
  mkdirSync(staleInputs, { recursive: true });
  writeFileSync(join(staleInputs, `docker-compose-prod${server}.yml`), 'stale-candidate\n');
  writeFileSync(join(staleInputs, `.env.infra${server}`), 'stale-env\n');
  if (server === 2) {
    mkdirSync(join(inputs, 'ops', 'prod2'), { recursive: true });
    writeFileSync(join(inputs, 'ops', 'prod2', 'install-logging.sh'), `#!/bin/sh\n# ${run}\n`);
    mkdirSync(join(root, 'incoming2', 'ops', 'prod2'), { recursive: true });
    writeFileSync(join(root, 'incoming2', 'ops', 'prod2', 'install-logging.sh'), '#!/bin/sh\n# previous-ops\n');
  }
  writeFileSync(join(root, `docker-compose-prod${server}.yml`), 'old-compose\n');
  writeFileSync(join(root, `.env.infra${server}`), 'old-env\n');
  writeFileSync(join(inputs, `docker-compose-prod${server}.yml`), `candidate-${run}\n`);
  writeFileSync(join(inputs, `.env.infra${server}`), `candidate-env-${run}\n`);
  writeFileSync(join(inputs, 'deploy-prod.sh'), readFileSync(script));
  executable(join(bin, 'flock'), '#!/bin/sh\n[ "$LOCK_HELD" != 1 ] || exit 1\nif [ -f "$FIXTURE/started" ] && [ ! -f "$FIXTURE/rollback-complete" ]; then sleep 4; fi\n');
  executable(join(bin, 'mv'), `#!/bin/sh
set -eu
destination=
for argument in "$@"; do destination=$argument; done
name=\${destination##*/}
if [ "$SCENARIO" = final-marker-failure ] && [ "$name" = result ] && [ ! -f "$FIXTURE/marker-failed" ] && grep -q '${run}' "$FIXTURE/incoming2/ops/prod2/install-logging.sh" 2>/dev/null; then
  touch "$FIXTURE/marker-failed"
  exit 1
fi
/usr/bin/mv "$@"
case "$name" in commit-ready|watchdog-ack|result|finished) printf '%s\\n' "$name" >>"$FIXTURE/marker-order" ;; esac
`);
  executable(join(bin, 'python3'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '-c') {
  const data = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write((typeof data.name === 'string' ? data.name : '') + '\\n');
  process.exit(0);
}
const source = process.argv[3];
const output = process.argv[4];
if (fs.statSync(source).isDirectory()) {
  fs.rmSync(output, { recursive: true, force: true });
  fs.renameSync(source, output);
  process.exit(0);
}
const data = JSON.parse(fs.readFileSync(source, 'utf8'));
const images = [];
const healthchecks = [];
for (const name of Object.keys(data.services).sort()) {
  const service = data.services[name];
  images.push(name + '|' + service.image);
  healthchecks.push(name + '|' + (service.healthcheck && !service.healthcheck.disable ? 'healthy' : 'running'));
  const resources = [];
  for (const mount of service.volumes || []) {
    const sourceValue = mount.type === 'volume' ? data.volumes[mount.source].name : mount.source;
    resources.push(['M', mount.type, sourceValue, mount.target, mount.read_only ? 'false' : 'true'].join('|'));
  }
  for (const network of Object.keys(service.networks || {}).sort()) resources.push('N|' + data.networks[network].name);
  fs.writeFileSync(path.join(output, 'resources', name), resources.sort().join('\\n') + (resources.length ? '\\n' : ''));
  const ports = (service.ports || []).map((port) => ['P', port.target + '/' + (port.protocol || 'tcp'), port.host_ip || '0.0.0.0', port.published].join('|'));
  fs.writeFileSync(path.join(output, 'ports', name), ports.sort().join('\\n') + (ports.length ? '\\n' : ''));
}
fs.writeFileSync(path.join(output, 'images.map'), images.join('\\n') + '\\n');
fs.writeFileSync(path.join(output, 'healthchecks.map'), healthchecks.join('\\n') + '\\n');
`);
  executable(join(bin, 'docker'), `#!/bin/sh
set -eu
args="$*"
printf '%s\n' "$args" >>"$FIXTURE/docker.args"
candidate=0
case "$args" in *'.deploy-staging/'*'/inputs/docker-compose-'*) candidate=1 ;; esac
case "$args" in
  *' config --services')
    case "$args" in *'--project-name infra'*'--project-directory '*) ;; *) echo 'missing exact project identity' >&2; exit 92 ;; esac
    printf 'app\\ncache\\n'
    ;;
  *' config --format json')
    app_image=image/app:1
    cache_image=image/cache:1
    app_source=/srv/app
    app_health='"test":["CMD","true"]'
    app_host=0.0.0.0
    cache_host=0.0.0.0
    network_name=infra_devnogi-network
    if [ "$candidate" = 1 ]; then
      if [ "$SERVER" = 2 ]; then app_host=127.0.0.1; cache_host=127.0.0.1; fi
      [ "$SCENARIO" != image-swap ] || { app_image=image/cache:1; cache_image=image/app:1; }
      [ "$SCENARIO" != resource-mismatch ] || app_source=/srv/other
      [ "$SCENARIO" != healthy-to-no-health ] || app_health=
      [ "$SCENARIO" != healthy-to-disabled-health ] || app_health='"disable":true'
      [ "$SCENARIO" != candidate-wildcard ] || app_host=0.0.0.0
    else
      [ "$SCENARIO" != prior-no-health-success ] || app_health=
      [ "$SCENARIO" != live-drift-mount ] || app_source=/srv/other
      [ "$SCENARIO" != live-drift-network ] || network_name=infra_other-network
      [ "$SCENARIO" != live-drift-port ] || app_host=127.0.0.1
      [ "$SCENARIO" != live-drift-readiness ] || app_health=
    fi
    if [ -n "$app_health" ]; then health=",\\\"healthcheck\\\":{\${app_health}}"; else health=; fi
    printf '{"name":"infra","services":{"app":{"image":"%s","volumes":[{"type":"bind","source":"%s","target":"/data"}],"networks":{"default":{}},"ports":[{"target":8080,"published":"18080","protocol":"tcp","host_ip":"%s"}]%s},"cache":{"image":"%s","volumes":[{"type":"volume","source":"cache-data","target":"/cache"}],"networks":{"default":{}},"ports":[{"target":6379,"published":"16379","protocol":"tcp","host_ip":"%s"}],"healthcheck":{"test":["CMD","true"]}}},"volumes":{"cache-data":{"name":"infra_cache-data"}},"networks":{"default":{"name":"%s"}}}\\n' "$app_image" "$app_source" "$app_host" "$health" "$cache_image" "$cache_host" "$network_name"
    ;;
  *' ps --all -q app') case "$args" in *'--project-name infra'*'--project-directory '*) echo container-app ;; *) exit 92 ;; esac ;;
  *' ps --all -q cache') case "$args" in *'--project-name infra'*'--project-directory '*) echo container-cache ;; *) exit 92 ;; esac ;;
  'inspect --format {{index .Config.Labels "com.docker.compose.project"}} container-'*) echo infra ;;
  'inspect --format {{index .Config.Labels "com.docker.compose.service"}} container-app') echo app ;;
  'inspect --format {{index .Config.Labels "com.docker.compose.service"}} container-cache') echo cache ;;
  'inspect --format {{.State.Status}} container-'*)
    if [ "$SCENARIO" = prior-stopped ] && [ ! -f "$FIXTURE/started" ] && [ "$args" = 'inspect --format {{.State.Status}} container-app' ]; then echo exited; else echo running; fi
    ;;
  'inspect --format {{json .Config}} container-'*)
    service=\${args##*container-}
    if [ ! -f "$FIXTURE/started" ]; then
      if [ "$SCENARIO" = prior-no-health-success ] && [ "$service" = app ]; then echo '{}'; else echo '{"Healthcheck":{}}'; fi
    elif [ -f "$FIXTURE/rollback-complete" ]; then
      if [ "$SCENARIO" = prior-no-health-success ] && [ "$service" = app ]; then echo '{}'; else echo '{"Healthcheck":{}}'; fi
    elif [ "$SCENARIO" = candidate-unhealthy ] || [ "$SCENARIO" = success ] || [ "$SCENARIO" = slow-success ]; then
      echo '{"Healthcheck":{}}'
    else
      echo '{"Healthcheck":{}}'
    fi
    ;;
  'inspect --format {{.State.Health.Status}} container-'*)
    if [ "$SCENARIO" = prior-unhealthy ] && [ ! -f "$FIXTURE/started" ] && [ "$args" = 'inspect --format {{.State.Health.Status}} container-app' ]; then
      echo unhealthy
    elif { [ "$SCENARIO" = candidate-unhealthy ] || [ "$SCENARIO" = rollback-port-mismatch ]; } && [ -f "$FIXTURE/started" ] && [ ! -f "$FIXTURE/rollback-complete" ]; then
      echo unhealthy
    elif [ "$SCENARIO" = recovery-unhealthy ] && [ -f "$FIXTURE/rollback-complete" ]; then
      echo unhealthy
    else
      echo healthy
    fi
    ;;
  'inspect --format {{.Image}} container-app') echo '${imageApp}' ;;
  'inspect --format {{.Image}} container-cache') echo '${imageCache}' ;;
  *NetworkSettings.Ports*container-app)
    if [ ! -f "$FIXTURE/started" ]; then host=0.0.0.0
    elif [ -f "$FIXTURE/rollback-complete" ]; then if [ "$SCENARIO" = rollback-port-mismatch ]; then host=127.0.0.1; else host=0.0.0.0; fi
    elif [ "$SCENARIO" = candidate-runtime-wildcard ]; then host=0.0.0.0
    elif [ "$SERVER" = 2 ]; then host=127.0.0.1
    else host=0.0.0.0; fi
    printf 'P|8080/tcp|%s|18080\\n' "$host"
    ;;
  *NetworkSettings.Ports*container-cache)
    if [ ! -f "$FIXTURE/started" ] || [ -f "$FIXTURE/rollback-complete" ]; then host=0.0.0.0
    elif [ "$SCENARIO" = candidate-runtime-wildcard ]; then host=0.0.0.0
    elif [ "$SERVER" = 2 ]; then host=127.0.0.1
    else host=0.0.0.0; fi
    printf 'P|6379/tcp|%s|16379\\n' "$host"
    ;;
  *Mounts*container-app) printf 'M|bind|/srv/app|/data|true\\n' ;;
  *Mounts*container-cache) printf 'M|volume|infra_cache-data|/cache|true\\n' ;;
  *NetworkSettings.Networks*container-*) printf 'N|infra_devnogi-network\\n' ;;
  *image*inspect*${imageApp}) echo 'image/app@sha256:${'a'.repeat(64)}' ;;
  *image*inspect*${imageCache}) echo 'image/cache@sha256:${'b'.repeat(64)}' ;;
  *' up -d --wait --pull never')
    count=0; [ ! -f "$FIXTURE/up-count" ] || count=$(cat "$FIXTURE/up-count"); count=$((count + 1)); printf '%s' "$count" >"$FIXTURE/up-count"
    if [ "$count" -eq 1 ]; then
      touch "$FIXTURE/started"
      case "$SCENARIO" in start-fail|rollback-fail|recovery-unhealthy) exit 1 ;; slow-success) sleep 3 ;; esac
    else
      [ "$SCENARIO" != rollback-fail ] || exit 1
      touch "$FIXTURE/rollback-complete"
    fi
    ;;
  *) echo "unexpected docker args: $args" >&2; exit 91 ;;
esac
`);
  return { root, bin, stage, inputs, state };
}

function runDeployment(t, server, scenario, options = {}) {
  const fixture = setupFixture(t, server, scenario, options.run);
  const command = 'if command -v cygpath >/dev/null; then FIXTURE=$(cygpath -u "$FIXTURE"); DEPLOY_ROOT=$(cygpath -u "$DEPLOY_ROOT"); STAGE=$(cygpath -u "$STAGE"); SCRIPT=$(cygpath -u "$SCRIPT"); fi; export FIXTURE DEPLOY_ROOT STAGE SCRIPT PATH="$FIXTURE/bin:$PATH"; exec "$SCRIPT" rollout "$SERVER" "$REVISION" "$STAGE"';
  const result = spawnSync(bash, ['-c', command], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${fixture.bin};${process.env.PATH}`,
      FIXTURE: fixture.root,
      DEPLOY_ROOT: fixture.root,
      STAGE: fixture.stage,
      SCRIPT: script,
      SERVER: String(server),
      REVISION: revision,
      SCENARIO: scenario,
      LOCK_HELD: options.lockHeld ? '1' : '0',
      DEPLOY_WATCHDOG_SECONDS: '10',
      DEPLOY_LOCK_WAIT_SECONDS: '1',
    },
  });
  return { ...fixture, result };
}

function runKilledDeployment(t, server) {
  const fixture = setupFixture(t, server, 'slow-success', '125-1');
  const command = `
if command -v cygpath >/dev/null; then FIXTURE=$(cygpath -u "$FIXTURE"); DEPLOY_ROOT=$(cygpath -u "$DEPLOY_ROOT"); STAGE=$(cygpath -u "$STAGE"); SCRIPT=$(cygpath -u "$SCRIPT"); fi
export FIXTURE DEPLOY_ROOT STAGE SCRIPT PATH="$FIXTURE/bin:$PATH"
"$SCRIPT" rollout "$SERVER" "$REVISION" "$STAGE" & rollout_pid=$!
for _ in $(seq 1 200); do [ -f "$FIXTURE/started" ] && break; sleep 0.05; done
[ -f "$FIXTURE/started" ]
kill -KILL "$rollout_pid"
wait "$rollout_pid" 2>/dev/null || true
for _ in $(seq 1 300); do [ -f "$STAGE/state/result" ] && break; sleep 0.05; done
test "$(cat "$STAGE/state/result")" = DEPLOY_RESULT=ROLLED_BACK
`;
  const result = spawnSync(bash, ['-c', command], {
    encoding: 'utf8',
    timeout: 25_000,
    env: {
      ...process.env,
      PATH: `${fixture.bin};${process.env.PATH}`,
      FIXTURE: fixture.root,
      DEPLOY_ROOT: fixture.root,
      STAGE: fixture.stage,
      SCRIPT: script,
      SERVER: String(server),
      REVISION: revision,
      SCENARIO: 'slow-success',
      LOCK_HELD: '0',
      DEPLOY_WATCHDOG_SECONDS: '10',
      DEPLOY_LOCK_WAIT_SECONDS: '10',
    },
  });
  return { ...fixture, result };
}

for (const server of [1, 2]) {
  test(`server ${server} bootstraps from a running container without a healthcheck`, (t) => {
    const { root, state, result } = runDeployment(t, server, 'prior-no-health-success');
    assert.equal(result.status, 0, `${result.stderr}\n${readFileSync(join(root, 'docker.args'), 'utf8')}`);
    assert.match(readFileSync(join(state, 'previous-readiness'), 'utf8'), /app\|running/);
    assert.equal(readFileSync(join(root, `.last-deployed-prod${server}-sha`), 'utf8').trim(), revision);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=SUCCESS');
    assert.equal(readFileSync(join(state, 'finished'), 'utf8').trim(), 'DEPLOY_FINISHED=1');
    assert.deepEqual(readFileSync(join(root, 'marker-order'), 'utf8').trim().split(/\r?\n/).slice(-4), ['commit-ready', 'watchdog-ack', 'result', 'finished']);
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'candidate-123-1\n');
    assert.equal(readFileSync(join(root, `.env.infra${server}`), 'utf8'), 'candidate-env-123-1\n');
    const dockerArgs = readFileSync(join(root, 'docker.args'), 'utf8');
    assert.match(dockerArgs, /--project-name infra/);
    assert.match(dockerArgs, /--project-directory/);
    assert.doesNotMatch(dockerArgs, /--project-name state(?:\s|$)/);
    if (server === 2) {
      assert.match(readFileSync(join(root, 'incoming2', 'ops', 'prod2', 'install-logging.sh'), 'utf8'), /123-1/);
    }
  });

  test(`server ${server} rejects an unhealthy prior container before mutation`, (t) => {
    const { root, state, result } = runDeployment(t, server, 'prior-unhealthy');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=PREFLIGHT_FAILED');
    assert.equal(existsSync(join(root, 'started')), false);
  });

  test(`server ${server} rejects a stopped prior container before mutation`, (t) => {
    const { root, result } = runDeployment(t, server, 'prior-stopped');
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, 'started')), false);
  });

  test(`server ${server} rejects a mount or network mismatch before mutation`, (t) => {
    const { root, result } = runDeployment(t, server, 'resource-mismatch');
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, 'started')), false);
  });

  test(`server ${server} rejects a service image swap before mutation`, (t) => {
    const { root, result } = runDeployment(t, server, 'image-swap');
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, 'started')), false);
  });

  test(`server ${server} rejects healthy-to-no-health before mutation`, (t) => {
    const { root, result } = runDeployment(t, server, 'healthy-to-no-health');
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, 'started')), false);
  });

  test(`server ${server} rejects a disabled candidate healthcheck before mutation`, (t) => {
    const { root, result } = runDeployment(t, server, 'healthy-to-disabled-health');
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, 'started')), false);
  });

  test(`server ${server} rolls back an unhealthy candidate`, (t) => {
    const { root, state, result } = runDeployment(t, server, 'candidate-unhealthy');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=ROLLED_BACK');
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'old-compose\n');
  });

  test(`server ${server} reports rollback failure`, (t) => {
    const { state, result } = runDeployment(t, server, 'rollback-fail');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=ROLLBACK_FAILED');
  });

  test(`server ${server} rejects a candidate runtime port mismatch and rolls back`, (t) => {
    const { state, result } = runDeployment(t, server, 'candidate-runtime-wildcard');
    if (server === 1) {
      assert.equal(result.status, 0, result.stderr);
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=ROLLED_BACK');
    }
  });

  test(`server ${server} rejects a rollback port mismatch`, (t) => {
    const { state, result } = runDeployment(t, server, 'rollback-port-mismatch');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=ROLLBACK_FAILED');
  });

  test(`server ${server} refuses an overlapping orphan deployment without mutation`, (t) => {
    const { root, state, result } = runDeployment(t, server, 'success', { lockHeld: true, run: '124-1' });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=PREFLIGHT_FAILED');
    assert.equal(existsSync(join(root, 'started')), false);
    assert.equal(readFileSync(join(root, `docker-compose-prod${server}.yml`), 'utf8'), 'old-compose\n');
  });
}

test('prod2 rejects a wildcard candidate binding before mutation', (t) => {
  const { root, state, result } = runDeployment(t, 2, 'candidate-wildcard', { run: '126-1' });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=PREFLIGHT_FAILED');
  assert.equal(existsSync(join(root, 'started')), false);
});

for (const scenario of ['live-drift-mount', 'live-drift-network', 'live-drift-port', 'live-drift-readiness']) {
  test(`live ${scenario.replace('live-drift-', '')} drift aborts before mutation`, (t) => {
    const { root, state, result } = runDeployment(t, 2, scenario, { run: '127-1' });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=PREFLIGHT_FAILED');
    assert.equal(existsSync(join(root, 'started')), false);
    assert.equal(existsSync(join(root, 'up-count')), false);
  });
}

test('prod2 restores the previous stable ops package when the final result marker fails', (t) => {
  const { root, state, result } = runDeployment(t, 2, 'final-marker-failure', { run: '128-1' });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=ROLLED_BACK');
  assert.match(readFileSync(join(root, 'incoming2', 'ops', 'prod2', 'install-logging.sh'), 'utf8'), /previous-ops/);
  assert.equal(existsSync(join(root, '.last-deployed-prod2-sha')), false);
});

test('detached watchdog rolls back after the rollout parent is SIGKILLed', (t) => {
  const { root, state, result } = runKilledDeployment(t, 1);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=ROLLED_BACK');
  assert.equal(readFileSync(join(root, 'docker-compose-prod1.yml'), 'utf8'), 'old-compose\n');
  assert.equal(existsSync(join(root, '.last-deployed-prod1-sha')), false);
});
