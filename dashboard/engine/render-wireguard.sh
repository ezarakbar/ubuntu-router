#!/bin/bash
# render-wireguard.sh — kelola interface WireGuard dari DB ke /etc/wireguard
#   * tulis /etc/wireguard/wg<name>.conf (600) untuk tiap interface aktif + peer
#   * apply live via `wg syncconf` (TANPA memutus handshake)
#   * interface baru: wg-quick up + systemctl enable (persist reboot)
#   * interface nonaktif: wg-quick down + systemctl disable
# Idempotent; private key TIDAK pernah diganti kecuali via API keygen.
set -euo pipefail

APP="${APP_DIR:-/opt/ubuntu-router}"
DB="$APP/state/router.db"
WG_DIR="/etc/wireguard"

command -v sqlite3 >/dev/null || { echo "ERROR: sqlite3 tidak ada"; exit 1; }
command -v wg >/dev/null || { echo "ERROR: wireguard-tools tidak ada"; exit 1; }
command -v wg-quick >/dev/null || { echo "ERROR: wg-quick tidak ada"; exit 1; }
[ -d "$WG_DIR" ] || { echo "SKIP: /etc/wireguard tidak ada"; exit 0; }

# tabel wg mungkin belum dibuat saat boot pertama dashboard — lewati dengan aman
if ! sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='wg_interfaces';" 2>/dev/null | grep -q wg_interfaces; then
    echo "SKIP: tabel wg_interfaces belum ada (dashboard belum seed)"
    exit 0
fi

if [ "${SKIP_APPLY:-0}" = "1" ]; then
    echo "DRY-RUN: wireguard hanya dicek (tidak diterapkan)"
    sqlite3 -separator '|' "$DB" \
      "SELECT name, listen_port, address, active FROM wg_interfaces ORDER BY id;" 2>/dev/null || true
    exit 0
fi

# ---- terapkan tiap interface aktif ----
while IFS='|' read -r id name port addr dns priv; do
    [ -n "$name" ] || continue
    [ -n "$priv" ] || { echo "SKIP $name: private key kosong"; continue; }
    conf="$WG_DIR/$name.conf"
    {
        echo "[Interface]"
        echo "Address = $addr"
        echo "ListenPort = ${port:-51820}"
        echo "PrivateKey = $priv"
        [ -n "$dns" ] && echo "DNS = $dns"
        echo
        while IFS='|' read -r pname pub psk allow ep keep; do
            [ -n "$pub" ] || continue
            echo "[Peer]"
            [ -n "$pname" ] && echo "# $pname"
            echo "PublicKey = $pub"
            [ -n "$psk" ] && echo "PresharedKey = $psk"
            echo "AllowedIPs = ${allow:-0.0.0.0/0}"
            [ -n "$ep" ] && echo "Endpoint = $ep"
            echo "PersistentKeepalive = ${keep:-25}"
            echo
        done < <(sqlite3 -separator '|' "$DB" \
          "SELECT name, public_key, preshared_key, allowed_ips, endpoint, persistent_keepalive
           FROM wg_peers WHERE iface_id=$id AND active=1 ORDER BY id;" 2>/dev/null || true)
    } > "$conf"
    chmod 600 "$conf"

    if ip link show "$name" >/dev/null 2>&1; then
        wg syncconf "$name" <(wg-quick strip "$conf")
        echo "OK: $name syncconf diterapkan"
    else
        wg-quick up "$conf"
        systemctl enable "wg-quick@$name.service" >/dev/null 2>&1 || true
        echo "OK: $name dibuat & diaktifkan (wg-quick)"
    fi
done < <(sqlite3 -separator '|' "$DB" \
  "SELECT id, name, listen_port, address, dns, private_key FROM wg_interfaces
   WHERE active=1 ORDER BY id;" 2>/dev/null || true)

# ---- nonaktifkan interface yang dimatikan di DB ----
while IFS='|' read -r name; do
    [ -n "$name" ] || continue
    if ip link show "$name" >/dev/null 2>&1; then
        wg-quick down "$name" 2>/dev/null || true
    fi
    systemctl disable "wg-quick@$name.service" >/dev/null 2>&1 || true
    echo "OK: $name dinonaktifkan"
done < <(sqlite3 -separator '|' "$DB" \
  "SELECT name FROM wg_interfaces WHERE active=0;" 2>/dev/null || true)

echo "OK: wireguard diterapkan"