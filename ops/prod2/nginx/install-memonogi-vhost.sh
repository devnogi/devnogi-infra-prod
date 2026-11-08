#!/bin/sh
set -eu
umask 077

usage() {
  echo "Usage: $0 --check|--apply <rendered-memonogi.conf>" >&2
}

[ "$#" -eq 2 ] || { usage; exit 2; }
mode=$1
candidate=$2
manifest=$candidate.manifest
target=/etc/nginx/sites-enabled/memonogi.conf
snippet_target=/etc/nginx/snippets/memonogi-outfit-upload.conf
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
snippet_source=$source_dir/outfit-upload-server.conf

[ "$mode" = --check ] || [ "$mode" = --apply ] || { usage; exit 2; }
for path in "$candidate" "$manifest" "$target" "$snippet_source"; do
  [ ! -L "$path" ] || { echo "Symlinks are not supported: $path" >&2; exit 1; }
  [ -f "$path" ] || { echo "Required regular file is missing: $path" >&2; exit 1; }
done
if [ -e "$snippet_target" ]; then
  [ ! -L "$snippet_target" ] || { echo "Symlinks are not supported: $snippet_target" >&2; exit 1; }
  [ -f "$snippet_target" ] || { echo "Existing snippet is not a regular file: $snippet_target" >&2; exit 1; }
fi
[ "$(grep -Ec '^[[:space:]]*include /etc/nginx/snippets/memonogi-outfit-upload\.conf;$' "$candidate")" -eq 1 ] || {
  echo 'Rendered candidate must contain exactly one managed upload include' >&2
  exit 1
}
if grep -Eq '@@[A-Z0-9_]+@@|MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY' "$candidate"; then
  echo 'Rendered candidate contains an unresolved marker' >&2
  exit 1
fi

manifest_value() {
  key=$1
  awk -v key="$key" '$1 == key { print $2 }' "$manifest"
}
source_sha256=$(manifest_value source_sha256)
candidate_sha256=$(manifest_value candidate_sha256)
[ "$(grep -c '^version 1$' "$manifest")" -eq 1 ] &&
[ "$(grep -c '^source_sha256 [0-9a-f]\{64\}$' "$manifest")" -eq 1 ] &&
[ "$(grep -c '^candidate_sha256 [0-9a-f]\{64\}$' "$manifest")" -eq 1 ] &&
[ "$(wc -l < "$manifest" | tr -d ' ')" -eq 3 ] || {
  echo 'Manifest structure is invalid' >&2
  exit 1
}

hash_file() {
  sha256sum -- "$1" | awk '{ print $1 }'
}
verify_hashes() {
  [ "$(hash_file "$target")" = "$source_sha256" ] || {
    echo 'Current vhost changed after rendering; render a fresh candidate from the current target' >&2
    return 1
  }
  [ "$(hash_file "$candidate")" = "$candidate_sha256" ] || {
    echo 'Rendered candidate does not match its manifest' >&2
    return 1
  }
}

if cmp -s "$target" "$candidate"; then
  echo 'Rendered candidate is identical to the current vhost; refusing a no-op' >&2
  exit 1
fi

if [ "$mode" = --check ]; then
  verify_hashes
  echo 'Candidate and source hashes match. Review a root-only diff before --apply.'
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { echo 'Run --apply as root after production approval' >&2; exit 1; }
for program in date install nginx systemctl cmp grep awk sha256sum stat wc tr cp rm mv mktemp chmod cat dirname; do
  command -v "$program" >/dev/null || { echo "Missing dependency: $program" >&2; exit 1; }
done

nginx -t
backup_root=/var/backups/memonogi-nginx
stamp=$(date -u +%Y%m%dT%H%M%SZ)
install -d -o root -g root -m 0700 "$backup_root"
backup=$(mktemp -d "$backup_root/memonogi-vhost-$stamp.XXXXXX")
chmod 0700 "$backup"
cp -a "$target" "$backup/memonogi.conf"
if [ -e "$snippet_target" ]; then
  cp -a "$snippet_target" "$backup/memonogi-outfit-upload.conf"
  printf 'present\n' > "$backup/snippet-state"
else
  printf 'absent\n' > "$backup/snippet-state"
fi

target_mode=$(stat -c %a "$target")
target_uid=$(stat -c %u "$target")
target_gid=$(stat -c %g "$target")
if [ -e "$snippet_target" ]; then
  snippet_mode=$(stat -c %a "$snippet_target")
  snippet_uid=$(stat -c %u "$snippet_target")
  snippet_gid=$(stat -c %g "$snippet_target")
else
  snippet_mode=644
  snippet_uid=0
  snippet_gid=0
fi

vhost_stage=
snippet_stage=
restore_file() {
  saved=$1
  destination=$2
  directory=$(dirname -- "$destination")
  restore_stage=$(mktemp "$directory/.memonogi.restore.XXXXXX")
  cp -a "$saved" "$restore_stage"
  mv -f -- "$restore_stage" "$destination"
}
restore_previous() {
  restore_file "$backup/memonogi.conf" "$target"
  if [ "$(cat "$backup/snippet-state")" = present ]; then
    restore_file "$backup/memonogi-outfit-upload.conf" "$snippet_target"
  else
    rm -f -- "$snippet_target"
  fi
  nginx -t
  systemctl reload nginx
}
cleanup_stages() {
  [ -z "$vhost_stage" ] || rm -f -- "$vhost_stage"
  [ -z "$snippet_stage" ] || rm -f -- "$snippet_stage"
}

armed=1
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  cleanup_stages
  if [ "$armed" -eq 1 ]; then
    echo 'Vhost installation failed; restoring the exact previous regular files and metadata' >&2
    restore_previous || status=1
  fi
  exit "$status"
}
trap on_exit EXIT HUP INT TERM

vhost_stage=$(mktemp /etc/nginx/sites-enabled/.memonogi.conf.candidate.XXXXXX)
snippet_stage=$(mktemp /etc/nginx/snippets/.memonogi-outfit-upload.candidate.XXXXXX)
install -o "$target_uid" -g "$target_gid" -m "$target_mode" "$candidate" "$vhost_stage"
install -o "$snippet_uid" -g "$snippet_gid" -m "$snippet_mode" "$snippet_source" "$snippet_stage"

# Recheck immediately before the first live rename so a stale render cannot
# overwrite route, upstream, header, or TLS changes made after rendering.
verify_hashes
mv -f -- "$snippet_stage" "$snippet_target"
snippet_stage=
mv -f -- "$vhost_stage" "$target"
vhost_stage=
nginx -t
systemctl reload nginx
armed=0
trap - EXIT HUP INT TERM
echo "Managed memonogi vhost installed. Rollback backup: $backup"
