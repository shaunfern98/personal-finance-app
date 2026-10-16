// Themes + cycler, Reports tab (category matrix, yearly, debt payoff, cards), Investing tab, Plan jump-nav. Uses app.js globals api(), setTheme(), escapeHtml().
(() => {
  const $ = (s) => document.querySelector(s), esc = (s) => escapeHtml(String(s ?? ""));
  const money = (v) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(Number(v) || 0);
  const ym = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  const txs = (m) => api("/api/transactions?month=" + m).then((r) => r.items || []).catch(() => []);
  const total = (a) => a.reduce((t, x) => t + x.amount, 0);
  const THEMES = [["midnight", "Midnight"], ["aurora", "Aurora"], ["sunset", "Sunset"], ["graphite", "Graphite"], ["sage", "Sage (light)"], ["porcelain", "Porcelain (light)"]];

  // ---- Themes: new picker options, one-time switch to a new default, header cycle button ----
  const sel = $("#theme-selector");
  if (sel) sel.innerHTML = THEMES.map(([k, n]) => `<option value="${k}">${n}</option>`).join("");
  if (!localStorage.getItem("theme_v2")) { localStorage.setItem("theme_v2", "1"); setTheme("midnight"); }
  const cur = () => document.documentElement.getAttribute("data-theme");
  if (sel) sel.value = THEMES.some((t) => t[0] === cur()) ? cur() : "midnight";
  const tb = document.createElement("button");
  tb.id = "btn-theme"; tb.type = "button"; tb.className = "btn btn-ghost btn-sm"; tb.title = "Change theme"; tb.textContent = "🎨";
  $("#btn-logout").before(tb);
  tb.onclick = () => { const i = THEMES.findIndex((t) => t[0] === cur()); const n = THEMES[(i + 1) % THEMES.length]; setTheme(n[0]); if (sel) sel.value = n[0]; tb.title = "Theme: " + n[1]; };

  // ---- Reports tab ----
  let range = "6", charts = [];
  async function reports() {
    const root = $("#reports-root"); root.innerHTML = '<p class="muted">Loading…</p>';
    const now = new Date(), n = range === "6" ? 6 : now.getMonth() + 1;
    const ms = Array.from({ length: n }, (_, i) => ym(new Date(now.getFullYear(), now.getMonth() - (n - 1) + i, 1)));
    const [data, H, D, C] = await Promise.all([Promise.all(ms.map(txs)), api("/api/house").catch(() => null), api("/api/debts").catch(() => ({ debts: [] })), api("/api/credit-cards").catch(() => ({ cards: [] }))]);
    const me = H && H.people.find((p) => (H.viewing_partner ? p.id !== H.me : p.id === H.me)), income = me ? me.income_used : 0;
    const cats = {}; data.forEach((a, i) => a.forEach((t) => { (cats[t.category] = cats[t.category] || Array(n).fill(0))[i] += t.amount; }));
    const rows = Object.entries(cats).sort((a, b) => b[1].reduce((x, y) => x + y) - a[1].reduce((x, y) => x + y));
    const spend = data.map(total), done = spend.filter((s) => s > 0), ytdSaved = income > 0 ? spend.reduce((t, s) => t + (income - s), 0) : null;
    const shade = (v, mx) => (v > 0 ? `background:color-mix(in srgb, var(--accent) ${Math.round(8 + 42 * v / mx)}%, transparent)` : "");
    const matrix = `<div class="table-wrap"><table class="mx"><thead><tr><th>Category</th>${ms.map((m) => `<th>${m.slice(2)}</th>`).join("")}<th>Last vs prior</th></tr></thead><tbody>
      ${rows.map(([c, v]) => { const mx = Math.max(...v), a = v[n - 1], b = v[n - 2] || 0, d = b > 0 ? Math.round((a - b) / b * 100) : null;
        return `<tr><td>${esc(c)}</td>${v.map((x) => `<td style="${shade(x, mx)}">${x ? money(x) : "·"}</td>`).join("")}<td class="${d > 0 ? "neg" : "pos"}">${d === null ? "—" : (d > 0 ? "+" : "") + d + "%"}</td></tr>`; }).join("")}
      <tr><td><b>Total</b></td>${spend.map((x) => `<td><b>${money(x)}</b></td>`).join("")}<td></td></tr></tbody></table></div>`;
    // debt payoff (avalanche: extra goes to the highest APR first)
    const debts = (D.debts || []).filter((d) => d.balance > 0);
    const sim = (extra) => { const ds = debts.map((d) => ({ ...d })); let mo = 0, int = 0; while (ds.some((d) => d.balance > 0.01) && mo < 600) { mo++; let pool = extra; ds.sort((a, b) => b.interest_rate - a.interest_rate);
      ds.forEach((d) => { if (d.balance <= 0) return; const i = d.balance * d.interest_rate / 1200; int += i; d.balance += i; const p = Math.min(d.balance, d.minimum_payment); d.balance -= p; });
      for (const d of ds) { if (pool <= 0) break; const p = Math.min(d.balance, pool); d.balance -= p; pool -= p; } } return { mo, int, never: ds.some((d) => d.balance > 0.01) }; };
    const b0 = debts.length ? sim(0) : null, b1 = debts.length ? sim(200) : null, tb2 = debts.reduce((t, d) => t + d.balance, 0);
    const debtHtml = !debts.length ? '<p class="muted">No debts tracked. Add them under Plan → Debt Tracker.</p>' : `
      <div class="ins-row"><div class="ins-tile"><span class="muted">Total debt</span><strong>${money(tb2)}</strong><small>${money(debts.reduce((t, d) => t + d.minimum_payment, 0))}/mo minimums</small></div>
      <div class="ins-tile"><span class="muted">Debt-free (minimums only)</span><strong>${b0.never ? "50+ yrs" : b0.mo + " mo"}</strong><small>${money(b0.int)} interest</small></div>
      <div class="ins-tile"><span class="muted">With +$200/mo (avalanche)</span><strong>${b1.never ? "—" : b1.mo + " mo"}</strong><small>${b1.never ? "" : "saves " + money(b0.int - b1.int) + " interest"}</small></div></div>
      <div class="table-wrap"><table class="mx"><thead><tr><th>Pay-off order</th><th>Balance</th><th>APR</th><th>Min/mo</th><th>Interest/mo</th></tr></thead><tbody>
      ${debts.slice().sort((a, b) => b.interest_rate - a.interest_rate).map((d) => `<tr><td>${esc(d.name)}</td><td>${money(d.balance)}</td><td>${d.interest_rate}%</td><td>${money(d.minimum_payment)}</td><td>${money(d.balance * d.interest_rate / 1200)}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted">Highest interest rate first (“avalanche”) costs the least overall. Projection assumes no new borrowing.</p>`;
    // payment methods this month
    const cm = data[n - 1], pm = {}, cd = {}; cm.forEach((t) => { pm[t.payment_method] = (pm[t.payment_method] || 0) + t.amount; if (t.payment_method === "credit") cd[t.credit_card || "No card"] = (cd[t.credit_card || "No card"] || 0) + t.amount; });
    const bar = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div style="margin:.4rem 0"><div style="display:flex;justify-content:space-between"><span>${esc(k)}</span><b>${money(v)}</b></div><div style="height:8px;border-radius:99px;background:var(--stroke)"><div style="height:8px;border-radius:99px;width:${Math.round(v / Math.max(...Object.values(o)) * 100)}%;background:var(--accent)"></div></div></div>`).join("") || '<p class="muted">Nothing this month.</p>';
    root.innerHTML = `<div class="rp"><div class="seg"><button data-r="6" class="${range === "6" ? "on" : ""}">Last 6 months</button><button data-r="y" class="${range === "y" ? "on" : ""}">This year</button></div>
      <div class="ins-row"><div class="ins-tile"><span class="muted">Total spent</span><strong>${money(spend.reduce((a, b) => a + b, 0))}</strong><small>${ms.length} months</small></div>
      <div class="ins-tile"><span class="muted">Average / month</span><strong>${money(done.length ? done.reduce((a, b) => a + b, 0) / done.length : 0)}</strong></div>
      <div class="ins-tile"><span class="muted">Estimated saved</span><strong class="${ytdSaved < 0 ? "neg" : ""}">${ytdSaved === null ? "—" : money(ytdSaved)}</strong><small>at current take-home</small></div>
      <div class="ins-tile"><span class="muted">Highest month</span><strong>${money(Math.max(...spend))}</strong><small>${ms[spend.indexOf(Math.max(...spend))]}</small></div></div>
      <section class="card"><h2>Category by month</h2>${matrix}</section>
      <div class="ov-charts" style="grid-template-columns:1fr 1fr"><section class="card"><h2>How you paid this month</h2>${bar(pm)}</section><section class="card"><h2>Credit card spend this month</h2>${bar(cd)}</section></div>
      <section class="card"><h2>Debt payoff</h2>${debtHtml}</section></div>`;
  }
  $("#reports-root").addEventListener("click", (e) => { if (e.target.dataset.r) { range = e.target.dataset.r; reports(); } });
  document.querySelectorAll('[data-tab="reports"]').forEach((b) => b.addEventListener("click", reports));

  // ---- Investing tab ----
  async function investing() {
    const root = $("#investing-root"), H = await api("/api/house").catch(() => null);
    if (!H) { root.innerHTML = '<p class="muted">Could not load accounts.</p>'; return; }
    const by = {}; H.accounts.forEach((a) => { by[a.account_type] = (by[a.account_type] || 0) + a.balance; });
    const tot = Object.values(by).reduce((a, b) => a + b, 0), name = (id) => (H.people.find((p) => p.id === id) || {}).username || "";
    root.innerHTML = `<div class="rp"><div class="ins-row"><div class="ins-tile"><span class="muted">Total invested &amp; saved</span><strong>${money(tot)}</strong><small>${H.accounts.length} accounts</small></div>
      ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="ins-tile"><span class="muted">${esc(k)}</span><strong>${money(v)}</strong><small>${tot ? Math.round(v / tot * 100) : 0}% of total</small></div>`).join("")}</div>
      <div class="ov-charts"><section class="card"><h2>Accounts</h2><div class="table-wrap"><table class="mx"><thead><tr><th>Account</th><th>Owner</th><th>Type</th><th>Value</th></tr></thead><tbody>
      ${H.accounts.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(name(a.user_id))}</td><td>${esc(a.account_type)}</td><td>${money(a.balance)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No accounts yet — add them in House Fund.</td></tr>'}</tbody></table></div>
      <p class="muted">Edit values in the House Fund tab. FHSA: $8,000 annual / $40,000 lifetime contribution limits.</p></section>
      <section class="card"><h2>Allocation</h2><canvas id="inv-chart"></canvas></section></div></div>`;
    charts.forEach((c) => c.destroy()); charts = [];
    if (window.Chart && tot > 0) charts.push(new Chart($("#inv-chart"), { type: "doughnut", data: { labels: Object.keys(by), datasets: [{ data: Object.values(by), borderWidth: 0 }] }, options: { plugins: { legend: { position: "bottom", labels: { color: getComputedStyle(document.body).getPropertyValue("--muted") } } } } }));
  }
  document.querySelectorAll('[data-tab="investing"]').forEach((b) => b.addEventListener("click", investing));

  // ---- Plan tab: jump links so the long page is easy to navigate ----
  const panel = $("#panel-budget"), heads = [...panel.querySelectorAll("section.card h2")].filter((h) => h.textContent.trim().length < 28);
  if (heads.length) { const nav = document.createElement("nav"); nav.className = "jump"; heads.forEach((h, i) => { h.id = h.id || "plan-" + i; nav.insertAdjacentHTML("beforeend", `<a href="#${h.id}">${esc(h.textContent.replace(/[^\w &]/g, "").trim())}</a>`); }); panel.prepend(nav); }
})();
