#!/usr/bin/env bash
# One-shot deploy for the Kazzhol AI bot onto a fresh Ubuntu/Debian VPS.
# Idempotent: safe to re-run for updates (pulls latest, reinstalls deps, restarts).
#
# Usage (on the server, as a sudo-capable user):
#   git clone <repo> /opt/kazzhol-ai && cd /opt/kazzhol-ai
#   cp .env.example .env && nano .env      # fill secrets
#   sudo bash deploy/deploy.sh bot.kazzhol.com
#
# Arg 1: the public domain/subdomain for webhooks (must already point to this VPS).
set -euo pipefail

DOMAIN="${1:?Usage: deploy.sh <domain e.g. bot.kazzhol.com>}"
APP_DIR="/opt/kazzhol-ai"
SERVICE_USER="kazzhol"

echo "==> 1/6 Node.js 20 (skip if present)"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> 2/6 System user + app dir"
id -u "$SERVICE_USER" >/dev/null 2>&1 || sudo useradd -r -s /usr/sbin/nologin "$SERVICE_USER"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

echo "==> 3/6 Dependencies"
[ -f "$APP_DIR/.env" ] || { echo "ERROR: $APP_DIR/.env missing — copy .env.example and fill it first."; exit 1; }
sudo chmod 600 "$APP_DIR/.env"
( cd "$APP_DIR" && sudo -u "$SERVICE_USER" npm ci --omit=dev && sudo -u "$SERVICE_USER" npm run typecheck )

echo "==> 4/6 systemd service"
sudo cp "$APP_DIR/deploy/kazzhol-bot.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable kazzhol-bot
sudo systemctl restart kazzhol-bot

echo "==> 5/6 Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update && sudo apt-get install -y caddy
fi
sudo sed "s/bot.kazzhol.com/${DOMAIN}/g" "$APP_DIR/deploy/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl restart caddy

echo "==> 6/6 Health check"
sleep 4
curl -fsS "http://127.0.0.1:3000/healthz" && echo " — local OK"
echo
echo "Done. Next:"
echo "  - Point Meta webhook to https://${DOMAIN}/webhooks/whatsapp (verify token = WHATSAPP_VERIFY_TOKEN in .env)"
echo "  - Staff console: https://${DOMAIN}/console  (admin seeded from CONSOLE_ADMIN_PASSWORD)"
echo "  - Logs: journalctl -u kazzhol-bot -f"
