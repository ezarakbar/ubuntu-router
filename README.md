# ubuntu-router

Installer satu-perintah untuk mengubah **Ubuntu/Debian Server** menjadi **router setara MikroTik RouterOS v7** — lengkap dengan routing, firewall/NAT, QoS, VPN, DHCP/DNS, dan Web GUI.

## Fitur

| Komponen | Fungsi |
|---|---|
| **FRR** | Routing OSPF + BGP |
| **nftables** | Firewall + NAT (tabel terpisah — aman untuk host yang menjalankan Docker) |
| **dnsmasq** | DHCP server + DNS (bind hanya di LAN bridge) |
| **WireGuard** | Tunnel klien (wg0, port 51820) |
| **OpenVPN** | Static-key VPN server (port 1194) |
| **strongSwan** | IPsec IKEv2 (template site-to-site & remote-access) |
| **FireQOS** | QoS / traffic shaping (HTB) + prioritas trafik manajemen |
| **Cockpit** | Web GUI manajemen (port 9090) + SSH (22) |

## Instalasi (satu baris)

```bash
curl -sL https://raw.githubusercontent.com/ezarakbar/ubuntu-router/main/ubuntu-router-install.sh | sudo bash
```

## Topologi otomatis

Script mendeteksi NIC fisik secara otomatis:

- **≥ 2 NIC fisik** → NIC ber-default-route = WAN, NIC lain = LAN (via bridge `br-lan`)
- **1 NIC fisik** → WAN = NIC fisik, LAN = sub-interface VLAN (default `100`) di bridge `br-lan`
- Alamat WAN yang sudah ada (statis) **dipertahankan**; jika tidak ada, dipakai DHCP4

Subnet default: `LAN 10.10.0.0/24` · `WireGuard 10.10.1.0/24` · `OpenVPN 10.10.2.0/24`

## Variabel env (override opsional)

```bash
VLAN_ID=100          LAN_SUBNET=10.10.0.0/24   LAN_IP=10.10.0.1
DHCP_RANGE=10.10.0.100,10.10.0.200
WG_SUBNET=10.10.1.0/24   WG_IP=10.10.1.1   WG_PORT=51820
WAN_BANDWIDTH=100mbit    DNS_UPSTREAM="1.1.1.1 8.8.8.8"
EXTRA_OPEN_PORTS=8080,8090   # port produksi tambahan yang harus tetap terbuka
WAN_IFACE=               # paksa interface WAN
LAN_IFACE=               # paksa interface LAN (multi-NIC)
SDR_LAB_SETUP_SCRIPT=    # path script yang ingin dijalankan otomatis saat boot
DRY_RUN=1                # mode kering (cetak perintah, tanpa eksekusi)
```

Contoh dengan override:

```bash
VLAN_ID=200 LAN_SUBNET=192.168.200.0/24 EXTRA_OPEN_PORTS=8080,8090 \
  curl -sL https://raw.githubusercontent.com/ezarakbar/ubuntu-router/main/ubuntu-router-install.sh | sudo bash
```

## Yang dilakukan script

1. Deteksi distro (harus berbasis apt) + NIC WAN/LAN + renderer netplan
2. Backup semua konfigurasi lama → `/root/ubuntu-router-backup-<timestamp>/`
3. Install paket: `frr dnsmasq openvpn strongswan fireqos cockpit cockpit-networkmanager cockpit-pcp wireguard-tools nftables iproute2`
4. Tulis `sysctl` (ip_forward=1, hardening) → `/etc/sysctl.d/99-router.conf`
5. Tulis netplan → `/etc/netplan/99-router.yaml` (VLAN/bridge LAN, WAN dipertahankan)
6. Tulis nftables → `/etc/nftables.conf` (filter + NAT MASQUERADE)
7. Konfigurasi dnsmasq, WireGuard (generate key), OpenVPN (generate static key), strongSwan, FRR (zebra/ospfd/bgpd), FireQOS
8. Aktifkan Cockpit (port 9090)
9. `systemctl enable` semua service → **otomatis hidup setelah reboot**

> **Idempotent** — aman dijalankan berulang. Semua config lama di-backup sebelum ditimpa.

## Akses manajemen

- **SSH**: port `22`
- **Web GUI (Cockpit)**: `https://<IP-server>:9090` (login user sistem)
- **WireGuard client template**: `/root/wg-client.conf.example` (dibuat saat instalasi)
- **Dashboard Ubuntu Router**: `http://<IP-server>:8081` (login `admin` / password default `admin123` — wajib diganti)

## Dashboard manajemen (pengganti Webfig/Winbox)

Dashboard FastAPI + SQLite di `dashboard/` — menu meniru struktur RouterOS:

```
Dashboard          ringkasan trafik, pelanggan, lease, CPU/RAM/disk
Pelanggan         tambah/atur pelanggan (MAC, IP statis/dinamis, profile, aktif/nonaktif)
Profile           definisi bandwidth (rate down/up kbit, priority) — setara Simple Queue
IP ▸ DHCP Pool    range DHCP per interface (gateway, DNS, leasetime)
IP ▸ DHCP Lease   daftar lease aktif dari dnsmasq
IP ▸ Firewall NAT dstnat (port-forward) & srcnat (masquerade)
Interfaces        daftar NIC + alamat + statistik trafik
System            identity, health, ganti password admin
Logs              journald viewer
```

Setiap perubahan di UI memicu **engine render idempotent** (`dashboard/engine/`):

| Script | Fungsi | Diterapkan ke |
|---|---|---|
| `render-nft.sh` | address-list pelanggan + rule NAT (tabel `ip ur_dyn`) | nftables |
| `render-dnsmasq.sh` | pool DHCP + static lease (`dhcp-host`) per pelanggan | dnsmasq (reload) |
| `render-tc.sh` | Simple Queue per pelanggan (HTB, DOWN di LAN + UP via ifb) | tc/br-lan |

**Tag IP per pelanggan (RADAR):** setiap pelanggan aktif otomatis masuk address-list `customers` dan mendapat kelas queue sesuai profile — mirip Simple Queue + address-list MikroTik.

## Menambah pelanggan (contoh)

```bash
# via API
TOKEN=$(curl -s -X POST http://<IP>:8081/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq -r .token)

# buat profile 7M
curl -s -X POST http://<IP>:8081/api/profiles \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"7M","rate_down_kbit":7000,"rate_up_kbit":3000}'

# daftarkan pelanggan (static IP dari pool + MAC)
curl -s -X POST http://<IP>:8081/api/customers \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"budiman","mac":"aa:bb:cc:00:11:22","static_ip":"10.10.0.150","profile":"7M"}'
# => dhcp-host + address-list + queue 7M langsung aktif
```

## Catatan

- Script diuji tuntas (EXIT 0, reboot test, uji DHCP/DNS/NAT, uji queue/address-list) pada Ubuntu Server 22.04.
- Untuk host yang menjalankan Docker, nftables memakai tabel terpisah (`inet router`) sehingga tidak mengganggu container.
- `cockpit-networkmanager` terpasang; jika server memakai `systemd-networkd`, halaman Network di Cockpit hanya menampilkan status (disarankan tetap `networkd` agar tidak mengganggu layanan yang berjalan).
- Dashboard memakai port `8081` (8080/8090 dipakai stack lain). Ubah di `dashboard/ubuntu-router-dashboard.service`.
- Setelah reboot, `ubuntu-router-engine.service` (oneshot) memulihkan address-list, rule NAT, dan queue secara otomatis.