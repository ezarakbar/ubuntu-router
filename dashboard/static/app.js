const LS_TOK = "ur_token";
const LS_USER = "ur_user";
let TOKEN = localStorage.getItem(LS_TOK) || "";
let USER = localStorage.getItem(LS_USER) || "";
let CURRENT = "dashboard";

const hdrs = (json = true) => {
  const h = { Authorization: "Bearer " + TOKEN };
  if (json) h["Content-Type"] = "application/json";
  return h;
};

async function api(path, opts = {}) {
  const o = { ...opts, headers: { ...hdrs(), ...(opts.headers || {}) } };
  if (opts.body) o.body = JSON.stringify(opts.body);
  const r = await fetch("/api" + path, o);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) { showLogin(); }
    throw new Error(data.detail || r.statusText);
  }
  return data;
}

function msg(text, cls = "err") {
  const el = document.getElementById("msg");
  el.textContent = text;
  el.className = "muted " + cls;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const fmtNum = n => (n == null ? "–" : Number(n).toLocaleString("id-ID"));
const badge = (on, onText, offText) =>
  `<span class="badge ${on ? "on" : "off"}">${on ? onText : offText}</span>`;

/* ---------------- login ---------------- */
function showLogin() {
  document.getElementById("login").style.display = "flex";
  document.getElementById("app").classList.remove("on");
}
function enterApp() {
  document.getElementById("login").style.display = "none";
  document.getElementById("app").classList.add("on");
  renderNav();
  navigate("dashboard");
}
async function doLogin() {
  const u = document.getElementById("lUser").value.trim();
  const p = document.getElementById("lPass").value;
  const m = document.getElementById("msgLogin");
  try {
    const r = await fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || r.statusText);
    TOKEN = d.token; USER = d.username;
    localStorage.setItem(LS_TOK, TOKEN);
    localStorage.setItem(LS_USER, USER);
    m.textContent = ""; m.className = "muted";
    enterApp();
  } catch (e) { m.textContent = e.message; m.className = "err"; }
}
async function doLogout() {
  try { await api("/logout", { method: "POST" }); } catch (e) {}
  TOKEN = ""; localStorage.removeItem(LS_TOK);
  showLogin();
}

/* ---------------- nav ---------------- */
const MENU = [
  { grp: "Menu Utama" },
  { key: "dashboard", label: "Dashboard" },
  { key: "customers", label: "Pelanggan" },
  { key: "profiles", label: "Profile" },
  { grp: "IP" },
  { key: "pools", label: "DHCP — Pool" },
  { key: "leases", label: "DHCP — Lease" },
  { grp: "IP · Firewall" },
  { key: "filter", label: "Firewall — Filter" },
  { key: "nat", label: "Firewall — NAT" },
  { key: "mangle", label: "Firewall — Mangle" },
  { key: "addrlists", label: "Firewall — Address List" },
  { grp: "IP · Routing" },
  { key: "policy", label: "Routing — Policy" },
  { grp: "IP · Tunnel" },
  { key: "wireguard", label: "Tunnel — WireGuard" },
  { key: "interfaces", label: "Interfaces" },
  { grp: "Sistem" },
  { key: "system", label: "System & Health" },
  { key: "logs", label: "Logs" },
];
const TITLES = Object.fromEntries(MENU.filter(m => m.key).map(m => [m.key, m.label]));

function renderNav() {
  document.getElementById("nav").innerHTML = MENU.map(m =>
    m.grp ? `<div class="grp">${m.grp}</div>`
          : `<a class="menu ${m.key === CURRENT ? "active" : ""}" onclick="navigate('${m.key}')">${m.label}</a>`
  ).join("");
  refreshTopbar().catch(() => {});
}
function navigate(key) {
  CURRENT = key;
  document.querySelectorAll("#nav a.menu").forEach(a =>
    a.classList.toggle("active", a.dataset.k === key));
  document.getElementById("pageTitle").textContent = TITLES[key] || key;
  const fn = RENDER[key];
  if (fn) fn().catch(e => { content(`<div class="err">${esc(e.message)}</div>`); });
}

function content(html) {
  document.getElementById("content").innerHTML = html;
}

/* ---------------- topbar / dashboard ---------------- */
async function refreshTopbar() {
  const s = await api("/status");
  const sys = s.system;
  document.getElementById("identTop").textContent = sys.identity || "ubuntu-router";
  document.getElementById("sideFoot").textContent = `${sys.hostname} · up ${fmtNum(parseFloat(sys.uptime))}s`;
  const mempct = sys.mem_total_mb ? Math.round((1 - sys.mem_available_mb / sys.mem_total_mb) * 100) : 0;
  const diskpct = sys.disk_total_gb ? Math.round((sys.disk_used_gb / sys.disk_total_gb) * 100) : 0;
  document.getElementById("health").innerHTML = `
    <span class="h">CPU <b>${esc(sys.load_1m)}</b> (${sys.cpu_cores} core)</span>
    <span class="h">RAM <b>${mempct}%</b></span>
    <span class="h">Disk <b>${diskpct}%</b></span>
    <span class="h">WAN <b>${esc((sys.wan && (sys.wan.address)) || "–")}</b></span>
    <span class="h">Pelanggan <b>${s.customers_active}</b></span>
    <span class="h">Lease <b>${s.leases_count}</b></span>`;
}

async function renderDashboard() {
  const s = await api("/status");
  const sys = s.system;
  const wan = sys.wan || {};
  const conns = s.leases.filter(l => l.hostname !== "*");
  content(`
    <div class="cards">
      <div class="card"><h3>Pelanggan Aktif</h3><div class="big">${s.customers_active}</div><div class="sub">${s.pools_active} pool DHCP aktif</div></div>
      <div class="card"><h3>Lease DHCP</h3><div class="big">${s.leases_count}</div><div class="sub">${conns.length} bernama</div></div>
      <div class="card"><h3>Rule NAT Aktif</h3><div class="big">${s.nat_rules_active}</div></div>
      <div class="card"><h3>Load 1m</h3><div class="big">${esc(sys.load_1m)}</div><div class="sub">${sys.cpu_cores} core CPU</div></div>
      <div class="card"><h3>RAM</h3><div class="big">${fmtNum(sys.mem_available_mb)} MB</div><div class="sub">bebas dari ${fmtNum(sys.mem_total_mb)} MB</div></div>
      <div class="card"><h3>Disk</h3><div class="big">${fmtNum(sys.disk_used_gb)} GB</div><div class="sub">dari ${fmtNum(sys.disk_total_gb)} GB</div></div>
    </div>
    <section class="view"><h2>Interfaces <span class="muted">${esc(wan.interface || "")} = WAN</span></h2>
      <table><thead><tr><th>Iface</th><th>Alamat</th><th>State</th><th>MTU</th><th>Speed</th><th>Rx (B)</th><th>Tx (B)</th></tr></thead>
      <tbody>${sys.interfaces.map(i => `
        <tr><td>${esc(i.name)}</td><td>${esc(i.address) || "–"}</td>
        <td><span class="badge ${i.up ? "on" : "off"}">${esc(i.operstate)}</span></td>
        <td>${i.mtu}</td><td>${esc(i.speed)}</td>
        <td>${fmtNum(i.rx_bytes)}</td><td>${fmtNum(i.tx_bytes)}</td></tr>`).join("")}
      </tbody></table>
    </section>
    <section class="view"><h2>Lease DHCP Terbaru</h2>
      <table><thead><tr><th>Host</th><th>IP</th><th>MAC</th><th>Kadaluarsa</th></tr></thead>
      <tbody>${s.leases.slice(0, 15).map(l => `
        <tr><td>${esc(l.hostname)}</td><td>${esc(l.ip)}</td><td>${esc(l.mac)}</td><td>${fmtNum(parseInt(l.expires))}</td></tr>`).join("")
        || '<tr><td colspan="4" class="muted">Belum ada lease</td></tr>'}
      </tbody></table>
    </section>`);
}

/* ---------------- customers ---------------- */
async function renderCustomers() {
  const [cust, prof] = await Promise.all([api("/customers"), api("/profiles")]);
  const leases = await api("/dhcp/leases").then(r => r.leases).catch(() => []);
  const byMac = {};
  leases.forEach(l => byMac[l.mac.toLowerCase()] = l);
  content(`
    <section class="view"><h2>Tambah Pelanggan</h2>
      <form class="f" id="fCust" onsubmit="return false;">
        <label>Nama<input id="cName" required></label>
        <label>MAC<select id="cMac">${leases.map(l => `<option value="${esc(l.mac)}">${esc(l.mac)} (${esc(l.hostname || l.ip)})</option>`).join("") || '<option value="">— kosong, isi manual —</option>'}</select></label>
        <label>IP Statis (ops.)<input id="cStatic" placeholder="10.10.0.150"></label>
        <label>Profile<select id="cProf">${prof.map(p => `<option>${esc(p.name)}</option>`).join("")}</select></label>
        <label>Komentar<input id="cComment" placeholder="cth: Pak Budi RT 01"></label>
        <button onclick="addCustomer()">Tambah</button>
      </form>
      <table><thead><tr><th>Nama</th><th>MAC</th><th>IP</th><th>Profile</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${cust.map(c => `
        <tr>
          <td>${esc(c.name)}</td><td>${esc(c.mac) || "–"}</td>
          <td>${esc(c.current_ip || c.static_ip || "dinamis")}</td>
          <td>${esc(c.profile_name)}</td>
          <td>${badge(c.active, "aktif", "nonaktif")}</td>
          <td>
            <button class="ghost mini" onclick="toggleCust('${esc(c.name)}', ${c.active ? 0 : 1})">${c.active ? "Nonaktif" : "Aktif"}</button>
            <button class="danger mini" onclick="delCust('${esc(c.name)}')">Hapus</button>
          </td>
        </tr>`).join("") || '<tr><td colspan="6" class="muted">Belum ada pelanggan</td></tr>'}
      </tbody></table>
    </section>`);
}

async function addCustomer() {
  const name = document.getElementById("cName").value.trim();
  const mac = document.getElementById("cMac").value.trim();
  const stat = document.getElementById("cStatic").value.trim();
  const prof = document.getElementById("cProf").value;
  const cmt = document.getElementById("cComment").value.trim();
  if (!name) return msg("Nama wajib diisi");
  try {
    await api("/customers", { method: "POST", body: { name, mac, static_ip: stat || null, profile: prof, comment: cmt || null } });
    msg(`Pelanggan ${name} ditambahkan & tag IP diterapkan`, "okmsg");
    renderCustomers().catch(() => {});
    refreshTopbar().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function toggleCust(name, active) {
  try {
    await api("/customers/" + encodeURIComponent(name), { method: "PUT", body: { active } });
    msg(`Pelanggan ${name} ${active ? "diaktifkan" : "dinonaktifkan"}`, "okmsg");
    renderCustomers().catch(() => {}); refreshTopbar().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delCust(name) {
  if (!confirm("Hapus pelanggan " + name + "?")) return;
  try {
    await api("/customers/" + encodeURIComponent(name), { method: "DELETE" });
    msg("Pelanggan dihapus", "okmsg");
    renderCustomers().catch(() => {}); refreshTopbar().catch(() => {});
  } catch (e) { msg(e.message); }
}

/* ---------------- profiles ---------------- */
async function renderProfiles() {
  const p = await api("/profiles");
  content(`
    <section class="view"><h2>Tambah Profile</h2>
      <form class="f" onsubmit="return false;">
        <label>Nama<input id="pName" placeholder="7M" required></label>
        <label>Down (kbit)<input id="pDown" type="number" min="64" value="7000"></label>
        <label>Up (kbit)<input id="pUp" type="number" min="64" value="3000"></label>
        <label>Burst Down (kbit, ops.)<input id="pBurstD" type="number" min="0" value="0" placeholder="0 = tanpa burst"></label>
        <label>Burst Up (kbit, ops.)<input id="pBurstU" type="number" min="0" value="0" placeholder="0 = tanpa burst"></label>
        <label>Priority<input id="pPri" type="number" value="1"></label>
        <button onclick="addProfile()">Tambah</button>
      </form>
      <table><thead><tr><th>Nama</th><th>Down</th><th>Up</th><th>Burst</th><th>Pri</th><th>Aksi</th></tr></thead>
      <tbody>${p.map(x => `
        <tr><td>${esc(x.name)}</td><td>${fmtNum(x.rate_down_kbit)} kbit</td><td>${fmtNum(x.rate_up_kbit)} kbit</td>
        <td>${x.burst_down_kbit ? `${fmtNum(x.burst_down_kbit)}/${fmtNum(x.burst_up_kbit)} kbit` : "–"}</td>
        <td>${x.priority}</td>
        <td>
          <button class="ghost mini" onclick="editProfile('${esc(x.name)}')">Ubah</button>
          <button class="danger mini" onclick="delProfile('${esc(x.name)}')">Hapus</button>
        </td></tr>`).join("")}
      </tbody></table>
    </section>`);
}
async function addProfile() {
  const name = document.getElementById("pName").value.trim();
  const d = +document.getElementById("pDown").value;
  const u = +document.getElementById("pUp").value;
  const bd = +document.getElementById("pBurstD").value || 0;
  const bu = +document.getElementById("pBurstU").value || 0;
  const pr = +document.getElementById("pPri").value || 1;
  if (!name || !d || !u) return msg("Lengkapi nama & rate");
  try {
    await api("/profiles", { method: "POST", body: { name, rate_down_kbit: d, rate_up_kbit: u, burst_down_kbit: bd, burst_up_kbit: bu, priority: pr } });
    msg("Profile ditambahkan", "okmsg"); renderProfiles().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function editProfile(name) {
  const rate = prompt(`Rate baru profile ${name} (kbit down/up [/burst_down/burst_up])\ncontoh: 7000/3000/10000/5000`);
  if (!rate) return;
  const parts = rate.split("/").map(Number);
  if (parts.length < 2 || !parts[0] || !parts[1]) return msg("Format salah: down/up [/burst]");
  try {
    await api("/profiles/" + encodeURIComponent(name), { method: "PUT", body: { rate_down_kbit: parts[0], rate_up_kbit: parts[1], burst_down_kbit: parts[2] || 0, burst_up_kbit: parts[3] || 0 } });
    msg(`Profile ${name} diperbarui (queue ditata ulang)`, "okmsg");
    renderProfiles().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delProfile(name) {
  if (!confirm("Hapus profile " + name + "?")) return;
  try {
    await api("/profiles/" + encodeURIComponent(name), { method: "DELETE" });
    msg("Profile dihapus", "okmsg"); renderProfiles().catch(() => {});
  } catch (e) { msg(e.message); }
}

/* ---------------- pools ---------------- */
async function renderPools() {
  const pools = await api("/pools");
  content(`
    <section class="view"><h2>Tambah Pool DHCP</h2>
      <form class="f" onsubmit="return false;">
        <label>Nama<input id="plName" placeholder="lan-lab" required></label>
        <label>Interface<input id="plIface" placeholder="br-lan"></label>
        <label>Mulai<input id="plStart" placeholder="10.10.0.100" required></label>
        <label>Akhir<input id="plEnd" placeholder="10.10.0.200" required></label>
        <label>Gateway<input id="plGw" placeholder="10.10.0.1"></label>
        <label>DNS1<input id="plDns1" placeholder="1.1.1.1"></label>
        <label>DNS2<input id="plDns2" placeholder="8.8.8.8"></label>
        <button onclick="addPool()">Tambah</button>
      </form>
      <table><thead><tr><th>Nama</th><th>Range</th><th>Iface</th><th>GW</th><th>DNS</th><th>Lease</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${pools.map(x => `
        <tr><td>${esc(x.name)}</td><td>${esc(x.start_ip)} – ${esc(x.end_ip)}</td>
        <td>${esc(x.iface) || "–"}</td><td>${esc(x.router_ip) || "–"}</td>
        <td>${esc(x.dns1) || "–"}${x.dns2 ? ", " + esc(x.dns2) : ""}</td><td>${esc(x.leasetime)}</td>
        <td>${badge(x.active, "aktif", "nonaktif")}</td>
        <td><button class="ghost mini" onclick="togglePool(${x.id}, ${x.active ? 0 : 1})">${x.active ? "Nonaktif" : "Aktif"}</button>
            <button class="danger mini" onclick="delPool(${x.id})">Hapus</button></td></tr>`).join("")
        || '<tr><td colspan="8" class="muted">Belum ada pool</td></tr>'}
      </tbody></table>
    </section>`);
}
async function addPool() {
  const name = document.getElementById("plName").value.trim();
  const body = {
    name,
    iface: document.getElementById("plIface").value.trim() || null,
    start_ip: document.getElementById("plStart").value.trim(),
    end_ip: document.getElementById("plEnd").value.trim(),
    router_ip: document.getElementById("plGw").value.trim() || null,
    dns1: document.getElementById("plDns1").value.trim() || null,
    dns2: document.getElementById("plDns2").value.trim() || null,
  };
  if (!name || !body.start_ip || !body.end_ip) return msg("Nama, mulai & akhir wajib");
  try {
    await api("/pools", { method: "POST", body });
    msg("Pool ditambahkan (dnsmasq direload)", "okmsg"); renderPools().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function togglePool(id, active) {
  try {
    await api("/pools/" + id, { method: "PUT", body: { active } });
    msg("Pool " + (active ? "diaktifkan" : "dinonaktifkan"), "okmsg");
    renderPools().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delPool(id) {
  if (!confirm("Hapus pool #" + id + "?")) return;
  try {
    await api("/pools/" + id, { method: "DELETE" });
    msg("Pool dihapus", "okmsg"); renderPools().catch(() => {});
  } catch (e) { msg(e.message); }
}

/* ---------------- leases ---------------- */
async function renderLeases() {
  const r = await api("/dhcp/leases");
  content(`
    <section class="view"><h2>Lease DHCP Aktif (dnsmasq)</h2>
      <table><thead><tr><th>Host</th><th>IP</th><th>MAC</th><th>Kadaluarsa (epoch)</th></tr></thead>
      <tbody>${r.leases.map(l => `
        <tr><td>${esc(l.hostname)}</td><td>${esc(l.ip)}</td><td>${esc(l.mac)}</td><td>${fmtNum(parseInt(l.expires))}</td></tr>`).join("")
        || '<tr><td colspan="4" class="muted">Belum ada lease</td></tr>'}
      </tbody></table>
      <p class="muted" style="margin-top:10px">Lease ini dipakai engine untuk men-tag IP pelanggan dinamis (address-list + queue).</p>
    </section>`);
}

/* ---------------- NAT ---------------- */
async function renderNat() {
  const [rules, masq] = await Promise.all([api("/firewall/nat"), api("/firewall/masquerade")]);
  content(`
    <section class="view"><h2>NAT — dstnat &amp; srcnat (nftables)</h2>
      <div class="tbar">
        <span class="muted">Masquerade (srcnat):</span>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;">
          <input type="checkbox" id="mMasq" style="width:auto" ${masq.enabled ? "checked" : ""} onchange="toggleMasq()"> Aktif
        </label>
        <button class="ghost mini" onclick="reloadAll()">↻ Render ulang engine</button>
      </div>
      <form class="f" onsubmit="return false;">
        <label>Chain<select id="nChain"><option value="dstnat">dstnat</option><option value="srcnat">srcnat</option></select></label>
        <label>Aksi<select id="nAction"><option value="dnat">dnat</option><option value="masquerade">masquerade</option><option value="snat">snat</option><option value="drop">drop</option><option value="accept">accept</option></select></label>
        <label>Proto<select id="nProto"><option value="">semua</option><option>tcp</option><option>udp</option></select></label>
        <label>Dst Port<input id="nDport" type="number" placeholder="8081"></label>
        <label>To Address<input id="nToAddr" placeholder="10.10.0.101"></label>
        <label>To Port (ops.)<input id="nToPort" type="number" placeholder="80"></label>
        <label>Komentar<input id="nComment" placeholder="cth: CCTV pelanggan"></label>
        <button onclick="addNat()">Tambah</button>
      </form>
      <table><thead><tr><th>ID</th><th>Chain</th><th>Aksi</th><th>Matcher</th><th>Target</th><th>Komentar</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${rules.map(x => {
        const parts = [];
        if (x.proto) parts.push(x.proto);
        if (x.src_address) parts.push("src " + x.src_address);
        if (x.dst_address) parts.push("dst " + x.dst_address);
        if (x.src_port) parts.push("sport " + x.src_port);
        if (x.dst_port) parts.push("dport " + x.dst_port);
        const target = ["dnat", "snat", "masquerade"].includes(x.action)
          ? (x.to_addresses || "–") + (x.to_ports ? ":" + x.to_ports : "") : "–";
        return `<tr><td>${x.id}</td><td>${esc(x.chain)}</td><td>${esc(x.action)}</td>
          <td class="muted">${esc(parts.join(" ")) || "–"}</td><td>${esc(target)}</td>
          <td class="muted">${esc(x.comment) || "–"}</td>
          <td>${badge(x.active, "aktif", "mati")}</td>
          <td><button class="ghost mini" onclick="toggleNat(${x.id}, ${x.active ? 0 : 1})">${x.active ? "Nonaktif" : "Aktif"}</button>
              <button class="danger mini" onclick="delNat(${x.id})">Hapus</button></td></tr>`;
      }).join("") || '<tr><td colspan="8" class="muted">Belum ada rule</td></tr>'}
      </tbody></table>
    </section>`);
}
async function addNat() {
  const body = {
    chain: document.getElementById("nChain").value,
    action: document.getElementById("nAction").value,
    protocol: document.getElementById("nProto").value || null,
    dst_port: document.getElementById("nDport").value ? +document.getElementById("nDport").value : null,
    to_addresses: document.getElementById("nToAddr").value.trim() || null,
    to_ports: document.getElementById("nToPort").value ? +document.getElementById("nToPort").value : null,
    comment: document.getElementById("nComment").value.trim() || null,
  };
  if (!body.to_addresses && !["drop", "accept", "masquerade"].includes(body.action))
    return msg("Isi To Address untuk dnat/snat");
  try {
    await api("/firewall/nat", { method: "POST", body });
    msg("Rule NAT ditambahkan & diterapkan", "okmsg"); renderNat().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function toggleMasq() {
  try {
    await api("/firewall/masquerade", { method: "POST", body: { enabled: document.getElementById("mMasq").checked } });
    msg("Masquerade " + (document.getElementById("mMasq").checked ? "diaktifkan" : "dinonaktifkan"), "okmsg");
  } catch (e) { msg(e.message); }
}
async function toggleNat(id, active) {
  try {
    await api("/firewall/nat/" + id, { method: "PUT", body: { active } });
    msg("Rule #" + id + " " + (active ? "diaktifkan" : "dinonaktifkan"), "okmsg");
    renderNat().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delNat(id) {
  if (!confirm("Hapus rule NAT #" + id + "?")) return;
  try {
    await api("/firewall/nat/" + id, { method: "DELETE" });
    msg("Rule NAT dihapus", "okmsg"); renderNat().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function reloadAll() {
  try {
    const r = await api("/reload", { method: "POST" });
    msg(r.note, "okmsg");
  } catch (e) { msg(e.message); }
}

/* ---------------- interfaces ---------------- */
async function renderInterfaces() {
  const r = await api("/interfaces");
  content(`
    <section class="view"><h2>Interfaces</h2>
      <table><thead><tr><th>Iface</th><th>Alamat</th><th>State</th><th>MTU</th><th>Speed</th><th>Rx (B)</th><th>Tx (B)</th></tr></thead>
      <tbody>${r.interfaces.map(i => `
        <tr><td>${esc(i.name)}</td><td>${esc(i.address) || "–"}</td>
        <td><span class="badge ${i.up ? "on" : "off"}">${esc(i.operstate)}</span></td>
        <td>${i.mtu}</td><td>${esc(i.speed)}</td>
        <td>${fmtNum(i.rx_bytes)}</td><td>${fmtNum(i.tx_bytes)}</td></tr>`).join("")}
      </tbody></table>
    </section>`);
}

/* ---------------- system ---------------- */
async function renderSystem() {
  const [s, st] = await Promise.all([api("/system"), api("/settings")]);
  const sys = s.system;
  const mempct = sys.mem_total_mb ? Math.round((1 - sys.mem_available_mb / sys.mem_total_mb) * 100) : 0;
  const diskpct = sys.disk_total_gb ? Math.round((sys.disk_used_gb / sys.disk_total_gb) * 100) : 0;
  content(`
    <div class="cards">
      <div class="card"><h3>Hostname</h3><div class="big">${esc(sys.hostname)}</div></div>
      <div class="card"><h3>Uptime</h3><div class="big">${fmtNum(Math.round(parseFloat(sys.uptime) || 0))} s</div></div>
      <div class="card"><h3>RAM</h3><div class="big">${mempct}%</div><div class="sub">${fmtNum(sys.mem_available_mb)} MB bebas</div></div>
      <div class="card"><h3>Disk</h3><div class="big">${diskpct}%</div><div class="sub">${fmtNum(sys.disk_used_gb)} / ${fmtNum(sys.disk_total_gb)} GB</div></div>
    </div>
    <section class="view"><h2>Identity &amp; Pengaturan</h2>
      <form class="f" onsubmit="return false;">
        <label>Nama Router (identity)<input id="iIdent" value="${esc(st.identity)}"></label>
        <label>Interface LAN<input id="iLan" value="${esc(st.lan_if)}"></label>
        <label>Interface WAN<input id="iWan" value="${esc(st.wan_if)}"></label>
        <button onclick="saveSettings()">Simpan</button>
      </form>
      <form class="f" onsubmit="return false;">
        <label>Ganti Password Admin<input id="iPass" type="password" placeholder="kosongkan bila tidak ganti"></label>
        <button class="ghost" onclick="savePass()">Ganti Password</button>
      </form>
    </section>`);
}
async function saveSettings() {
  try {
    await api("/settings", { method: "POST", body: {
      identity: document.getElementById("iIdent").value.trim() || null,
      lan_if: document.getElementById("iLan").value.trim() || null,
      wan_if: document.getElementById("iWan").value.trim() || null,
    } });
    msg("Pengaturan disimpan", "okmsg");
    refreshTopbar().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function savePass() {
  const p = document.getElementById("iPass").value;
  if (!p) return msg("Isi password baru");
  if (!confirm("Ganti password admin?")) return;
  try {
    await api("/settings", { method: "POST", body: { admin_password: p } });
    msg("Password diganti — silakan login ulang", "okmsg");
    doLogout();
  } catch (e) { msg(e.message); }
}

/* ---------------- logs ---------------- */
async function renderLogs() {
  const r = await api("/logs?lines=100");
  content(`
    <section class="view"><h2>Log Sistem (journald)</h2>
      <div class="tbar">
        <button class="ghost mini" onclick="renderLogs()">↻ Segarkan</button>
      </div>
      <pre class="logbox">${esc(r.logs || "(kosong)")}</pre>
    </section>`);
}

/* ---------------- firewall: filter ---------------- */
async function renderFilter() {
  const rules = await api("/firewall/filter");
  const lists = await api("/address-lists");
  const listOpts = lists.map(l => `<option>${esc(l.name)}</option>`).join("");
  content(`
    <section class="view"><h2>Firewall Filter (input/forward/output) <span class="muted">default policy = accept</span></h2>
      <div class="tbar"><button class="ghost mini" onclick="reloadAll()">↻ Render ulang engine</button></div>
      <form class="f" onsubmit="return false;">
        <label>Chain<select id="fChain"><option value="forward">forward</option><option value="input">input</option><option value="output">output</option></select></label>
        <label>Aksi<select id="fAction"><option value="drop">drop</option><option value="accept">accept</option><option value="reject">reject</option><option value="log">log</option></select></label>
        <label>Proto<select id="fProto"><option value="">semua</option><option>tcp</option><option>udp</option><option>icmp</option></select></label>
        <label>Src Addr<input id="fSrc" placeholder="10.10.0.0/24"></label>
        <label>Dst Addr<input id="fDst" placeholder="10.10.0.1"></label>
        <label>Src Port<input id="fSport" type="number"></label>
        <label>Dst Port<input id="fDport" type="number"></label>
        <label>Src List<select id="fSrcList"><option value="">–</option>${listOpts}</select></label>
        <label>Dst List<select id="fDstList"><option value="">–</option>${listOpts}</select></label>
        <label>Conn State<select id="fState"><option value="">–</option><option value="invalid">invalid</option><option value="established,related">established,related</option><option value="new">new</option></select></label>
        <label>ICMP Type<input id="fIcmp" placeholder="echo-request"></label>
        <label>Limit<input id="fLimit" placeholder="10/second"></label>
        <label>Komentar<input id="fComment" placeholder="cth: blokir akses internet"></label>
        <button onclick="addFilter()">Tambah</button>
      </form>
      <table><thead><tr><th>ID</th><th>Chain</th><th>Aksi</th><th>Matcher</th><th>Komentar</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${rules.map(x => {
        const parts = [];
        if (x.proto) parts.push(x.proto);
        if (x.src_address) parts.push("src " + x.src_address);
        if (x.dst_address) parts.push("dst " + x.dst_address);
        if (x.src_port) parts.push("sport " + x.src_port);
        if (x.dst_port) parts.push("dport " + x.dst_port);
        if (x.src_list) parts.push("src-list " + x.src_list);
        if (x.dst_list) parts.push("dst-list " + x.dst_list);
        if (x.connstate) parts.push("state " + x.connstate);
        if (x.icmp_type) parts.push("icmp " + x.icmp_type);
        if (x.limit_rate) parts.push("limit " + x.limit_rate);
        return `<tr><td>${x.id}</td><td>${esc(x.chain)}</td><td>${esc(x.action)}</td>
          <td class="muted">${esc(parts.join(" ")) || "–"}</td><td class="muted">${esc(x.comment) || "–"}</td>
          <td>${badge(x.active, "aktif", "mati")}</td>
          <td><button class="ghost mini" onclick="toggleFilter(${x.id}, ${x.active ? 0 : 1})">${x.active ? "Nonaktif" : "Aktif"}</button>
              <button class="danger mini" onclick="delFilter(${x.id})">Hapus</button></td></tr>`;
      }).join("") || '<tr><td colspan="7" class="muted">Belum ada rule</td></tr>'}
      </tbody></table>
    </section>`);
}
async function addFilter() {
  const g = id => document.getElementById(id).value;
  const num = id => { const v = g(id); return v ? +v : null; };
  const body = {
    chain: g("fChain"), action: g("fAction"),
    protocol: g("fProto") || null,
    src_address: g("fSrc").trim() || null, dst_address: g("fDst").trim() || null,
    src_port: num("fSport"), dst_port: num("fDport"),
    src_list: g("fSrcList") || null, dst_list: g("fDstList") || null,
    connstate: g("fState") || null, icmp_type: g("fIcmp").trim() || null,
    limit_rate: g("fLimit").trim() || null,
    comment: g("fComment").trim() || null,
  };
  if (body.action === "drop" && !body.src_address && !body.dst_address && !body.src_list && !body.dst_list && !body.protocol)
    return msg("Hati-hati: drop tanpa matcher akan memblokir SEMUA lalu lintas chain tsb. Isi matcher dulu.");
  try {
    await api("/firewall/filter", { method: "POST", body });
    msg("Rule filter ditambahkan & diterapkan", "okmsg"); renderFilter().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function toggleFilter(id, active) {
  try {
    await api("/firewall/filter/" + id, { method: "PUT", body: { active } });
    msg("Rule #" + id + " " + (active ? "diaktifkan" : "dinonaktifkan"), "okmsg");
    renderFilter().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delFilter(id) {
  if (!confirm("Hapus rule filter #" + id + "?")) return;
  try {
    await api("/firewall/filter/" + id, { method: "DELETE" });
    msg("Rule filter dihapus", "okmsg"); renderFilter().catch(() => {});
  } catch (e) { msg(e.message); }
}

/* ---------------- firewall: mangle ---------------- */
async function renderMangle() {
  const rules = await api("/firewall/mangle");
  const lists = await api("/address-lists");
  const listOpts = lists.map(l => `<option>${esc(l.name)}</option>`).join("");
  content(`
    <section class="view"><h2>Mangle (mark packet/connection) <span class="muted">untuk policy routing</span></h2>
      <div class="tbar"><button class="ghost mini" onclick="reloadAll()">↻ Render ulang engine</button></div>
      <form class="f" onsubmit="return false;">
        <label>Chain<select id="mChain">
          <option value="prerouting">prerouting</option><option value="input">input</option>
          <option value="forward">forward</option><option value="output">output</option><option value="postrouting">postrouting</option>
        </select></label>
        <label>Aksi<select id="mAction"><option value="mark_packet">mark_packet</option><option value="mark_connection">mark_connection</option><option value="accept">accept</option><option value="drop">drop</option></select></label>
        <label>Mark<select id="mMark">
          <option value="16">0x10 (16)</option><option value="32">0x20 (32)</option>
          <option value="64">0x40 (64)</option><option value="128">0x80 (128)</option>
        </select></label>
        <label>Proto<select id="mProto"><option value="">semua</option><option>tcp</option><option>udp</option></select></label>
        <label>Src Addr<input id="mSrc" placeholder="10.10.0.0/24"></label>
        <label>Dst Addr<input id="mDst" placeholder="192.168.96.3"></label>
        <label>Src Port<input id="mSport" type="number"></label>
        <label>Dst Port<input id="mDport" type="number"></label>
        <label>Src List<select id="mSrcList"><option value="">–</option>${listOpts}</select></label>
        <label>Dst List<select id="mDstList"><option value="">–</option>${listOpts}</select></label>
        <label>Komentar<input id="mComment" placeholder="cth: tandai trafik download"></label>
        <button onclick="addMangle()">Tambah</button>
      </form>
      <table><thead><tr><th>ID</th><th>Chain</th><th>Aksi</th><th>Mark</th><th>Matcher</th><th>Komentar</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${rules.map(x => {
        const parts = [];
        if (x.proto) parts.push(x.proto);
        if (x.src_address) parts.push("src " + x.src_address);
        if (x.dst_address) parts.push("dst " + x.dst_address);
        if (x.src_port) parts.push("sport " + x.src_port);
        if (x.dst_port) parts.push("dport " + x.dst_port);
        if (x.src_list) parts.push("src-list " + x.src_list);
        if (x.dst_list) parts.push("dst-list " + x.dst_list);
        return `<tr><td>${x.id}</td><td>${esc(x.chain)}</td><td>${esc(x.action)}</td>
          <td>${x.mark != null ? "0x" + Number(x.mark).toString(16) : "–"}</td>
          <td class="muted">${esc(parts.join(" ")) || "–"}</td><td class="muted">${esc(x.comment) || "–"}</td>
          <td>${badge(x.active, "aktif", "mati")}</td>
          <td><button class="ghost mini" onclick="toggleMangle(${x.id}, ${x.active ? 0 : 1})">${x.active ? "Nonaktif" : "Aktif"}</button>
              <button class="danger mini" onclick="delMangle(${x.id})">Hapus</button></td></tr>`;
      }).join("") || '<tr><td colspan="8" class="muted">Belum ada rule</td></tr>'}
      </tbody></table>
    </section>`);
}
async function addMangle() {
  const g = id => document.getElementById(id).value;
  const num = id => { const v = g(id); return v ? +v : null; };
  const body = {
    chain: g("mChain"), action: g("mAction"),
    mark: g("mMark") ? +g("mMark") : null,
    protocol: g("mProto") || null,
    src_address: g("mSrc").trim() || null, dst_address: g("mDst").trim() || null,
    src_port: num("mSport"), dst_port: num("mDport"),
    src_list: g("mSrcList") || null, dst_list: g("mDstList") || null,
    comment: g("mComment").trim() || null,
  };
  try {
    await api("/firewall/mangle", { method: "POST", body });
    msg("Rule mangle ditambahkan & diterapkan", "okmsg"); renderMangle().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function toggleMangle(id, active) {
  try {
    await api("/firewall/mangle/" + id, { method: "PUT", body: { active } });
    msg("Rule #" + id + " " + (active ? "diaktifkan" : "dinonaktifkan"), "okmsg");
    renderMangle().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delMangle(id) {
  if (!confirm("Hapus rule mangle #" + id + "?")) return;
  try {
    await api("/firewall/mangle/" + id, { method: "DELETE" });
    msg("Rule mangle dihapus", "okmsg"); renderMangle().catch(() => {});
  } catch (e) { msg(e.message); }
}

/* ---------------- firewall: address lists ---------------- */
async function renderAddrLists() {
  const lists = await api("/address-lists");
  content(`
    <section class="view"><h2>Address List (nft set) <span class="muted">dipakai matcher src-list/dst-list</span></h2>
      <div class="tbar"><button class="ghost mini" onclick="reloadAll()">↻ Render ulang engine</button></div>
      <form class="f" onsubmit="return false;">
        <label>Nama List<input id="alName" placeholder="cth: blocked" required></label>
        <label>Komentar<input id="alComment"></label>
        <button onclick="addAddrList()">Buat List</button>
      </form>
      <table><thead><tr><th>Nama</th><th>Isi (IP/CIDR)</th><th>Komentar</th><th>Aksi</th></tr></thead>
      <tbody>${lists.map(l => `
        <tr><td><b>${esc(l.name)}</b></td>
          <td>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:4px">
              <input id="alNew_${l.id}" placeholder="10.10.0.99" style="max-width:160px">
              <button class="ghost mini" onclick="addListEntry(${l.id})">+</button>
            </div>
            <div class="muted">${(l.entries || []).map(e =>
              `<span style="display:inline-block;background:#0d1220;border:1px solid var(--line);border-radius:10px;padding:1px 8px;margin:2px">${esc(e.address)} <a style="cursor:pointer;color:var(--bad)" onclick="delListEntry(${l.id}, ${e.id})">✕</a></span>`).join(" ") || "— kosong —"}</div>
          </td>
          <td class="muted">${esc(l.comment) || "–"}</td>
          <td><button class="danger mini" onclick="delAddrList(${l.id})">Hapus List</button></td></tr>`).join("")
        || '<tr><td colspan="4" class="muted">Belum ada address-list</td></tr>'}
      </tbody></table>
    </section>`);
}
async function addAddrList() {
  const name = document.getElementById("alName").value.trim();
  const cmt = document.getElementById("alComment").value.trim();
  if (!name) return msg("Nama list wajib");
  if (!/^[A-Za-z0-9_.]+$/.test(name)) return msg("Nama hanya huruf/angka/underscore");
  try {
    await api("/address-lists", { method: "POST", body: { name, comment: cmt || null } });
    msg("Address-list dibuat", "okmsg"); renderAddrLists().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function addListEntry(listId) {
  const v = document.getElementById("alNew_" + listId).value.trim();
  if (!v) return msg("Isi alamat IP/CIDR");
  try {
    await api("/address-lists/" + listId + "/entries", { method: "POST", body: { address: v } });
    msg("Entry ditambahkan & diterapkan", "okmsg"); renderAddrLists().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delListEntry(listId, entryId) {
  try {
    await api(`/address-lists/${listId}/entries/${entryId}`, { method: "DELETE" });
    msg("Entry dihapus", "okmsg"); renderAddrLists().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delAddrList(id) {
  if (!confirm("Hapus address-list #" + id + "?")) return;
  try {
    await api("/address-lists/" + id, { method: "DELETE" });
    msg("Address-list dihapus", "okmsg"); renderAddrLists().catch(() => {});
  } catch (e) { msg(e.message); }
}

/* ---------------- routing: policy ---------------- */
async function renderPolicy() {
  const rules = await api("/policy");
  content(`
    <section class="view"><h2>Policy Routing (fwmark → routing table)</h2>
      <p class="muted" style="margin-bottom:12px">Kombinasi dengan Mangle: tandai paket (cth <code>0x10</code>) lalu atur default route via gateway/interface lain di sini.</p>
      <div class="tbar"><button class="ghost mini" onclick="reloadAll()">↻ Render ulang engine</button></div>
      <form class="f" onsubmit="return false;">
        <label>Mark (fwmark)<select id="poMark">
          <option value="16">0x10 (16)</option><option value="32">0x20 (32)</option>
          <option value="64">0x40 (64)</option><option value="128">0x80 (128)</option>
        </select></label>
        <label>Tabel Routing<select id="poTable">
          <option value="100">100</option><option value="200">200</option><option value="300">300</option>
        </select></label>
        <label>Via (gateway)<input id="poVia" placeholder="192.168.96.1"></label>
        <label>Interface<input id="poDev" placeholder="enp6s0"></label>
        <label>Priority<input id="poPri" type="number" value="5000"></label>
        <label>Komentar<input id="poComment" placeholder="cth: semua trafik 10.10.0.0/24 via WAN2"></label>
        <button onclick="addPolicy()">Tambah</button>
      </form>
      <table><thead><tr><th>ID</th><th>Mark</th><th>Table</th><th>Via/Dev</th><th>Priority</th><th>Komentar</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${rules.map(x => `
        <tr><td>${x.id}</td><td>0x${Number(x.mark).toString(16)}</td><td>${x.table_id}</td>
        <td>${esc(x.via || "")}${x.dev ? " dev " + esc(x.dev) : ""}</td><td>${x.priority}</td>
        <td class="muted">${esc(x.comment) || "–"}</td>
        <td>${badge(x.active, "aktif", "mati")}</td>
        <td><button class="ghost mini" onclick="togglePolicy(${x.id}, ${x.active ? 0 : 1})">${x.active ? "Nonaktif" : "Aktif"}</button>
            <button class="danger mini" onclick="delPolicy(${x.id})">Hapus</button></td></tr>`).join("")
        || '<tr><td colspan="8" class="muted">Belum ada rule</td></tr>'}
      </tbody></table>
    </section>`);
}
async function addPolicy() {
  const g = id => document.getElementById(id).value;
  const body = {
    mark: +g("poMark"), table_id: +g("poTable"),
    via: g("poVia").trim() || null, dev: g("poDev").trim() || null,
    priority: +g("poPri") || 5000,
    comment: g("poComment").trim() || null,
  };
  if (!body.via && !body.dev) return msg("Isi Via (gateway) atau Interface");
  try {
    await api("/policy", { method: "POST", body });
    msg("Policy route ditambahkan & diterapkan", "okmsg"); renderPolicy().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function togglePolicy(id, active) {
  try {
    await api("/policy/" + id, { method: "PUT", body: { active } });
    msg("Rule #" + id + " " + (active ? "diaktifkan" : "dinonaktifkan"), "okmsg");
    renderPolicy().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delPolicy(id) {
  if (!confirm("Hapus policy route #" + id + "?")) return;
  try {
    await api("/policy/" + id, { method: "DELETE" });
    msg("Policy route dihapus", "okmsg"); renderPolicy().catch(() => {});
  } catch (e) { msg(e.message); }
}

/* ---------------- wireguard ---------------- */
function hsAge(epoch) {
  const e = parseInt(epoch) || 0;
  if (!e) return "–";
  const s = Math.floor(Date.now() / 1000) - e;
  if (s < 0) return "baru";
  if (s < 60) return s + " s";
  if (s < 3600) return Math.floor(s / 60) + " m";
  return Math.floor(s / 3600) + " j";
}
const fmtBytes = b => {
  const n = Number(b) || 0;
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB"];
  let i = -1;
  let v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(1) + " " + u[i];
};

async function renderWireguard() {
  const [ifaces, status] = await Promise.all([api("/wg/interfaces"), api("/wg/status")]);
  const live = {};
  status.interfaces.forEach(i => live[i.name] = i);
  content(`
    <section class="view"><h2>Tambah Interface WireGuard</h2>
      <form class="f" onsubmit="return false;">
        <label>Nama<input id="wgName" placeholder="wg1" required></label>
        <label>Listen Port<input id="wgPort" type="number" value="51821"></label>
        <label>Address (CIDR)<input id="wgAddr" placeholder="10.10.4.1/24" required></label>
        <label>DNS (ops.)<input id="wgDns" placeholder="10.10.0.1"></label>
        <label>Komentar<input id="wgComment" placeholder="cth: klien kantor"></label>
        <button onclick="addWgIface()">Tambah (auto-gen key)</button>
      </form>
    </section>
    ${ifaces.map(i => {
      const st = live[i.name] || {};
      const peers = st.peers || {};
      return `
      <section class="view">
        <h2><b>${esc(i.name)}</b>
          <span>
            ${badge(i.active, "aktif", "nonaktif")}
            <button class="ghost mini" onclick="toggleWgIface(${i.id}, ${i.active ? 0 : 1})">${i.active ? "Nonaktif" : "Aktif"}</button>
            <button class="ghost mini" onclick="keygenWg(${i.id})">Regenerate Key</button>
            <button class="danger mini" onclick="delWgIface(${i.id})">Hapus</button>
          </span>
        </h2>
        <table><tbody>
          <tr><td class="muted">Public Key</td><td><code>${esc(i.public_key || "–")}</code></td></tr>
          <tr><td class="muted">Listen Port</td><td>${esc(String(st.port ?? i.listen_port))}</td></tr>
          <tr><td class="muted">Address</td><td>${esc(i.address || "–")}</td></tr>
          <tr><td class="muted">DNS</td><td>${esc(i.dns || "–")}</td></tr>
        </tbody></table>
        <h3 style="margin:14px 0 8px;font-size:12px;color:var(--mut)">Tambahkan Peer</h3>
        <form class="f" onsubmit="return false;">
          <label>Nama<input id="wgpName_${i.id}" placeholder="client-01"></label>
          <label>Public Key<input id="wgpPub_${i.id}" placeholder="base64" required></label>
          <label>AllowedIPs<input id="wgpAllow_${i.id}" placeholder="10.10.1.2/32" required></label>
          <label>Endpoint<input id="wgpEp_${i.id}" placeholder="1.2.3.4:51820"></label>
          <label>Keepalive<input id="wgpKa_${i.id}" type="number" value="25"></label>
          <button class="ghost" onclick="addWgPeer(${i.id})">+ Peer</button>
        </form>
        <table><thead><tr><th>Nama</th><th>Public Key</th><th>AllowedIPs</th><th>Endpoint</th><th>Handshake</th><th>Rx/Tx</th><th>Status</th><th>Aksi</th></tr></thead>
        <tbody>${(i.peers || []).map(p => {
          const lp = peers[p.public_key] || {};
          return `<tr><td>${esc(p.name) || "–"}</td>
            <td><code style="font-size:10.5px">${esc(p.public_key.slice(0, 18))}…</code></td>
            <td>${esc(p.allowed_ips)}</td>
            <td>${esc(p.endpoint) || "–"}</td>
            <td>${hsAge(lp.latest_handshake)}</td>
            <td class="muted">${fmtBytes(lp.rx)} / ${fmtBytes(lp.tx)}</td>
            <td>${badge(p.active, "aktif", "mati")}</td>
            <td><button class="ghost mini" onclick="toggleWgPeer(${p.id}, ${p.active ? 0 : 1})">${p.active ? "Nonaktif" : "Aktif"}</button>
                <button class="danger mini" onclick="delWgPeer(${p.id})">Hapus</button></td></tr>`;
        }).join("") || '<tr><td colspan="8" class="muted">Belum ada peer</td></tr>'}
        </tbody></table>
      </section>`;
    }).join("") || '<section class="view"><h2>WireGuard</h2><p class="muted">Belum ada interface. Tambah di atas.</p></section>'}
  `);
}
async function addWgIface() {
  const body = {
    name: document.getElementById("wgName").value.trim(),
    listen_port: +document.getElementById("wgPort").value || 51820,
    address: document.getElementById("wgAddr").value.trim() || null,
    dns: document.getElementById("wgDns").value.trim() || null,
    comment: document.getElementById("wgComment").value.trim() || null,
  };
  if (!body.name || !body.address) return msg("Nama & Address wajib");
  try {
    await api("/wg/interfaces", { method: "POST", body });
    msg("Interface WireGuard dibuat & aktif", "okmsg"); renderWireguard().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function addWgPeer(ifaceId) {
  const g = id => document.getElementById(id).value;
  const body = {
    iface_id: ifaceId,
    name: g("wgpName_" + ifaceId).trim() || null,
    public_key: g("wgpPub_" + ifaceId).trim(),
    allowed_ips: g("wgpAllow_" + ifaceId).trim(),
    endpoint: g("wgpEp_" + ifaceId).trim() || null,
    persistent_keepalive: +g("wgpKa_" + ifaceId) || 25,
  };
  if (!body.public_key || !body.allowed_ips) return msg("Public Key & AllowedIPs wajib");
  try {
    await api("/wg/peers", { method: "POST", body });
    msg("Peer ditambahkan & diterapkan", "okmsg"); renderWireguard().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function toggleWgIface(id, active) {
  try {
    await api("/wg/interfaces/" + id, { method: "PUT", body: { active } });
    msg("Interface " + (active ? "diaktifkan" : "dinonaktifkan"), "okmsg");
    renderWireguard().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function keygenWg(id) {
  if (!confirm("Generate ulang private key? PEER DI CLIENT HARUS DIPERBARUI.")) return;
  try {
    const r = await api(`/wg/interfaces/${id}/keygen`, { method: "POST" });
    msg("Key baru digenerate. Public key: " + r.public_key.slice(0, 20) + "… (salin ke peer)", "okmsg");
    renderWireguard().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delWgIface(id) {
  if (!confirm("Hapus interface WireGuard #" + id + " (beserta semua peer)?")) return;
  try {
    await api("/wg/interfaces/" + id, { method: "DELETE" });
    msg("Interface dihapus", "okmsg"); renderWireguard().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function toggleWgPeer(id, active) {
  try {
    await api("/wg/peers/" + id, { method: "PUT", body: { active } });
    msg("Peer " + (active ? "diaktifkan" : "dinonaktifkan"), "okmsg");
    renderWireguard().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function delWgPeer(id) {
  if (!confirm("Hapus peer #" + id + "?")) return;
  try {
    await api("/wg/peers/" + id, { method: "DELETE" });
    msg("Peer dihapus", "okmsg"); renderWireguard().catch(() => {});
  } catch (e) { msg(e.message); }
}

/* ---------------- router ---------------- */
const RENDER = {
  dashboard: renderDashboard,
  customers: renderCustomers,
  profiles: renderProfiles,
  pools: renderPools,
  leases: renderLeases,
  nat: renderNat,
  filter: renderFilter,
  mangle: renderMangle,
  addrlists: renderAddrLists,
  policy: renderPolicy,
  wireguard: renderWireguard,
  interfaces: renderInterfaces,
  system: renderSystem,
  logs: renderLogs,
};

function boot() {
  // halaman login default; bila token ada, coba masuk
  if (!TOKEN) { showLogin(); return; }
  api("/status")
    .then(() => enterApp())
    .catch(() => showLogin());
}
setInterval(() => {
  if (TOKEN) {
    if (CURRENT === "dashboard") renderDashboard().catch(() => {});
    refreshTopbar().catch(() => {});
  }
}, 5000);

document.getElementById("lPass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
boot();