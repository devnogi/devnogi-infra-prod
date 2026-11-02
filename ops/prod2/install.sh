#!/bin/sh
set -eu
if [ "$(id -u)" -ne 0 ]; then echo 'Run as root after production approval' >&2; exit 1; fi
for program in node docker rclone rsyslogd logrotate systemctl flock; do
  command -v "$program" >/dev/null || { echo "Missing dependency: $program" >&2; exit 1; }
done
test -x /usr/bin/node || { echo 'Node must be installed at /usr/bin/node' >&2; exit 1; }
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -d -m 0700 /etc/memonogi-backup /var/backups/memonogi/mysql /var/lib/memonogi-backup /opt/memonogi-backup
for service in auth community batch gateway react; do
  install -d -o syslog -g adm -m 0750 "/var/log/memonogi/$service"
done
install -m 0644 "$source_dir/rsyslog.conf" /etc/rsyslog.d/30-memonogi.conf
install -m 0644 "$source_dir/logrotate.conf" /etc/logrotate.d/memonogi
install -m 0644 "$source_dir/compose.backup.yml" "$source_dir/backup.mjs" /opt/memonogi-backup/
for unit in memonogi-db-backup.service memonogi-db-backup.timer memonogi-drive-upload.service memonogi-drive-upload.timer; do
  install -m 0644 "$source_dir/$unit" "/etc/systemd/system/$unit"
done
rsyslogd -N1
logrotate -d /etc/logrotate.d/memonogi
systemd-analyze verify /etc/systemd/system/memonogi-db-backup.service /etc/systemd/system/memonogi-db-backup.timer /etc/systemd/system/memonogi-drive-upload.service /etc/systemd/system/memonogi-drive-upload.timer
systemctl daemon-reload
echo 'Installed; timers were not enabled or started. Follow the production runbook.'
