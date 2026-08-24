#!/usr/bin/env bash
# Aggiorna il bot sul server: scarica il codice, ricompila, riavvia.
# Da lanciare SUL SERVER: cd ~/tore-bot && ./deploy.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "→ scarico le modifiche da GitHub"
git pull --rebase --autostash

echo "→ dipendenze"
npm ci --silent

echo "→ compilo"
npm run build

echo "→ riavvio il servizio"
sudo systemctl restart torebot
sleep 4

echo
echo "→ stato: $(systemctl is-active torebot)"
sudo journalctl -u torebot -n 8 --no-pager -o cat
