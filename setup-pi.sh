#!/usr/bin/env bash
# Run this on your Raspberry Pi to install and start zotero-timeline.
# Usage: curl -fsSL https://raw.githubusercontent.com/lucash0rta/zotero-timeline/main/setup-pi.sh | bash

set -euo pipefail

REPO="https://github.com/lucash0rta/zotero-timeline.git"
APP_DIR="$HOME/zotero-timeline"
APP_NAME="zotero-timeline"

echo ""
echo "=== Zotero Timeline — Pi Setup ==="
echo ""

# ── Node.js ───────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node --version | cut -c2-3)" -lt 20 ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "Node.js $(node --version) already installed."
fi

# ── PM2 ───────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  echo "Installing PM2..."
  sudo npm install -g pm2
else
  echo "PM2 $(pm2 --version) already installed."
fi

# ── Clone or update repo ──────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo "Pulling latest from GitHub..."
  git -C "$APP_DIR" pull
else
  echo "Cloning repo..."
  git clone "$REPO" "$APP_DIR"
fi

cd "$APP_DIR"
npm install --omit=dev

# ── .env ─────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "------------------------------------------------------------"
  echo "  Created .env — edit it before starting:"
  echo "    nano $APP_DIR/.env"
  echo ""
  echo "  Required:"
  echo "    WEBDAV_BASE   your WebDAV URL"
  echo "    WEBDAV_USER   WebDAV username"
  echo "    WEBDAV_PASS   WebDAV password"
  echo "    APP_USER      login username for the web UI"
  echo "    APP_PASS      login password for the web UI"
  echo "    WEBHOOK_SECRET  run: openssl rand -hex 32"
  echo "------------------------------------------------------------"
  echo ""
  read -p "Edit .env now? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    ${EDITOR:-nano} .env
  fi
fi

# ── PM2 start ─────────────────────────────────────────────────
if pm2 list | grep -q "$APP_NAME"; then
  echo "Restarting existing PM2 process..."
  pm2 restart "$APP_NAME"
else
  echo "Starting with PM2..."
  pm2 start server.js --name "$APP_NAME"
fi

pm2 save

# Auto-start on boot
echo "Configuring PM2 startup..."
pm2 startup | grep "sudo" | bash || true

# ── nginx snippet ─────────────────────────────────────────────
PORT=$(grep '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3001)

echo ""
echo "=== Done! App is running on port $PORT ==="
echo ""
echo "Add this to your nginx config (e.g. /etc/nginx/sites-available/timeline):"
echo ""
cat <<NGINX
server {
    listen 80;
    server_name timeline.unshittify.cc;

    # Forward to Node app
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;

        # Required for Server-Sent Events (scan/enrich progress)
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding on;
        proxy_read_timeout 300s;
    }
}
NGINX

echo ""
echo "Then run:"
echo "  sudo ln -s /etc/nginx/sites-available/timeline /etc/nginx/sites-enabled/"
echo "  sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "In Cloudflare: add an A record  timeline → your Pi's IP."
echo "Set SSL/TLS mode to 'Flexible' (Cloudflare → Pi is plain HTTP)."
echo ""
echo "Add the GitHub webhook:"
echo "  Repo → Settings → Webhooks → Add webhook"
echo "  Payload URL: https://timeline.unshittify.cc/webhook"
echo "  Content type: application/json"
echo "  Secret: the WEBHOOK_SECRET value from your .env"
echo "  Events: Just the push event"
echo ""
