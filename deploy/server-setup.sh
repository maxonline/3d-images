#!/bin/sh
# One-time production server setup for image3d.maxonline.se.
#
# Installs nginx/certbot if missing, creates the deploy directory, and adds
# an nginx site for this domain WITHOUT touching any other site already
# configured on the server (e.g. colrize.com). Safe to re-run.
#
# Run from your local machine: ./deploy/server-setup.sh
# Requires SSH key access + sudo on the remote server (will prompt for your
# key passphrase and sudo password interactively).
set -eu

REMOTE_HOST="max@192.168.50.31"
DOMAIN="image3d.maxonline.se"
DEPLOY_PATH="/home/max/apps/image3d"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

echo "Copying nginx site config to $REMOTE_HOST..."
scp "$SCRIPT_DIR/nginx.conf" "$REMOTE_HOST:/tmp/$DOMAIN.conf"

ssh -t "$REMOTE_HOST" "
  set -eu
  sudo apt update
  sudo apt install -y nginx certbot python3-certbot-nginx

  mkdir -p '$DEPLOY_PATH'

  # nginx (running as www-data) needs traverse (x) permission on every
  # directory in the path down to the app files — home directories are
  # commonly 750, which would otherwise block it. This only grants
  # traversal, not listing (\`ls /home/max\` still requires read).
  chmod o+x /home/max

  sudo mv \"/tmp/$DOMAIN.conf\" \"/etc/nginx/sites-available/$DOMAIN\"
  sudo ln -sf \"/etc/nginx/sites-available/$DOMAIN\" \"/etc/nginx/sites-enabled/$DOMAIN\"
  sudo nginx -t
  sudo systemctl reload nginx
"

echo ""
echo "nginx site for $DOMAIN is live on port 80 (existing sites untouched)."
echo "Next steps:"
echo "  1. ./deploy.sh                              # upload the site files"
echo "  2. ssh $REMOTE_HOST"
echo "     sudo certbot --nginx -d $DOMAIN           # one-time, interactive HTTPS setup"
