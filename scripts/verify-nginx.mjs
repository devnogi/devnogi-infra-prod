import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nginxDirectory = join(root, 'ops', 'prod2', 'nginx');
const image = 'nginx:1.24.0-alpine@sha256:77e5d4a6ad906c5d3793764085706577fa705b1dc6f244ea0241c4b5e2155385';

export function run({ runDocker = spawnSync, stdout = process.stdout, stderr = process.stderr } = {}) {
  const result = runDocker('docker', [
    'run', '--rm',
    '--mount', `type=bind,source=${nginxDirectory},target=/etc/nginx/memonogi,readonly`,
    image,
    'nginx', '-t', '-c', '/etc/nginx/memonogi/fixtures/outfit-upload-vhost.conf',
  ], { stdio: 'inherit', shell: false });

  if (result.error) {
    stderr.write(`Nginx syntax 검사 환경을 확인하세요: ${result.error.message}\n`);
    return 1;
  }
  if (result.status !== 0) {
    stderr.write(`Nginx syntax 검사 실패 (exit ${result.status})\n`);
    return 1;
  }
  stdout.write('PASS ops/prod2/nginx/outfit-upload-server.conf\n');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
