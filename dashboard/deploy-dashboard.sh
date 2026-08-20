#!/bin/bash
# deploy-dashboard.sh — pasang/mutakhirkan dashboard ubuntu-router (idempotent)
#   - kopi kode ke /opt/ubuntu-router
#   - venv python + dependency
#   - unit systemd + enable
#   - seed DB + render engine pertama (nft, dnsmasq, tc)
# Jalankan dengan sudo. Contoh:
#   sudo bash deploy-dashboard.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "PERLU SUDO: sudo bash deploy-dashboard.sh"; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
APP="/opt/ubuntu-router"
STATE="$APP/state"
GEN="$STATE/gen"
DASH_PASSWORD="${ADMIN_PASSWORD:-admin123}"

echo "==> target: $APP"
mkdir -p "$APP/dashboard" "$APP/engine" "$STATE/gen"

echo "==> menyalin kode dashboard"
cp -r "$SRC/." "$APP/dashboard/"
cp "$SRC"/engine/*.sh "$APP/engine/"
chmod +x "$APP"/engine/*.sh

echo "==> venv python"
if [ ! -x "$APP/.venv/bin/python" ]; then
    python3 -m venv "$APP/.venv"
fi
"$APP/.venv/bin/pip" install -q --upgrade pip >/dev/null
"$APP/.venv/bin/pip" install -q -r "$APP/dashboard/requirements.txt"

echo "==> unit systemd"
sed "s/\${ADMIN_PASSWORD}/$DASH_PASSWORD/" \
    "$APP/dashboard/ubuntu-router-dashboard.service" \
    > /etc/systemd/system/ubuntu-router-dashboard.service
systemctl daemon-reload
systemctl enable ubuntu-router-dashboard.service >/dev/null 2>&1

echo "==> unit engine (oneshot boot)"
cp "$APP/dashboard/ubuntu-router-engine.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable ubuntu-router-engine.service >/dev/null 2>&1

echo "==> engine inisial (nft, dnsmasq, tc, policy)"
for e in render-nft.sh render-dnsmasq.sh render-tc.sh render-policy.sh; do
    echo "    - $e"
    APP_DIR="$APP" LAN_IF="${LAN_IF:-br-lan}" bash "$APP/engine/$e" || echo "    ! $e dilewati (belum sesuai topologi)"
done

echo "==> start dashboard & engine"
systemctl restart ubuntu-router-dashboard.service
systemctl restart ubuntu-router-engine.service
sleep 2

systemctl is-active ubuntu-router-dashboard.service >/dev/null \
    && echo "OK: dashboard aktif di http://<IP>:8081 (login admin / password: $DASH_PASSWORD)" \
    || { echo "GAGAL: cek systemctl status ubuntu-router-dashboard"; exit 1; }