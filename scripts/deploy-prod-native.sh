#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

server=${1:-}
revision=${2:-}
run=${3:-}
[[ $server == 1 || $server == 2 ]] || { echo 'Invalid production server number' >&2; exit 1; }
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid production revision' >&2; exit 1; }
[[ $run =~ ^[0-9]+-[0-9]+$ ]] || { echo 'Invalid production run identity' >&2; exit 1; }

for name in PROD_HOST PROD_USER PROD_SSH_PORT PROD_SSH_PRIVATE_KEY PROD_HOST_FINGERPRINT PROD_ENV_FILE; do
  [[ -n ${!name:-} ]] || { echo "Missing $name" >&2; exit 1; }
done
[[ $PROD_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid production host' >&2; exit 1; }
[[ $PROD_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Invalid production user' >&2; exit 1; }
[[ $PROD_SSH_PORT =~ ^[0-9]{1,5}$ ]] && (( PROD_SSH_PORT >= 1 && PROD_SSH_PORT <= 65535 )) || { echo 'Invalid production SSH port' >&2; exit 1; }
[[ $PROD_HOST_FINGERPRINT =~ ^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$ ]] || { echo 'Invalid production host fingerprint' >&2; exit 1; }

compose="docker-compose-prod${server}.yml"
[[ -s $compose && -s scripts/deploy-prod.sh ]] || { echo 'Production deployment sources are missing' >&2; exit 1; }
if [[ $server == 2 ]]; then [[ -d ops/prod2 ]] || { echo 'Production operations package is missing' >&2; exit 1; }; fi

work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/infra-prod${server}-deploy.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$PROD_SSH_PRIVATE_KEY" >"$work/key"
printf '%s\n' "$PROD_ENV_FILE" >"$work/$compose.env"
chmod 600 "$work/key" "$work/$compose.env"

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
stage="/opt/infra/.deploy-staging/prod${server}-${revision}-${run}"
inputs="$stage/inputs"
state="$stage/state"

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

retry_transfer 'Remote immutable staging preparation' ssh "${opts[@]}" -p "$PROD_SSH_PORT" "$destination" "umask 077; mkdir -p '/opt/infra/.deploy-staging'; mkdir '$stage'; mkdir '$inputs' '$state'"
retry_transfer 'Compose transfer' scp -P "$PROD_SSH_PORT" "${opts[@]}" "$compose" "$destination:$inputs/$compose"
retry_transfer 'Environment transfer' scp -P "$PROD_SSH_PORT" "${opts[@]}" "$work/$compose.env" "$destination:$inputs/.env.infra${server}"
retry_transfer 'Deployment script transfer' scp -P "$PROD_SSH_PORT" "${opts[@]}" scripts/deploy-prod.sh "$destination:$inputs/deploy-prod.sh"
if [[ $server == 2 ]]; then
  retry_transfer 'Operations transfer' ssh "${opts[@]}" -p "$PROD_SSH_PORT" "$destination" "mkdir '$inputs/ops'"
  retry_transfer 'Operations package transfer' scp -P "$PROD_SSH_PORT" "${opts[@]}" -r ops/prod2 "$destination:$inputs/ops/"
fi
retry_transfer 'Immutable staging permissions' ssh "${opts[@]}" -p "$PROD_SSH_PORT" "$destination" "chmod -R go-rwx '$stage'; chmod 500 '$inputs'; find '$inputs' -type d -exec chmod 500 {} +; find '$inputs' -type f -exec chmod 400 {} +; chmod 700 '$state'"

set +e
ssh "${opts[@]}" -p "$PROD_SSH_PORT" "$destination" "nohup env DEPLOY_WATCHDOG_SECONDS='${DEPLOY_WATCHDOG_SECONDS:-600}' bash '$inputs/deploy-prod.sh' rollout '$server' '$revision' '$stage' </dev/null >'$stage/remote.log' 2>&1 &" >"$work/launch.log" 2>&1
launch_status=$?
set -e

result=
poll_attempts=${DEPLOY_POLL_ATTEMPTS:-150}
poll_interval=${DEPLOY_POLL_INTERVAL_SECONDS:-5}
[[ $poll_attempts =~ ^[1-9][0-9]{0,2}$ && $poll_attempts -le 300 ]]
[[ $poll_interval =~ ^[0-9]$ ]]
for _ in $(seq 1 "$poll_attempts"); do
  result=$(ssh "${opts[@]}" -p "$PROD_SSH_PORT" "$destination" "test ! -f '$state/result' || cat '$state/result'" 2>/dev/null) || true
  [[ -z $result ]] || break
  sleep "$poll_interval"
done

cleanup_stage() {
  ssh "${opts[@]}" -p "$PROD_SSH_PORT" "$destination" "rm -rf '$stage'" >/dev/null 2>&1 || true
}

case $result in
  DEPLOY_RESULT=SUCCESS)
    cleanup_stage
    echo "Production deployment verified for server $server"
    ;;
  DEPLOY_RESULT=ROLLED_BACK)
    cleanup_stage
    echo 'Production deployment failed; the pre-change runtime was restored' >&2
    exit 1
    ;;
  DEPLOY_RESULT=PREFLIGHT_FAILED)
    cleanup_stage
    echo 'Production deployment preflight failed before mutation' >&2
    exit 1
    ;;
  DEPLOY_RESULT=ROLLBACK_FAILED)
    echo 'Production deployment and rollback verification failed' >&2
    exit 2
    ;;
  *)
    [[ $launch_status -eq 0 ]] || echo 'The launch SSH connection ended before acknowledgement' >&2
    echo 'Production deployment ended without a verified durable result' >&2
    exit 1
    ;;
esac
