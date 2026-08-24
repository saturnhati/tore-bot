#!/usr/bin/env bash
# Backup locale del database (sul server).
# I dati personali NON vanno mai su GitHub: restano sul server, in ./backups.
set -euo pipefail

cd "$(dirname "$0")"

node backup.js
