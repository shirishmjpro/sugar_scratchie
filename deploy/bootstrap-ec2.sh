#!/usr/bin/env bash
set -euo pipefail

# Run on a fresh Ubuntu 22.04/24.04 EC2 instance as ubuntu (after cloning the repo).
# Usage:
#   sudo DOMAIN=scratchie.example.com bash deploy/bootstrap-ec2.sh

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo, e.g. sudo DOMAIN=your.domain bash deploy/bootstrap-ec2.sh"
  exit 1
fi

DOMAIN="${DOMAIN:-}"
if [[ -z "${DOMAIN}" ]]; then
  echo "Set DOMAIN, e.g. sudo DOMAIN=scratchie.example.com bash deploy/bootstrap-ec2.sh"
  exit 1
fi

APP_DIR="/opt/sugar-scratchie"
APP_USER="ubuntu"

apt-get update
apt-get install -y nginx certbot python3-certbot-nginx git curl ffmpeg

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "Clone the repo to ${APP_DIR} first, then re-run this script."
  exit 1
fi

cd "${APP_DIR}"
sudo -u "${APP_USER}" npm ci
sudo -u "${APP_USER}" npm run build

if [[ ! -d "${APP_DIR}/.venv" ]]; then
  sudo -u "${APP_USER}" python3 -m venv "${APP_DIR}/.venv"
fi
sudo -u "${APP_USER}" "${APP_DIR}/.venv/bin/pip" install -r backend/requirements.txt

if [[ ! -f "${APP_DIR}/.env" ]]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
  echo "Created ${APP_DIR}/.env — add XAI_API_KEY and CORS_ORIGINS before starting the API."
fi

sed "s/YOUR_DOMAIN/${DOMAIN}/g" "${APP_DIR}/deploy/nginx/sugar-scratchie.conf" \
  > /etc/nginx/sites-available/sugar-scratchie
ln -sf /etc/nginx/sites-available/sugar-scratchie /etc/nginx/sites-enabled/sugar-scratchie
rm -f /etc/nginx/sites-enabled/default

cp "${APP_DIR}/deploy/systemd/sugar-scratchie-api.service" /etc/systemd/system/sugar-scratchie-api.service
systemctl daemon-reload
systemctl enable sugar-scratchie-api
systemctl restart sugar-scratchie-api
nginx -t
systemctl reload nginx

certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}" || true

echo
echo "Bootstrap complete."
echo "  App:      https://${DOMAIN}/"
echo "  Dashboard: https://${DOMAIN}/dashboard"
echo "  API health: https://${DOMAIN}/api/health"
echo
echo "Ensure ${APP_DIR}/.env contains:"
echo "  XAI_API_KEY=sk-..."
echo "  CORS_ORIGINS=https://${DOMAIN}"
echo "Then: sudo systemctl restart sugar-scratchie-api"
