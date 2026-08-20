#!/bin/bash
# render-nft.sh — generate + apply nftables dinamis (tabel ip ur_dyn)
#   * address-list pelanggan aktif (tag IP per pelanggan)
#   * rule NAT dstnat (port-forward) dari router.db
# Idempotent: seluruh tabel ur_dyn ditulis ulang penuh; tidak menyentuh
# tabel base router (inet router / router-nat).
set -euo pipefail

APP="${APP_DIR:-/opt/ubuntu-router}"
STATE="$APP/state"
GEN="$STATE/gen"
DB="$STATE/router.db"
OUT="$GEN/ur-dyn.nft"
DNSMASQ_LEASES="/var/lib/misc/dnsmasq.leases"

command -v sqlite3 >/dev/null || { echo "ERROR: sqlite3 tidak ada"; exit 1; }
command -v nft >/dev/null || { echo "ERROR: nft tidak ada"; exit 1; }
mkdir -p "$GEN"

# helper: cari IP aktif pelanggan dari lease dnsmasq berdasarkan MAC
lease_ip() {
    local mac="$1"
    [ -n "$mac" ] || return 0
    [ -f "$DNSMASQ_LEASES" ] || return 0
    awk -v m="$mac" '{ x=tolower($2); gsub(/:/,"",x); if (x==m) {print $3; exit} }' "$DNSMASQ_LEASES"
}

# ambil daftar pelanggan aktif + IP efektifnya
rows=$(sqlite3 -separator '|' "$DB" \
  "SELECT c.name, lower(c.mac), COALESCE(c.static_ip,''), p.rate_down_kbit
   FROM customers c JOIN profiles p ON p.id=c.profile_id
   WHERE c.active=1 AND c.type='dhcp' ORDER BY c.id;" 2>/dev/null || true)

elements=()
declare -A cust_ip
while IFS='|' read -r name mac ip down; do
    [ -n "$name" ] || continue
    eff="$ip"
    [ -n "$eff" ] || eff=$(lease_ip "$mac")
    [ -n "$eff" ] || continue
    cust_ip["$name"]="$eff"
    elements+=("$eff")
done <<< "$rows"

{
    echo '#!/usr/sbin/nft -f'
    echo
    echo 'table ip ur_dyn {'
    if [ ${#elements[@]} -gt 0 ]; then
        printf '  set customers { type ipv4_addr; flags interval; elements = { %s } }\n' "$(IFS=,; echo "${elements[*]}")"
    else
        echo '  set customers { type ipv4_addr; flags interval; }'
    fi
    echo
    echo '  chain pre {'
    echo '    type nat hook prerouting priority dstnat; policy accept;'
    # rule NAT dstnat
    sqlite3 -separator $'\t' "$DB" \
      "SELECT proto, src_address, dst_address, src_port, dst_port, to_addresses, to_ports, comment
       FROM nat_rules WHERE active=1 AND chain='dstnat'
       ORDER BY position IS NULL, position, id;" 2>/dev/null \
    | while IFS=$'\t' read -r proto src dst sport dport toa top cmt; do
        [ -n "$toa" ] || continue
        p="${proto:-tcp}"
        parts=("ip protocol $p")
        [ -n "$src" ]  && parts+=("ip saddr $src")
        [ -n "$dst" ]  && parts+=("ip daddr $dst")
        [ -n "$sport" ] && parts+=("$p sport $sport")
        [ -n "$dport" ] && parts+=("$p dport $dport")
        target="$toa"; [ -n "$top" ] && target="$toa:$top"
        line="    ${parts[*]} dnat to $target"
        [ -n "$cmt" ] && line="$line comment \"$cmt\""
        printf '%s\n' "$line"
    done
    echo '  }'
    echo
    echo '  chain post {'
    echo '    type nat hook postrouting priority srcnat; policy accept;'
    # rule NAT srcnat (masquerade, snat)
    sqlite3 -separator $'\t' "$DB" \
      "SELECT proto, src_address, dst_address, src_port, dst_port, to_addresses, to_ports, action, comment
       FROM nat_rules WHERE active=1 AND chain='srcnat'
       ORDER BY position IS NULL, position, id;" 2>/dev/null \
    | while IFS=$'\t' read -r proto src dst sport dport toa top act cmt; do
        case "$act" in
            masquerade)
                parts=()
                [ -n "$src" ]  && parts+=("ip saddr $src")
                [ -n "$dst" ]  && parts+=("ip daddr $dst")
                [ -n "$sport" ] && parts+=("ip protocol ${proto:-tcp} sport $sport")
                line="    ${parts[*]} counter masquerade"
                [ -n "$cmt" ] && line="$line comment \"$cmt\""
                printf '%s\n' "$line"
                ;;
            snat)
                [ -n "$toa" ] || continue
                parts=()
                [ -n "$src" ]  && parts+=("ip saddr $src")
                [ -n "$dst" ]  && parts+=("ip daddr $dst")
                [ -n "$sport" ] && parts+=("ip protocol ${proto:-tcp} sport $sport")
                target="$toa"; [ -n "$top" ] && target="$toa:$top"
                line="    ${parts[*]} counter snat to $target"
                [ -n "$cmt" ] && line="$line comment \"$cmt\""
                printf '%s\n' "$line"
                ;;
        esac
    done
    echo '  }'
    echo '}'
} > "$OUT"

nft -f "$OUT"
echo "OK: nft diterapkan ($OUT)"