#!/bin/sh
set -eu

# Certbot invokes deploy hooks only after a successful renewal.
nginx -t
systemctl reload nginx
