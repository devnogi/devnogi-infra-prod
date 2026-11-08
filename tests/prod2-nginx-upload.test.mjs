import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { render } from '../scripts/render-memonogi-vhost.mjs';
import { run } from '../scripts/verify-nginx.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

test('outfit upload boundary is large enough for five 5 MiB files and uses bounded timeouts', () => {
  const config = read('ops/prod2/nginx/outfit-upload-server.conf');
  assert.match(config, /^client_max_body_size 30m;$/m);
  assert.match(config, /^client_body_timeout 150s;$/m);
  assert.match(config, /^proxy_send_timeout 150s;$/m);
  assert.match(config, /^proxy_read_timeout 150s;$/m);
});

test('ingress 413 responses use the stable JSON error contract', () => {
  const config = read('ops/prod2/nginx/outfit-upload-server.conf');
  assert.match(config, /^error_page 413 = @outfit_payload_too_large;$/m);
  assert.match(config, /default_type application\/json;/);
  assert.match(config, /return 413 '\{"code":"OUTFIT_PAYLOAD_TOO_LARGE","message":"[^"]+"\}';/);
  assert.match(config, /add_header Cache-Control "no-store" always;/);
});

test('syntax fixture preserves routing as a synthetic proxy and imports the reviewed fragment', () => {
  const fixture = read('ops/prod2/nginx/fixtures/outfit-upload-vhost.conf');
  assert.match(fixture, /server_name memonogi\.invalid;/);
  assert.match(fixture, /include \/etc\/nginx\/memonogi\/outfit-upload-server\.conf;/);
  assert.match(fixture, /proxy_pass http:\/\/127\.0\.0\.1:18080;/);
  assert.doesNotMatch(fixture, /memonogi\.com|ssl_certificate|api[_-]?key|password/i);
});

test('managed full-vhost template preserves current routes and isolates environment values in marked input', () => {
  const template = read('ops/prod2/nginx/memonogi.conf.template');
  for (const token of [
    '@@CURRENT_VHOST_BEFORE_OUTFIT_BOUNDARY@@',
    '@@OUTFIT_UPLOAD_BOUNDARY_INCLUDE@@',
    '@@CURRENT_VHOST_AFTER_OUTFIT_BOUNDARY@@',
  ]) assert.ok(template.includes(token));
  assert.doesNotMatch(template, /memonogi\.com|proxy_pass|ssl_certificate|private_key|password/i);

  const source = `server {\n    listen 443 ssl;\n    server_name www.example.invalid;\n    include /root-only/tls.conf;\n    location / { proxy_pass http://127.0.0.1:13000; }\n}\n`;
  const marked = source.replace('    location /', '    # MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\n    location /');
  const { output: rendered, manifest } = render(marked, source);
  assert.match(rendered, /server_name www\.example\.invalid;/);
  assert.match(rendered, /include \/root-only\/tls\.conf;/);
  assert.match(rendered, /location \/ \{ proxy_pass http:\/\/127\.0\.0\.1:13000; \}/);
  assert.match(rendered, /^    include \/etc\/nginx\/snippets\/memonogi-outfit-upload\.conf;$/m);
  assert.doesNotMatch(rendered, /MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY|@@[A-Z0-9_]+@@/);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  assert.equal(manifest, `version 1\nsource_sha256 ${hash(source)}\ncandidate_sha256 ${hash(rendered)}\n`);
});

test('managed renderer recognizes an actual direct server child through comments and quoted braces', () => {
  const marked = `# fake server {\nserver {\n    set $literal "upstream { not-a-block; }";\n    # map $x $y {\n    # MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\n}\n`;
  assert.doesNotThrow(() => render(marked, marked.replace('    # MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\n', '')));
});

test('managed renderer permits only the marker and preserves source line endings byte-for-byte', () => {
  const source = 'server {\r\n    include /root-only/tls.conf;\r\n    location / { proxy_pass http://127.0.0.1:13000; }\r\n}\r\n';
  const marked = source.replace('    location /', '    # MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\r\n    location /');
  const { output } = render(marked, source);
  assert.match(output, /include \/etc\/nginx\/snippets\/memonogi-outfit-upload\.conf;\r\n    location/);
  assert.ok(output.includes('include /root-only/tls.conf;\r\n'));

  const routeEdited = marked.replace('127.0.0.1:13000', '127.0.0.1:13001');
  const tlsEdited = marked.replace('/root-only/tls.conf', '/root-only/other-tls.conf');
  assert.throws(() => render(routeEdited, source), /untouched source plus exactly one marker/);
  assert.throws(() => render(tlsEdited, source), /untouched source plus exactly one marker/);
  assert.throws(() => render(marked.replace(/\r\n/g, '\n'), source), /untouched source plus exactly one marker/);
});

test('managed renderer rejects ambiguous, top-level, non-server, and nested markers', () => {
  const assertRejectedBlock = (marked) => {
    const source = marked.replace(/^\s*# MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\n/m, '');
    assert.throws(() => render(marked, source), /direct child/);
  };
  assertRejectedBlock('# MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\nserver {}\n');
  assertRejectedBlock('upstream app {\n# MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\n}\n');
  assertRejectedBlock('map $x $y {\n# MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\n}\n');
  assertRejectedBlock('server {\nlocation / {\n# MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\n}\n}\n');
  assert.throws(() => render('server {\n# MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\n# MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\n}\n', 'server {}\n'), /exactly one/);
  assert.throws(() => render('server {\ninclude /etc/nginx/snippets/memonogi-outfit-upload.conf;\n# MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY\n}\n', 'server {}\n'), /already contains/);
});

test('managed installer has explicit compare/apply modes and rollback validation', () => {
  const installerPath = fileURLToPath(new URL('../ops/prod2/nginx/install-memonogi-vhost.sh', import.meta.url));
  const installer = readFileSync(installerPath, 'utf8');
  assert.match(installer, /--check\|--apply/);
  assert.match(installer, /target=\/etc\/nginx\/sites-enabled\/memonogi\.conf/);
  assert.match(installer, /cmp -s "\$target" "\$candidate"/);
  assert.match(installer, /\[ ! -L "\$path" \].*Symlinks are not supported/);
  assert.match(installer, /\[ ! -L "\$snippet_target" \].*Symlinks are not supported/);
  assert.match(installer, /source_sha256=\$\(manifest_value source_sha256\)/);
  assert.match(installer, /sha256sum -- "\$1"/);
  assert.ok((installer.match(/verify_hashes/g) ?? []).length >= 3);
  assert.match(installer, /stat -c %a "\$target"/);
  assert.match(installer, /cp -a "\$saved" "\$restore_stage"/);
  assert.match(installer, /mv -f -- "\$snippet_stage" "\$snippet_target"/);
  assert.match(installer, /mv -f -- "\$vhost_stage" "\$target"/);
  assert.match(installer, /nginx -t/);
  assert.match(installer, /restore_previous/);
  assert.ok(installer.indexOf('nginx -t') < installer.indexOf('mv -f -- "$vhost_stage" "$target"'));
  const bash = process.platform === 'win32'
    ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..', 'bin', 'bash.exe')
    : 'bash';
  const syntax = spawnSync(bash, ['-n', installerPath], { encoding: 'utf8' });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('nginx syntax verifier uses a fixed Nginx release and the synthetic fixture', () => {
  let invocation;
  const streams = { stdout: '', stderr: '' };
  const status = run({
    runDocker: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0 };
    },
    stdout: { write: (value) => { streams.stdout += value; } },
    stderr: { write: (value) => { streams.stderr += value; } },
  });

  assert.equal(status, 0);
  assert.equal(invocation.command, 'docker');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio, 'inherit');
  assert.ok(invocation.args.includes('nginx:1.24.0-alpine@sha256:77e5d4a6ad906c5d3793764085706577fa705b1dc6f244ea0241c4b5e2155385'));
  assert.deepEqual(invocation.args.slice(-4), [
    'nginx', '-t', '-c', '/etc/nginx/memonogi/fixtures/outfit-upload-vhost.conf',
  ]);
  assert.match(streams.stdout, /^PASS /);
  assert.equal(streams.stderr, '');
});

test('PR verification requires the real pinned-image nginx syntax check', () => {
  const workflow = read('.github/workflows/pr-verify.yml');
  assert.match(workflow, /- run: node scripts\/verify-nginx\.mjs/);
  assert.ok(workflow.indexOf('node scripts/verify-nginx.mjs') < workflow.indexOf('node scripts/verify.mjs'));
});
