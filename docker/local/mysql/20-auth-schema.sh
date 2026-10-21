#!/bin/sh
# Local Compose only. Also safe to source from the MySQL image's init entrypoint.
(
  set -eu

  fail() { printf '%s\n' "$1" >&2; exit 1; }
  [ "${DEVNOGI_LOCAL_BOOTSTRAP:-}" = 1 ] || fail 'Local auth bootstrap: this container is not configured for local bootstrap.'
  case "${MYSQL_USER:-}" in
    ''|root|*[!a-zA-Z0-9_]*) fail 'Local auth bootstrap: MYSQL_USER must be a non-root identifier (letters, digits, underscore).' ;;
  esac
  [ "${#MYSQL_USER}" -le 32 ] || fail 'Local auth bootstrap: MYSQL_USER exceeds 32 characters.'
  [ -n "${MYSQL_ROOT_PASSWORD:-}" ] || fail 'Local auth bootstrap: MYSQL_ROOT_PASSWORD is required.'

  # Keep credentials out of argv and output. Use only this container's local socket.
  # Check the existing app account before creating anything; never reset its password.
  if ! account_count=$(MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=socket --user=root --batch --skip-column-names 2>/dev/null <<SQL
SELECT COUNT(*) FROM mysql.user WHERE User = '${MYSQL_USER}' AND Host = '%';
SQL
  ); then
    fail 'Local auth bootstrap: cannot verify the existing database user.'
  fi
  [ "$account_count" = 1 ] || fail 'Local auth bootstrap: configured app user does not exist at host %; existing accounts were not changed.'

  if ! MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=socket --user=root --batch 2>/dev/null <<SQL
CREATE DATABASE IF NOT EXISTS auth;
GRANT ALL PRIVILEGES ON auth.* TO '${MYSQL_USER}'@'%';
SQL
  then
    fail 'Local auth bootstrap: schema/grant failed; check local MySQL readiness and root credentials.'
  fi
  printf '%s\n' 'Local auth schema and existing app-user grant are ready.'
)
