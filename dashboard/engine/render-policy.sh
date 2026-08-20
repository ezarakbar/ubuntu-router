#!/bin/bash
# render-policy.sh — policy routing (setara RouterOS routing rules)
#   Mangle menandai paket (fwmark) -> ip rule fwmark X lookup table N
#   Tabel routing diisi default route via next-hop/interface.
# Idempotent: rule dengan priority di tabel ini dihapus lalu dibuat ulang.
set -euo pipefail

APP="${APP_DIR:-/opt/ubuntu-router}"
DB="$APP/state/router.db"
MARKER="$APP/state/gen/policy-applied.txt"

command -v sqlite3 >/dev/null || { echo "ERROR: sqlite3 tidak ada"; exit 1; }
command -v ip >/dev/null || { echo "ERROR: iproute2 tidak ada"; exit 1; }

if [ "${SKIP_APPLY:-0}" = "1" ]; then
    echo "DRY-RUN: policy routing dicek (tidak diterapkan)"
    sqlite3 -separator $'\t' "$DB" \
      "SELECT mark, table_id, priority, via, dev FROM policy_routes
       WHERE active=1 ORDER BY priority, id;" 2>/dev/null
    exit 0
fi

# ---- hapus rule engine yang tercatat sebelumnya (priority dari marker) ----
if [ -f "$MARKER" ]; then
    while read -r pri; do
        [ -n "$pri" ] || continue
        ip rule del priority "$pri" 2>/dev/null || true
    done < "$MARKER"
fi

# ---- hapus route default lama di tabel yang dipakai DB (agar tidak kadaluarsa) ----
while IFS=$'\t' read -r t; do
    [ -n "$t" ] || continue
    ip route del default table "$t" 2>/dev/null || true
done < <(sqlite3 -separator $'\t' "$DB" \
    "SELECT DISTINCT table_id FROM policy_routes;" 2>/dev/null || true)

# ---- terapkan ulang & catat priority ----
applied=0
: > "$MARKER"
while IFS=$'\t' read -r mark table pri via dev; do
    [ -n "$mark" ] || continue
    if [ -n "$via" ] && [ -n "$dev" ]; then
        ip route add default via "$via" dev "$dev" table "$table" 2>/dev/null || true
    elif [ -n "$via" ]; then
        ip route add default via "$via" table "$table" 2>/dev/null || true
    elif [ -n "$dev" ]; then
        ip route add default dev "$dev" table "$table" 2>/dev/null || true
    fi
    ip rule add priority "$pri" fwmark "$mark" lookup "$table" 2>/dev/null || true
    echo "$pri" >> "$MARKER"
    applied=$((applied+1))
done < <(sqlite3 -separator $'\t' "$DB" \
    "SELECT mark, table_id, priority, via, dev FROM policy_routes
     WHERE active=1 ORDER BY priority, id;" 2>/dev/null || true)

echo "OK: policy routing diterapkan ($applied rule)"