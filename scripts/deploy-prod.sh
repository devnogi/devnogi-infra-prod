#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

valid_path() { [[ ${1:-} =~ ^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$ && ${1:-} != *..* ]]; }
valid_service() { [[ ${1:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; }
valid_revision() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]]; }

record_result() {
  local result=$1 temporary
  temporary="$state_dir/result.tmp.$$"
  printf 'DEPLOY_RESULT=%s\n' "$result" >"$temporary"
  mv "$temporary" "$state_dir/result"
}

container_has_healthcheck() {
  local container=$1 config_json
  config_json=$(docker inspect --format '{{json .Config}}' "$container") || return 1
  printf '%s\n' "$config_json" | grep -Eq '"Healthcheck":\{'
}

container_health() {
  docker inspect --format '{{.State.Health.Status}}' "$1"
}

inspect_resources() {
  local container=$1
  {
    docker inspect --format '{{range .Mounts}}M|{{.Type}}|{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}|{{.Destination}}|{{.RW}}{{"\n"}}{{end}}' "$container"
    docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}N|{{$name}}{{"\n"}}{{end}}' "$container"
  } | sed '/^$/d' | sort
}

render_compose() {
  local compose_file=$1 environment_file=$2 output_dir=$3 rendered
  rendered="$output_dir/rendered.json"
  mkdir -p "$output_dir/resources"
  docker compose --project-name "$project" --project-directory "$root" -f "$compose_file" --env-file "$environment_file" config --format json >"$rendered"
  python3 - "$rendered" "$output_dir" <<'PY'
import json, pathlib, re, sys
source, output = sys.argv[1:]
data = json.load(open(source, encoding="utf-8"))
out = pathlib.Path(output)
images = []
healthchecks = []
services = data.get("services", {})
for name in sorted(services):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name):
        raise SystemExit("invalid service name")
    service = services[name]
    image = service.get("image")
    if not isinstance(image, str) or not image:
        raise SystemExit("missing service image")
    images.append(f"{name}|{image}")
    healthcheck = service.get("healthcheck")
    healthchecks.append(f"{name}|{'healthy' if isinstance(healthcheck, dict) and not healthcheck.get('disable', False) else 'running'}")
    resources = []
    for mount in service.get("volumes", []):
        kind = mount.get("type")
        source_name = mount.get("source")
        target = mount.get("target")
        if kind == "volume":
            source_value = data.get("volumes", {}).get(source_name, {}).get("name")
        elif kind == "bind":
            source_value = source_name
        else:
            raise SystemExit("unsupported mount type")
        if not all(isinstance(x, str) and x for x in (source_value, target)):
            raise SystemExit("invalid mount")
        rw = "false" if mount.get("read_only", False) else "true"
        resources.append(f"M|{kind}|{source_value}|{target}|{rw}")
    for network_name in sorted(service.get("networks", {})):
        resolved = data.get("networks", {}).get(network_name, {}).get("name")
        if not isinstance(resolved, str) or not resolved:
            raise SystemExit("invalid network")
        resources.append(f"N|{resolved}")
    (out / "resources" / name).write_text("\n".join(sorted(resources)) + ("\n" if resources else ""), encoding="utf-8")
(out / "images.map").write_text("\n".join(images) + "\n", encoding="utf-8")
(out / "healthchecks.map").write_text("\n".join(healthchecks) + "\n", encoding="utf-8")
PY
}

runtime_ready() {
  local mode=$1 container=$2 state health
  state=$(docker inspect --format '{{.State.Status}}' "$container") || return 1
  [[ $state == running ]] || return 1
  if [[ $mode == healthy ]]; then
    container_has_healthcheck "$container" || return 1
    health=$(container_health "$container") || return 1
    [[ $health == healthy ]]
  elif [[ $mode == running ]]; then
    ! container_has_healthcheck "$container"
  else
    return 1
  fi
}

same_runtime() {
  local service container expected_image actual_resources
  while IFS='|' read -r service expected_image; do
    valid_service "$service" && [[ $expected_image =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    container=$(docker compose --project-name "$project" -f "$root/$compose" -f "$state_dir/previous-images.yml" --env-file "$root/$env_file" ps --all -q "$service") || return 1
    [[ -n $container && $container != *$'\n'* ]] || return 1
    [[ $(docker inspect --format '{{.Image}}' "$container") == "$expected_image" ]] || return 1
    actual_resources="$state_dir/current-resources/$service"
    inspect_resources "$container" >"$actual_resources"
    cmp -s "$state_dir/previous-resources/$service" "$actual_resources" || return 1
  done <"$state_dir/previous-image-ids.map"
}

candidate_ready() {
  local service previous_mode container candidate_mode
  while IFS='|' read -r service previous_mode; do
    valid_service "$service" || return 1
    container=$(docker compose --project-name "$project" -f "$root/$compose" -f "$state_dir/previous-images.yml" --env-file "$root/$env_file" ps --all -q "$service") || return 1
    [[ -n $container && $container != *$'\n'* ]] || return 1
    if container_has_healthcheck "$container"; then candidate_mode=healthy; else candidate_mode=running; fi
    [[ $previous_mode != healthy || $candidate_mode == healthy ]] || return 1
    runtime_ready "$candidate_mode" "$container" || return 1
  done <"$state_dir/previous-readiness"
  same_runtime
}

rollback_ready() {
  local service expected container
  while IFS='|' read -r service expected; do
    valid_service "$service" || return 1
    container=$(docker compose --project-name "$project" -f "$root/$compose" -f "$state_dir/previous-images.yml" --env-file "$root/$env_file" ps --all -q "$service") || return 1
    [[ -n $container && $container != *$'\n'* ]] || return 1
    runtime_ready "$expected" "$container" || return 1
  done <"$state_dir/previous-readiness"
  same_runtime
}

load_state() {
  server=$(<"$state_dir/server")
  revision=$(<"$state_dir/revision")
  project=$(<"$state_dir/project")
  root=$(<"$state_dir/root")
  compose="docker-compose-prod${server}.yml"
  env_file=".env.infra${server}"
  [[ $server == 1 || $server == 2 ]]
  valid_revision "$revision"
  valid_service "$project"
  valid_path "$root"
  [[ -s $state_dir/previous-compose.yml && -s $state_dir/previous-env && -s $state_dir/previous-images.yml ]]
}

rollback() {
  cp "$state_dir/previous-compose.yml" "$root/$compose"
  cp "$state_dir/previous-env" "$root/$env_file"
  chmod 600 "$root/$env_file"
  if docker compose --project-name "$project" --project-directory "$root" -f "$root/$compose" -f "$state_dir/previous-images.yml" --env-file "$root/$env_file" up -d --wait --pull never &&
     rollback_ready; then
    record_result ROLLED_BACK
    return 0
  fi
  record_result ROLLBACK_FAILED
  return 1
}

watchdog_main() {
  stage=${2:-}
  state_dir="$stage/state"
  parent_pid=${3:-}
  local timeout=${DEPLOY_WATCHDOG_SECONDS:-600} elapsed=0
  valid_path "$stage"
  [[ $parent_pid =~ ^[1-9][0-9]*$ ]]
  [[ $timeout =~ ^[1-9][0-9]{0,3}$ && $timeout -le 900 ]]
  exec 9>&- || true

  while [[ ! -f $state_dir/result ]] && kill -0 "$parent_pid" 2>/dev/null && ((elapsed < timeout)); do
    sleep 1
    ((elapsed += 1))
  done
  [[ -f $state_dir/result ]] && exit 0
  if kill -0 "$parent_pid" 2>/dev/null; then
    kill -TERM "$parent_pid" 2>/dev/null || true
    for _ in $(seq 1 15); do
      [[ -f $state_dir/result ]] && exit 0
      kill -0 "$parent_pid" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$parent_pid" 2>/dev/null || true
  fi

  load_state || { record_result ROLLBACK_FAILED; exit 2; }
  exec 8>"$root/.deploy-prod${server}.lock"
  lock_wait=${DEPLOY_LOCK_WAIT_SECONDS:-60}
  [[ $lock_wait =~ ^[1-9][0-9]?$ && $lock_wait -le 60 ]] || { record_result ROLLBACK_FAILED; exit 2; }
  flock -w "$lock_wait" 8 || { record_result ROLLBACK_FAILED; exit 2; }
  [[ -f $state_dir/result ]] && exit 0
  rollback || exit 2
  exit 1
}

rollout_main() {
  server=${2:-}
  revision=${3:-}
  stage=${4:-}
  [[ $server == 1 || $server == 2 ]] || exit 1
  valid_revision "$revision"
  valid_path "$stage"
  root=${DEPLOY_ROOT:-/opt/infra}
  valid_path "$root"
  [[ $stage =~ ^$root/\.deploy-staging/prod$server-$revision-[0-9]+-[0-9]+$ ]]
  inputs="$stage/inputs"
  state_dir="$stage/state"
  compose="docker-compose-prod${server}.yml"
  env_file=".env.infra${server}"
  [[ -d $state_dir && -s $inputs/$compose && -s $inputs/$env_file && -s $inputs/deploy-prod.sh ]]
  if [[ $server == 2 ]]; then [[ -s $inputs/ops/prod2/install-logging.sh ]]; fi
  cd "$root"

  record_preflight_failure() {
    trap - ERR HUP INT TERM
    [[ -f $state_dir/result ]] || record_result PREFLIGHT_FAILED
    exit 1
  }
  trap 'record_preflight_failure' ERR HUP INT TERM
  exec 9>".deploy-prod${server}.lock"
  lock_wait=${DEPLOY_LOCK_WAIT_SECONDS:-60}
  [[ $lock_wait =~ ^[1-9][0-9]?$ && $lock_wait -le 60 ]]
  flock -w "$lock_wait" 9
  [[ ! -e $state_dir/result ]]

  cp "$root/$compose" "$state_dir/previous-compose.yml"
  cp "$root/$env_file" "$state_dir/previous-env"
  chmod 600 "$state_dir/previous-compose.yml" "$state_dir/previous-env"
  services=$(docker compose -f "$state_dir/previous-compose.yml" --env-file "$state_dir/previous-env" config --services)
  [[ -n $services ]]
  mkdir "$state_dir/previous-resources" "$state_dir/current-resources" "$state_dir/current-render" "$state_dir/candidate-render"
  : >"$state_dir/previous-readiness"
  : >"$state_dir/previous-image-ids.map"
  printf 'services:\n' >"$state_dir/previous-images.yml"

  project=
  for service in $services; do
    valid_service "$service"
    containers=$(docker compose -f "$state_dir/previous-compose.yml" --env-file "$state_dir/previous-env" ps --all -q "$service")
    set -- $containers
    [[ $# -eq 1 ]]
    container=$1
    [[ $(docker inspect --format '{{.State.Status}}' "$container") == running ]]
    container_project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")
    container_service=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")
    valid_service "$container_project"
    [[ $container_service == "$service" ]]
    if [[ -z $project ]]; then project=$container_project; else [[ $project == "$container_project" ]]; fi
    if container_has_healthcheck "$container"; then
      [[ $(container_health "$container") == healthy ]]
      readiness=healthy
    else
      readiness=running
    fi
    printf '%s|%s\n' "$service" "$readiness" >>"$state_dir/previous-readiness"

    image_id=$(docker inspect --format '{{.Image}}' "$container")
    [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]]
    digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id")
    set -- $digests
    [[ $# -eq 1 ]]
    printf '%s\n' "$1" | grep -Eq '@sha256:[0-9a-f]{64}$'
    printf '%s|%s\n' "$service" "$image_id" >>"$state_dir/previous-image-ids.map"
    printf '  %s:\n    image: "%s"\n' "$service" "$1" >>"$state_dir/previous-images.yml"
    inspect_resources "$container" >"$state_dir/previous-resources/$service"
  done

  render_compose "$state_dir/previous-compose.yml" "$state_dir/previous-env" "$state_dir/current-render"
  render_compose "$inputs/$compose" "$inputs/$env_file" "$state_dir/candidate-render"
  cmp -s "$state_dir/current-render/images.map" "$state_dir/candidate-render/images.map"
  for service in $services; do
    cmp -s "$state_dir/previous-resources/$service" "$state_dir/candidate-render/resources/$service"
  done
  while IFS='|' read -r service previous_mode; do
    candidate_mode=$(awk -F '|' -v service="$service" '$1 == service { print $2 }' "$state_dir/candidate-render/healthchecks.map")
    [[ $candidate_mode == healthy || $candidate_mode == running ]]
    [[ $previous_mode != healthy || $candidate_mode == healthy ]]
  done <"$state_dir/previous-readiness"

  printf '%s\n' "$server" >"$state_dir/server"
  printf '%s\n' "$revision" >"$state_dir/revision"
  printf '%s\n' "$project" >"$state_dir/project"
  printf '%s\n' "$root" >"$state_dir/root"
  chmod -R go-rwx "$state_dir"

  nohup env DEPLOY_WATCHDOG_SECONDS="${DEPLOY_WATCHDOG_SECONDS:-600}" DEPLOY_LOCK_WAIT_SECONDS="$lock_wait" bash "$inputs/deploy-prod.sh" watchdog "$stage" "$$" </dev/null >/dev/null 2>&1 &
  watchdog_pid=$!

  recover() {
    trap - ERR HUP INT TERM
    set +e
    load_state
    rollback
    local status=$?
    wait "$watchdog_pid" 2>/dev/null || true
    ((status == 0)) && exit 1
    exit 2
  }
  trap 'recover' ERR HUP INT TERM

  cp "$inputs/$compose" "$root/$compose"
  cp "$inputs/$env_file" "$root/$env_file"
  chmod 600 "$root/$env_file"
  docker compose --project-name "$project" --project-directory "$root" -f "$root/$compose" -f "$state_dir/previous-images.yml" --env-file "$root/$env_file" up -d --wait --pull never
  candidate_ready

  trap - ERR HUP INT TERM
  printf '%s\n' "$revision" >"$root/.last-deployed-prod${server}-sha"
  record_result SUCCESS
  wait "$watchdog_pid" 2>/dev/null || true
  echo "Production deployment passed for server $server"
}

case ${1:-} in
  rollout) rollout_main "$@" ;;
  watchdog) watchdog_main "$@" ;;
  *) exit 1 ;;
esac
