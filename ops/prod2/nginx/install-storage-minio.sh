#!/bin/sh
set -eu
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run as root after production approval' >&2
  exit 1
fi

for program in date install nginx systemctl openssl awk cat cp rm mv mktemp chmod; do
  command -v "$program" >/dev/null || { echo "Missing dependency: $program" >&2; exit 1; }
done

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
candidate="$source_dir/storage-minio.conf"
target=/etc/nginx/conf.d/storage-minio.conf
tls_snippet=/etc/nginx/snippets/memonogi-storage-tls.conf
backup_root=/var/backups/memonogi-nginx
stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage=
candidate_main=
armed=0

[ -f "$candidate" ] || { echo 'Missing reviewed storage-minio.conf' >&2; exit 1; }
[ -f "$tls_snippet" ] || { echo 'Missing reviewed TLS snippet for storage.memonogi.com' >&2; exit 1; }
certificate=$(awk '$1 == "ssl_certificate" { value=$2; sub(/;$/, "", value); print value }' "$tls_snippet")
set -- $certificate
[ "$#" -eq 1 ] && [ -f "$1" ] || { echo 'TLS snippet must name exactly one readable certificate file' >&2; exit 1; }
openssl x509 -in "$1" -noout -checkhost storage.memonogi.com >/dev/null 2>&1 || {
  echo 'Certificate does not cover storage.memonogi.com; refusing installation' >&2
  exit 1
}
nginx -t

install -d -o root -g root -m 0700 "$backup_root"
backup=$(mktemp -d "$backup_root/storage-minio-$stamp.XXXXXX")
chmod 0700 "$backup"
if [ -e "$target" ]; then
  cp -a "$target" "$backup/storage-minio.conf"
  printf 'present\n' > "$backup/previous-state"
else
  printf 'absent\n' > "$backup/previous-state"
fi

restore_previous() {
  state=$(cat "$backup/previous-state")
  if [ "$state" = present ]; then
    install -o root -g root -m 0644 "$backup/storage-minio.conf" "$target"
  elif [ "$state" = absent ]; then
    rm -f -- "$target"
  else
    echo 'Invalid backup state; refusing automatic rollback' >&2
    return 1
  fi
  nginx -t
  systemctl reload nginx
}

cleanup_files() {
  [ -z "$stage" ] || rm -f -- "$stage"
  [ -z "$candidate_main" ] || rm -f -- "$candidate_main"
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$armed" -eq 1 ]; then
    echo 'Interrupted during live Nginx change; restoring previous storage vhost' >&2
    restore_previous || status=1
  fi
  cleanup_files
  exit "$status"
}
trap on_exit EXIT HUP INT TERM

# Validate the reviewed vhost outside the live include glob. The live path is
# replaced only by a same-filesystem rename after this isolated syntax/TLS test.
stage=$(mktemp /etc/nginx/conf.d/.storage-minio.candidate.XXXXXX)
candidate_main=$(mktemp "$backup/candidate-nginx.XXXXXX")
install -o root -g root -m 0644 "$candidate" "$stage"
cat > "$candidate_main" <<EOF
pid $backup/nginx-candidate.pid;
error_log stderr;
events {}
http {
  include /etc/nginx/mime.types;
  include $stage;
}
EOF
nginx -t -c "$candidate_main"

armed=1
mv -f -- "$stage" "$target"
stage=
if ! nginx -t; then
  echo 'Nginx validation failed; restoring previous storage vhost' >&2
  restore_previous
  armed=0
  exit 1
fi
if ! systemctl reload nginx; then
  echo 'Nginx reload failed; restoring previous storage vhost' >&2
  restore_previous
  armed=0
  exit 1
fi
armed=0
cleanup_files
trap - EXIT HUP INT TERM

echo "Storage MinIO vhost installed. Rollback backup: $backup"
