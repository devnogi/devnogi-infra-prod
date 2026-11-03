#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

server=${1:-}
revision=${2:-}
[[ $server == 1 || $server == 2 ]] || { echo 'Invalid production server number' >&2; exit 1; }
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid production revision' >&2; exit 1; }

root=${DEPLOY_ROOT:-/opt/infra}
incoming="$root/incoming${server}"
compose="docker-compose-prod${server}.yml"
env_file=".env.infra${server}"
previous_compose=".previous-compose-prod${server}.yml"
previous_env=".previous-env-prod${server}"
previous_images=".previous-images-prod${server}.yml"
previous_readiness=".previous-readiness-prod${server}"
next_env="$incoming/.next-env-infra${server}"

cd "$root"
exec 9>".deploy-prod${server}.lock"
flock -w 60 9 || { echo 'Another production deployment holds the lock' >&2; exit 1; }

test -s "$compose"
test -s "$env_file"
test -s "$incoming/$compose"
test -s "$next_env"
if [[ $server == 2 ]]; then test -s "$incoming/ops/prod2/install-logging.sh"; fi

cp "$compose" "$previous_compose"
cp "$env_file" "$previous_env"
services=$(docker compose -f "$previous_compose" --env-file "$env_file" config --services)
test -n "$services" || { echo 'No services available for rollback' >&2; exit 1; }
printf 'services:\n' >"$previous_images"
: >"$previous_readiness"

container_has_healthcheck() {
  local container=$1 config_json
  config_json=$(docker inspect --format '{{json .Config}}' "$container") || return 1
  printf '%s\n' "$config_json" | grep -Eq '"Healthcheck":\{'
}

container_health() {
  docker inspect --format '{{.State.Health.Status}}' "$1"
}

for service in $services; do
  containers=$(docker compose -f "$previous_compose" --env-file "$env_file" ps --all -q "$service")
  set -- $containers
  [[ $# -eq 1 ]] || { echo "Expected one prior container for $service" >&2; exit 1; }
  container=$1
  state=$(docker inspect --format '{{.State.Status}}' "$container")
  [[ $state == running ]] || { echo "Prior container is not running for $service" >&2; exit 1; }
  if container_has_healthcheck "$container"; then
    health=$(container_health "$container")
    [[ $health == healthy ]] || { echo "Prior container is unhealthy for $service" >&2; exit 1; }
    readiness=healthy
  else
    readiness=running
  fi
  printf '%s|%s\n' "$service" "$readiness" >>"$previous_readiness"

  image=$(docker inspect --format '{{.Image}}' "$container")
  test -n "$image"
  digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image")
  set -- $digests
  [[ $# -eq 1 ]] || { echo "Missing or ambiguous digest for $service" >&2; exit 1; }
  printf '%s\n' "$1" | grep -Eq '@sha256:[0-9a-f]{64}$' || { echo "Invalid digest for $service" >&2; exit 1; }
  printf '  %s:\n    image: "%s"\n' "$service" "$1" >>"$previous_images"
done

candidate_services=$(docker compose --project-directory "$root" -f "$incoming/$compose" --env-file "$next_env" config --services | sort)
test "$(printf '%s\n' "$services" | sort)" = "$candidate_services" || { echo 'Changed service set requires explicit image selection' >&2; exit 1; }
previous_declared_images=$(docker compose -f "$previous_compose" --env-file "$env_file" config --images | sort)
candidate_images=$(docker compose --project-directory "$root" -f "$incoming/$compose" --env-file "$next_env" config --images | sort)
test "$previous_declared_images" = "$candidate_images" || { echo 'Changed image declarations require an explicit digest promotion' >&2; exit 1; }

candidate_ready() {
  local service containers container state health
  for service in $services; do
    containers=$(docker compose -f "$compose" -f "$previous_images" --env-file "$env_file" ps --all -q "$service") || return 1
    set -- $containers
    [[ $# -eq 1 ]] || return 1
    container=$1
    state=$(docker inspect --format '{{.State.Status}}' "$container") || return 1
    [[ $state == running ]] || return 1
    if container_has_healthcheck "$container"; then
      health=$(container_health "$container") || return 1
      [[ $health == healthy ]] || return 1
    fi
  done
}

rollback_ready() {
  local service expected containers container state health
  while IFS='|' read -r service expected; do
    [[ -n $service && -n $expected ]] || return 1
    containers=$(docker compose -f "$compose" -f "$previous_images" --env-file "$env_file" ps --all -q "$service") || return 1
    set -- $containers
    [[ $# -eq 1 ]] || return 1
    container=$1
    state=$(docker inspect --format '{{.State.Status}}' "$container") || return 1
    [[ $state == running ]] || return 1
    if [[ $expected == healthy ]]; then
      container_has_healthcheck "$container" || return 1
      health=$(container_health "$container") || return 1
      [[ $health == healthy ]] || return 1
    elif [[ $expected == running ]]; then
      ! container_has_healthcheck "$container" || return 1
    else
      return 1
    fi
  done <"$previous_readiness"
}

cp "$incoming/$compose" "$compose"
cp "$next_env" "$env_file"
chmod 600 "$env_file"
if docker compose -f "$compose" -f "$previous_images" --env-file "$env_file" up -d --wait --pull never && candidate_ready; then
  printf '%s\n' "$revision" >".last-deployed-prod${server}-sha"
  echo "Production deployment passed for server $server"
  exit 0
fi

cp "$previous_compose" "$compose"
cp "$previous_env" "$env_file"
if docker compose -f "$compose" -f "$previous_images" --env-file "$env_file" up -d --wait --pull never; then
  if rollback_ready; then
    echo 'Rollback readiness verification passed'
  else
    echo 'Rollback readiness verification failed' >&2
  fi
else
  echo 'Rollback failed' >&2
fi
exit 1
