import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const server of [1, 2]) {
  test(`server ${server} production deployment is main-only and recoverable`, () => {
    const workflow = readFileSync(new URL(`../.github/workflows/deploy-prod${server}.yml`, import.meta.url), 'utf8');
    assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
    assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
    assert.doesNotMatch(workflow, /refs\/heads\/dev/);
    assert.match(workflow, new RegExp(`group: infra-production-server${server}`));
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /runs-on: ubuntu-24\.04/);
    assert.match(workflow, new RegExp(`run: bash scripts/deploy-prod-native\\.sh ${server} "\\$GITHUB_SHA" "\\$GITHUB_RUN_ID-\\$GITHUB_RUN_ATTEMPT"`));
    assert.match(workflow, /timeout-minutes: 15/);
    assert.match(workflow, new RegExp(`PROD_HOST: \\$\\{\\{ secrets\\.PROD${server}_HOST \\}\\}`));
    assert.match(workflow, new RegExp(`PROD_HOST_FINGERPRINT: \\$\\{\\{ secrets\\.PROD${server}_HOST_FINGERPRINT \\}\\}`));
    assert.doesNotMatch(workflow, /appleboy\/(?:scp|ssh)-action/);
    assert.doesNotMatch(workflow, /down\s+-v|volume\s+rm|image prune/);
  });
}

test('shared native deployment scripts keep strict host verification and rollback invariants', () => {
  const runner = readFileSync(new URL('../scripts/deploy-prod-native.sh', import.meta.url), 'utf8');
  const remote = readFileSync(new URL('../scripts/deploy-prod.sh', import.meta.url), 'utf8');
  assert.match(runner, /ssh-keyscan[^\n]+-t ed25519/);
  assert.match(runner, /StrictHostKeyChecking=yes/);
  assert.match(runner, /HostKeyAlgorithms=ssh-ed25519/);
  assert.match(runner, /IdentitiesOnly=yes/);
  assert.doesNotMatch(runner, /StrictHostKeyChecking=(?:no|accept-new)/);
  assert.match(runner, /\.deploy-staging\/prod\$\{server\}-\$\{revision\}-\$\{run\}/);
  assert.match(runner, /DEPLOY_RESULT=SUCCESS/);
  assert.match(runner, /test -f '\$state\/finished'/);
  assert.match(remote, /watchdog_main/);
  assert.match(remote, /record_result ROLLED_BACK/);
  assert.match(remote, /cp "\$state_dir\/previous-compose\.yml" "\$root\/\$compose"/);
  assert.match(remote, /cp "\$state_dir\/previous-env" "\$root\/\$env_file"/);
  assert.match(remote, /validate_service_transition "\$state_dir\/current-render\/images\.map" "\$state_dir\/candidate-render\/images\.map"/);
  assert.match(remote, /validate_prod2_bootstrap_contract/);
  assert.match(remote, /validate_profile_continuity/);
  assert.match(remote, /--profile bootstrap run --rm --no-deps --pull never "\$service"/);
  assert.match(remote, /rm -f -s \$services/);
  assert.match(remote, /runtime_resources_reproduce_render/);
  assert.match(remote, /for entry do/);
  assert.doesNotMatch(remote, /command -v find|\$\(find /);
  assert.match(remote, /cmp -s "\$state_dir\/current-render\/resources\/\$service" "\$state_dir\/candidate-render\/resources\/\$service"/);
  assert.match(remote, /incoming2\/ops\/prod2/);
  assert.match(remote, /renameat2/);
  assert.match(remote, /candidate-render\/ports/);
  assert.match(remote, /previous-ports/);
  assert.match(remote, /same_runtime "\$state_dir\/candidate-render\/resources" "\$state_dir\/candidate-render\/ports" normalized/);
  assert.match(remote, /same_runtime "\$state_dir\/current-render\/resources" "\$state_dir\/previous-ports" exact/);
  const commitReady = remote.indexOf('record_commit_ready', remote.indexOf('printf \'%s\\n\' "$revision"'));
  const ackCheck = remote.indexOf('[[ $ack_seen == 1 ]]', commitReady);
  const releaseLock = remote.indexOf('exec 9>&-', ackCheck);
  const disarmSignals = remote.indexOf('trap - HUP INT TERM', releaseLock);
  const successResult = remote.indexOf('record_result SUCCESS', disarmSignals);
  const disarmError = remote.indexOf('trap - ERR', successResult);
  const waitForWatchdog = remote.indexOf('wait "$watchdog_pid"', disarmError);
  assert.ok(commitReady < ackCheck && ackCheck < releaseLock && releaseLock < disarmSignals && disarmSignals < successResult && successResult < disarmError && disarmError < waitForWatchdog);
  assert.match(remote, /--pull never/);
  assert.match(remote, /rollback_ready/);
  assert.match(remote, /candidate_ready/);
  assert.doesNotMatch(remote, /down\s+-v|volume\s+rm|image prune/);
  assert.doesNotMatch(remote, /sudo\s+sh\s+.*ops\/prod2\/install-logging\.sh/);
  assert.doesNotMatch(remote, /systemctl\s+(?:enable|start).*memonogi-(?:db-backup|drive-upload)\.timer/);
});

test('prod2 MinIO reconciliation is main-only, pinned, and lock-protected', () => {
  const workflow = readFileSync(new URL('../.github/workflows/reconcile-prod2-minio.yml', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../scripts/reconcile-prod2-minio.sh', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /group: infra-production-server2/);
  assert.match(workflow, /run: bash scripts\/reconcile-prod2-minio\.sh/);
  assert.match(workflow, /PROD_HOST_FINGERPRINT: \$\{\{ secrets\.PROD2_HOST_FINGERPRINT \}\}/);
  assert.match(script, /ssh-keyscan[^\n]+-t ed25519/);
  assert.match(script, /StrictHostKeyChecking=yes/);
  assert.match(script, /HostKeyAlgorithms=ssh-ed25519/);
  assert.match(script, /IdentitiesOnly=yes/);
  assert.match(script, /\.last-deployed-prod2-sha/);
  assert.match(script, /exec 9>\.deploy-prod2\.lock/);
  assert.match(script, /flock -w 30 9/);
  assert.match(script, /"s3:GetBucketLocation","s3:ListBucket"/);
  assert.match(script, /--profile bootstrap run --rm --no-deps --pull never minio-init/);
  assert.equal(Buffer.from(script).includes(13), false);
  assert.doesNotMatch(script, /StrictHostKeyChecking=(?:no|accept-new)|down\s+-v|volume\s+rm|image prune/);
});

test('prod1 Kafka keeps the proven private bind and restart policy', () => {
  const compose = readFileSync(new URL('../docker-compose-prod1.yml', import.meta.url), 'utf8');
  const kafka = compose.match(/\r?\n  kafka:\r?\n([\s\S]*?)\r?\n  kafka-ui:/)?.[1] ?? '';
  assert.match(kafka, /restart: unless-stopped/);
  assert.match(kafka, /"172\.30\.1\.27:9102:9102"/);
  assert.doesNotMatch(kafka, /\n\s*- "9102:9102"/);
});

test('the prod2 logging runbook keeps privileged activation explicit and verifiable', () => {
  const runbook = readFileSync(new URL('../docs/prod2-logging.md', import.meta.url), 'utf8');
  assert.match(runbook, /sudo sh incoming2\/ops\/prod2\/install-logging\.sh/);
  assert.match(runbook, /원자적으로 승격/);
  assert.match(runbook, /sudo systemctl restart rsyslog/);
  assert.match(runbook, /sudo rsyslogd -N1/);
  assert.match(runbook, /LogConfig\.Type/);
  assert.match(runbook, /memonogi-(?:db-backup|drive-upload)\.timer/);
  assert.match(runbook, /bash -o pipefail/);
  assert.match(runbook, /gzip -t "\$capture"/);
  assert.doesNotMatch(runbook, /gzip -t[^\n]*\*/);
});

test('the logging-only installer has no backup runtime dependency or timer side effect', () => {
  const installer = readFileSync(new URL('../ops/prod2/install-logging.sh', import.meta.url), 'utf8');
  assert.match(installer, /for service in auth community batch gateway react/);
  assert.match(installer, /"\/var\/log\/memonogi\/\$service"/);
  assert.match(installer, /\/etc\/rsyslog\.d\/30-memonogi\.conf/);
  assert.match(installer, /\/etc\/logrotate\.d\/memonogi/);
  assert.doesNotMatch(installer, /\b(?:node|rclone|docker|mysql)\b/);
  assert.doesNotMatch(installer, /memonogi-(?:db-backup|drive-upload)\.timer|systemctl\s+(?:enable|start)/);
  assert.doesNotMatch(installer, /systemctl\s+restart\s+rsyslog/);
  assert.match(installer, /chown syslog:adm "\$log_file"/);
  assert.match(installer, /chmod 0640 "\$log_file"/);
});

test('the repository README links the prod2 logging runbook', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /\[prod2 로그 설정\]\(docs\/prod2-logging\.md\)/);
});

test('prod2 Linux operations files use LF line endings', () => {
  const directory = new URL('../ops/prod2/', import.meta.url);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const content = readFileSync(new URL(entry.name, directory));
    assert.equal(content.includes(13), false, `${entry.name} contains a CR byte`);
  }
});

test('rsyslog creates every application log as syslog:adm mode 0640', () => {
  const config = readFileSync(new URL('../ops/prod2/rsyslog.conf', import.meta.url), 'utf8');
  const actions = config.match(/action\(type="omfile"[^\n]+\)/g) ?? [];
  assert.equal(actions.length, 5);
  for (const action of actions) {
    assert.match(action, /fileOwner="syslog"/);
    assert.match(action, /fileGroup="adm"/);
    assert.match(action, /fileCreateMode="0640"/);
  }
});

test('rsyslog strictly matches Docker RFC5424 APP-NAME after journald forwarding', () => {
  const config = readFileSync(new URL('../ops/prod2/rsyslog.conf', import.meta.url), 'utf8');
  for (const service of ['auth', 'community', 'batch', 'gateway', 'react']) {
    const tag = `memonogi-${service}`;
    const condition = `if ($programname == '${tag}' or re_match($rawmsg, '^<[0-9]+>1 [^ ]+ [^ ]+ ${tag} ')) then {`;
    assert.ok(config.includes(condition), `missing strict RFC5424 APP-NAME match for ${tag}`);
  }
  assert.equal(config.match(/re_match\(\$rawmsg, '\^<\[0-9\]\+>1 /g)?.length, 5);
  assert.doesNotMatch(config, /\bcontains\b/);
});
