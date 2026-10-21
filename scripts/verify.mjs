import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'devnogi-compose-verify-'));
const fixture = join(root, 'tests', 'compose.env');
const env = { ...process.env };
for (const line of readFileSync(fixture, 'utf8').split(/\r?\n/)) {
  const match = /^([A-Z_0-9]+)=(.*)$/.exec(line);
  if (match) env[match[1]] = match[2];
}

try {
  copyFileSync(fixture, join(temp, '.env.infra2'));
  for (const file of ['compose.local.yml', 'docker-compose-prod1.yml', 'docker-compose-prod2.yml']) {
    copyFileSync(join(root, file), join(temp, file));
    const result = spawnSync('docker', ['compose', '--project-directory', temp, '--env-file', fixture, '-f', join(temp, file), 'config', '--quiet'], { env, stdio: 'inherit' });
    if (result.error) throw new Error(`Docker Compose 실행 환경을 확인하세요: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${file}: 설정 검증 실패 (exit ${result.status})`);
    process.stdout.write(`PASS ${file}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
