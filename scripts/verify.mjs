import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['compose.local.yml', 'docker-compose-prod1.yml', 'docker-compose-prod2.yml'];
const help = `사용법:
  node scripts/verify.mjs         Compose 설정 검사
  node scripts/verify.mjs --help  도움말 표시

준비 조건: Node.js 20 이상. 실제 설정 검사에는 Docker Compose v2 이상이 필요합니다.
도움말은 Docker 없이 실행할 수 있으며 Docker 데몬은 설정 검사에도 필요하지 않습니다.

검사 파일: ${files.join(', ')}
tests/compose.env의 합성 환경과 임시 디렉터리로 config --quiet만 검사합니다.
실제 .env를 변경하거나 컨테이너를 실행하지 않습니다.
`;

export function run(args = [], { runDocker = spawnSync, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (args.length === 1 && args[0] === '--help') {
    stdout.write(help);
    return 0;
  }
  if (args.length > 0) {
    stderr.write(`알 수 없는 인수: ${args.join(' ')}\n사용법은 node scripts/verify.mjs --help로 확인하세요.\n`);
    return 2;
  }

  let temp;
  try {
    temp = mkdtempSync(join(tmpdir(), 'devnogi-compose-verify-'));
    const fixture = join(root, 'tests', 'compose.env');
    const env = { ...process.env };
    for (const line of readFileSync(fixture, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z_0-9]+)=(.*)$/.exec(line);
      if (match) env[match[1]] = match[2];
    }
    copyFileSync(fixture, join(temp, '.env.infra2'));
    for (const file of files) {
      copyFileSync(join(root, file), join(temp, file));
      const result = runDocker('docker', ['compose', '--project-directory', temp, '--env-file', fixture, '-f', join(temp, file), 'config', '--quiet'], { env, stdio: 'inherit' });
      if (result.error) throw new Error(`Docker Compose 실행 환경을 확인하세요: ${result.error.message}`);
      if (result.status !== 0) throw new Error(`${file}: 설정 검증 실패 (exit ${result.status})`);
      stdout.write(`PASS ${file}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
