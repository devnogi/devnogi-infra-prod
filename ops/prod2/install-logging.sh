#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run as root after production approval' >&2
  exit 1
fi

for program in install chown chmod rsyslogd logrotate systemctl; do
  command -v "$program" >/dev/null || { echo "Missing dependency: $program" >&2; exit 1; }
done

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for service in auth community batch gateway react; do
  install -d -o syslog -g adm -m 0750 "/var/log/memonogi/$service"
  log_file="/var/log/memonogi/$service/application.log"
  if [ -f "$log_file" ]; then
    chown syslog:adm "$log_file"
    chmod 0640 "$log_file"
  fi
done

install -m 0644 "$source_dir/rsyslog.conf" /etc/rsyslog.d/30-memonogi.conf
install -m 0644 "$source_dir/logrotate.conf" /etc/logrotate.d/memonogi

rsyslogd -N1
logrotate -d /etc/logrotate.d/memonogi
echo 'Logging settings installed. Restart rsyslog explicitly after reviewing validation output.'
