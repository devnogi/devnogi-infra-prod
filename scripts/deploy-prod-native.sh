#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

server=${1:-}
revision=${2:-}
[[ $server == 1 || $server == 2 ]] || { echo 'Invalid production server number' >&2; exit 1; }
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid production revision' >&2; exit 1; }

for name in PROD_HOST PROD_USER PROD_SSH_PORT PROD_SSH_PRIVATE_KEY PROD_HOST_FINGERPRINT PROD_ENV_FILE; do
  [[ -n ${!name:-} ]] || { echo "Missing $name" >&2; exit 1; }
done
[[ $PROD_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid production host' >&2; exit 1; }
[[ $PROD_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Invalid production user' >&2; exit 1; }
[[ $PROD_SSH_PORT =~ ^[0-9]{1,5}$ ]] && (( PROD_SSH_PORT >= 1 && PROD_SSH_PORT <= 65535 )) || { echo 'Invalid production SSH port' >&2; exit 1; }
[[ $PROD_HOST_FINGERPRINT =~ ^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$ ]] || { echo 'Invalid production host fingerprint' >&2; exit 1; }

compose="docker-compose-prod${server}.yml"
[[ -s $compose && -s scripts/deploy-prod.sh ]] || { echo 'Production deployment sources are missing' >&2; exit 1; }
if [[ $server == 2 ]]; then
  [[ -d ops/prod2 ]] || { echo 'Production operations package is missing' >&2; exit 1; }
fi

work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/infra-prod${server}-deploy.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$PROD_SSH_PRIVATE_KEY" >"$work/key"
printf '%s\n' "$PROD_ENV_FILE" >"$work/.next-env-infra${server}"
chmod 600 "$work/key" "$work/.next-env-infra${server}"

scan_ok=0
for attempt in 1 2 3; do
  if ssh-keyscan -T 15 -p "$PROD_SSH_PORT" -t ed25519 "$PROD_HOST" >"$work/known_hosts" 2>"$work/scan.log" &&
     awk 'NF != 3 || $2 != "ssh-ed25519" { bad=1 } END { exit (bad || NR != 1) }' "$work/known_hosts"; then
    scan_ok=1
    break
  fi
  if [[ $attempt -lt 3 ]]; then sleep 5; fi
done
[[ $scan_ok == 1 ]] || { echo 'Host key scan failed after bounded retries' >&2; exit 1; }
chmod 600 "$work/known_hosts"
fingerprint=$(ssh-keygen -E sha256 -lf "$work/known_hosts" 2>"$work/scan.log") || { echo 'Host key validation failed' >&2; exit 1; }
[[ $fingerprint == "256 $PROD_HOST_FINGERPRINT "*' (ED25519)' ]] || { echo 'Host key validation failed' >&2; exit 1; }

opts=(-i "$work/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$work/known_hosts" -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519 -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ConnectionAttempts=2 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)
destination="$PROD_USER@$PROD_HOST"
incoming="/opt/infra/incoming${server}"
staging_command="mkdir -p '$incoming' && chmod 700 '$incoming'"
if [[ $server == 2 ]]; then staging_command="mkdir -p '$incoming/ops' && chmod 700 '$incoming' '$incoming/ops'"; fi

retry_transfer() {
  local label=$1 attempt
  shift
  for attempt in 1 2 3; do
    if "$@" >"$work/ssh.log" 2>&1; then return 0; fi
    if [[ $attempt -lt 3 ]]; then sleep 5; fi
  done
  echo "$label failed after bounded retries" >&2
  return 1
}

retry_transfer 'Remote staging preparation' ssh "${opts[@]}" -p "$PROD_SSH_PORT" "$destination" "$staging_command"
retry_transfer 'Compose transfer' scp -P "$PROD_SSH_PORT" "${opts[@]}" "$compose" "$destination:$incoming/$compose"
retry_transfer 'Environment transfer' scp -P "$PROD_SSH_PORT" "${opts[@]}" "$work/.next-env-infra${server}" "$destination:$incoming/.next-env-infra${server}"
retry_transfer 'Deployment script transfer' scp -P "$PROD_SSH_PORT" "${opts[@]}" scripts/deploy-prod.sh "$destination:$incoming/deploy-prod.sh"
if [[ $server == 2 ]]; then
  retry_transfer 'Operations transfer' scp -P "$PROD_SSH_PORT" "${opts[@]}" -r ops/prod2 "$destination:$incoming/ops/"
fi
retry_transfer 'Remote staging permissions' ssh "${opts[@]}" -p "$PROD_SSH_PORT" "$destination" "chmod 600 '$incoming/.next-env-infra${server}' && chmod 700 '$incoming/deploy-prod.sh'"

if ! ssh "${opts[@]}" -p "$PROD_SSH_PORT" "$destination" "bash '$incoming/deploy-prod.sh' '$server' '$revision'" >"$work/deploy.log" 2>&1; then
  sed -E 's/(PASSWORD|SECRET|TOKEN|KEY)=[^[:space:]]+/\1=<redacted>/g' "$work/deploy.log" >&2
  echo 'Remote production deployment failed' >&2
  exit 1
fi
cat "$work/deploy.log"
