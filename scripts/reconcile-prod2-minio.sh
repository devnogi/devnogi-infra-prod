#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ ${GITHUB_REPOSITORY:-} == devnogi/devnogi-infra-prod ]] || { echo 'Invalid repository' >&2; exit 1; }
[[ ${GITHUB_REF:-} == refs/heads/main && ${GITHUB_EVENT_NAME:-} == workflow_dispatch ]] || { echo 'MinIO reconciliation requires a main dispatch' >&2; exit 1; }
[[ ${GITHUB_SHA:-} =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid production revision' >&2; exit 1; }
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]] || { echo 'Invalid workflow identity' >&2; exit 1; }

for name in PROD_HOST PROD_USER PROD_SSH_PORT PROD_SSH_PRIVATE_KEY PROD_HOST_FINGERPRINT; do
  [[ -n ${!name:-} ]] || { echo "Missing $name" >&2; exit 1; }
done
[[ $PROD_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid production host' >&2; exit 1; }
[[ $PROD_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Invalid production user' >&2; exit 1; }
[[ $PROD_SSH_PORT == 46232 ]] || { echo 'Invalid production SSH port' >&2; exit 1; }
[[ $PROD_HOST_FINGERPRINT =~ ^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$ ]] || { echo 'Invalid production host fingerprint' >&2; exit 1; }
grep -Fq '"s3:GetBucketLocation","s3:ListBucket"' docker-compose-prod2.yml || { echo 'Community bucket policy contract is missing' >&2; exit 1; }

work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/infra-prod2-minio.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$PROD_SSH_PRIVATE_KEY" > "$work/key"
chmod 600 "$work/key"

scan_ok=0
for attempt in 1 2 3; do
  if ssh-keyscan -T 15 -p "$PROD_SSH_PORT" -t ed25519 "$PROD_HOST" > "$work/known_hosts" 2> "$work/scan.log" &&
     awk 'NF != 3 || $2 != "ssh-ed25519" { bad=1 } END { exit (bad || NR != 1) }' "$work/known_hosts"; then
    scan_ok=1
    break
  fi
  if [[ $attempt -lt 3 ]]; then sleep 5; fi
done
[[ $scan_ok == 1 ]] || { echo 'Host key scan failed after bounded retries' >&2; exit 1; }
chmod 600 "$work/known_hosts"
fingerprint=$(ssh-keygen -E sha256 -lf "$work/known_hosts" 2> "$work/scan.log") || { echo 'Host key validation failed' >&2; exit 1; }
[[ $fingerprint == "256 $PROD_HOST_FINGERPRINT "*' (ED25519)' ]] || { echo 'Host key validation failed' >&2; exit 1; }

cat > "$work/reconcile.sh" <<'REMOTE_SCRIPT'
set -Eeuo pipefail
umask 077
expected_revision=$1
[[ $expected_revision =~ ^[0-9a-f]{40}$ ]]
cd /opt/infra
[[ -s docker-compose-prod2.yml && -s .env.infra2 && -s .last-deployed-prod2-sha ]]
[[ $(<.last-deployed-prod2-sha) == "$expected_revision" ]]
grep -Fq '"s3:GetBucketLocation","s3:ListBucket"' docker-compose-prod2.yml

exec 9>.deploy-prod2.lock
flock -w 30 9
project=$(docker compose --project-directory /opt/infra -f docker-compose-prod2.yml --env-file .env.infra2 config --format json |
  python3 -c 'import json, sys; value=json.load(sys.stdin).get("name"); print(value if isinstance(value, str) else "")')
[[ $project =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]

log=$(mktemp /tmp/prod2-minio-reconcile.XXXXXXXX.log)
trap 'rm -f "$log"' EXIT
if ! docker compose --project-name "$project" --project-directory /opt/infra -f docker-compose-prod2.yml --env-file .env.infra2 --profile bootstrap run --rm --no-deps --pull never minio-init > "$log" 2>&1; then
  echo 'MinIO policy reconciliation failed' >&2
  exit 1
fi
echo 'MinIO policy reconciliation verified'
REMOTE_SCRIPT

opts=(-i "$work/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$work/known_hosts" -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519 -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ConnectionAttempts=2 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)
destination="$PROD_USER@$PROD_HOST"
if ! ssh "${opts[@]}" -p "$PROD_SSH_PORT" "$destination" bash -s -- "$GITHUB_SHA" < "$work/reconcile.sh" > "$work/ssh.log" 2>&1; then
  echo 'Remote MinIO policy reconciliation failed' >&2
  exit 1
fi
grep -qx 'MinIO policy reconciliation verified' "$work/ssh.log" || { echo 'MinIO policy verification result missing' >&2; exit 1; }
echo 'prod2 Community MinIO policy reconciled'
