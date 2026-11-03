#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

for name in PROD2_HOST PROD2_USER PROD2_SSH_PORT PROD2_SSH_PRIVATE_KEY PROD2_HOST_FINGERPRINT; do
  [[ -n ${!name:-} ]] || { echo "Missing $name" >&2; exit 1; }
done
[[ $PROD2_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid production host' >&2; exit 1; }
[[ $PROD2_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Invalid production user' >&2; exit 1; }
[[ $PROD2_SSH_PORT == 46232 ]] || { echo 'Invalid production SSH port' >&2; exit 1; }
[[ $PROD2_HOST_FINGERPRINT =~ ^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$ ]] || { echo 'Invalid production host fingerprint' >&2; exit 1; }
[[ -s docker-compose-prod2.yml && -d ops/prod2 ]] || { echo 'Production transfer sources are missing' >&2; exit 1; }

work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/infra-prod2-transfer.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$PROD2_SSH_PRIVATE_KEY" >"$work/key"
chmod 600 "$work/key"

scan_ok=0
for attempt in 1 2 3; do
  if ssh-keyscan -T 15 -p "$PROD2_SSH_PORT" -t ed25519 "$PROD2_HOST" >"$work/known_hosts" 2>"$work/scan.log" &&
     awk 'NF != 3 || $2 != "ssh-ed25519" { bad=1 } END { exit (bad || NR != 1) }' "$work/known_hosts"; then
    scan_ok=1
    break
  fi
  if [[ $attempt -lt 3 ]]; then sleep 5; fi
done
[[ $scan_ok == 1 ]] || { echo 'Host key scan failed after bounded retries' >&2; exit 1; }
chmod 600 "$work/known_hosts"
fingerprint=$(ssh-keygen -E sha256 -lf "$work/known_hosts" 2>"$work/scan.log") || { echo 'Host key validation failed' >&2; exit 1; }
[[ $fingerprint == "256 $PROD2_HOST_FINGERPRINT "*' (ED25519)' ]] || { echo 'Host key validation failed' >&2; exit 1; }

opts=(-i "$work/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$work/known_hosts" -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519 -o ConnectTimeout=15 -o ConnectionAttempts=2 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)
destination="$PROD2_USER@$PROD2_HOST"

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

retry_transfer 'Remote staging preparation' ssh "${opts[@]}" -p "$PROD2_SSH_PORT" "$destination" 'mkdir -p /opt/infra/incoming2/ops'
retry_transfer 'Compose transfer' scp -P "$PROD2_SSH_PORT" "${opts[@]}" docker-compose-prod2.yml "$destination:/opt/infra/incoming2/docker-compose-prod2.yml"
retry_transfer 'Operations transfer' scp -P "$PROD2_SSH_PORT" "${opts[@]}" -r ops/prod2 "$destination:/opt/infra/incoming2/ops/"
