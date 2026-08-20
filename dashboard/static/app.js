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
  { key: "nat", label: "Firewall — NAT" },
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
        <label>Priority<input id="pPri" type="number" value="1"></label>
        <button onclick="addProfile()">Tambah</button>
      </form>
      <table><thead><tr><th>Nama</th><th>Down</th><th>Up</th><th>≈ Down</th><th>≈ Up</th><th>Pri</th><th>Aksi</th></tr></thead>
      <tbody>${p.map(x => `
        <tr><td>${esc(x.name)}</td><td>${fmtNum(x.rate_down_kbit)} kbit</td><td>${fmtNum(x.rate_up_kbit)} kbit</td>
        <td>${(x.rate_down_kbit / 1000).toFixed(1)} Mbps</td><td>${(x.rate_up_kbit / 1000).toFixed(1)} Mbps</td>
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
  const pr = +document.getElementById("pPri").value || 1;
  if (!name || !d || !u) return msg("Lengkapi nama & rate");
  try {
    await api("/profiles", { method: "POST", body: { name, rate_down_kbit: d, rate_up_kbit: u, priority: pr } });
    msg("Profile ditambahkan", "okmsg"); renderProfiles().catch(() => {});
  } catch (e) { msg(e.message); }
}
async function editProfile(name) {
  const rate = prompt(`Rate baru profile ${name} (kbit down/up)\ncontoh: 7000/3000`);
  if (!rate) return;
  const [d, u] = rate.split("/").map(Number);
  if (!d || !u) return msg("Format salah: down/up kbit");
  try {
    await api("/profiles/" + encodeURIComponent(name), { method: "PUT", body: { rate_down_kbit: d, rate_up_kbit: u } });
    msg(`Profile ${name} -> ${d}/${u} kbit (queue diperbarui)`, "okmsg");
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

/* ---------------- router ---------------- */
const RENDER = {
  dashboard: renderDashboard,
  customers: renderCustomers,
  profiles: renderProfiles,
  pools: renderPools,
  leases: renderLeases,
  nat: renderNat,
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