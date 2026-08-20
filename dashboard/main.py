import glob
import hashlib
import os
import re
import secrets
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

APP = Path(os.environ.get("APP_DIR", "/opt/ubuntu-router"))
STATE = APP / "state"
DB = STATE / "router.db"
ENGINE = APP / "engine"
GEN = STATE / "gen"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
SESSION_TTL = 60 * 60 * 24
DNSMASQ_LEASES = Path("/var/lib/misc/dnsmasq.leases")
IF_IGNORE = {"lo", "docker0", "virbr0", "tailscale0", "veth"}

app = FastAPI(title="Ubuntu Router — Dashboard", version="0.1.0")


# --------------------------------------------------------------------------
# DB
# --------------------------------------------------------------------------
def db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def hashpw(pw):
    return hashlib.sha256(pw.encode()).hexdigest()


def init_db():
    STATE.mkdir(parents=True, exist_ok=True)
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS admin_users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'admin',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            expires INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            rate_down_kbit INTEGER NOT NULL,
            rate_up_kbit INTEGER NOT NULL,
            burst_down_kbit INTEGER DEFAULT 0,
            burst_up_kbit INTEGER DEFAULT 0,
            priority INTEGER DEFAULT 1,
            comment TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            type TEXT DEFAULT 'dhcp',
            mac TEXT,
            static_ip TEXT,
            profile_id INTEGER NOT NULL REFERENCES profiles(id),
            active INTEGER DEFAULT 1,
            comment TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS pools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            iface TEXT,
            subnet TEXT DEFAULT '255.255.255.0',
            start_ip TEXT NOT NULL,
            end_ip TEXT NOT NULL,
            router_ip TEXT,
            dns1 TEXT,
            dns2 TEXT,
            leasetime TEXT DEFAULT '12h',
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS nat_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain TEXT DEFAULT 'dstnat',
            action TEXT DEFAULT 'dnat',
            proto TEXT,
            src_address TEXT,
            dst_address TEXT,
            src_port INTEGER,
            dst_port INTEGER,
            to_addresses TEXT,
            to_ports INTEGER,
            comment TEXT,
            active INTEGER DEFAULT 1,
            position INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS address_lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            comment TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS address_list_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            list_id INTEGER NOT NULL REFERENCES address_lists(id) ON DELETE CASCADE,
            address TEXT NOT NULL,
            comment TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS firewall_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain TEXT NOT NULL DEFAULT 'forward',
            action TEXT NOT NULL DEFAULT 'drop',
            proto TEXT,
            src_address TEXT,
            dst_address TEXT,
            src_port INTEGER,
            dst_port INTEGER,
            src_list TEXT,
            dst_list TEXT,
            connstate TEXT,
            icmp_type TEXT,
            limit_rate TEXT,
            comment TEXT,
            active INTEGER DEFAULT 1,
            position INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS mangle_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain TEXT NOT NULL DEFAULT 'prerouting',
            action TEXT NOT NULL DEFAULT 'mark_packet',
            mark INTEGER,
            proto TEXT,
            src_address TEXT,
            dst_address TEXT,
            src_port INTEGER,
            dst_port INTEGER,
            src_list TEXT,
            dst_list TEXT,
            comment TEXT,
            active INTEGER DEFAULT 1,
            position INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS policy_routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mark INTEGER NOT NULL,
            table_id INTEGER NOT NULL,
            priority INTEGER DEFAULT 5000,
            via TEXT,
            dev TEXT,
            comment TEXT,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS wg_interfaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            listen_port INTEGER DEFAULT 51820,
            address TEXT,
            dns TEXT,
            private_key TEXT,
            comment TEXT,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS wg_peers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            iface_id INTEGER NOT NULL REFERENCES wg_interfaces(id) ON DELETE CASCADE,
            name TEXT,
            public_key TEXT NOT NULL,
            preshared_key TEXT,
            allowed_ips TEXT NOT NULL,
            endpoint TEXT,
            persistent_keepalive INTEGER DEFAULT 25,
            comment TEXT,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )
    if conn.execute("SELECT COUNT(*) FROM admin_users").fetchone()[0] == 0:
        conn.execute(
            "INSERT INTO admin_users(username, password_hash) VALUES (?,?)",
            ("admin", hashpw(ADMIN_PASSWORD)),
        )
    if conn.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO profiles(name, rate_down_kbit, rate_up_kbit) VALUES (?,?,?)",
            [("1M", 1000, 1000), ("5M", 5000, 5000), ("10M", 10000, 10000)],
        )
    masq = conn.execute(
        "SELECT id FROM nat_rules WHERE chain='srcnat' AND action='masquerade'"
    ).fetchone()
    if masq is None:
        conn.execute(
            "INSERT INTO nat_rules(chain, action, comment) "
            "VALUES ('srcnat','masquerade','NAT default (base router)')"
        )
    conn.commit()
    conn.close()
    seed_wg_from_files()


def seed_wg_from_files():
    """Import konfigurasi WireGuard yang sudah ada (/etc/wireguard/wg*.conf)
    bila tabel wg_interfaces masih kosong — non-destruktif, key dipertahankan."""
    try:
        conn = db()
        if conn.execute("SELECT COUNT(*) FROM wg_interfaces").fetchone()[0] > 0:
            conn.close()
            return
        for conf in sorted(glob.glob("/etc/wireguard/wg*.conf")):
            name = Path(conf).stem  # wg0, wg1, ...
            iface = {}
            peers = []
            cur_peer = None
            for raw in Path(conf).read_text().splitlines():
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("["):
                    if line == "[Interface]":
                        cur_peer = None
                    elif line == "[Peer]":
                        cur_peer = {}
                        peers.append(cur_peer)
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip()
                if cur_peer is not None:
                    cur_peer[k] = v
                else:
                    iface[k] = v
            if not iface.get("PrivateKey"):
                continue
            cur = conn.execute(
                "INSERT INTO wg_interfaces(name, listen_port, address, dns, private_key) "
                "VALUES (?,?,?,?,?)",
                (name, int(iface.get("ListenPort", 51820)),
                 iface.get("Address"), iface.get("DNS"), iface["PrivateKey"]),
            )
            iface_id = cur.lastrowid
            for p in peers:
                if not p.get("PublicKey") or not p.get("AllowedIPs"):
                    continue
                conn.execute(
                    "INSERT INTO wg_peers(iface_id, public_key, preshared_key, allowed_ips, "
                    "endpoint, persistent_keepalive) VALUES (?,?,?,?,?,?)",
                    (iface_id, p["PublicKey"], p.get("PresharedKey"),
                     p["AllowedIPs"], p.get("Endpoint"),
                     p.get("PersistentKeepalive", 25)),
                )
        conn.commit()
        conn.close()
    except Exception:
        pass


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
def check_auth(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "perlu login")
    token = authorization[7:].strip()
    conn = db()
    row = conn.execute(
        "SELECT * FROM sessions WHERE token=? AND expires>?",
        (token, int(time.time())),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(401, "sesi tidak valid / kadaluarsa")
    return row["username"]


# --------------------------------------------------------------------------
# Engine
# --------------------------------------------------------------------------
def engine_env():
    env = dict(os.environ)
    env["APP_DIR"] = str(APP)
    try:
        rt = subprocess.run(
            ["ip", "route", "show", "default"], capture_output=True, text=True, timeout=5
        ).stdout
        m = re.search(r"dev (\S+)", rt)
        env["WAN_IF"] = m.group(1) if m else ""
    except Exception:
        env["WAN_IF"] = ""
    return env


def run_engine(name):
    script = ENGINE / name
    if not script.exists():
        return
    try:
        p = subprocess.run(
            ["bash", str(script)],
            env=engine_env(),
            capture_output=True,
            text=True,
            timeout=90,
        )
    except FileNotFoundError:
        return
    if p.returncode != 0:
        raise HTTPException(500, f"engine {name} gagal: {(p.stderr or p.stdout)[-600:]}")


def apply_all():
    run_engine("render-nft.sh")
    run_engine("render-dnsmasq.sh")
    run_engine("render-tc.sh")
    run_engine("render-policy.sh")
    run_engine("render-wireguard.sh")


# --------------------------------------------------------------------------
# System helpers
# --------------------------------------------------------------------------
def sys_status():
    load = Path("/proc/loadavg").read_text().split() if Path("/proc/loadavg").exists() else ["-"]
    mem = {}
    for line in Path("/proc/meminfo").read_text().splitlines()[:5]:
        k, v = line.split(":", 1)
        mem[k.strip()] = int(v.strip().split()[0]) // 1024
    disk = subprocess.run(
        ["df", "-B1", "/"], capture_output=True, text=True
    ).stdout.splitlines()
    dtotal = dused = 0
    if len(disk) > 1:
        parts = disk[1].split()
        dtotal, dused = int(parts[1]), int(parts[2])
    return {
        "load_1m": load[0],
        "cpu_cores": os.cpu_count(),
        "mem_total_mb": mem.get("MemTotal", 0),
        "mem_available_mb": mem.get("MemAvailable", 0),
        "disk_total_gb": round(dtotal / 1024**3, 1),
        "disk_used_gb": round(dused / 1024**3, 1),
        "uptime": Path("/proc/uptime").read_text().split()[0] if Path("/proc/uptime").exists() else "-",
        "hostname": subprocess.run(["hostname"], capture_output=True, text=True).stdout.strip(),
    }


def wan_info():
    try:
        rt = subprocess.run(
            ["ip", "route", "show", "default"], capture_output=True, text=True, timeout=5
        ).stdout
        m = re.search(r"dev (\S+)", rt)
        dev = m.group(1) if m else ""
        out = subprocess.run(
            ["ip", "-4", "-o", "addr", "show"], capture_output=True, text=True, timeout=5
        ).stdout
        addr = ""
        for line in out.splitlines():
            mm = re.match(r"\d+:\s+(\S+)\s+inet\s+(\S+)", line)
            if not mm:
                continue
            iface, ip = mm.group(1), mm.group(2).split("/")[0]
            if iface == dev:
                addr = ip
                break
        return {"interface": dev, "address": addr}
    except Exception:
        return {"interface": "", "address": ""}


def list_interfaces():
    out = subprocess.run(
        ["ip", "-o", "link", "show"], capture_output=True, text=True, timeout=5
    ).stdout
    ifaces = []
    for line in out.splitlines():
        m = re.match(r"\d+:\s+(\S+):\s+<(.*?)>\s+mtu\s+(\d+)", line)
        if not m:
            continue
        name, flags, mtu = m.group(1), m.group(2), int(m.group(3))
        if any(name.startswith(p) for p in IF_IGNORE):
            continue
        up = "UP" in flags
        state = subprocess.run(
            ["cat", f"/sys/class/net/{name}/operstate"],
            capture_output=True, text=True,
        ).stdout.strip() or ("up" if up else "down")
        rx = tx = 0
        try:
            rx = int(Path(f"/sys/class/net/{name}/statistics/rx_bytes").read_text())
            tx = int(Path(f"/sys/class/net/{name}/statistics/tx_bytes").read_text())
        except Exception:
            pass
        speed = "—"
        try:
            s = Path(f"/sys/class/net/{name}/speed").read_text().strip()
            speed = s + " Mbps" if s and s != "-1" else "—"
        except Exception:
            pass
        addr = ""
        aout = subprocess.run(
            ["ip", "-4", "-o", "addr", "show", name],
            capture_output=True, text=True,
        ).stdout
        for al in aout.splitlines():
            am = re.search(r"inet\s+(\S+)", al)
            if am:
                addr = am.group(1)
                break
        ifaces.append(
            {"name": name, "mtu": mtu, "operstate": state,
             "up": up, "rx_bytes": rx, "tx_bytes": tx, "speed": speed, "address": addr}
        )
    return ifaces


def dnsmasq_leases():
    if not DNSMASQ_LEASES.exists():
        return []
    rows = []
    for line in DNSMASQ_LEASES.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 4:
            rows.append(
                {"expires": parts[0], "mac": parts[1], "ip": parts[2],
                 "hostname": parts[3]}
            )
    return rows


# --------------------------------------------------------------------------
# Pydantic models
# --------------------------------------------------------------------------
class LoginReq(BaseModel):
    username: str
    password: str


class ProfileCreate(BaseModel):
    name: str
    rate_down_kbit: int
    rate_up_kbit: int
    burst_down_kbit: int = 0
    burst_up_kbit: int = 0
    priority: int = 1
    comment: Optional[str] = None


class ProfileUpdate(BaseModel):
    rate_down_kbit: int
    rate_up_kbit: int
    burst_down_kbit: int = 0
    burst_up_kbit: int = 0
    priority: int = 1
    comment: Optional[str] = None


class CustomerCreate(BaseModel):
    name: str
    type: str = "dhcp"
    mac: Optional[str] = None
    static_ip: Optional[str] = None
    profile: str
    active: bool = True
    comment: Optional[str] = None


class CustomerUpdate(BaseModel):
    type: Optional[str] = None
    mac: Optional[str] = None
    static_ip: Optional[str] = None
    profile: Optional[str] = None
    active: Optional[bool] = None
    comment: Optional[str] = None


class PoolCreate(BaseModel):
    name: str
    iface: Optional[str] = None
    subnet: Optional[str] = "255.255.255.0"
    start_ip: str
    end_ip: str
    router_ip: Optional[str] = None
    dns1: Optional[str] = None
    dns2: Optional[str] = None
    leasetime: Optional[str] = "12h"
    active: bool = True


class PoolUpdate(BaseModel):
    iface: Optional[str] = None
    subnet: Optional[str] = None
    start_ip: Optional[str] = None
    end_ip: Optional[str] = None
    router_ip: Optional[str] = None
    dns1: Optional[str] = None
    dns2: Optional[str] = None
    leasetime: Optional[str] = None
    active: Optional[bool] = None


class NatRuleCreate(BaseModel):
    chain: str = "dstnat"
    action: str = "dnat"
    protocol: Optional[str] = None
    src_address: Optional[str] = None
    dst_address: Optional[str] = None
    src_port: Optional[int] = None
    dst_port: Optional[int] = None
    to_addresses: Optional[str] = None
    to_ports: Optional[int] = None
    comment: Optional[str] = None
    position: Optional[int] = None


class NatRuleUpdate(BaseModel):
    chain: Optional[str] = None
    action: Optional[str] = None
    protocol: Optional[str] = None
    src_address: Optional[str] = None
    dst_address: Optional[str] = None
    src_port: Optional[int] = None
    dst_port: Optional[int] = None
    to_addresses: Optional[str] = None
    to_ports: Optional[int] = None
    comment: Optional[str] = None
    active: Optional[bool] = None


class MasqueradeReq(BaseModel):
    enabled: bool


class FwRuleCreate(BaseModel):
    chain: str = "forward"
    action: str = "drop"
    protocol: Optional[str] = None
    src_address: Optional[str] = None
    dst_address: Optional[str] = None
    src_port: Optional[int] = None
    dst_port: Optional[int] = None
    src_list: Optional[str] = None
    dst_list: Optional[str] = None
    connstate: Optional[str] = None
    icmp_type: Optional[str] = None
    limit_rate: Optional[str] = None
    comment: Optional[str] = None
    position: Optional[int] = None


class FwRuleUpdate(BaseModel):
    chain: Optional[str] = None
    action: Optional[str] = None
    protocol: Optional[str] = None
    src_address: Optional[str] = None
    dst_address: Optional[str] = None
    src_port: Optional[int] = None
    dst_port: Optional[int] = None
    src_list: Optional[str] = None
    dst_list: Optional[str] = None
    connstate: Optional[str] = None
    icmp_type: Optional[str] = None
    limit_rate: Optional[str] = None
    comment: Optional[str] = None
    active: Optional[bool] = None


class MangleCreate(BaseModel):
    chain: str = "prerouting"
    action: str = "mark_packet"
    mark: Optional[int] = None
    protocol: Optional[str] = None
    src_address: Optional[str] = None
    dst_address: Optional[str] = None
    src_port: Optional[int] = None
    dst_port: Optional[int] = None
    src_list: Optional[str] = None
    dst_list: Optional[str] = None
    comment: Optional[str] = None
    position: Optional[int] = None


class MangleUpdate(BaseModel):
    chain: Optional[str] = None
    action: Optional[str] = None
    mark: Optional[int] = None
    protocol: Optional[str] = None
    src_address: Optional[str] = None
    dst_address: Optional[str] = None
    src_port: Optional[int] = None
    dst_port: Optional[int] = None
    src_list: Optional[str] = None
    dst_list: Optional[str] = None
    comment: Optional[str] = None
    active: Optional[bool] = None


class AddrListCreate(BaseModel):
    name: str
    comment: Optional[str] = None


class AddrListEntry(BaseModel):
    address: str
    comment: Optional[str] = None


class PolicyCreate(BaseModel):
    mark: int
    table_id: int
    priority: int = 5000
    via: Optional[str] = None
    dev: Optional[str] = None
    comment: Optional[str] = None


class PolicyUpdate(BaseModel):
    mark: Optional[int] = None
    table_id: Optional[int] = None
    priority: Optional[int] = None
    via: Optional[str] = None
    dev: Optional[str] = None
    comment: Optional[str] = None
    active: Optional[bool] = None


class WgIfaceCreate(BaseModel):
    name: str
    listen_port: int = 51820
    address: Optional[str] = None
    dns: Optional[str] = None
    private_key: Optional[str] = None
    comment: Optional[str] = None


class WgIfaceUpdate(BaseModel):
    listen_port: Optional[int] = None
    address: Optional[str] = None
    dns: Optional[str] = None
    private_key: Optional[str] = None
    comment: Optional[str] = None
    active: Optional[bool] = None


class WgPeerCreate(BaseModel):
    iface_id: int
    name: Optional[str] = None
    public_key: str
    preshared_key: Optional[str] = None
    allowed_ips: str
    endpoint: Optional[str] = None
    persistent_keepalive: Optional[int] = 25
    comment: Optional[str] = None


class WgPeerUpdate(BaseModel):
    name: Optional[str] = None
    public_key: Optional[str] = None
    preshared_key: Optional[str] = None
    allowed_ips: Optional[str] = None
    endpoint: Optional[str] = None
    persistent_keepalive: Optional[int] = None
    comment: Optional[str] = None
    active: Optional[bool] = None


class IdentityUpdate(BaseModel):
    identity: Optional[str] = None
    wan_if: Optional[str] = None
    lan_if: Optional[str] = None
    admin_password: Optional[str] = None


# --------------------------------------------------------------------------
# Startup
# --------------------------------------------------------------------------
@app.on_event("startup")
def startup():
    init_db()


# --------------------------------------------------------------------------
# Auth endpoints
# --------------------------------------------------------------------------
@app.post("/api/login")
def login(l: LoginReq):
    conn = db()
    row = conn.execute(
        "SELECT * FROM admin_users WHERE username=?", (l.username,)
    ).fetchone()
    if not row or row["password_hash"] != hashpw(l.password):
        conn.close()
        raise HTTPException(401, "username/password salah")
    token = secrets.token_hex(16)
    conn.execute(
        "INSERT INTO sessions(token, username, expires) VALUES (?,?,?)",
        (token, l.username, int(time.time()) + SESSION_TTL),
    )
    conn.commit()
    conn.close()
    return {"token": token, "username": l.username}


@app.post("/api/logout")
def logout(authorization: Optional[str] = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        conn = db()
        conn.execute("DELETE FROM sessions WHERE token=?", (authorization[7:].strip(),))
        conn.commit()
        conn.close()
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"status": "ok"}


# --------------------------------------------------------------------------
# Status / dashboard
# --------------------------------------------------------------------------
@app.get("/api/status", dependencies=[Depends(check_auth)])
def status():
    sys_ = sys_status()
    sys_["wan"] = wan_info()
    sys_["interfaces"] = list_interfaces()
    leases = dnsmasq_leases()
    conn = db()
    n_cust = conn.execute(
        "SELECT COUNT(*) c FROM customers WHERE active=1"
    ).fetchone()["c"]
    n_pool = conn.execute(
        "SELECT COUNT(*) c FROM pools WHERE active=1"
    ).fetchone()["c"]
    n_nat = conn.execute(
        "SELECT COUNT(*) c FROM nat_rules WHERE active=1"
    ).fetchone()["c"]
    identity = conn.execute(
        "SELECT value FROM settings WHERE key='identity'"
    ).fetchone()
    conn.close()
    sys_["identity"] = identity["value"] if identity else "ubuntu-router"
    return {
        "system": sys_,
        "customers_active": n_cust,
        "pools_active": n_pool,
        "nat_rules_active": n_nat,
        "leases": leases,
        "leases_count": len(leases),
    }


# --------------------------------------------------------------------------
# Profiles
# --------------------------------------------------------------------------
@app.get("/api/profiles", dependencies=[Depends(check_auth)])
def list_profiles():
    conn = db()
    rows = conn.execute("SELECT * FROM profiles ORDER BY id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/profiles", dependencies=[Depends(check_auth)])
def create_profile(p: ProfileCreate):
    conn = db()
    try:
        cur = conn.execute(
            "INSERT INTO profiles(name, rate_down_kbit, rate_up_kbit, "
            "burst_down_kbit, burst_up_kbit, priority, comment) VALUES (?,?,?,?,?,?,?)",
            (p.name, p.rate_down_kbit, p.rate_up_kbit, p.burst_down_kbit,
             p.burst_up_kbit, p.priority, p.comment),
        )
        conn.commit()
        return {"id": cur.lastrowid, **p.model_dump()}
    except sqlite3.IntegrityError:
        raise HTTPException(400, "nama profile sudah ada")
    finally:
        conn.close()


@app.put("/api/profiles/{name}", dependencies=[Depends(check_auth)])
def update_profile(name: str, p: ProfileUpdate):
    conn = db()
    cur = conn.execute(
        "UPDATE profiles SET rate_down_kbit=?, rate_up_kbit=?, "
        "burst_down_kbit=?, burst_up_kbit=?, priority=?, comment=? WHERE name=?",
        (p.rate_down_kbit, p.rate_up_kbit, p.burst_down_kbit, p.burst_up_kbit,
         p.priority, p.comment, name),
    )
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "profile tidak ada")
    apply_all()
    return {"ok": True, "name": name}


@app.delete("/api/profiles/{name}", dependencies=[Depends(check_auth)])
def delete_profile(name: str):
    conn = db()
    used = conn.execute(
        "SELECT COUNT(*) c FROM customers c JOIN profiles p ON p.id=c.profile_id "
        "WHERE p.name=? AND c.active=1",
        (name,),
    ).fetchone()["c"]
    if used:
        conn.close()
        raise HTTPException(400, f"profile dipakai {used} pelanggan aktif — pindahkan dulu")
    conn.execute("DELETE FROM profiles WHERE name=?", (name,))
    conn.commit()
    conn.close()
    apply_all()
    return {"ok": True}


# --------------------------------------------------------------------------
# Customers (pelanggan)
# --------------------------------------------------------------------------
def norm_mac(mac):
    if not mac:
        return ""
    return re.sub(r"[^0-9a-fA-F]", "", mac).lower()


@app.get("/api/customers", dependencies=[Depends(check_auth)])
def list_customers():
    conn = db()
    rows = conn.execute(
        "SELECT c.*, p.name AS profile_name, p.rate_down_kbit, p.rate_up_kbit "
        "FROM customers c JOIN profiles p ON p.id=c.profile_id ORDER BY c.id"
    ).fetchall()
    conn.close()
    leases = dnsmasq_leases()
    lease_by_mac = {
        re.sub(r"[^0-9a-fA-F]", "", l["mac"]).lower(): l["ip"] for l in leases
    }
    result = []
    for r in rows:
        d = dict(r)
        mac = norm_mac(r["mac"])
        if not r["static_ip"] and mac in lease_by_mac:
            d["current_ip"] = lease_by_mac[mac]
        else:
            d["current_ip"] = r["static_ip"]
        result.append(d)
    return result


@app.post("/api/customers", dependencies=[Depends(check_auth)])
def create_customer(c: CustomerCreate):
    conn = db()
    try:
        p = conn.execute(
            "SELECT id FROM profiles WHERE name=?", (c.profile,)
        ).fetchone()
        if not p:
            raise HTTPException(404, f"profile '{c.profile}' tidak ada")
        cur = conn.execute(
            "INSERT INTO customers(name, type, mac, static_ip, profile_id, active, comment) "
            "VALUES (?,?,?,?,?,?,?)",
            (c.name, c.type, norm_mac(c.mac), c.static_ip or None, p["id"],
             1 if c.active else 0, c.comment),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "nama pelanggan sudah ada")
    finally:
        conn.close()
    apply_all()
    return {"id": cur.lastrowid, "ok": True, "name": c.name}


@app.put("/api/customers/{name}", dependencies=[Depends(check_auth)])
def update_customer(name: str, c: CustomerUpdate):
    conn = db()
    row = conn.execute("SELECT * FROM customers WHERE name=?", (name,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "pelanggan tidak ada")
    fields, vals = [], []
    if c.type is not None:
        fields.append("type=?"); vals.append(c.type)
    if c.mac is not None:
        fields.append("mac=?"); vals.append(norm_mac(c.mac))
    if c.static_ip is not None:
        fields.append("static_ip=?"); vals.append(c.static_ip or None)
    if c.active is not None:
        fields.append("active=?"); vals.append(1 if c.active else 0)
    if c.comment is not None:
        fields.append("comment=?"); vals.append(c.comment)
    if c.profile is not None:
        p = conn.execute(
            "SELECT id FROM profiles WHERE name=?", (c.profile,)
        ).fetchone()
        if not p:
            conn.close()
            raise HTTPException(404, f"profile '{c.profile}' tidak ada")
        fields.append("profile_id=?"); vals.append(p["id"])
    if fields:
        conn.execute(
            f"UPDATE customers SET {', '.join(fields)} WHERE name=?", (*vals, name)
        )
        conn.commit()
    conn.close()
    apply_all()
    return {"ok": True}


@app.delete("/api/customers/{name}", dependencies=[Depends(check_auth)])
def delete_customer(name: str):
    conn = db()
    cur = conn.execute("DELETE FROM customers WHERE name=?", (name,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "pelanggan tidak ada")
    apply_all()
    return {"ok": True}


# --------------------------------------------------------------------------
# Pools (DHCP)
# --------------------------------------------------------------------------
@app.get("/api/pools", dependencies=[Depends(check_auth)])
def list_pools():
    conn = db()
    rows = conn.execute("SELECT * FROM pools ORDER BY id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/pools", dependencies=[Depends(check_auth)])
def create_pool(p: PoolCreate):
    conn = db()
    try:
        cur = conn.execute(
            "INSERT INTO pools(name, iface, subnet, start_ip, end_ip, router_ip, "
            "dns1, dns2, leasetime, active) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (p.name, p.iface or None, p.subnet, p.start_ip, p.end_ip,
             p.router_ip or None, p.dns1 or None, p.dns2 or None,
             p.leasetime, 1 if p.active else 0),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "nama pool sudah ada")
    finally:
        conn.close()
    apply_all()
    return {"id": cur.lastrowid, "ok": True}


@app.put("/api/pools/{pool_id}", dependencies=[Depends(check_auth)])
def update_pool(pool_id: int, p: PoolUpdate):
    conn = db()
    row = conn.execute("SELECT * FROM pools WHERE id=?", (pool_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "pool tidak ada")
    fields, vals = [], []
    for col, val in (
        ("iface", p.iface), ("subnet", p.subnet), ("start_ip", p.start_ip),
        ("end_ip", p.end_ip), ("router_ip", p.router_ip), ("dns1", p.dns1),
        ("dns2", p.dns2), ("leasetime", p.leasetime),
    ):
        if val is not None:
            fields.append(f"{col}=?"); vals.append(val)
    if p.active is not None:
        fields.append("active=?"); vals.append(1 if p.active else 0)
    if fields:
        conn.execute(
            f"UPDATE pools SET {', '.join(fields)} WHERE id=?", (*vals, pool_id)
        )
        conn.commit()
    conn.close()
    apply_all()
    return {"ok": True}


@app.delete("/api/pools/{pool_id}", dependencies=[Depends(check_auth)])
def delete_pool(pool_id: int):
    conn = db()
    cur = conn.execute("DELETE FROM pools WHERE id=?", (pool_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "pool tidak ada")
    apply_all()
    return {"ok": True}


@app.get("/api/dhcp/leases", dependencies=[Depends(check_auth)])
def get_leases():
    return {"leases": dnsmasq_leases()}


# --------------------------------------------------------------------------
# Firewall / NAT
# --------------------------------------------------------------------------
def validate_nat(chain, action, protocol):
    if chain not in ("srcnat", "dstnat"):
        raise HTTPException(400, "chain harus srcnat/dstnat")
    if action not in ("masquerade", "dnat", "snat", "accept", "drop"):
        raise HTTPException(400, "action tidak dikenal")
    if protocol is not None and protocol not in ("tcp", "udp"):
        raise HTTPException(400, "protocol harus tcp/udp atau kosong")


def shift_positions(conn, at):
    conn.execute(
        "UPDATE nat_rules SET position=position+1 "
        "WHERE position IS NOT NULL AND position>=?",
        (at,),
    )


@app.get("/api/firewall/nat", dependencies=[Depends(check_auth)])
def list_nat():
    conn = db()
    rows = conn.execute(
        "SELECT id, chain, action, proto, src_address, dst_address, "
        "src_port, dst_port, to_addresses, to_ports, comment, active, position "
        "FROM nat_rules ORDER BY position IS NULL, position, id"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/firewall/nat", dependencies=[Depends(check_auth)])
def add_nat(r: NatRuleCreate):
    validate_nat(r.chain, r.action, r.protocol)
    conn = db()
    if r.position is not None:
        shift_positions(conn, r.position)
    cur = conn.execute(
        "INSERT INTO nat_rules(chain, action, proto, src_address, dst_address, "
        "src_port, dst_port, to_addresses, to_ports, comment, position) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (r.chain, r.action, r.protocol, r.src_address, r.dst_address,
         r.src_port, r.dst_port, r.to_addresses, r.to_ports, r.comment, r.position),
    )
    conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"id": cur.lastrowid, **r.model_dump()}


@app.put("/api/firewall/nat/{rule_id}", dependencies=[Depends(check_auth)])
def update_nat(rule_id: int, r: NatRuleUpdate):
    conn = db()
    row = conn.execute("SELECT * FROM nat_rules WHERE id=?", (rule_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "rule tidak ada")
    if r.chain is not None or r.action is not None:
        validate_nat(
            r.chain or row["chain"], r.action or row["action"],
            r.protocol or row["proto"],
        )
    fields, vals = [], []
    for col, val in (
        ("chain", r.chain), ("action", r.action), ("proto", r.protocol),
        ("src_address", r.src_address), ("dst_address", r.dst_address),
        ("src_port", r.src_port), ("dst_port", r.dst_port),
        ("to_addresses", r.to_addresses), ("to_ports", r.to_ports),
        ("comment", r.comment),
    ):
        if val is not None:
            fields.append(f"{col}=?"); vals.append(val)
    if r.active is not None:
        fields.append("active=?"); vals.append(1 if r.active else 0)
    if fields:
        conn.execute(
            f"UPDATE nat_rules SET {', '.join(fields)} WHERE id=?", (*vals, rule_id)
        )
        conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True, "id": rule_id}


@app.delete("/api/firewall/nat/{rule_id}", dependencies=[Depends(check_auth)])
def delete_nat(rule_id: int):
    conn = db()
    cur = conn.execute("DELETE FROM nat_rules WHERE id=?", (rule_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "rule tidak ada")
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


def masquerade_row(conn):
    return conn.execute(
        "SELECT * FROM nat_rules WHERE chain='srcnat' AND action='masquerade' "
        "ORDER BY id LIMIT 1"
    ).fetchone()


@app.get("/api/firewall/masquerade", dependencies=[Depends(check_auth)])
def get_masquerade():
    conn = db()
    row = masquerade_row(conn)
    conn.close()
    return {"enabled": bool(row and row["active"])}


@app.post("/api/firewall/masquerade", dependencies=[Depends(check_auth)])
def set_masquerade(m: MasqueradeReq):
    conn = db()
    row = masquerade_row(conn)
    if row:
        conn.execute(
            "UPDATE nat_rules SET active=? WHERE id=?",
            (1 if m.enabled else 0, row["id"]),
        )
    else:
        conn.execute(
            "INSERT INTO nat_rules(chain, action, active) "
            "VALUES ('srcnat','masquerade',?)",
            (1 if m.enabled else 0,),
        )
    conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True, "enabled": m.enabled}


# --------------------------------------------------------------------------
# Firewall filter
# --------------------------------------------------------------------------
def fw_validate(chain, action):
    if chain not in ("input", "forward", "output"):
        raise HTTPException(400, "chain harus input/forward/output")
    if action not in ("accept", "drop", "reject", "log"):
        raise HTTPException(400, "action harus accept/drop/reject/log")


@app.get("/api/firewall/filter", dependencies=[Depends(check_auth)])
def list_filter():
    conn = db()
    rows = conn.execute(
        "SELECT * FROM firewall_rules ORDER BY position IS NULL, position, id"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/firewall/filter", dependencies=[Depends(check_auth)])
def add_filter(r: FwRuleCreate):
    fw_validate(r.chain, r.action)
    conn = db()
    if r.position is not None:
        conn.execute(
            "UPDATE firewall_rules SET position=position+1 "
            "WHERE position IS NOT NULL AND position>=?", (r.position,)
        )
    cur = conn.execute(
        "INSERT INTO firewall_rules(chain, action, proto, src_address, dst_address, "
        "src_port, dst_port, src_list, dst_list, connstate, icmp_type, limit_rate, "
        "comment, position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (r.chain, r.action, r.protocol, r.src_address, r.dst_address,
         r.src_port, r.dst_port, r.src_list, r.dst_list, r.connstate,
         r.icmp_type, r.limit_rate, r.comment, r.position),
    )
    conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"id": cur.lastrowid, **r.model_dump()}


@app.put("/api/firewall/filter/{rule_id}", dependencies=[Depends(check_auth)])
def update_filter(rule_id: int, r: FwRuleUpdate):
    conn = db()
    row = conn.execute("SELECT * FROM firewall_rules WHERE id=?", (rule_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "rule tidak ada")
    if r.chain is not None or r.action is not None:
        fw_validate(r.chain or row["chain"], r.action or row["action"])
    fields, vals = [], []
    for col, val in (
        ("chain", r.chain), ("action", r.action), ("proto", r.protocol),
        ("src_address", r.src_address), ("dst_address", r.dst_address),
        ("src_port", r.src_port), ("dst_port", r.dst_port),
        ("src_list", r.src_list), ("dst_list", r.dst_list),
        ("connstate", r.connstate), ("icmp_type", r.icmp_type),
        ("limit_rate", r.limit_rate), ("comment", r.comment),
    ):
        if val is not None:
            fields.append(f"{col}=?"); vals.append(val)
    if r.active is not None:
        fields.append("active=?"); vals.append(1 if r.active else 0)
    if fields:
        conn.execute(
            f"UPDATE firewall_rules SET {', '.join(fields)} WHERE id=?", (*vals, rule_id)
        )
        conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True, "id": rule_id}


@app.delete("/api/firewall/filter/{rule_id}", dependencies=[Depends(check_auth)])
def delete_filter(rule_id: int):
    conn = db()
    cur = conn.execute("DELETE FROM firewall_rules WHERE id=?", (rule_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "rule tidak ada")
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


# --------------------------------------------------------------------------
# Mangle
# --------------------------------------------------------------------------
@app.get("/api/firewall/mangle", dependencies=[Depends(check_auth)])
def list_mangle():
    conn = db()
    rows = conn.execute(
        "SELECT * FROM mangle_rules ORDER BY position IS NULL, position, id"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/firewall/mangle", dependencies=[Depends(check_auth)])
def add_mangle(r: MangleCreate):
    if r.action not in ("mark_packet", "mark_connection", "accept", "drop"):
        raise HTTPException(400, "action tidak dikenal")
    if r.action.startswith("mark") and r.mark is None:
        raise HTTPException(400, "mark wajib diisi (cth 0x10 / 16)")
    conn = db()
    if r.position is not None:
        conn.execute(
            "UPDATE mangle_rules SET position=position+1 "
            "WHERE position IS NOT NULL AND position>=?", (r.position,)
        )
    cur = conn.execute(
        "INSERT INTO mangle_rules(chain, action, mark, proto, src_address, dst_address, "
        "src_port, dst_port, src_list, dst_list, comment, position) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (r.chain, r.action, r.mark, r.protocol, r.src_address, r.dst_address,
         r.src_port, r.dst_port, r.src_list, r.dst_list, r.comment, r.position),
    )
    conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"id": cur.lastrowid, **r.model_dump()}


@app.put("/api/firewall/mangle/{rule_id}", dependencies=[Depends(check_auth)])
def update_mangle(rule_id: int, r: MangleUpdate):
    conn = db()
    row = conn.execute("SELECT * FROM mangle_rules WHERE id=?", (rule_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "rule tidak ada")
    fields, vals = [], []
    for col, val in (
        ("chain", r.chain), ("action", r.action), ("mark", r.mark),
        ("proto", r.protocol), ("src_address", r.src_address),
        ("dst_address", r.dst_address), ("src_port", r.src_port),
        ("dst_port", r.dst_port), ("src_list", r.src_list),
        ("dst_list", r.dst_list), ("comment", r.comment),
    ):
        if val is not None:
            fields.append(f"{col}=?"); vals.append(val)
    if r.active is not None:
        fields.append("active=?"); vals.append(1 if r.active else 0)
    if fields:
        conn.execute(
            f"UPDATE mangle_rules SET {', '.join(fields)} WHERE id=?", (*vals, rule_id)
        )
        conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True, "id": rule_id}


@app.delete("/api/firewall/mangle/{rule_id}", dependencies=[Depends(check_auth)])
def delete_mangle(rule_id: int):
    conn = db()
    cur = conn.execute("DELETE FROM mangle_rules WHERE id=?", (rule_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "rule tidak ada")
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


# --------------------------------------------------------------------------
# Address Lists
# --------------------------------------------------------------------------
def list_known_lists():
    conn = db()
    names = {r["name"] for r in conn.execute("SELECT name FROM address_lists")}
    for t, col in (("firewall_rules", "src_list"), ("firewall_rules", "dst_list"),
                   ("mangle_rules", "src_list"), ("mangle_rules", "dst_list")):
        for r in conn.execute(f"SELECT {col} v FROM {t} WHERE {col} IS NOT NULL AND {col}!=''"):
            if r["v"]:
                names.add(r["v"])
    conn.close()
    return sorted(names)


@app.get("/api/address-lists", dependencies=[Depends(check_auth)])
def get_address_lists():
    conn = db()
    lists = conn.execute("SELECT * FROM address_lists ORDER BY id").fetchall()
    out = []
    for l in lists:
        entries = conn.execute(
            "SELECT * FROM address_list_entries WHERE list_id=? ORDER BY id",
            (l["id"],),
        ).fetchall()
        out.append({**dict(l), "entries": [dict(e) for e in entries]})
    conn.close()
    return out


@app.post("/api/address-lists", dependencies=[Depends(check_auth)])
def create_address_list(al: AddrListCreate):
    conn = db()
    try:
        cur = conn.execute(
            "INSERT INTO address_lists(name, comment) VALUES (?,?)",
            (al.name, al.comment),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "nama address-list sudah ada")
    finally:
        conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"id": cur.lastrowid, "ok": True, "name": al.name}


@app.delete("/api/address-lists/{list_id}", dependencies=[Depends(check_auth)])
def delete_address_list(list_id: int):
    conn = db()
    cur = conn.execute("DELETE FROM address_lists WHERE id=?", (list_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "list tidak ada")
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


@app.post("/api/address-lists/{list_id}/entries", dependencies=[Depends(check_auth)])
def add_list_entry(list_id: int, e: AddrListEntry):
    conn = db()
    if not conn.execute("SELECT id FROM address_lists WHERE id=?", (list_id,)).fetchone():
        conn.close()
        raise HTTPException(404, "list tidak ada")
    conn.execute(
        "INSERT INTO address_list_entries(list_id, address, comment) VALUES (?,?,?)",
        (list_id, e.address, e.comment),
    )
    conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


@app.delete("/api/address-lists/{list_id}/entries/{entry_id}", dependencies=[Depends(check_auth)])
def delete_list_entry(list_id: int, entry_id: int):
    conn = db()
    cur = conn.execute(
        "DELETE FROM address_list_entries WHERE id=? AND list_id=?", (entry_id, list_id)
    )
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "entry tidak ada")
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


# --------------------------------------------------------------------------
# Policy routing
# --------------------------------------------------------------------------
@app.get("/api/policy", dependencies=[Depends(check_auth)])
def list_policy():
    conn = db()
    rows = conn.execute("SELECT * FROM policy_routes ORDER BY priority, id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/policy", dependencies=[Depends(check_auth)])
def add_policy(p: PolicyCreate):
    conn = db()
    cur = conn.execute(
        "INSERT INTO policy_routes(mark, table_id, priority, via, dev, comment) "
        "VALUES (?,?,?,?,?,?)",
        (p.mark, p.table_id, p.priority, p.via or None, p.dev or None, p.comment),
    )
    conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"id": cur.lastrowid, **p.model_dump()}


@app.put("/api/policy/{rule_id}", dependencies=[Depends(check_auth)])
def update_policy(rule_id: int, p: PolicyUpdate):
    conn = db()
    row = conn.execute("SELECT * FROM policy_routes WHERE id=?", (rule_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "rule tidak ada")
    fields, vals = [], []
    for col, val in (
        ("mark", p.mark), ("table_id", p.table_id), ("priority", p.priority),
        ("via", p.via), ("dev", p.dev), ("comment", p.comment),
    ):
        if val is not None:
            fields.append(f"{col}=?"); vals.append(val)
    if p.active is not None:
        fields.append("active=?"); vals.append(1 if p.active else 0)
    if fields:
        conn.execute(
            f"UPDATE policy_routes SET {', '.join(fields)} WHERE id=?", (*vals, rule_id)
        )
        conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


@app.delete("/api/policy/{rule_id}", dependencies=[Depends(check_auth)])
def delete_policy(rule_id: int):
    conn = db()
    cur = conn.execute("DELETE FROM policy_routes WHERE id=?", (rule_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "rule tidak ada")
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


# --------------------------------------------------------------------------
# WireGuard
# --------------------------------------------------------------------------
def wg_cmd(*args):
    try:
        p = subprocess.run(["wg", *args], capture_output=True, text=True, timeout=10)
        return p.stdout.strip()
    except Exception:
        return ""


def wg_gen_keypair():
    priv = wg_cmd("genkey")
    if not priv:
        raise HTTPException(500, "wg genkey gagal (wireguard-tools?)")
    pub = subprocess.run(
        ["wg", "pubkey"], input=priv, capture_output=True, text=True, timeout=10
    ).stdout.strip()
    return priv, pub


@app.get("/api/wg/interfaces", dependencies=[Depends(check_auth)])
def list_wg():
    conn = db()
    ifaces = conn.execute("SELECT * FROM wg_interfaces ORDER BY id").fetchall()
    out = []
    for i in ifaces:
        peers = conn.execute(
            "SELECT * FROM wg_peers WHERE iface_id=? ORDER BY id", (i["id"],)
        ).fetchall()
        item = dict(i)
        item["public_key"] = ""
        if i["private_key"]:
            item["public_key"] = subprocess.run(
                ["wg", "pubkey"], input=i["private_key"], capture_output=True,
                text=True, timeout=10,
            ).stdout.strip()
        item["peers"] = [dict(p) for p in peers]
        out.append(item)
    conn.close()
    return out


@app.post("/api/wg/interfaces", dependencies=[Depends(check_auth)])
def create_wg(r: WgIfaceCreate):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", r.name):
        raise HTTPException(400, "nama interface hanya huruf/angka/_/-")
    priv = r.private_key
    if not priv:
        priv, _ = wg_gen_keypair()
    conn = db()
    try:
        cur = conn.execute(
            "INSERT INTO wg_interfaces(name, listen_port, address, dns, private_key, comment) "
            "VALUES (?,?,?,?,?,?)",
            (r.name, r.listen_port, r.address, r.dns, priv, r.comment),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "nama interface sudah ada")
    finally:
        conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"id": cur.lastrowid, "ok": True, "name": r.name}


@app.put("/api/wg/interfaces/{iface_id}", dependencies=[Depends(check_auth)])
def update_wg(iface_id: int, r: WgIfaceUpdate):
    conn = db()
    if not conn.execute("SELECT id FROM wg_interfaces WHERE id=?", (iface_id,)).fetchone():
        conn.close()
        raise HTTPException(404, "interface tidak ada")
    fields, vals = [], []
    for col, val in (
        ("listen_port", r.listen_port), ("address", r.address), ("dns", r.dns),
        ("private_key", r.private_key), ("comment", r.comment),
    ):
        if val is not None:
            fields.append(f"{col}=?"); vals.append(val)
    if r.active is not None:
        fields.append("active=?"); vals.append(1 if r.active else 0)
    if fields:
        conn.execute(
            f"UPDATE wg_interfaces SET {', '.join(fields)} WHERE id=?", (*vals, iface_id)
        )
        conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


@app.delete("/api/wg/interfaces/{iface_id}", dependencies=[Depends(check_auth)])
def delete_wg(iface_id: int):
    conn = db()
    row = conn.execute("SELECT name FROM wg_interfaces WHERE id=?", (iface_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "interface tidak ada")
    conn.execute("DELETE FROM wg_peers WHERE iface_id=?", (iface_id,))
    conn.execute("DELETE FROM wg_interfaces WHERE id=?", (iface_id,))
    conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


@app.post("/api/wg/interfaces/{iface_id}/keygen", dependencies=[Depends(check_auth)])
def wg_keygen(iface_id: int):
    priv, pub = wg_gen_keypair()
    conn = db()
    cur = conn.execute(
        "UPDATE wg_interfaces SET private_key=? WHERE id=?", (priv, iface_id)
    )
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "interface tidak ada")
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True, "private_key": priv, "public_key": pub}


@app.post("/api/wg/peers", dependencies=[Depends(check_auth)])
def create_wg_peer(r: WgPeerCreate):
    conn = db()
    if not conn.execute("SELECT id FROM wg_interfaces WHERE id=?", (r.iface_id,)).fetchone():
        conn.close()
        raise HTTPException(404, "interface tidak ada")
    cur = conn.execute(
        "INSERT INTO wg_peers(iface_id, name, public_key, preshared_key, allowed_ips, "
        "endpoint, persistent_keepalive, comment) VALUES (?,?,?,?,?,?,?,?)",
        (r.iface_id, r.name, r.public_key, r.preshared_key, r.allowed_ips,
         r.endpoint, r.persistent_keepalive, r.comment),
    )
    conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"id": cur.lastrowid, "ok": True}


@app.put("/api/wg/peers/{peer_id}", dependencies=[Depends(check_auth)])
def update_wg_peer(peer_id: int, r: WgPeerUpdate):
    conn = db()
    if not conn.execute("SELECT id FROM wg_peers WHERE id=?", (peer_id,)).fetchone():
        conn.close()
        raise HTTPException(404, "peer tidak ada")
    fields, vals = [], []
    for col, val in (
        ("name", r.name), ("public_key", r.public_key), ("preshared_key", r.preshared_key),
        ("allowed_ips", r.allowed_ips), ("endpoint", r.endpoint),
        ("persistent_keepalive", r.persistent_keepalive), ("comment", r.comment),
    ):
        if val is not None:
            fields.append(f"{col}=?"); vals.append(val)
    if r.active is not None:
        fields.append("active=?"); vals.append(1 if r.active else 0)
    if fields:
        conn.execute(
            f"UPDATE wg_peers SET {', '.join(fields)} WHERE id=?", (*vals, peer_id)
        )
        conn.commit()
    conn.close()
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


@app.delete("/api/wg/peers/{peer_id}", dependencies=[Depends(check_auth)])
def delete_wg_peer(peer_id: int):
    conn = db()
    cur = conn.execute("DELETE FROM wg_peers WHERE id=?", (peer_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "peer tidak ada")
    try:
        apply_all()
    except HTTPException as e:
        raise HTTPException(500, e.detail)
    return {"ok": True}


@app.get("/api/wg/status", dependencies=[Depends(check_auth)])
def wg_status():
    out = wg_cmd("show", "all", "dump")
    if not out:
        return {"interfaces": []}
    ifaces = {}
    for line in out.splitlines():
        f = line.split("\t")
        if len(f) == 5 and f[0] and not f[0].startswith("interface"):
            # baris interface: name, private_key, public_key, port, fwmark
            ifaces[f[0]] = {"name": f[0], "public_key": f[2], "port": f[3], "peers": {}}
        elif len(f) == 9:
            # baris peer: iface, public_key, psk, endpoint, allowed_ips, hs, rx, tx, keepalive
            iface = f[0]
            if iface not in ifaces:
                ifaces[iface] = {"name": iface, "public_key": "", "port": None, "peers": {}}
            ifaces[iface]["peers"][f[1]] = {
                "public_key": f[1],
                "preshared_key": f[2],
                "endpoint": f[3],
                "allowed_ips": f[4],
                "latest_handshake": f[5],
                "rx": int(f[6]) if f[6].isdigit() else 0,
                "tx": int(f[7]) if f[7].isdigit() else 0,
                "persistent_keepalive": f[8],
            }
    conn = db()
    for row in conn.execute("SELECT name FROM wg_interfaces").fetchall():
        if row["name"] not in ifaces:
            ifaces[row["name"]] = {"name": row["name"], "public_key": "", "port": None, "peers": {}}
    conn.close()
    return {"interfaces": list(ifaces.values())}


# --------------------------------------------------------------------------
# OpenVPN (static-key mode, manage existing server/router.conf)
# --------------------------------------------------------------------------
OVPN_CONF = "/etc/openvpn/server/router.conf"
OVPN_KEY = "/etc/openvpn/server/router.key"
OVPN_STATUS = "/var/log/openvpn-router-status.log"
OVPN_SERVICE = "openvpn-server@router.service"


class OvpnConfigUpdate(BaseModel):
    port: Optional[int] = None
    proto: Optional[str] = None
    dev: Optional[str] = None
    server_ip: Optional[str] = None
    client_ip: Optional[str] = None
    cipher: Optional[str] = None
    auth: Optional[str] = None
    keepalive: Optional[str] = None
    verb: Optional[int] = None


def ovpn_read_config():
    cfg = {
        "port": "1194", "proto": "udp", "dev": "tun",
        "server_ip": "10.10.2.1", "client_ip": "10.10.2.2",
        "cipher": "AES-256-CBC", "auth": "SHA256",
        "keepalive": "10 120", "verb": "3",
        "raw": "",
    }
    try:
        with open(OVPN_CONF) as f:
            cfg["raw"] = f.read()
        for line in cfg["raw"].splitlines():
            line = line.split("#", 1)[0].strip()
            p = line.split()
            if not p:
                continue
            k = p[0]
            if k == "port" and len(p) > 1:
                cfg["port"] = p[1]
            elif k == "proto" and len(p) > 1:
                cfg["proto"] = p[1]
            elif k == "dev" and len(p) > 1:
                cfg["dev"] = p[1]
            elif k == "ifconfig" and len(p) > 2:
                cfg["server_ip"], cfg["client_ip"] = p[1], p[2]
            elif k == "cipher" and len(p) > 1:
                cfg["cipher"] = p[1]
            elif k == "auth" and len(p) > 1:
                cfg["auth"] = p[1]
            elif k == "keepalive" and len(p) > 2:
                cfg["keepalive"] = p[1] + " " + p[2]
            elif k == "verb" and len(p) > 1:
                cfg["verb"] = p[1]
    except FileNotFoundError:
        pass
    return cfg


def ovpn_status():
    st = {"active": False, "enabled": False, "updated": None, "tun_read": 0, "tun_write": 0}
    try:
        st["active"] = subprocess.run(
            ["systemctl", "is-active", OVPN_SERVICE], capture_output=True, text=True, timeout=5
        ).stdout.strip() == "active"
        st["enabled"] = subprocess.run(
            ["systemctl", "is-enabled", OVPN_SERVICE], capture_output=True, text=True, timeout=5
        ).stdout.strip() == "enabled"
    except Exception:
        pass
    try:
        with open(OVPN_STATUS) as f:
            for line in f:
                line = line.strip()
                if line.startswith("Updated,"):
                    st["updated"] = line.split(",", 1)[1]
                elif line.startswith("TUN/TAP read bytes,"):
                    st["tun_read"] = int(line.split(",", 1)[1])
                elif line.startswith("TUN/TAP write bytes,"):
                    st["tun_write"] = int(line.split(",", 1)[1])
    except FileNotFoundError:
        pass
    return st


def ovpn_public_ip():
    try:
        out = subprocess.run(
            ["ip", "-4", "route", "get", "1.1.1.1"], capture_output=True, text=True, timeout=5
        ).stdout
        for tok in out.split():
            if tok.startswith("src"):
                continue
        parts = out.split()
        if "src" in parts:
            return parts[parts.index("src") + 1]
    except Exception:
        pass
    return ""


def ovpn_write_config(c: OvpnConfigUpdate):
    cur = ovpn_read_config()
    port = c.port if c.port is not None else cur["port"]
    proto = (c.proto or cur["proto"]).strip()
    dev = (c.dev or cur["dev"]).strip()
    srv = (c.server_ip or cur["server_ip"]).strip()
    cli = (c.client_ip or cur["client_ip"]).strip()
    cipher = (c.cipher or cur["cipher"]).strip()
    auth = (c.auth or cur["auth"]).strip()
    keep = (c.keepalive or cur["keepalive"]).strip()
    verb = c.verb if c.verb is not None else int(cur["verb"])
    body = (
        "# OpenVPN Server - static key mode (dikelola dashboard)\n"
        f"dev {dev}\n"
        f"proto {proto}\n"
        f"port {port}\n"
        f"ifconfig {srv} {cli}\n"
        "secret /etc/openvpn/server/router.key\n"
        f"cipher {cipher}\n"
        f"auth {auth}\n"
        f"keepalive {keep}\n"
        "user nobody\n"
        "group nogroup\n"
        "persist-key\n"
        "persist-tun\n"
        f"status {OVPN_STATUS}\n"
        f"verb {verb}\n"
    )
    return body


@app.get("/api/openvpn", dependencies=[Depends(check_auth)])
def get_openvpn():
    cfg = ovpn_read_config()
    st = ovpn_status()
    cfg["service"] = st
    cfg["public_ip"] = ovpn_public_ip()
    cfg["key_exists"] = os.path.exists(OVPN_KEY)
    return cfg


@app.put("/api/openvpn", dependencies=[Depends(check_auth)])
def update_openvpn(r: OvpnConfigUpdate):
    if not os.path.exists(OVPN_CONF):
        raise HTTPException(404, "konfigurasi OpenVPN tidak ditemukan")
    body = ovpn_write_config(r)
    try:
        with open(OVPN_CONF, "w") as f:
            f.write(body)
    except PermissionError:
        raise HTTPException(500, "dashboard tidak bisa menulis konfigurasi (izin?)")
    p = subprocess.run(["systemctl", "restart", OVPN_SERVICE], capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        raise HTTPException(500, "gagal restart OpenVPN: " + p.stderr.strip()[-300:])
    return {"ok": True, "config": body}


@app.post("/api/openvpn/toggle", dependencies=[Depends(check_auth)])
def toggle_openvpn(r: dict):
    active = bool(r.get("active"))
    if not os.path.exists(OVPN_CONF):
        raise HTTPException(404, "konfigurasi OpenVPN tidak ditemukan")
    action = "start" if active else "stop"
    p = subprocess.run(["systemctl", action, OVPN_SERVICE], capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        raise HTTPException(500, f"gagal {action}: " + p.stderr.strip()[-300:])
    en = subprocess.run(["systemctl", "enable" if active else "disable", OVPN_SERVICE],
                        capture_output=True, text=True, timeout=10)
    return {"ok": True, "active": active}


@app.get("/api/openvpn/client.ovpn", dependencies=[Depends(check_auth)])
def openvpn_client():
    if not os.path.exists(OVPN_KEY):
        raise HTTPException(404, "static key tidak ditemukan")
    cfg = ovpn_read_config()
    pub = ovpn_public_ip() or "PUBLIC_IP"
    with open(OVPN_KEY) as f:
        key = f.read().strip()
    body = (
        "# OpenVPN client - static key mode (unduh dari dashboard)\n"
        "client\n"
        f"dev {cfg['dev']}\n"
        f"proto {cfg['proto']}\n"
        f"remote {pub} {cfg['port']}\n"
        "resolv-retry infinite\n"
        "nobind\n"
        "persist-key\n"
        "persist-tun\n"
        f"ifconfig {cfg['client_ip']} {cfg['server_ip']}\n"
        "<secret>\n"
        f"{key}\n"
        "</secret>\n"
        f"cipher {cfg['cipher']}\n"
        f"auth {cfg['auth']}\n"
        f"keepalive {cfg['keepalive']}\n"
        f"verb {cfg['verb']}\n"
    )
    return Response(
        content=body,
        media_type="application/x-openvpn-profile",
        headers={"Content-Disposition": "attachment; filename=client.ovpn"},
    )


# --------------------------------------------------------------------------
# Interfaces / System / Logs
# --------------------------------------------------------------------------
@app.get("/api/interfaces", dependencies=[Depends(check_auth)])
def interfaces():
    return {"interfaces": list_interfaces()}


@app.get("/api/system", dependencies=[Depends(check_auth)])
def system_info():
    return {"system": sys_status(), "wan": wan_info()}


@app.get("/api/logs", dependencies=[Depends(check_auth)])
def logs(lines: int = 80, unit: str = ""):
    args = ["journalctl", "-n", str(lines), "--no-pager"]
    if unit:
        args += ["-u", unit]
    out = subprocess.run(args, capture_output=True, text=True, timeout=10).stdout
    return {"logs": out[-8000:]}


@app.get("/api/settings", dependencies=[Depends(check_auth)])
def get_settings():
    conn = db()
    vals = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM settings")}
    conn.close()
    return {"identity": vals.get("identity", "ubuntu-router"),
            "wan_if": vals.get("wan_if", ""),
            "lan_if": vals.get("lan_if", "br-lan")}


@app.post("/api/settings", dependencies=[Depends(check_auth)])
def save_settings(s: IdentityUpdate):
    conn = db()
    for key, val in (("identity", s.identity), ("wan_if", s.wan_if),
                     ("lan_if", s.lan_if)):
        if val is not None:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, val),
            )
    if s.admin_password:
        conn.execute(
            "UPDATE admin_users SET password_hash=? WHERE username=?",
            (hashpw(s.admin_password), "admin"),
        )
    conn.commit()
    conn.close()
    if s.admin_password:
        for fn in ("sessions",):
            pass
        conn = db()
        conn.execute("DELETE FROM sessions")
        conn.commit()
        conn.close()
    return {"ok": True}


@app.post("/api/reload", dependencies=[Depends(check_auth)])
def reload_all():
    apply_all()
    return {"ok": True, "note": "engine dijalankan ulang (nft, dnsmasq, tc)"}


app.mount("/", StaticFiles(directory=str(Path(__file__).parent / "static"), html=True), name="static")