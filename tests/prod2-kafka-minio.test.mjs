import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const compose = readFileSync(new URL('../docker-compose-prod2.yml', import.meta.url), 'utf8');
const nginx = readFileSync(new URL('../ops/prod2/nginx/storage-minio.conf', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../ops/prod2/nginx/install-storage-minio.sh', import.meta.url), 'utf8');

function service(name, next) {
  const pattern = new RegExp(`\\n  ${name}:\\r?\\n([\\s\\S]*?)\\r?\\n  ${next}:`);
  return compose.match(pattern)?.[1] ?? '';
}

test('prod2 Kafka uses internal service discovery and loopback-only diagnostics', () => {
  const kafka = service('kafka', 'kafka-init');
  assert.match(kafka, /image: \$\{KAFKA_IMAGE\}/);
  assert.match(kafka, /127\.0\.0\.1:9102:9102/);
  assert.match(kafka, /INTERNAL:\/\/kafka:29092,EXTERNAL:\/\/localhost:9102/);
  assert.match(kafka, /\/opt\/kafka\/data:\/var\/lib\/kafka\/data/);
  assert.match(kafka, /KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"/);
  assert.match(kafka, /kafka-topics --bootstrap-server localhost:29092 --list/);
  assert.doesNotMatch(kafka, /172\.30\.|119\.194\.|memonogi\.com:9102/);
});

test('Kafka init creates only the active production topics', () => {
  const init = service('kafka-init', 'kafka-ui');
  assert.match(init, /profiles: \["bootstrap"\]/);
  assert.match(init, /command:\r?\n\s+- \|/);
  for (const topic of ['USER_INFO_UPDATE_EVENT', 'USER_VERIFICATION_VERIFY_EVENT', 'USER_INFO_UPDATE_EVENT.DLT']) {
    assert.match(init, new RegExp(topic.replace('.', '\\.')));
  }
  assert.doesNotMatch(init, /USER_INFO_UPDATE_EVENT-dlt|test-topic|test2|test3/);
  assert.match(init, /--partitions 1 --replication-factor 1/);
});

test('Kafka UI and MinIO host ports are IPv4 loopback only', () => {
  const kafkaUi = service('kafka-ui', 'minio');
  const minio = service('minio', 'minio-init');
  assert.match(kafkaUi, /127\.0\.0\.1:\$\{KAFKA_UI_PORT\}:\$\{KAFKA_UI_PORT\}/);
  assert.match(minio, /127\.0\.0\.1:9001:9001/);
  assert.match(minio, /127\.0\.0\.1:9000:9000/);
  assert.match(minio, /MC_HOST_health=/);
  assert.match(minio, /mc ready health/);
  assert.doesNotMatch(minio, /mc alias set[^\n]*(?:ROOT_USER|ROOT_PASSWORD)/);
  assert.doesNotMatch(minio, /healthcheck:[\s\S]*?\bcurl\b/);
  assert.doesNotMatch(`${kafkaUi}\n${minio}`, /\n\s+- "(?:9000|9001|9112):/);
});

test('MinIO init creates isolated users, buckets, policies, and public Auth downloads', () => {
  const init = service('minio-init', 'autoheal');
  assert.match(init, /image: \$\{MINIO_IMAGE\}/);
  assert.match(init, /profiles: \["bootstrap"\]/);
  assert.match(init, /command:\r?\n\s+- \|/);
  assert.match(init, /mc mb --ignore-existing "prod\/\$\$AUTH_MINIO_BUCKET"/);
  assert.match(init, /mc mb --ignore-existing "prod\/\$\$COMMUNITY_MINIO_BUCKET"/);
  assert.match(init, /mc anonymous set download "prod\/\$\$AUTH_MINIO_BUCKET"/);
  assert.match(init, /mc anonymous set none "prod\/\$\$COMMUNITY_MINIO_BUCKET"/);
  assert.match(init, /mc admin policy attach prod auth-profile-rw --user "\$\$AUTH_MINIO_ACCESS_KEY"/);
  assert.match(init, /mc admin policy attach prod community-media-rw --user "\$\$COMMUNITY_MINIO_ACCESS_KEY"/);
  assert.match(init, /"Action":\["s3:GetBucketLocation","s3:ListBucket"\].*\$\$COMMUNITY_MINIO_BUCKET/);
  assert.match(init, /policy create overwrites an existing named policy/);
  assert.match(init, /printf '%s\\n%s\\n' "\$\$AUTH_MINIO_ACCESS_KEY" "\$\$AUTH_MINIO_SECRET_KEY" \| mc admin user add prod/);
  assert.match(init, /printf '%s\\n%s\\n' "\$\$COMMUNITY_MINIO_ACCESS_KEY" "\$\$COMMUNITY_MINIO_SECRET_KEY" \| mc admin user add prod/);
  assert.doesNotMatch(init, /mc admin user add prod[^\n]*(?:ACCESS_KEY|SECRET_KEY)/);
  assert.doesNotMatch(init, /mc alias set[^\n]*(?:ROOT_USER|ROOT_PASSWORD)/);
  assert.doesNotMatch(init, /echo[^\n]*(?:PASSWORD|SECRET|ACCESS_KEY)/);
});

test('storage vhost preserves S3 Host and proxies only to loopback MinIO', () => {
  assert.match(nginx, /server_name storage\.memonogi\.com/);
  assert.match(nginx, /proxy_set_header Host \$http_host/);
  assert.match(nginx, /ignore_invalid_headers off/);
  assert.match(nginx, /chunked_transfer_encoding off/);
  assert.match(nginx, /proxy_request_buffering off/);
  assert.match(nginx, /proxy_buffering off/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:9001/);
  assert.doesNotMatch(nginx, /proxy_pass[^\n]*(?:172\.30\.|119\.194\.)/);
});

test('storage vhost installer validates and restores on failure', () => {
  assert.match(installer, /\[ "\$\(id -u\)" -ne 0 \]/);
  assert.match(installer, /nginx -t/);
  assert.match(installer, /openssl x509 -in "\$1" -noout -checkhost storage\.memonogi\.com/);
  assert.match(installer, /previous-state/);
  assert.match(installer, /restore_previous/);
  assert.match(installer, /nginx -t -c "\$candidate_main"/);
  assert.match(installer, /mv -f -- "\$stage" "\$target"/);
  assert.match(installer, /trap on_exit EXIT HUP INT TERM/);
  assert.ok(installer.indexOf('nginx -t -c "$candidate_main"') < installer.indexOf('mv -f -- "$stage" "$target"'));
  assert.match(installer, /systemctl reload nginx/);
  assert.doesNotMatch(installer, /rm -rf|systemctl (?:enable|start)/);
});
