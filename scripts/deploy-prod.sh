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

record_finished() {
  local temporary="$state_dir/finished.tmp.$$"
  printf 'DEPLOY_FINISHED=1\n' >"$temporary"
  mv "$temporary" "$state_dir/finished"
}

record_watchdog_ack() {
  local temporary="$state_dir/watchdog-ack.tmp.$$"
  printf 'WATCHDOG_ACK=1\n' >"$temporary"
  mv "$temporary" "$state_dir/watchdog-ack"
}

record_commit_ready() {
  local temporary="$state_dir/commit-ready.tmp.$$"
  printf 'COMMIT_READY=1\n' >"$temporary"
  mv "$temporary" "$state_dir/commit-ready"
}

record_watchdog_marker() {
  local name=$1 temporary="$state_dir/$1.tmp.$$"
  printf '%s=1\n' "${name^^}" >"$temporary"
  mv "$temporary" "$state_dir/$name"
}

healthcheck_mode_from_json() {
  python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if value is None:
    print("running")
    raise SystemExit(0)
if not isinstance(value, dict):
    raise SystemExit(1)
test = value.get("Test")
if test is None or test == []:
    print("running")
    raise SystemExit(0)
if not isinstance(test, list) or not test or not all(isinstance(item, str) for item in test):
    raise SystemExit(1)
if test[0] == "NONE" and len(test) == 1:
    print("running")
elif test[0] in ("CMD", "CMD-SHELL") and len(test) >= 2 and all(item for item in test[1:]):
    print("healthy")
else:
    raise SystemExit(1)
'
}

container_health_mode() {
  local container=$1 healthcheck_json
  healthcheck_json=$(docker inspect --format '{{json .Config.Healthcheck}}' "$container") || return 1
  printf '%s\n' "$healthcheck_json" | healthcheck_mode_from_json
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

runtime_resources_reproduce_render() {
  local container=$1 expected_image=$2 actual=$3 rendered=$4 filtered declared_volumes line marker kind source target rw extra labels status
  cmp -s "$actual" "$rendered" && return 0
  filtered="${actual}.rendered-contract.$$"
  : >"$filtered"
  declared_volumes=$(docker image inspect --format '{{json .Config.Volumes}}' "$expected_image") || {
    rm -f -- "$filtered"
    return 1
  }
  while IFS= read -r line || [[ -n $line ]]; do
    if grep -Fqx -- "$line" "$rendered"; then
      printf '%s\n' "$line" >>"$filtered"
      continue
    fi
    IFS='|' read -r marker kind source target rw extra <<<"$line"
    if [[ $marker != M || $kind != volume || ! $source =~ ^[0-9a-f]{64}$ || $target != /* || $rw != true || -n $extra ]]; then
      rm -f -- "$filtered"
      return 1
    fi
    if ! { printf '%s\n' "$target"; printf '%s\n' "$declared_volumes"; } | python3 -c '
import json, sys
target = sys.stdin.readline().rstrip("\n")
value = json.load(sys.stdin)
raise SystemExit(0 if isinstance(value, dict) and target in value else 1)
' declared-volume; then
      rm -f -- "$filtered"
      return 1
    fi
    labels=$(docker volume inspect --format '{{json .Labels}}' "$source") || {
      rm -f -- "$filtered"
      return 1
    }
    if ! printf '%s\n' "$labels" | python3 -c '
import json, sys
value = json.load(sys.stdin)
raise SystemExit(0 if isinstance(value, dict) and value.get("com.docker.volume.anonymous") == "" else 1)
' anonymous-label; then
      rm -f -- "$filtered"
      return 1
    fi
    if ! docker exec "$container" sh -c '
target=$1
[ -d "$target" ] || exit 1
command -v find >/dev/null 2>&1 || exit 1
first=$(find "$target" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null) || exit 1
[ -z "$first" ]
' sh "$target" >/dev/null; then
      rm -f -- "$filtered"
      return 1
    fi
  done <"$actual"
  cmp -s "$filtered" "$rendered"
  status=$?
  rm -f -- "$filtered"
  return "$status"
}

inspect_ports() {
  docker inspect --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{if $bindings}}{{range $bindings}}P|{{$port}}|{{.HostIp}}|{{.HostPort}}{{"\n"}}{{end}}{{end}}{{end}}' "$1" |
    sed '/^$/d' | sort
}

current_ports_reproduce_runtime() {
  local actual=$1 rendered=$2
  cmp -s "$actual" "$rendered" && return 0
  awk -F '|' '
    NR == FNR {
      expected[$0]++
      if ($1 == "P" && $3 == "0.0.0.0") {
        wildcard_v6[$1 FS $2 FS "::" FS $4]++
      }
      next
    }
    { observed[$0]++ }
    END {
      for (line in expected) {
        if (observed[line] != expected[line]) exit 1
      }
      for (line in observed) {
        if (line in expected) {
          if (observed[line] != expected[line]) exit 1
        } else if (!(line in wildcard_v6) || observed[line] != wildcard_v6[line]) {
          exit 1
        }
      }
    }
  ' "$rendered" "$actual"
}

image_health_mode() {
  local image_id=$1 healthcheck_json
  healthcheck_json=$(docker image inspect --format '{{json .Config.Healthcheck}}' "$image_id") || return 1
  printf '%s\n' "$healthcheck_json" | healthcheck_mode_from_json
}

render_compose() {
  local compose_file=$1 environment_file=$2 output_dir=$3 rendered
  rendered="$output_dir/rendered.json"
  mkdir -p "$output_dir/resources" "$output_dir/ports"
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
    if "healthcheck" not in service:
        healthcheck_mode = "absent"
    elif isinstance(service.get("healthcheck"), dict) and service["healthcheck"].get("disable", False):
        healthcheck_mode = "disabled"
    else:
        healthcheck_mode = "configured"
    healthchecks.append(f"{name}|{healthcheck_mode}")
    resources = []
    ports = []
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
    for port in service.get("ports", []):
        target = port.get("target")
        published = port.get("published")
        protocol = port.get("protocol", "tcp")
        host_ip = port.get("host_ip") or "0.0.0.0"
        if not isinstance(target, int) or not (1 <= target <= 65535):
            raise SystemExit("invalid target port")
        if isinstance(published, int):
            published = str(published)
        if not isinstance(published, str) or not published.isdigit() or not (1 <= int(published) <= 65535):
            raise SystemExit("invalid published port")
        if protocol not in ("tcp", "udp", "sctp") or not isinstance(host_ip, str) or not host_ip:
            raise SystemExit("invalid port binding")
        ports.append(f"P|{target}/{protocol}|{host_ip}|{published}")
    (out / "resources" / name).write_text("\n".join(sorted(resources)) + ("\n" if resources else ""), encoding="utf-8")
    (out / "ports" / name).write_text("\n".join(sorted(ports)) + ("\n" if ports else ""), encoding="utf-8")
(out / "images.map").write_text("\n".join(images) + "\n", encoding="utf-8")
(out / "healthchecks.map").write_text("\n".join(healthchecks) + "\n", encoding="utf-8")
PY
}

runtime_ready() {
  local mode=$1 container=$2 state health actual_mode
  state=$(docker inspect --format '{{.State.Status}}' "$container") || return 1
  [[ $state == running ]] || return 1
  actual_mode=$(container_health_mode "$container") || return 1
  if [[ $mode == healthy ]]; then
    [[ $actual_mode == healthy ]] || return 1
    health=$(container_health "$container") || return 1
    [[ $health == healthy ]]
  elif [[ $mode == running ]]; then
    [[ $actual_mode == running ]]
  else
    return 1
  fi
}

same_runtime() {
  local expected_resources=$1 expected_ports=$2 service container expected_image actual_resources actual_ports
  while IFS='|' read -r service expected_image; do
    valid_service "$service" && [[ $expected_image =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    container=$(docker compose --project-name "$project" --project-directory "$root" -f "$root/$compose" -f "$state_dir/previous-images.yml" --env-file "$root/$env_file" ps --all -q "$service") || return 1
    [[ -n $container && $container != *$'\n'* ]] || return 1
    [[ $(docker inspect --format '{{.Image}}' "$container") == "$expected_image" ]] || return 1
    actual_resources="$state_dir/current-resources/$service"
    inspect_resources "$container" >"$actual_resources"
    runtime_resources_reproduce_render "$container" "$expected_image" "$actual_resources" "$expected_resources/$service" || return 1
    actual_ports="$state_dir/current-ports/$service"
    inspect_ports "$container" >"$actual_ports"
    cmp -s "$expected_ports/$service" "$actual_ports" || return 1
  done <"$state_dir/previous-image-ids.map"
}

candidate_ready() {
  local service previous_mode container candidate_mode
  while IFS='|' read -r service previous_mode; do
    valid_service "$service" || return 1
    container=$(docker compose --project-name "$project" --project-directory "$root" -f "$root/$compose" -f "$state_dir/previous-images.yml" --env-file "$root/$env_file" ps --all -q "$service") || return 1
    [[ -n $container && $container != *$'\n'* ]] || return 1
    candidate_mode=$(container_health_mode "$container") || return 1
    [[ $previous_mode != healthy || $candidate_mode == healthy ]] || return 1
    runtime_ready "$candidate_mode" "$container" || return 1
  done <"$state_dir/previous-readiness"
  same_runtime "$state_dir/candidate-render/resources" "$state_dir/candidate-render/ports"
}

rollback_ready() {
  local service expected container
  while IFS='|' read -r service expected; do
    valid_service "$service" || return 1
    container=$(docker compose --project-name "$project" --project-directory "$root" -f "$root/$compose" -f "$state_dir/previous-images.yml" --env-file "$root/$env_file" ps --all -q "$service") || return 1
    [[ -n $container && $container != *$'\n'* ]] || return 1
    runtime_ready "$expected" "$container" || return 1
  done <"$state_dir/previous-readiness"
  same_runtime "$state_dir/current-render/resources" "$state_dir/previous-ports"
}

atomic_replace_path() {
  local source=$1 target=$2
  python3 - "$source" "$target" <<'PY'
import ctypes, os, sys
source, target = map(os.fsencode, sys.argv[1:])
if os.path.lexists(target):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100, source, -100, target, 2) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
else:
    os.rename(source, target)
PY
  chmod -R u+rwX "$source" 2>/dev/null || true
  rm -rf -- "$source" || true
}

promote_prod2_ops() {
  local ops_parent="$root/incoming2/ops" ops_target="$root/incoming2/ops/prod2" ops_temporary="$root/incoming2/ops/.prod2-$revision-$$"
  mkdir -p "$ops_parent"
  cp -a "$inputs/ops/prod2" "$ops_temporary"
  chmod -R go-rwx "$ops_temporary"
  atomic_replace_path "$ops_temporary" "$ops_target"
}

restore_prod2_ops() {
  [[ $server == 2 ]] || return 0
  local ops_parent="$root/incoming2/ops" ops_target="$root/incoming2/ops/prod2" ops_temporary="$root/incoming2/ops/.prod2-rollback-$revision-$$"
  mkdir -p "$ops_parent"
  if [[ $(<"$state_dir/previous-ops-presence") == present ]]; then
    cp -a "$state_dir/previous-prod2-ops" "$ops_temporary"
    atomic_replace_path "$ops_temporary" "$ops_target"
  elif [[ -e $ops_target || -L $ops_target ]]; then
    python3 - "$ops_target" "$ops_temporary" <<'PY'
import os, sys
source, target = map(os.fsencode, sys.argv[1:])
os.rename(source, target)
PY
    chmod -R u+rwX "$ops_temporary" 2>/dev/null || true
    rm -rf -- "$ops_temporary"
  fi
}

restore_last_deployed_marker() {
  local target="$root/.last-deployed-prod${server}-sha"
  if [[ $(<"$state_dir/previous-last-presence") == present ]]; then
    cp "$state_dir/previous-last-sha" "$target"
  else
    rm -f -- "$target"
  fi
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
  [[ $(<"$state_dir/previous-last-presence") == absent || -s $state_dir/previous-last-sha ]]
  if [[ $server == 2 ]]; then
    [[ $(<"$state_dir/previous-ops-presence") == absent || -e $state_dir/previous-prod2-ops || -L $state_dir/previous-prod2-ops ]]
  fi
}

rollback() {
  local status=0
  cp "$state_dir/previous-compose.yml" "$root/$compose"
  cp "$state_dir/previous-env" "$root/$env_file"
  chmod 600 "$root/$env_file"
  docker compose --project-name "$project" --project-directory "$root" -f "$root/$compose" -f "$state_dir/previous-images.yml" --env-file "$root/$env_file" up -d --wait --pull never &&
    rollback_ready || status=1
  restore_prod2_ops || status=1
  restore_last_deployed_marker || status=1
  if ((status == 0)); then
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
  local timeout=${DEPLOY_WATCHDOG_SECONDS:-600} elapsed=0 acked=0 status=2 result_value=
  valid_path "$stage"
  [[ $parent_pid =~ ^[1-9][0-9]*$ ]]
  [[ $timeout =~ ^[1-9][0-9]{0,3}$ && $timeout -le 900 ]]
  exec 9>&- || true

  while kill -0 "$parent_pid" 2>/dev/null && ((elapsed < timeout)); do
    if [[ $acked == 0 && -f $state_dir/commit-ready ]]; then
      record_watchdog_ack
      acked=1
    fi
    [[ -f $state_dir/result ]] && break
    sleep 1
    ((elapsed += 1))
  done
  if [[ ! -f $state_dir/result ]] && kill -0 "$parent_pid" 2>/dev/null && ((elapsed >= timeout)); then
    kill -TERM "$parent_pid" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$parent_pid" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$parent_pid" 2>/dev/null || true
  fi

  [[ -f $state_dir/result ]] || record_watchdog_marker watchdog-takeover
  load_state || { record_result ROLLBACK_FAILED; record_finished; exit 2; }
  exec 8>"$root/.deploy-prod${server}.lock"
  lock_wait=${DEPLOY_LOCK_WAIT_SECONDS:-60}
  [[ $lock_wait =~ ^[1-9][0-9]?$ && $lock_wait -le 60 ]] || { record_result ROLLBACK_FAILED; record_finished; exit 2; }
  flock -w "$lock_wait" 8 || { record_result ROLLBACK_FAILED; record_finished; exit 2; }
  record_watchdog_marker watchdog-lock-acquired
  if [[ -f $state_dir/result ]]; then
    result_value=$(<"$state_dir/result")
    case $result_value in
      DEPLOY_RESULT=SUCCESS) status=0 ;;
      DEPLOY_RESULT=ROLLED_BACK) status=1 ;;
      DEPLOY_RESULT=ROLLBACK_FAILED) status=2 ;;
      *) if rollback; then status=1; else status=2; fi ;;
    esac
  elif rollback; then
    status=1
  else
    status=2
  fi
  exec 8>&-
  record_finished
  exit "$status"
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
    exec 9>&- || true
    record_finished
    exit 1
  }
  trap 'record_preflight_failure' ERR HUP INT TERM
  exec 9>".deploy-prod${server}.lock"
  lock_wait=${DEPLOY_LOCK_WAIT_SECONDS:-60}
  [[ $lock_wait =~ ^[1-9][0-9]?$ && $lock_wait -le 60 ]]
  flock -w "$lock_wait" 9
  lock_held=1
  [[ ! -e $state_dir/result ]]

  cp "$root/$compose" "$state_dir/previous-compose.yml"
  cp "$root/$env_file" "$state_dir/previous-env"
  chmod 600 "$state_dir/previous-compose.yml" "$state_dir/previous-env"
  project=$(docker compose --project-directory "$root" -f "$state_dir/previous-compose.yml" --env-file "$state_dir/previous-env" config --format json |
    python3 -c 'import json, sys; value=json.load(sys.stdin).get("name"); print(value if isinstance(value, str) else "")')
  valid_service "$project"
  services=$(docker compose --project-name "$project" --project-directory "$root" -f "$state_dir/previous-compose.yml" --env-file "$state_dir/previous-env" config --services)
  [[ -n $services ]]
  mkdir "$state_dir/previous-resources" "$state_dir/previous-ports" "$state_dir/current-resources" "$state_dir/current-ports" "$state_dir/current-render" "$state_dir/candidate-render"
  : >"$state_dir/previous-readiness"
  : >"$state_dir/previous-image-ids.map"
  : >"$state_dir/previous-image-health.map"
  printf 'services:\n' >"$state_dir/previous-images.yml"

  for service in $services; do
    valid_service "$service"
    containers=$(docker compose --project-name "$project" --project-directory "$root" -f "$state_dir/previous-compose.yml" --env-file "$state_dir/previous-env" ps --all -q "$service")
    set -- $containers
    [[ $# -eq 1 ]]
    container=$1
    [[ $(docker inspect --format '{{.State.Status}}' "$container") == running ]]
    container_project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")
    container_service=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")
    valid_service "$container_project"
    [[ $container_service == "$service" ]]
    [[ $project == "$container_project" ]]
    readiness=$(container_health_mode "$container")
    if [[ $readiness == healthy ]]; then
      [[ $(container_health "$container") == healthy ]]
    fi
    printf '%s|%s\n' "$service" "$readiness" >>"$state_dir/previous-readiness"

    image_id=$(docker inspect --format '{{.Image}}' "$container")
    [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]]
    digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id")
    set -- $digests
    [[ $# -eq 1 ]]
    printf '%s\n' "$1" | grep -Eq '@sha256:[0-9a-f]{64}$'
    printf '%s|%s\n' "$service" "$image_id" >>"$state_dir/previous-image-ids.map"
    image_readiness=$(image_health_mode "$image_id")
    printf '%s|%s\n' "$service" "$image_readiness" >>"$state_dir/previous-image-health.map"
    printf '  %s:\n    image: "%s"\n' "$service" "$1" >>"$state_dir/previous-images.yml"
    inspect_resources "$container" >"$state_dir/previous-resources/$service"
    inspect_ports "$container" >"$state_dir/previous-ports/$service"
  done

  render_compose "$state_dir/previous-compose.yml" "$state_dir/previous-env" "$state_dir/current-render"
  render_compose "$inputs/$compose" "$inputs/$env_file" "$state_dir/candidate-render"
  cmp -s "$state_dir/current-render/images.map" "$state_dir/candidate-render/images.map"
  for service in $services; do
    container=$(docker compose --project-name "$project" --project-directory "$root" -f "$state_dir/previous-compose.yml" --env-file "$state_dir/previous-env" ps --all -q "$service")
    expected_image=$(awk -F '|' -v service="$service" '$1 == service { print $2 }' "$state_dir/previous-image-ids.map")
    [[ $expected_image =~ ^sha256:[0-9a-f]{64}$ ]]
    runtime_resources_reproduce_render "$container" "$expected_image" "$state_dir/previous-resources/$service" "$state_dir/current-render/resources/$service"
    current_ports_reproduce_runtime "$state_dir/previous-ports/$service" "$state_dir/current-render/ports/$service"
    cmp -s "$state_dir/current-render/resources/$service" "$state_dir/candidate-render/resources/$service"
    if [[ $server == 2 ]]; then
      awk -F '|' '$1 == "P" && $3 != "127.0.0.1" { bad=1 } END { exit (bad ? 1 : 0) }' "$state_dir/candidate-render/ports/$service"
    fi
  done
  while IFS='|' read -r service previous_mode; do
    current_healthcheck=$(awk -F '|' -v service="$service" '$1 == service { print $2 }' "$state_dir/current-render/healthchecks.map")
    candidate_healthcheck=$(awk -F '|' -v service="$service" '$1 == service { print $2 }' "$state_dir/candidate-render/healthchecks.map")
    image_mode=$(awk -F '|' -v service="$service" '$1 == service { print $2 }' "$state_dir/previous-image-health.map")
    case $current_healthcheck in
      configured) current_mode=healthy ;;
      disabled) current_mode=running ;;
      absent) current_mode=$image_mode ;;
      *) exit 1 ;;
    esac
    case $candidate_healthcheck in
      configured) candidate_mode=healthy ;;
      disabled) candidate_mode=running ;;
      absent) candidate_mode=$image_mode ;;
      *) exit 1 ;;
    esac
    [[ $current_mode == "$previous_mode" ]]
    [[ $current_healthcheck != configured || $candidate_healthcheck == configured ]]
    [[ $previous_mode != healthy || $candidate_mode == healthy ]]
  done <"$state_dir/previous-readiness"

  printf '%s\n' "$server" >"$state_dir/server"
  printf '%s\n' "$revision" >"$state_dir/revision"
  printf '%s\n' "$project" >"$state_dir/project"
  printf '%s\n' "$root" >"$state_dir/root"
  rollout_pid=$BASHPID
  printf '%s\n' "$rollout_pid" >"$state_dir/rollout-pid"
  chmod -R go-rwx "$state_dir"
  if [[ $server == 2 ]]; then
    if [[ -e $root/incoming2/ops/prod2 || -L $root/incoming2/ops/prod2 ]]; then
      cp -a "$root/incoming2/ops/prod2" "$state_dir/previous-prod2-ops"
      printf 'present\n' >"$state_dir/previous-ops-presence"
    else
      printf 'absent\n' >"$state_dir/previous-ops-presence"
    fi
  fi
  if [[ -e $root/.last-deployed-prod${server}-sha ]]; then
    cp -a "$root/.last-deployed-prod${server}-sha" "$state_dir/previous-last-sha"
    printf 'present\n' >"$state_dir/previous-last-presence"
  else
    printf 'absent\n' >"$state_dir/previous-last-presence"
  fi

  nohup env DEPLOY_WATCHDOG_SECONDS="${DEPLOY_WATCHDOG_SECONDS:-600}" DEPLOY_LOCK_WAIT_SECONDS="$lock_wait" bash "$inputs/deploy-prod.sh" watchdog "$stage" "$rollout_pid" </dev/null >/dev/null 2>&1 &
  watchdog_pid=$!

  recover() {
    trap - ERR HUP INT TERM
    set +e
    load_state
    if [[ ${lock_held:-0} != 1 ]]; then
      exec 9>"$root/.deploy-prod${server}.lock"
      flock -w "$lock_wait" 9
      lock_held=1
    fi
    rollback
    local status=$?
    exec 9>&- || true
    lock_held=0
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
  if [[ $server == 2 ]]; then promote_prod2_ops; fi

  printf '%s\n' "$revision" >"$root/.last-deployed-prod${server}-sha"
  record_commit_ready
  ack_seen=0
  for _ in $(seq 1 30); do
    if [[ -f $state_dir/watchdog-ack ]]; then ack_seen=1; break; fi
    kill -0 "$watchdog_pid" 2>/dev/null || break
    sleep 1
  done
  [[ $ack_seen == 1 ]]
  [[ $(<"$state_dir/watchdog-ack") == WATCHDOG_ACK=1 ]]
  exec 9>&-
  lock_held=0
  trap - HUP INT TERM
  record_result SUCCESS
  trap - ERR
  wait "$watchdog_pid"
  echo "Production deployment passed for server $server"
}

case ${1:-} in
  rollout) rollout_main "$@" ;;
  watchdog) watchdog_main "$@" ;;
  *) exit 1 ;;
esac
