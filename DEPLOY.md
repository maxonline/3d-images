# Deploying

The app is 100% static — nginx serves the files in `web/` directly. There's
no application process to keep alive, so no custom systemd service is
needed; nginx already autostarts on boot via its own `nginx.service`.

Target server: `max@192.168.50.31`, served from `/home/max/apps/image3d/`
as `image3d.maxonline.se` (DNS already points here). The server already
hosts another site, `colrize.com` (proxied to local port 8080) — the setup
below only adds a new nginx site alongside it and never touches that config.

## One-time server setup

From your local machine (prompts for your SSH key passphrase, then sudo
password on the server):

```sh
./deploy/server-setup.sh
```

This installs nginx + certbot if missing, creates the deploy directory, and
adds the nginx site from `deploy/nginx.conf` (HTTP only, port 80) via the
standard `sites-available`/`sites-enabled` layout. Safe to re-run.

Then push the site files (see below), and provision HTTPS — one-time,
interactive (asks for an email + ToS agreement):

```sh
ssh max@192.168.50.31
sudo certbot --nginx -d image3d.maxonline.se
```

Certbot rewrites the nginx config in place to add the HTTPS server block and
an HTTP→HTTPS redirect, and sets up auto-renewal. `deploy/nginx.conf` in
this repo stays as the original pre-certbot version for reference — it
won't match the live server config exactly after this step, and that's
expected.

## Routine deploys

```sh
./deploy.sh
```

Rsyncs `web/` to the server and fixes permissions so nginx can read the new
files. Since nginx serves them directly, changes are live immediately — no
restart or reload needed. Use `./deploy.sh --dry-run` to preview what would
change first.
