import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function bashPath(path) {
  if (process.platform !== 'win32') return path;
  const result = spawnSync(bash, ['-c', 'cygpath -u "$1"', 'sh', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('anonymous volume shell check accepts only an accessible empty directory', (t) => {
  const source = readFileSync(script, 'utf8');
  const match = /if ! docker exec "\$container" sh -c '\r?\n([\s\S]*?)\r?\n' sh "\$target" >\/dev\/null; then/.exec(source);
  assert.ok(match, 'empty-volume shell check was not found');
  const check = match[1];
  const root = mkdtempSync(join(tmpdir(), 'infra-volume-empty-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (directory) => spawnSync(bash, ['-c', check, 'sh', bashPath(directory)], { encoding: 'utf8' });
  const directory = (name) => {
    const value = join(root, name);
    mkdirSync(value);
    return value;
  };

  assert.equal(run(directory('empty')).status, 0);
  for (const [name, entry] of [['visible', 'entry'], ['hidden', '.hidden'], ['double-dot', '..hidden']]) {
    const value = directory(name);
    writeFileSync(join(value, entry), 'data');
    assert.notEqual(run(value).status, 0, name);
  }

  if (process.platform !== 'win32') {
    const brokenLink = directory('broken-link');
    symlinkSync('missing-target', join(brokenLink, 'broken'));
    assert.notEqual(run(brokenLink).status, 0, 'broken symlink');

    const globName = directory('glob-name');
    writeFileSync(join(globName, '[literal]*?'), 'data');
    assert.notEqual(run(globName).status, 0, 'glob-character filename');

    if (process.getuid?.() !== 0) {
      const inaccessible = directory('inaccessible');
      writeFileSync(join(inaccessible, 'protected'), 'data');
      chmodSync(inaccessible, 0o000);
      try {
        assert.notEqual(run(inaccessible).status, 0, 'inaccessible directory');
      } finally {
        chmodSync(inaccessible, 0o700);
      }
    }
  }
});

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
  executable(join(bin, 'flock'), '#!/bin/sh\n[ "$LOCK_HELD" != 1 ] || exit 1\nif [ "$SCENARIO" = slow-success ] && [ -f "$FIXTURE/started" ] && [ ! -f "$FIXTURE/rollback-complete" ]; then sleep 4; fi\nif [ "$SCENARIO" = term-after-success ] && [ -f "$FIXTURE/started" ] && [ ! -f "$FIXTURE/rollback-complete" ]; then sleep 2; fi\n');
  executable(join(bin, 'mv'), `#!/bin/sh
set -eu
destination=
for argument in "$@"; do destination=$argument; done
name=\${destination##*/}
if [ "$SCENARIO" = term-before-success ] && [ "$name" = result ] && [ ! -f "$FIXTURE/term-before-triggered" ] && grep -q '${run}' "$FIXTURE/incoming2/ops/prod2/install-logging.sh" 2>/dev/null; then
  touch "$FIXTURE/term-before-triggered"
  state_dir=\${destination%/*}
  kill -TERM "$(cat "$state_dir/rollout-pid")"
  sleep 0.1
  exit 1
fi
if [ "$SCENARIO" = final-marker-failure ] && [ "$name" = result ] && [ ! -f "$FIXTURE/marker-failed" ] && grep -q '${run}' "$FIXTURE/incoming2/ops/prod2/install-logging.sh" 2>/dev/null; then
  touch "$FIXTURE/marker-failed"
  exit 1
fi
/usr/bin/mv "$@"
case "$name" in commit-ready|watchdog-ack|watchdog-takeover|watchdog-lock-acquired|result|finished) printf '%s\\n' "$name" >>"$FIXTURE/marker-order" ;; esac
if [ "$SCENARIO" = term-during-success-publish ] && [ "$name" = result ]; then
  state_dir=\${destination%/*}
  kill -TERM "$(cat "$state_dir/rollout-pid")"
  sleep 0.1
fi
if [ "$SCENARIO" = kill-after-ack ] && [ "$name" = watchdog-ack ]; then
  state_dir=\${destination%/*}
  kill -STOP "$(cat "$state_dir/rollout-pid")"
fi
if [ "$SCENARIO" = term-after-finished ] && [ "$name" = finished ]; then
  state_dir=\${destination%/*}
  kill -STOP "$(cat "$state_dir/rollout-pid")"
fi
`);
  executable(join(bin, 'python3'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '-c') {
  const input = fs.readFileSync(0, 'utf8');
  const declaredVolume = process.argv.indexOf('declared-volume');
  if (declaredVolume !== -1) {
    const newline = input.indexOf('\\n');
    const target = input.slice(0, newline);
    const data = JSON.parse(input.slice(newline + 1));
    process.exit(data && typeof data === 'object' && Object.hasOwn(data, target) ? 0 : 1);
  }
  const data = JSON.parse(input);
  if (process.argv.includes('anonymous-label')) {
    process.exit(data && typeof data === 'object' && data['com.docker.volume.anonymous'] === '' ? 0 : 1);
  } else if (data && typeof data.name === 'string') {
    process.stdout.write(data.name + '\\n');
  } else if (data === null || (data && typeof data === 'object' && (data.Test == null || data.Test.length === 0))) {
    process.stdout.write('running\\n');
  } else if (data && typeof data === 'object' && Array.isArray(data.Test) && data.Test.length === 1 && data.Test[0] === 'NONE') {
    process.stdout.write('running\\n');
  } else if (data && typeof data === 'object' && Array.isArray(data.Test) && data.Test.length >= 2 && ['CMD', 'CMD-SHELL'].includes(data.Test[0]) && data.Test.slice(1).every((item) => typeof item === 'string' && item.length > 0)) {
    process.stdout.write('healthy\\n');
  } else {
    process.exit(1);
  }
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
  const healthcheckMode = !Object.hasOwn(service, 'healthcheck') ? 'absent' : (service.healthcheck?.disable ? 'disabled' : 'configured');
  healthchecks.push(name + '|' + healthcheckMode);
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
    case "$SCENARIO" in image-health-success|image-health-disabled|image-none-success|none-runtime-image-active|active-runtime-image-none) app_health= ;; disabled-none-success) app_health='"disable":true' ;; esac
    if [ "$candidate" = 1 ]; then
      if [ "$SERVER" = 2 ]; then app_host=127.0.0.1; cache_host=127.0.0.1; fi
      [ "$SCENARIO" != image-swap ] || { app_image=image/cache:1; cache_image=image/app:1; }
      [ "$SCENARIO" != resource-mismatch ] || app_source=/srv/other
      [ "$SCENARIO" != healthy-to-no-health ] || app_health=
      [ "$SCENARIO" != healthy-to-disabled-health ] || app_health='"disable":true'
      [ "$SCENARIO" != image-health-disabled ] || app_health='"disable":true'
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
  'inspect --format {{json .Config.Healthcheck}} container-'*)
    service=\${args##*container-}
    if [ "$service" = app ]; then
      if [ "$SCENARIO" = prior-no-health-success ] && { [ ! -f "$FIXTURE/started" ] || [ -f "$FIXTURE/rollback-complete" ]; }; then
        echo '{"Test":["NONE"]}'
      else
        case "$SCENARIO" in
          disabled-none-success|image-none-success|none-runtime-configured|none-runtime-image-active) echo '{"Test":["NONE"]}' ;;
          malformed-health-mode) echo '{"Test":["BOGUS","true"]}' ;;
          *) echo '{"Test":["CMD","true"]}' ;;
        esac
      fi
    else
      echo '{"Test":["CMD","true"]}'
    fi
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
    if [ ! -f "$FIXTURE/started" ]; then
      case "$SCENARIO" in
        ipv6-only-wildcard) printf 'P|8080/tcp|::|18080\\n'; exit 0 ;;
        custom-ipv6-wildcard) printf 'P|8080/tcp|0.0.0.0|18080\\nP|8080/tcp|2001:db8::1|18080\\n'; exit 0 ;;
        dual-stack-wildcard) printf 'P|8080/tcp|0.0.0.0|18080\\nP|8080/tcp|::|18080\\n'; exit 0 ;;
      esac
      host=0.0.0.0
    elif [ -f "$FIXTURE/rollback-complete" ]; then if [ "$SCENARIO" = rollback-port-mismatch ]; then host=127.0.0.1; else host=0.0.0.0; fi
    elif [ "$SCENARIO" = candidate-runtime-wildcard ]; then host=0.0.0.0
    elif [ "$SERVER" = 2 ]; then host=127.0.0.1
    else host=0.0.0.0; fi
    printf 'P|8080/tcp|%s|18080\\n' "$host"
    ;;
  *NetworkSettings.Ports*container-cache)
    if [ ! -f "$FIXTURE/started" ]; then
      if [ "$SCENARIO" = dual-stack-wildcard ]; then printf 'P|6379/tcp|0.0.0.0|16379\\nP|6379/tcp|::|16379\\n'; exit 0; fi
      host=0.0.0.0
    elif [ -f "$FIXTURE/rollback-complete" ]; then host=0.0.0.0
    elif [ "$SCENARIO" = candidate-runtime-wildcard ]; then host=0.0.0.0
    elif [ "$SERVER" = 2 ]; then host=127.0.0.1
    else host=0.0.0.0; fi
    printf 'P|6379/tcp|%s|16379\\n' "$host"
    ;;
  *Mounts*container-app)
    printf 'M|bind|/srv/app|/data|true\\n'
    case "$SCENARIO" in
      image-anonymous-empty-volume|image-anonymous-nonempty-volume|image-anonymous-missing-label|image-anonymous-misleading-label|image-anonymous-undeclared-target)
        printf 'M|volume|${'c'.repeat(64)}|/runtime-secrets|true\\n'
        ;;
      image-anonymous-nonhex-name)
        printf 'M|volume|manual-volume|/runtime-secrets|true\\n'
        ;;
      image-anonymous-bind-extra)
        printf 'M|bind|/tmp/runtime-secrets|/runtime-secrets|true\\n'
        ;;
    esac
    ;;
  *Mounts*container-cache) printf 'M|volume|infra_cache-data|/cache|true\\n' ;;
  *NetworkSettings.Networks*container-*) printf 'N|infra_devnogi-network\\n' ;;
  *'image inspect --format {{json .Config.Volumes}}'*${imageApp})
    case "$SCENARIO" in
      image-anonymous-empty-volume|image-anonymous-nonempty-volume|image-anonymous-missing-label|image-anonymous-misleading-label|image-anonymous-nonhex-name|image-anonymous-bind-extra) echo '{"/runtime-secrets":{}}' ;;
      *) echo null ;;
    esac
    ;;
  *'volume inspect --format {{json .Labels}} '${'c'.repeat(64)})
    case "$SCENARIO" in
      image-anonymous-missing-label) echo '{}' ;;
      image-anonymous-misleading-label) echo '{"note":"com.docker.volume.anonymous"}' ;;
      *) echo '{"com.docker.volume.anonymous":""}' ;;
    esac
    ;;
  *'exec container-app sh -c '*' /runtime-secrets')
    [ "$SCENARIO" != image-anonymous-nonempty-volume ]
    ;;
  *'image inspect --format {{json .Config.Healthcheck}}'*${imageApp})
    case "$SCENARIO" in
      image-health-success|image-health-disabled|none-runtime-image-active) echo '{"Test":["CMD","true"]}' ;;
      image-none-success|disabled-none-success|none-runtime-configured|active-runtime-image-none) echo '{"Test":["NONE"]}' ;;
      *) echo null ;;
    esac
    ;;
  *'image inspect --format {{json .Config.Healthcheck}}'*${imageCache}) echo null ;;
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
for _ in $(seq 1 200); do [ -f "$STAGE/state/finished" ] && break; sleep 0.05; done
test "$(cat "$STAGE/state/finished")" = DEPLOY_FINISHED=1
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

function runKilledAfterAck(t) {
  const fixture = setupFixture(t, 2, 'kill-after-ack', '129-1');
  const command = `
if command -v cygpath >/dev/null; then FIXTURE=$(cygpath -u "$FIXTURE"); DEPLOY_ROOT=$(cygpath -u "$DEPLOY_ROOT"); STAGE=$(cygpath -u "$STAGE"); SCRIPT=$(cygpath -u "$SCRIPT"); fi
export FIXTURE DEPLOY_ROOT STAGE SCRIPT PATH="$FIXTURE/bin:$PATH"
"$SCRIPT" rollout 2 "$REVISION" "$STAGE" & rollout_pid=$!
for _ in $(seq 1 300); do [ -f "$STAGE/state/watchdog-ack" ] && break; sleep 0.05; done
[ -f "$STAGE/state/watchdog-ack" ]
test "$rollout_pid" = "$(cat "$STAGE/state/rollout-pid")"
kill -KILL "$rollout_pid"
wait "$rollout_pid" 2>/dev/null || true
printf 'PARENT_KILLED=1\n' >"$STAGE/state/test-parent-killed"
for _ in $(seq 1 200); do [ -f "$STAGE/state/watchdog-takeover" ] && break; sleep 0.05; done
test -f "$STAGE/state/watchdog-takeover"
for _ in $(seq 1 200); do [ -f "$STAGE/state/watchdog-lock-acquired" ] && break; sleep 0.05; done
test -f "$STAGE/state/watchdog-lock-acquired"
for _ in $(seq 1 200); do [ -f "$STAGE/state/finished" ] && break; sleep 0.05; done
test "$(cat "$STAGE/state/result")" = DEPLOY_RESULT=ROLLED_BACK
test "$(cat "$STAGE/state/finished")" = DEPLOY_FINISHED=1
`;
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
      REVISION: revision,
      SERVER: '2',
      SCENARIO: 'kill-after-ack',
      LOCK_HELD: '0',
      DEPLOY_WATCHDOG_SECONDS: '10',
      DEPLOY_LOCK_WAIT_SECONDS: '10',
    },
  });
  return { ...fixture, result };
}

function runTermWindow(t, scenario, run) {
  const fixture = setupFixture(t, 2, scenario, run);
  let synchronization;
  if (scenario === 'term-before-success') {
    synchronization = `
for _ in $(seq 1 300); do [ -f "$STAGE/state/finished" ] && break; sleep 0.05; done
test "$(cat "$STAGE/state/result")" = DEPLOY_RESULT=ROLLED_BACK
test "$(cat "$STAGE/state/finished")" = DEPLOY_FINISHED=1
`;
  } else if (scenario === 'term-after-success') {
    synchronization = `
for _ in $(seq 1 300); do [ -f "$STAGE/state/result" ] && break; sleep 0.05; done
test "$(cat "$STAGE/state/result")" = DEPLOY_RESULT=SUCCESS
test ! -e "$STAGE/state/finished"
kill -TERM "$rollout_pid"
wait "$rollout_pid" 2>/dev/null || true
for _ in $(seq 1 300); do [ -f "$STAGE/state/finished" ] && break; sleep 0.05; done
test "$(cat "$STAGE/state/result")" = DEPLOY_RESULT=SUCCESS
test "$(cat "$STAGE/state/finished")" = DEPLOY_FINISHED=1
`;
  } else if (scenario === 'term-during-success-publish') {
    synchronization = `
for _ in $(seq 1 300); do [ -f "$STAGE/state/finished" ] && break; sleep 0.05; done
wait "$rollout_pid" 2>/dev/null || true
test "$(cat "$STAGE/state/result")" = DEPLOY_RESULT=SUCCESS
test "$(cat "$STAGE/state/finished")" = DEPLOY_FINISHED=1
`;
  } else {
    synchronization = `
for _ in $(seq 1 300); do [ -f "$STAGE/state/finished" ] && break; sleep 0.05; done
test "$(cat "$STAGE/state/result")" = DEPLOY_RESULT=SUCCESS
kill -TERM "$rollout_pid"
kill -CONT "$rollout_pid" 2>/dev/null || true
wait "$rollout_pid" 2>/dev/null || true
test "$(cat "$STAGE/state/result")" = DEPLOY_RESULT=SUCCESS
`;
  }
  const command = `
if command -v cygpath >/dev/null; then FIXTURE=$(cygpath -u "$FIXTURE"); DEPLOY_ROOT=$(cygpath -u "$DEPLOY_ROOT"); STAGE=$(cygpath -u "$STAGE"); SCRIPT=$(cygpath -u "$SCRIPT"); fi
export FIXTURE DEPLOY_ROOT STAGE SCRIPT PATH="$FIXTURE/bin:$PATH"
"$SCRIPT" rollout 2 "$REVISION" "$STAGE" & rollout_pid=$!
${synchronization}
`;
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
      REVISION: revision,
      SERVER: '2',
      SCENARIO: scenario,
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
    assert.deepEqual(readFileSync(join(root, 'marker-order'), 'utf8').trim().split(/\r?\n/).slice(-5), ['commit-ready', 'watchdog-ack', 'result', 'watchdog-lock-acquired', 'finished']);
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

test('prod2 accepts the exact Docker dual-stack expansion of a Compose wildcard before mutation', (t) => {
  const { root, state, result } = runDeployment(t, 2, 'dual-stack-wildcard', { run: '134-1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=SUCCESS');
  assert.equal(readFileSync(join(root, 'up-count'), 'utf8'), '1');
});

test('prod1 accepts an empty image-declared anonymous volume across recreation', (t) => {
  const { root, state, result } = runDeployment(t, 1, 'image-anonymous-empty-volume', { run: '144-1' });
  assert.equal(result.status, 0, `${result.stderr}\n${readFileSync(join(root, 'docker.args'), 'utf8')}`);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=SUCCESS');
  assert.equal(readFileSync(join(root, 'up-count'), 'utf8'), '1');
});

test('prod1 rejects a non-empty image-declared anonymous volume before mutation', (t) => {
  const { root, state, result } = runDeployment(t, 1, 'image-anonymous-nonempty-volume', { run: '145-1' });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=PREFLIGHT_FAILED');
  assert.equal(existsSync(join(root, 'started')), false);
});

for (const [scenario, run] of [
  ['image-anonymous-missing-label', '146-1'],
  ['image-anonymous-misleading-label', '147-1'],
  ['image-anonymous-nonhex-name', '148-1'],
  ['image-anonymous-undeclared-target', '149-1'],
  ['image-anonymous-bind-extra', '150-1'],
]) {
  test(`prod1 rejects unsafe runtime volume exception ${scenario}`, (t) => {
    const { root, state, result } = runDeployment(t, 1, scenario, { run });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=PREFLIGHT_FAILED');
    assert.equal(existsSync(join(root, 'started')), false);
  });
}

for (const scenario of ['ipv6-only-wildcard', 'custom-ipv6-wildcard']) {
  test(`prod2 rejects ${scenario} as unexpected runtime binding drift`, (t) => {
    const { root, state, result } = runDeployment(t, 2, scenario, { run: '135-1' });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=PREFLIGHT_FAILED');
    assert.equal(existsSync(join(root, 'started')), false);
  });
}

test('prod2 accepts image-level healthcheck continuity for the exact pinned image', (t) => {
  const { root, state, result } = runDeployment(t, 2, 'image-health-success', { run: '136-1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=SUCCESS');
  assert.equal(readFileSync(join(root, 'up-count'), 'utf8'), '1');
});

test('prod2 rejects explicitly disabling a proven image-level healthcheck', (t) => {
  const { root, state, result } = runDeployment(t, 2, 'image-health-disabled', { run: '137-1' });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=PREFLIGHT_FAILED');
  assert.equal(existsSync(join(root, 'started')), false);
});

test('prod2 accepts disabled Compose health with runtime Test NONE as running continuity', (t) => {
  const { root, state, result } = runDeployment(t, 2, 'disabled-none-success', { run: '138-1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=SUCCESS');
  assert.doesNotMatch(readFileSync(join(root, 'docker.args'), 'utf8'), /State\.Health\.Status}} container-app/);
});

test('prod2 accepts absent Compose health with pinned image Test NONE as running continuity', (t) => {
  const { root, state, result } = runDeployment(t, 2, 'image-none-success', { run: '139-1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=SUCCESS');
  assert.doesNotMatch(readFileSync(join(root, 'docker.args'), 'utf8'), /State\.Health\.Status}} container-app/);
});

for (const [scenario, run] of [
  ['none-runtime-configured', '140-1'],
  ['none-runtime-image-active', '141-1'],
  ['active-runtime-image-none', '142-1'],
  ['malformed-health-mode', '143-1'],
]) {
  test(`prod2 rejects health metadata mismatch ${scenario} before mutation`, (t) => {
    const { root, state, result } = runDeployment(t, 2, scenario, { run });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=PREFLIGHT_FAILED');
    assert.equal(existsSync(join(root, 'started')), false);
  });
}

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

test('watchdog rolls back exact prior state when the parent dies immediately after ACK', (t) => {
  const { root, state, result } = runKilledAfterAck(t);
  const evidence = [
    result.stderr,
    existsSync(join(root, 'marker-order')) ? readFileSync(join(root, 'marker-order'), 'utf8') : 'no marker-order',
    ...['watchdog-ack', 'test-parent-killed', 'watchdog-takeover', 'watchdog-lock-acquired', 'result', 'finished'].map((name) => `${name}=${existsSync(join(state, name))}`),
  ].join('\n');
  assert.equal(result.status, 0, evidence);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=ROLLED_BACK');
  assert.equal(readFileSync(join(state, 'finished'), 'utf8').trim(), 'DEPLOY_FINISHED=1');
  assert.equal(readFileSync(join(state, 'test-parent-killed'), 'utf8').trim(), 'PARENT_KILLED=1');
  assert.equal(existsSync(join(state, 'watchdog-takeover')), true);
  assert.equal(existsSync(join(state, 'watchdog-lock-acquired')), true);
  assert.equal(readFileSync(join(root, 'docker-compose-prod2.yml'), 'utf8'), 'old-compose\n');
  assert.equal(readFileSync(join(root, '.env.infra2'), 'utf8'), 'old-env\n');
  assert.match(readFileSync(join(root, 'incoming2', 'ops', 'prod2', 'install-logging.sh'), 'utf8'), /previous-ops/);
  assert.equal(existsSync(join(root, '.last-deployed-prod2-sha')), false);
  assert.deepEqual(readFileSync(join(root, 'marker-order'), 'utf8').trim().split(/\r?\n/).slice(-6), [
    'commit-ready',
    'watchdog-ack',
    'watchdog-takeover',
    'watchdog-lock-acquired',
    'result',
    'finished',
  ]);
});

test('TERM immediately before SUCCESS rolls back exactly once', (t) => {
  const { root, state, result } = runTermWindow(t, 'term-before-success', '130-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=ROLLED_BACK');
  assert.equal(readFileSync(join(state, 'finished'), 'utf8').trim(), 'DEPLOY_FINISHED=1');
  assert.equal(readFileSync(join(root, `docker-compose-prod2.yml`), 'utf8'), 'old-compose\n');
  assert.match(readFileSync(join(root, 'incoming2', 'ops', 'prod2', 'install-logging.sh'), 'utf8'), /previous-ops/);
  assert.equal(readFileSync(join(root, 'marker-order'), 'utf8').trim().split(/\r?\n/).filter((marker) => marker === 'result').length, 1);
});

for (const [scenario, run] of [['term-after-success', '131-1'], ['term-after-finished', '132-1']]) {
  test(`${scenario} preserves SUCCESS without rollback`, (t) => {
    const { root, state, result } = runTermWindow(t, scenario, run);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=SUCCESS');
    assert.equal(readFileSync(join(state, 'finished'), 'utf8').trim(), 'DEPLOY_FINISHED=1');
    assert.equal(readFileSync(join(root, 'up-count'), 'utf8'), '1');
    assert.equal(existsSync(join(root, 'rollback-complete')), false);
    assert.equal(readFileSync(join(root, 'docker-compose-prod2.yml'), 'utf8'), `candidate-${run}\n`);
    assert.match(readFileSync(join(root, 'incoming2', 'ops', 'prod2', 'install-logging.sh'), 'utf8'), new RegExp(run));
    assert.equal(readFileSync(join(root, 'marker-order'), 'utf8').trim().split(/\r?\n/).filter((marker) => marker === 'result').length, 1);
  });
}

test('TERM after atomic SUCCESS publication but before mv return preserves SUCCESS', (t) => {
  const run = '133-1';
  const { root, state, result } = runTermWindow(t, 'term-during-success-publish', run);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(state, 'result'), 'utf8').trim(), 'DEPLOY_RESULT=SUCCESS');
  assert.equal(readFileSync(join(state, 'finished'), 'utf8').trim(), 'DEPLOY_FINISHED=1');
  assert.equal(readFileSync(join(root, 'up-count'), 'utf8'), '1');
  assert.equal(existsSync(join(root, 'rollback-complete')), false);
  assert.equal(readFileSync(join(root, 'docker-compose-prod2.yml'), 'utf8'), `candidate-${run}\n`);
  assert.match(readFileSync(join(root, 'incoming2', 'ops', 'prod2', 'install-logging.sh'), 'utf8'), new RegExp(run));
  assert.equal(readFileSync(join(root, 'marker-order'), 'utf8').trim().split(/\r?\n/).filter((marker) => marker === 'result').length, 1);
});
