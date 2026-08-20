#!/usr/bin/env bash
# ============================================================================
# ubuntu-router-install.sh
# ----------------------------------------------------------------------------
# Mengubah Ubuntu/Debian Server menjadi ROUTER setara MikroTik RouterOS v7:
#   - FRR            : OSPF + BGP
#   - nftables       : firewall + NAT (tabel terpisah, tidak merusak Docker)
#   - dnsmasq        : DHCP + DNS (bind LAN saja)
#   - WireGuard      : tunnel klien (wg0)
#   - OpenVPN        : static-key VPN (tun)
#   - strongSwan     : IPsec IKEv2 template
#   - FireQOS        : QoS / traffic shaping (HTB)
#   - Cockpit        : Web GUI (port 9090) + SSH (22)
#
# Otomatis:
#   - deteksi distro (apt-based), NIC fisik WAN/LAN (1-NIC -> VLAN, >=2 -> fisik)
#   - backup config lama ke /root/ubuntu-router-backup-<timestamp>/
#   - tulis semua konfigurasi via heredoc, enable semua systemd service
#   - IDEMPOTENT: aman dijalankan ulang
#   - log ke $LOG, variabel env bisa override
#
# Pakai:  curl -sL <RAW_URL> | sudo bash
# Env:    VLAN_ID, LAN_SUBNET, LAN_IP, DHCP_RANGE, WG_SUBNET, WG_PORT,
#         WAN_BANDWIDTH, DNS_UPSTREAM, EXTRA_OPEN_PORTS, WAN_IFACE,
#         LAN_IFACE, DRY_RUN, SDR_LAB_SETUP_SCRIPT, DEPLOY_DASHBOARD,
#         GITHUB_URL
# ============================================================================

set -euo pipefail

# ----------------------------- konfigurasi ---------------------------------
VLAN_ID="${VLAN_ID:-100}"
LAN_BRIDGE="${LAN_BRIDGE:-br-lan}"
LAN_SUBNET="${LAN_SUBNET:-10.10.0.0/24}"
LAN_IP="${LAN_IP:-10.10.0.1}"
DHCP_RANGE="${DHCP_RANGE:-10.10.0.100,10.10.0.200}"
DHCP_LEASE="${DHCP_LEASE:-12h}"
WG_SUBNET="${WG_SUBNET:-10.10.1.0/24}"
WG_IP="${WG_IP:-10.10.1.1}"
WG_PORT="${WG_PORT:-51820}"
OVPN_SUBNET="${OVPN_SUBNET:-10.10.2.0/24}"
OVPN_IP="${OVPN_IP:-10.10.2.1}"
IPSEC_SUBNET="${IPSEC_SUBNET:-10.10.3.0/24}"
WAN_BANDWIDTH="${WAN_BANDWIDTH:-100mbit}"
DNS_UPSTREAM="${DNS_UPSTREAM:-1.1.1.1 8.8.8.8}"
EXTRA_OPEN_PORTS="${EXTRA_OPEN_PORTS:-}"
SDR_LAB_SETUP_SCRIPT="${SDR_LAB_SETUP_SCRIPT:-}"
DRY_RUN="${DRY_RUN:-0}"

LOG="/var/log/ubuntu-router-install.log"
BACKUP_DIR="/root/ubuntu-router-backup-$(date +%Y%m%d-%H%M%S)"

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
die()  { log "ERROR: $*"; exit 1; }
run() {
    if [ "$DRY_RUN" = "1" ]; then log "[dry-run] $*"; else eval "$*"; fi
}

# ---------------------------- cek lingkungan -------------------------------
[ "$(id -u)" = "0" ] || die "Jalankan sebagai root (sudo)."
command -v apt-get >/dev/null 2>&1 || die "Distro harus berbasis apt (Ubuntu/Debian)."
: > "$LOG" 2>/dev/null || die "Tidak bisa menulis $LOG (butuh root)."

log "=== ubuntu-router-install.sh mulai ==="
log "DRY_RUN=$DRY_RUN | VLAN_ID=$VLAN_ID | LAN=$LAN_SUBNET | WG=$WG_SUBNET | OVPN=$OVPN_SUBNET"

DISTRO=$(grep -E '^(ID|VERSION_ID)=' /etc/os-release | tr '\n' ' ')
log "Distro: $DISTRO"

# deteksi renderer netplan: prefer networkd bila sudah dipakai
if systemctl is-active --quiet NetworkManager 2>/dev/null && ! systemctl is-active --quiet systemd-networkd 2>/dev/null; then
    RENDERER="NetworkManager"
else
    RENDERER="networkd"
fi
log "Netplan renderer: $RENDERER"

# --------------------------- deteksi NIC WAN/LAN ---------------------------
detect_nics() {
    local phys=()
    for i in /sys/class/net/*; do
        local dev
        dev=$(basename "$i")
        # NIC fisik: punya /sys/class/net/$dev/device
        if [ -d "$i/device" ]; then
            case "$dev" in
                lo|veth*|docker*|virbr*|br-*|tailscale*|wg*|tun*|tap*|ifb*) ;;
                *) phys+=("$dev") ;;
            esac
        fi
    done
    log "NIC fisik terdeteksi: ${phys[*]:-TIDAK ADA}"

    WAN_IFACE="${WAN_IFACE:-$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')}"
    [ -z "$WAN_IFACE" ] && [ "${#phys[@]}" -gt 0 ] && WAN_IFACE="${phys[0]}"
    [ -z "$WAN_IFACE" ] && die "Tidak bisa mendeteksi interface WAN. Set WAN_IFACE=..."

    LAN_IFACE="${LAN_IFACE:-}"
    if [ "${#phys[@]}" -ge 2 ] && [ -z "$LAN_IFACE" ]; then
        for d in "${phys[@]}"; do
            [ "$d" != "$WAN_IFACE" ] && LAN_IFACE="$d" && break
        done
    fi

    if [ -n "$LAN_IFACE" ]; then
        MODE="multi-nic"
        LAN_VLAN_IFACE=""
        log "MODE multi-NIC: WAN=$WAN_IFACE LAN(fisik)=$LAN_IFACE"
    else
        MODE="single-nic"
        LAN_IFACE="$WAN_IFACE.$VLAN_ID"
        LAN_VLAN_IFACE="$LAN_IFACE"
        log "MODE single-NIC: WAN=$WAN_IFACE LAN=VLAN$VLAN_ID ($LAN_IFACE)"
    fi

    # pertahankan alamat WAN yang sudah ada (statis) jika ada
    WAN_IP=$(ip -4 -o addr show dev "$WAN_IFACE" 2>/dev/null | grep -v ' 127\.' | awk '{print $4; exit}')
    WAN_GW=$(ip -4 route show default dev "$WAN_IFACE" 2>/dev/null | awk '{print $3; exit}')
    if [ -n "$WAN_IP" ] && [ -n "$WAN_GW" ]; then
        WAN_STATIC="yes"
        log "WAN statis terdeteksi: $WAN_IP via $WAN_GW (dipertahankan)"
    else
        WAN_STATIC="no"
        log "WAN akan pakai DHCP4"
    fi
}
detect_nics

# ------------------------------ backup config ------------------------------
backup_configs() {
    mkdir -p "$BACKUP_DIR/netplan" "$BACKUP_DIR/etc"
    cp -a /etc/netplan/. "$BACKUP_DIR/netplan/" 2>/dev/null || true
    for f in nftables.conf sysctl.conf; do
        [ -f "/etc/$f" ] && cp -a "/etc/$f" "$BACKUP_DIR/etc/"
    done
    [ -d /etc/sysctl.d ] && cp -a /etc/sysctl.d "$BACKUP_DIR/etc/"
    log "Backup config -> $BACKUP_DIR"
}
backup_configs

# ------------------------------ install paket ------------------------------
install_packages() {
    log "apt-get update + install paket..."
    DEBIAN_FRONTEND=noninteractive apt-get update -y >>"$LOG" 2>&1
    for attempt in 1 2 3; do
        if DEBIAN_FRONTEND=noninteractive apt-get install -y --fix-missing \
            frr dnsmasq openvpn strongswan fireqos \
            cockpit cockpit-networkmanager cockpit-pcp \
            wireguard-tools nftables iproute2 >>"$LOG" 2>&1; then
            break
        else
            log "apt install gagal (attempt $attempt), coba lagi..."
            sleep 5
        fi
    done
    dpkg -l frr dnsmasq openvpn strongswan fireqos cockpit nftables 2>/dev/null | grep -q '^ii' || die "Installasi paket tidak lengkap."
    log "Paket terinstall."
}
install_packages

# ------------------------------ sysctl -------------------------------------
write_sysctl() {
    cat > /etc/sysctl.d/99-router.conf <<'EOF'
# Router: forward + hardening
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.ip_dynaddr = 1
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
EOF
    sysctl --system >/dev/null 2>&1 || true
    log "sysctl ditulis + diterapkan (ip_forward=1)."
}
write_sysctl

# ------------------------------ netplan ------------------------------------
render_netplan() {
    local NP="/etc/netplan/99-router.yaml"
    # buang file netplan lama (sudah di-backup) agar tidak konflik merge
    run "find /etc/netplan -maxdepth 1 -name '*.yaml' -not -name '99-router.yaml' -delete"

    {
        echo "network:"
        echo "  version: 2"
        echo "  renderer: $RENDERER"
        echo "  ethernets:"
        echo "    $WAN_IFACE:"
        if [ "$WAN_STATIC" = "yes" ]; then
            echo "      addresses:"
            echo "        - $WAN_IP"
            echo "      routes:"
            echo "        - to: default"
            echo "          via: $WAN_GW"
            echo "      nameservers:"
            echo "        addresses:"
            for ns in $DNS_UPSTREAM; do echo "          - $ns"; done
        else
            echo "      dhcp4: true"
        fi
        if [ "$MODE" = "multi-nic" ]; then
            echo "    $LAN_IFACE:"
            echo "      dhcp4: false"
            echo "  bridges:"
            echo "    $LAN_BRIDGE:"
            echo "      interfaces: [$LAN_IFACE]"
            echo "      addresses:"
            echo "        - $LAN_IP/$([[ "$LAN_SUBNET" =~ / ]] && echo "${LAN_SUBNET#*/}" || echo 24)"
        else
            echo "  vlans:"
            echo "    $LAN_VLAN_IFACE:"
            echo "      id: $VLAN_ID"
            echo "      link: $WAN_IFACE"
            echo "  bridges:"
            echo "    $LAN_BRIDGE:"
            echo "      interfaces: [$LAN_VLAN_IFACE]"
            echo "      addresses:"
            echo "        - $LAN_IP/24"
        fi
    } > "$NP"
    chmod 600 "$NP"
    log "netplan ditulis -> $NP (mode=$MODE)"
}
render_netplan

apply_netplan() {
    log "netplan generate + apply..."
    netplan generate >>"$LOG" 2>&1
    netplan apply >>"$LOG" 2>&1 || { log "WARN: netplan apply bermasalah, coba lagi"; netplan apply; }
    sleep 2
    ip -brief a show "$LAN_BRIDGE" 2>/dev/null | sed "s/^/  /" | tee -a "$LOG"
}
apply_netplan

# ------------------------------ nftables -----------------------------------
write_nftables() {
    # daftar port terbuka (router + ekstra)
    local OPEN_TCP="22, 9090"
    local OPEN_UDP="67, 53, 51820, 500, 4500, 1194"
    if [ -n "$EXTRA_OPEN_PORTS" ]; then
        OPEN_TCP="$OPEN_TCP, $EXTRA_OPEN_PORTS"
    fi
    cat > /etc/nftables.conf <<EOF
#!/usr/sbin/nft -f

define WAN_IFACE = $WAN_IFACE
define LAN_BRIDGE = $LAN_BRIDGE

table inet router {
    chain input {
        type filter hook input priority filter; policy drop;
        ct state established,related accept
        ct state invalid drop
        iifname "lo" accept
        iifname "tailscale0" accept
        iifname \$LAN_BRIDGE accept
        iifname "docker0" accept
        iifname "veth*" accept
        iifname "virbr0" accept
        meta l4proto icmp icmp type { echo-request, echo-reply, destination-unreachable, time-exceeded } accept
        meta l4proto icmpv6 icmpv6 type { echo-request, echo-reply, destination-unreachable, time-exceeded } accept
        tcp dport { $OPEN_TCP } accept
        udp dport { $OPEN_UDP } accept
        meta l4proto { 50, 51 } accept
    }

    chain forward {
        type filter hook forward priority filter; policy accept;
        ct state established,related accept
        ct state invalid drop
        iifname "lo" accept
        iifname { \$LAN_BRIDGE, "wg0", "ovpn0", "tun0" } oifname \$WAN_IFACE accept
        iifname \$WAN_IFACE oifname { \$LAN_BRIDGE, "wg0", "ovpn0", "tun0" } ct state new drop
    }

    chain output {
        type filter hook output priority filter; policy accept;
    }
}

table inet router-nat {
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        oifname \$WAN_IFACE ip saddr $LAN_SUBNET masquerade
        oifname \$WAN_IFACE ip saddr $WG_SUBNET masquerade
        oifname \$WAN_IFACE ip saddr $OVPN_SUBNET masquerade
    }
}
EOF
    log "nftables.conf ditulis (WAN=$WAN_IFACE)."
}
write_nftables

apply_nftables() {
    if ! nft -c -f /etc/nftables.conf; then
        die "Syntax nftables tidak valid!"
    fi
    systemctl enable nftables >>"$LOG" 2>&1
    systemctl restart nftables >>"$LOG" 2>&1
    log "nftables aktif + enabled."
}
apply_nftables

# ------------------------------ dnsmasq ------------------------------------
write_dnsmasq() {
    cat > /etc/dnsmasq.d/router.conf <<EOF
interface=$LAN_BRIDGE
bind-interfaces
except-interface=lo
listen-address=$LAN_IP
dhcp-range=$DHCP_RANGE,$DHCP_LEASE
dhcp-option=option:router,$LAN_IP
dhcp-option=option:dns-server,$LAN_IP
dhcp-authoritative
domain-needed
bogus-priv
no-resolv
no-poll
cache-size=1000
expand-hosts
domain=lan
EOF
    for ns in $DNS_UPSTREAM; do echo "server=$ns" >> /etc/dnsmasq.d/router.conf; done
    systemctl enable dnsmasq >>"$LOG" 2>&1
    systemctl restart dnsmasq >>"$LOG" 2>&1
    log "dnsmasq dikonfigurasi + enabled (DHCP $DHCP_RANGE)."
}
write_dnsmasq

# ------------------------------ WireGuard ----------------------------------
setup_wireguard() {
    local WG_CONF="/etc/wireguard/wg0.conf"
    if [ ! -f "$WG_CONF" ]; then
        umask 077
        local PRIV
        PRIV=$(wg genkey)
        local PUB
        PUB=$(echo "$PRIV" | wg pubkey)
        {
            echo "[Interface]"
            echo "Address = $WG_IP/24"
            echo "ListenPort = $WG_PORT"
            echo "PrivateKey = $PRIV"
            echo ""
            echo "# Tambahkan peer klien di bawah ini, contoh:"
            echo "# [Peer]"
            echo "# PublicKey = <PUBLIC_KEY_KLien>"
            echo "# AllowedIPs = 10.10.1.2/32"
            echo "# Tambah peer: wg set wg0 peer <PUBKEY> allowed-ips 10.10.1.2/32"
        } > "$WG_CONF"
        chmod 600 "$WG_CONF"
        log "wg0.conf dibuat. SERVER PUBLIC KEY: $PUB"
        # template config klien
        cat > /root/wg-client.conf.example <<EOF
[Interface]
Address = 10.10.1.2/24
PrivateKey = <PRIVATE_KEY_KLien>
DNS = $LAN_IP

[Peer]
PublicKey = $PUB
Endpoint = $(hostname -I | awk '{print $1}'):$WG_PORT
AllowedIPs = $WG_SUBNET, $LAN_SUBNET
PersistentKeepalive = 25
EOF
        chmod 600 /root/wg-client.conf.example
        log "Template klien -> /root/wg-client.conf.example"
    else
        log "wg0.conf sudah ada, dilewati."
    fi
    systemctl enable wg-quick@wg0 >>"$LOG" 2>&1 || true
    systemctl restart wg-quick@wg0 >>"$LOG" 2>&1 || { wg-quick down wg0 2>/dev/null || true; systemctl start wg-quick@wg0 >>"$LOG" 2>&1; }
    log "WireGuard wg0 aktif + enabled."
}
setup_wireguard

# ------------------------------ OpenVPN ------------------------------------
setup_openvpn() {
    local OVPN_CONF="/etc/openvpn/server/router.conf"
    local OVPN_KEY="/etc/openvpn/server/router.key"
    mkdir -p /etc/openvpn/server
    if [ ! -f "$OVPN_KEY" ]; then
        openvpn --genkey secret "$OVPN_KEY" >>"$LOG" 2>&1
        chmod 600 "$OVPN_KEY"
    fi
    cat > "$OVPN_CONF" <<EOF
# OpenVPN Server - static key mode
dev tun
proto udp
port 1194
ifconfig $OVPN_IP 10.10.2.2
secret $OVPN_KEY
cipher AES-256-CBC
auth SHA256
keepalive 10 120
user nobody
group nogroup
persist-key
persist-tun
status /var/log/openvpn-router-status.log
verb 3
EOF
    # OpenVPN >= 2.6 butuh flag ini untuk static-key mode
    if openvpn --version 2>/dev/null | grep -qE 'OpenVPN 2\.([6-9]|[1-9][0-9])'; then
        echo "allow-deprecated-insecure-static-crypto" >> "$OVPN_CONF"
        log "OpenVPN >= 2.6 terdeteksi, flag static-crypto ditambahkan."
    fi
    chmod 600 "$OVPN_CONF"
    systemctl enable openvpn-server@router >>"$LOG" 2>&1
    systemctl restart openvpn-server@router >>"$LOG" 2>&1 || die "OpenVPN server gagal start. Cek: journalctl -u openvpn-server@router"
    log "OpenVPN server aktif + enabled (port 1194)."
}
setup_openvpn

# ------------------------------ strongSwan ---------------------------------
setup_strongswan() {
    cat > /etc/ipsec.conf <<EOF
config setup
    charondebug="ike 1, knl 1, cfg 0"
    uniqueids=no

conn %default
    ikelifetime=60m
    keylife=20m
    rekeymargin=3m
    keyingtries=1
    keyexchange=ikev2
    authby=secret
    esp=aes256-sha2_256!
    ike=aes256-sha2_256-prfsha256-modp2048!

conn site-to-site
    left=%defaultroute
    leftid=@router
    leftsubnet=$LAN_SUBNET
    right=CHANGE_ME_PEER_IP
    rightsubnet=CHANGE_ME_PEER_SUBNET
    auto=add

conn remote-access
    left=%defaultroute
    leftid=@router
    leftsubnet=0.0.0.0/0
    right=%any
    rightid=%any
    rightsourceip=$IPSEC_SUBNET
    rightdns=$LAN_IP
    auto=add
EOF
    cat > /etc/ipsec.secrets <<'EOF'
# strongSwan secrets - isi sesuai peer
# @router CHANGE_ME_PEER_IP : PSK "ganti-secret-anda"
EOF
    chmod 600 /etc/ipsec.conf /etc/ipsec.secrets
    systemctl enable strongswan-starter >>"$LOG" 2>&1
    systemctl restart strongswan-starter >>"$LOG" 2>&1
    log "strongSwan template aktif + enabled."
}
setup_strongswan

# ------------------------------ FRR ----------------------------------------
setup_frr() {
    sed -i -e 's/^zebra=no/zebra=yes/' -e 's/^ospfd=no/ospfd=yes/' -e 's/^bgpd=no/bgpd=yes/' /etc/frr/daemons
    cat > /etc/frr/frr.conf <<EOF
frr version 8.1
frr defaults traditional
hostname router

log syslog informational

router bgp 65000
  bgp router-id $LAN_IP
  neighbor $WG_IP peer-group
  neighbor $WG_IP remote-as 65000
  address-family ipv4 unicast
    network $LAN_SUBNET
    neighbor $WG_IP activate
  exit-address-family
exit

router ospf
  ospf router-id $LAN_IP
  network $LAN_SUBNET area 0
  network $WG_SUBNET area 0
exit

line vty
!
EOF
    chown frr:frr /etc/frr/frr.conf 2>/dev/null || true
    systemctl enable frr >>"$LOG" 2>&1
    systemctl restart frr >>"$LOG" 2>&1
    log "FRR (zebra/ospfd/bgpd) aktif + enabled."
}
setup_frr

# ------------------------------ FireQOS ------------------------------------
setup_fireqos() {
    echo "ifb" > /etc/modules-load.d/fireqos.conf
    modprobe ifb 2>/dev/null || true
    cat > /etc/firehol/fireqos.conf <<EOF
#!/sbin/fireqos start
interface $WAN_IFACE wan-in input rate $WAN_BANDWIDTH
    class management commit 10% ceil 25%
        match tcp dport 22
        match tcp dport 9090
    class interactive commit 20% ceil 50%
        match tcp
    class default commit 70% ceil 100%

interface $WAN_IFACE wan-out output rate $WAN_BANDWIDTH
    class management commit 10% ceil 25%
        match tcp sport 22
        match tcp sport 9090
    class interactive commit 20% ceil 50%
        match tcp
    class default commit 70% ceil 100%
EOF
    cat > /etc/systemd/system/fireqos.service <<'EOF'
[Unit]
Description=FireQOS traffic shaping
Documentation=man:fireqos(1) man:fireqos.conf(5)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/fireqos start
ExecStop=/usr/sbin/fireqos stop
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable fireqos >>"$LOG" 2>&1
    systemctl restart fireqos >>"$LOG" 2>&1 || true
    log "FireQOS dikonfigurasi + enabled (WAN=$WAN_IFACE, $WAN_BANDWIDTH)."
}
setup_fireqos

# ------------------------------ Cockpit ------------------------------------
setup_cockpit() {
    systemctl enable --now cockpit.socket >>"$LOG" 2>&1
    log "Cockpit aktif (port 9090)."
}
setup_cockpit

# ---------------------- hook opsional: auto-restore project ---------------
optional_hook() {
    if [ -n "$SDR_LAB_SETUP_SCRIPT" ] && [ -f "$SDR_LAB_SETUP_SCRIPT" ]; then
        chmod +x "$SDR_LAB_SETUP_SCRIPT"
        cat > /etc/systemd/system/sdr-router-lab.service <<EOF
[Unit]
Description=Auto-restore project lab network
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
User=$(stat -c '%U' "$SDR_LAB_SETUP_SCRIPT")
Group=$(stat -c '%G' "$SDR_LAB_SETUP_SCRIPT")
WorkingDirectory=$(dirname "$SDR_LAB_SETUP_SCRIPT")
ExecStart=$SDR_LAB_SETUP_SCRIPT
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable sdr-router-lab.service >>"$LOG" 2>&1
        log "Hook SDR_LAB_SETUP_SCRIPT aktif -> $SDR_LAB_SETUP_SCRIPT"
    fi
}
optional_hook

# --------------------- dashboard manajemen (pengganti MikroTik) -----------
# Mengklon repo ini lalu menjalankan deploy-dashboard.sh (FastAPI + engine).
# Matikan dengan DEPLOY_DASHBOARD=0
deploy_dashboard() {
    log "==> Dashboard manajemen (pengganti MikroTik Webfig/Winbox)"
    [ "${DEPLOY_DASHBOARD:-1}" = "1" ] || { log "    dilewati (DEPLOY_DASHBOARD=0)"; return; }
    if [ -n "$GITHUB_URL" ]; then
        log "    sumber: $GITHUB_URL"
    fi
    command -v git >/dev/null 2>&1 || apt-get install -y -q git >>"$LOG" 2>&1 || true
    SRC=/tmp/ubuntu-router-src
    rm -rf "$SRC"
    if git clone -q --depth 1 "${GITHUB_URL:-https://github.com/ezarakbar/ubuntu-router}" "$SRC" 2>>"$LOG"; then
        if bash "$SRC/dashboard/deploy-dashboard.sh" >>"$LOG" 2>&1; then
            log "    Dashboard aktif: http://<IP-server>:8081 (admin / admin123 — WAJIB ganti!)"
        else
            log "    ! Dashboard gagal deploy — lihat $LOG"
        fi
    else
        log "    ! Gagal clone repo — dashboard dilewati"
    fi
    rm -rf "$SRC"
}
deploy_dashboard

# ------------------------------ ringkasan ----------------------------------
summary() {
    log "=== RINGKASAN INSTALASI ==="
    {
        echo "Topologi : WAN=$WAN_IFACE ($([ "$WAN_STATIC" = yes ] && echo statis || echo DHCP)) | LAN=$LAN_BRIDGE ($LAN_IP/$([[ "$LAN_SUBNET" =~ / ]] && echo "${LAN_SUBNET#*/}"))"
        echo "Mode     : $MODE ($([ "$MODE" = single-nic ] && echo "VLAN $VLAN_ID di $WAN_IFACE" || echo "NIC fisik $LAN_IFACE"))"
        echo "Subnet   : LAN=$LAN_SUBNET | WG=$WG_SUBNET | OVPN=$OVPN_SUBNET"
        echo "Services : FRR, nftables, dnsmasq, WireGuard, OpenVPN, strongSwan, FireQOS, Cockpit"
        echo "Web GUI  : https://<IP>:9090  (login user sistem)"
        echo "SSH      : port 22"
        echo "Backup   : $BACKUP_DIR"
    } | tee -a "$LOG"
    log "=== SELESAI. Reboot disarankan: sudo reboot ==="
}
summary

exit 0