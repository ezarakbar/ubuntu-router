#!/bin/bash
# render-tc.sh — Simple Queue per-pelanggan (setara MikroTik)
#   DOWN: shape pada egress interface LAN (filter dst=IP pelanggan)
#   UP  : redirect ingress LAN ke ifb, shape egress ifb (filter src=IP)
# Rate mengikuti profile pelanggan (kbit). Idempotent (reset penuh).
set -euo pipefail

APP="${APP_DIR:-/opt/ubuntu-router}"
STATE="$APP/state"
GEN="$STATE/gen"
DB="$STATE/router.db"
OUT="$GEN/tc-customers.sh"

LAN_IF="${LAN_IF:-br-lan}"
IFB="${IFB_IF:-ifb1}"
IFACE_BITRATE="${IFACE_BITRATE:-100mbit}"
DEFAULT_RATE="${DEFAULT_RATE:-1mbit}"
DNSMASQ_LEASES="/var/lib/misc/dnsmasq.leases"

command -v sqlite3 >/dev/null || { echo "ERROR: sqlite3 tidak ada"; exit 1; }
command -v tc >/dev/null || { echo "ERROR: iproute2/tc tidak ada"; exit 1; }
mkdir -p "$GEN"

lease_ip() {
    local mac="$1"
    [ -n "$mac" ] || return 0
    [ -f "$DNSMASQ_LEASES" ] || return 0
    awk -v m="$mac" '{ x=tolower($2); gsub(/:/,"",x); if (x==m) {print $3; exit} }' "$DNSMASQ_LEASES"
}

# kumpulkan pelanggan aktif dengan IP efektif
rows=$(sqlite3 -separator '|' "$DB" \
  "SELECT c.name, lower(c.mac), COALESCE(c.static_ip,''), p.rate_down_kbit, p.rate_up_kbit, COALESCE(p.burst_down_kbit,0), COALESCE(p.burst_up_kbit,0)
   FROM customers c JOIN profiles p ON p.id=c.profile_id
   WHERE c.active=1 AND c.type='dhcp' ORDER BY c.id;" 2>/dev/null || true)

declare -A DOWN UP BDOWN BUP
n=0
while IFS='|' read -r name mac ip down up bd bu; do
    [ -n "$name" ] || continue
    eff="$ip"
    [ -n "$eff" ] || eff=$(lease_ip "$mac")
    [ -n "$eff" ] || continue
    DOWN["$eff"]="${down:-1000}"
    UP["$eff"]="${up:-1000}"
    BDOWN["$eff"]="${bd:-0}"
    BUP["$eff"]="${bu:-0}"
    n=$((n+1))
done <<< "$rows"

if ! ip link show "$LAN_IF" >/dev/null 2>&1; then
    echo "SKIP: interface $LAN_IF tidak ada (queue belum diterapkan)"
    exit 0
fi

{
    echo '#!/bin/bash'
    echo 'set -e'
    echo "LAN_IF=$LAN_IF"
    echo "IFB=$IFB"
    echo "IFACE_BITRATE=$IFACE_BITRATE"
    echo "DEFAULT_RATE=$DEFAULT_RATE"
    echo
    echo '# ---- siapkan ifb (UP direction) ----'
    echo 'modprobe ifb 2>/dev/null || true'
    echo "ip link add \$IFB type ifb 2>/dev/null || true"
    echo 'ip link set $IFB up'
    echo
    echo '# ---- reset ----'
    echo 'tc qdisc del dev $LAN_IF root 2>/dev/null || true'
    echo 'tc qdisc del dev $LAN_IF ingress 2>/dev/null || true'
    echo 'tc qdisc del dev $IFB root 2>/dev/null || true'
    echo
    echo '# ---- DOWN: HTB pada egress LAN (filter dst=IP pelanggan) ----'
    echo 'tc qdisc add dev $LAN_IF root handle 1: htb default 9999'
    echo 'tc class add dev $LAN_IF parent 1: classid 1:9999 htb rate $DEFAULT_RATE ceil $IFACE_BITRATE'
    echo
    echo '# ---- UP: redirect ingress LAN -> ifb, lalu HTB di ifb (filter src=IP) ----'
    echo 'tc qdisc add dev $LAN_IF handle ffff: ingress'
    echo 'tc filter add dev $LAN_IF parent ffff: protocol ip u32 match u32 0 0 action mirred egress redirect dev $IFB'
    echo 'tc qdisc add dev $IFB root handle 1: htb default 9999'
    echo 'tc class add dev $IFB parent 1: classid 1:9999 htb rate $DEFAULT_RATE ceil $IFACE_BITRATE'
    echo
    id=100
    for ip in "${!DOWN[@]}"; do
        id=$((id+1))
        down="${DOWN[$ip]}"
        up="${UP[$ip]}"
        bd="${BDOWN[$ip]}"
        bu="${BUP[$ip]}"
        [ "$bd" -gt 0 ] 2>/dev/null && dburst=" burst ${bd}k cburst ${bd}k" || dburst=""
        [ "$bu" -gt 0 ] 2>/dev/null && uburst=" burst ${bu}k cburst ${bu}k" || uburst=""
        echo "# $ip"
        echo "tc class add dev \$LAN_IF parent 1: classid 1:$id htb rate ${down}kbit ceil ${down}kbit$dburst"
        echo "tc filter add dev \$LAN_IF parent 1: protocol ip prio $id u32 match ip dst $ip flowid 1:$id"
        echo "tc class add dev \$IFB parent 1: classid 1:$id htb rate ${up}kbit ceil ${up}kbit$uburst"
        echo "tc filter add dev \$IFB parent 1: protocol ip prio $id u32 match ip src $ip flowid 1:$id"
    done
} > "$OUT"

bash "$OUT"
echo "OK: simple queue diterapkan ($n pelanggan) — $OUT"