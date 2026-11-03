import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

test('prod2 data services retain container ports and publish only to IPv4 loopback', () => {
  const compose = read('docker-compose-prod2.yml');
  assert.match(compose, /"127\.0\.0\.1:3316:3316"/);
  assert.match(compose, /"127\.0\.0\.1:6389:6389"/);
  assert.doesNotMatch(compose, /"(?:3316:3316|6389:6389)"/);
  assert.match(compose, /--port=3316/);
  assert.match(compose, /"--port", "6389"/);
});

test('renewal hook does not reload nginx when the configuration test fails', () => {
  const hook = read('ops/prod2/nginx/renew-deploy-hook.sh');
  assert.match(hook, /set -eu/);
  assert.match(hook, /nginx -t\s+systemctl reload nginx/);
  const bash = process.platform === 'win32'
    ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..', 'bin', 'bash.exe')
    : 'bash';
  const syntax = spawnSync(bash, ['-n', fileURLToPath(new URL('../ops/prod2/nginx/renew-deploy-hook.sh', import.meta.url))]);
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr?.toString());
  const failing = spawnSync(bash, ['-c', 'nginx() { return 1; }; systemctl() { echo RELOADED; }; export -f nginx systemctl; exec "$BASH" "$1"', 'test', fileURLToPath(new URL('../ops/prod2/nginx/renew-deploy-hook.sh', import.meta.url))], { encoding: 'utf8' });
  assert.ifError(failing.error);
  assert.notEqual(failing.status, 0);
  assert.doesNotMatch(failing.stdout, /RELOADED/);
});

test('ACME challenge has an explicit webroot and limits remain observation-only', () => {
  const acme = read('ops/prod2/nginx/acme-location.conf');
  assert.match(acme, /location \^~ \/\.well-known\/acme-challenge\//);
  assert.match(acme, /root \/var\/lib\/memonogi-acme;/);
  assert.match(acme, /try_files \$uri =404;/);
  const zones = read('ops/prod2/nginx/limits-http.conf');
  for (const name of ['memonogi_auth', 'memonogi_query', 'memonogi_connections']) assert.ok(zones.includes(name));
  for (const name of ['auth', 'query']) {
    const location = read(`ops/prod2/nginx/limits-${name}-location.conf`);
    assert.match(location, /limit_req_dry_run on;/);
    assert.match(location, /limit_conn_dry_run on;/);
  }
});

test('certificate guidance limits installation to covered SANs and records the active renewal method', () => {
  const guide = read('ops/prod2/nginx/README.md');
  assert.match(guide, /Point only the TLS vhosts whose `server_name` is covered by the issued certificate SANs/);
  assert.match(guide, /Keep `api\.memonogi\.com` and every other uncovered vhost on its existing valid certificate/);
  assert.match(guide, /Certbot 2\.9\.0's Nginx authenticator\/installer/);
  assert.match(guide, /renew --cert-name memonogi\.com --dry-run --run-deploy-hooks/);
});
