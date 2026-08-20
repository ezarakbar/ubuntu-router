#!/bin/bash
# render-nft.sh — generate + apply nftables dinamis (tabel ip ur_dyn)
#   * set pelanggan aktif (customers) + address-list user (al_<name>)
#   * chain NAT pre/post (dstnat/srcnat)
#   * chain filter input/forward/output
#   * chain mangle (mark packet/connection utk policy routing)
# Idempotent: seluruh tabel ur_dyn ditulis ulang penuh.
# Catatan: separator sqlite memakai '|' (tab = whitespace, bakal di-collapse read).
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

norm() { printf '%s' "$1" | tr -cd 'A-Za-z0-9_.'; echo; }

# cari IP aktif pelanggan dari lease dnsmasq (MAC tanpa separator)
lease_ip() {
    local mac="$1"
    [ -n "$mac" ] || return 0
    [ -f "$DNSMASQ_LEASES" ] || return 0
    awk -v m="$mac" '{ x=tolower($2); gsub(/:/,"",x); if (x==m) {print $3; exit} }' "$DNSMASQ_LEASES"
}

# ---- kumpulkan IP pelanggan aktif ----
cust_rows=$(sqlite3 -separator '|' "$DB" \
  "SELECT c.name, lower(c.mac), COALESCE(c.static_ip,''), p.rate_down_kbit
   FROM customers c JOIN profiles p ON p.id=c.profile_id
   WHERE c.active=1 AND c.type='dhcp' ORDER BY c.id;" 2>/dev/null || true)

cust_elems=()
while IFS='|' read -r name mac ip down; do
    [ -n "$name" ] || continue
    eff="$ip"
    [ -n "$eff" ] || eff=$(lease_ip "$mac")
    [ -n "$eff" ] || continue
    cust_elems+=("$eff")
done <<< "$cust_rows"

# ---- address-list user: nama yang direferensikan rule + definisi ----
list_names=$(sqlite3 -separator $'\n' "$DB" "
  SELECT name FROM address_lists
  UNION SELECT src_list FROM firewall_rules WHERE src_list IS NOT NULL AND src_list != ''
  UNION SELECT dst_list FROM firewall_rules WHERE dst_list IS NOT NULL AND dst_list != ''
  UNION SELECT src_list FROM mangle_rules WHERE src_list IS NOT NULL AND src_list != ''
  UNION SELECT dst_list FROM mangle_rules WHERE dst_list IS NOT NULL AND dst_list != ''
  ORDER BY name;" 2>/dev/null | while read -r n; do [ -n "$n" ] && norm "$n"; done)

list_elems() {
    local lname="$1"
    sqlite3 -separator $'\n' "$DB" \
      "SELECT e.address FROM address_list_entries e
       JOIN address_lists l ON l.id=e.list_id WHERE l.name='$lname'
       ORDER BY e.id;" 2>/dev/null | while read -r a; do [ -n "$a" ] && echo "$a"; done
}

# ---- matcher umum (filter & mangle) ----
m() {
    # $1=proto $2=src $3=dst $4=sport $5=dport $6=srclist $7=dstlist $8=state
    local out=()
    [ -n "$2" ] && out+=("ip saddr $2")
    [ -n "$3" ] && out+=("ip daddr $3")
    [ -n "$6" ] && out+=("ip saddr @al_$(norm "$6")")
    [ -n "$7" ] && out+=("ip daddr @al_$(norm "$7")")
    if [ -n "$1" ]; then
        out+=("ip protocol $1")
        [ -n "$4" ] && out+=("$1 sport $4")
        [ -n "$5" ] && out+=("$1 dport $5")
    fi
    [ -n "$8" ] && out+=("ct state $8")
    printf '%s' "${out[*]}"
}

# ======================================================================
# tulis file nft
# ======================================================================
{
    echo '#!/usr/sbin/nft -f'
    echo
    echo 'table ip ur_dyn {'

    # ---- set pelanggan aktif ----
    if [ ${#cust_elems[@]} -gt 0 ]; then
        printf '  set customers { type ipv4_addr; flags interval; elements = { %s } }\n' "$(IFS=,; echo "${cust_elems[*]}")"
    else
        echo '  set customers { type ipv4_addr; flags interval; }'
    fi

    # ---- set address-list user ----
    if [ -n "$list_names" ]; then
        echo
        while read -r lname; do
            [ -n "$lname" ] || continue
            elems=$(list_elems "$lname")
            if [ -n "$elems" ]; then
                printf '  set al_%s { type ipv4_addr; flags interval; elements = { %s } }\n' \
                    "$lname" "$(echo "$elems" | paste -sd, -)"
            else
                printf '  set al_%s { type ipv4_addr; flags interval; }\n' "$lname"
            fi
        done <<< "$list_names"
    fi
    echo

    # ============================ NAT pre ============================
    echo '  chain pre {'
    echo '    type nat hook prerouting priority dstnat; policy accept;'
    sqlite3 -separator '|' "$DB" \
      "SELECT proto, src_address, dst_address, src_port, dst_port, to_addresses, to_ports, comment
       FROM nat_rules WHERE active=1 AND chain='dstnat'
       ORDER BY position IS NULL, position, id;" 2>/dev/null \
    | while IFS='|' read -r proto src dst sport dport toa top cmt; do
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

    # ============================ NAT post ===========================
    echo '  chain post {'
    echo '    type nat hook postrouting priority srcnat; policy accept;'
    sqlite3 -separator '|' "$DB" \
      "SELECT proto, src_address, dst_address, src_port, dst_port, to_addresses, to_ports, action, comment
       FROM nat_rules WHERE active=1 AND chain='srcnat'
       ORDER BY position IS NULL, position, id;" 2>/dev/null \
    | while IFS='|' read -r proto src dst sport dport toa top act cmt; do
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
    echo

    # ====================== filter input/forward/output ==============
    for ch in input forward output; do
        echo "  chain filter_$ch {"
        echo "    type filter hook $ch priority 0; policy accept;"
        sqlite3 -separator '|' "$DB" \
          "SELECT proto, src_address, dst_address, src_port, dst_port, src_list, dst_list, connstate, icmp_type, limit_rate, action, comment
           FROM firewall_rules WHERE active=1 AND chain='$ch'
           ORDER BY position IS NULL, position, id;" 2>/dev/null \
        | while IFS='|' read -r proto src dst sport dport srcl dstl state icmp lim act cmt; do
            parts=$(m "$proto" "$src" "$dst" "$sport" "$dport" "$srcl" "$dstl" "$state")
            [ -n "$icmp" ] && parts="$parts icmp type $icmp"
            [ -n "$lim" ] && parts="$parts limit rate $lim"
            case "$act" in
                accept) stmt="accept";;
                drop)   stmt="drop";;
                reject) stmt="reject";;
                log)    stmt="log";;
                *)      stmt="drop";;
            esac
            line="    ${parts} $stmt"
            [ -n "$cmt" ] && line="$line comment \"$cmt\""
            printf '%s\n' "$line"
        done
        echo '  }'
        echo
    done

    # ============================ mangle =============================
    for chain_db in prerouting input forward output postrouting; do
        mch="mangle_${chain_db:0:3}"
        hook="$chain_db"
        echo "  chain $mch {"
        echo "    type filter hook $hook priority -150; policy accept;"
        sqlite3 -separator '|' "$DB" \
          "SELECT proto, src_address, dst_address, src_port, dst_port, src_list, dst_list, action, mark, comment
           FROM mangle_rules WHERE active=1 AND chain='$chain_db'
           ORDER BY position IS NULL, position, id;" 2>/dev/null \
        | while IFS='|' read -r proto src dst sport dport srcl dstl act mk cmt; do
            parts=$(m "$proto" "$src" "$dst" "$sport" "$dport" "$srcl" "$dstl" "")
            case "$act" in
                mark_packet)     stmt="meta mark set $mk";;
                mark_connection) stmt="ct mark set $mk";;
                accept)          stmt="accept";;
                drop)            stmt="drop";;
                *)               stmt="accept";;
            esac
            line="    ${parts} $stmt"
            [ -n "$cmt" ] && line="$line comment \"$cmt\""
            printf '%s\n' "$line"
        done
        echo '  }'
        echo
    done

    echo '}'
} > "$OUT"

if [ "${SKIP_APPLY:-0}" = "1" ]; then
    echo "DRY-RUN: file nft siap di $OUT (tidak diterapkan)"
    exit 0
fi
# nft -f bersifat merge/add dan flush table tidak menghapus set/chains:
# gunakan delete table lalu terapkan ulang agar idempotent penuh.
nft delete table ip ur_dyn 2>/dev/null || true
nft -f "$OUT"
echo "OK: nft diterapkan ($OUT)"