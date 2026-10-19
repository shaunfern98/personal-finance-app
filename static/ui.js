// Redesign behaviour: add-expense drawer, expense insights, Overview tab. Loaded after app.js (uses globals api(), escapeHtml()).
(() => {
  const $ = (s) => document.querySelector(s);
  document.head.insertAdjacentHTML("beforeend", "<style>.ins-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem}.ins-tile{display:flex;flex-direction:column;gap:.25rem;padding:.9rem 1rem;border:1px solid var(--stroke);border-radius:16px;background:var(--surface)}.ins-tile strong{font-size:1.35rem}.ins-tile small{color:var(--muted)}.ins-notes{display:grid;gap:.4rem;padding:.85rem 1rem;border-radius:16px;background:var(--accent-dim)}.ins-notes p{margin:0}#overview-root{display:grid;gap:1rem}</style>");
  const money = (v) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(Number(v) || 0);
  const ym = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  const addM = (m, n) => { const [y, mo] = m.split("-").map(Number); return ym(new Date(y, mo - 1 + n, 1)); };
  const txs = (m) => api("/api/transactions?month=" + m).then((r) => r.items || []).catch(() => []);
  const total = (a) => a.reduce((t, x) => t + x.amount, 0);
  const byCat = (a) => a.reduce((o, x) => ((o[x.category] = (o[x.category] || 0) + x.amount), o), {});
  const day = (t) => Number(t.date.slice(8, 10));
  const tile = (label, value, sub, cls) => `<div class="ins-tile"><span class="muted">${label}</span><strong class="${cls || ""}">${value}</strong><small>${sub || ""}</small></div>`;

  // ---- Add-expense drawer ----
  const drawer = $(".expenses-sidebar"), back = document.createElement("div");
  back.id = "drawer-backdrop"; document.body.appendChild(back);
  const open = (on) => { drawer.classList.toggle("open", on); back.classList.toggle("open", on); if (on) setTimeout(() => $("#amount").focus(), 250); };
  const btn = document.createElement("button");
  btn.id = "btn-add"; btn.type = "button"; btn.className = "btn btn-primary"; btn.textContent = "＋ Add expense";
  $(".month-nav").appendChild(btn);
  btn.onclick = () => open(true); back.onclick = () => open(false);
  document.addEventListener("keydown", (e) => e.key === "Escape" && open(false));
  $("#form-add").addEventListener("submit", () => setTimeout(() => open(false), 500));

  // ---- Insights under the KPI strip (recomputed whenever app.js re-renders the summary) ----
  async function insights() {
    const m = $("#month-input").value; if (!m) return;
    const [cur, prev, H] = await Promise.all([txs(m), txs(addM(m, -1)), api('/api/house?month=' + m).catch(() => null)]);
    const me = H && H.people.find((p) => (H.viewing_partner ? p.id !== H.me : p.id === H.me));
    const inc = me ? me.income_used : 0, saved = me ? inc - me.month_spent : 0;
    const [y, mo] = m.split("-").map(Number), dim = new Date(y, mo, 0).getDate(), now = new Date();
    const live = ym(now) === m, el = live ? now.getDate() : dim, spent = total(cur);
    const prevTD = prev.filter((t) => day(t) <= el), pTot = total(prevTD);
    const delta = pTot > 0 ? (spent - pTot) / pTot * 100 : null;
    const active = new Set(cur.filter((t) => day(t) <= el).map((t) => t.date)).size;
    const cats = byCat(cur), pc = byCat(prevTD), top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
    const big = cur.slice().sort((a, b) => b.amount - a.amount)[0];
    const ups = Object.entries(cats).map(([c, v]) => [c, v - (pc[c] || 0), pc[c] || 0]).filter((x) => x[1] > 25 && x[2] > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
    const downs = Object.entries(pc).map(([c, v]) => [c, v - (cats[c] || 0)]).filter((x) => x[1] > 25).sort((a, b) => b[1] - a[1]).slice(0, 1);
    const notes = [
      ...ups.map((x) => `📈 <b>${escapeHtml(x[0])}</b> is up ${money(x[1])} (${Math.round(x[1] / x[2] * 100)}%) versus the same point last month.`),
      ...downs.map((x) => `📉 You're ${money(x[1])} lower on <b>${escapeHtml(x[0])}</b> than at this point last month.`),
      ...(live && spent > 0 ? [`🔮 At this pace you'll finish ${ym(now) === m ? "the month" : ""} around <b>${money(spent / el * dim)}</b>.`] : []),
    ];
    box.innerHTML = `<div class="ins-row">
      ${inc > 0 ? tile("Income this month", money(inc), "take-home") + tile("Saved so far", money(saved), Math.round(saved / inc * 100) + "% of income", saved < 0 ? "up" : "down") : tile("Income", "—", "set it in Plan")}
      ${tile("vs last month", delta === null ? "—" : (delta > 0 ? "+" : "") + Math.round(delta) + "%", "same days, " + money(pTot) + " last month", delta > 0 ? "up" : "down")}
      ${tile("Daily average", money(spent / Math.max(el, 1)), el + " days counted")}
      ${live ? tile("Projected month-end", money(spent / el * dim), "at current pace") : ""}
      ${tile("Top category", top ? escapeHtml(top[0]) : "—", top ? Math.round(top[1] / spent * 100) + "% of spend (" + money(top[1]) + ")" : "")}
      ${tile("Biggest purchase", big ? money(big.amount) : "—", big ? escapeHtml(big.purchase || big.category) : "")}
      ${tile("No-spend days", Math.max(0, el - active), "of " + el)}</div>
      ${notes.length ? `<div class="ins-notes">${notes.map((n) => `<p>${n}</p>`).join("")}</div>` : ""}`;
  }

  // ---- Overview tab ----
  let charts = [];
  async function overview() {
    const root = $("#overview-root"); root.innerHTML = '<p class="muted">Loading…</p>';
    const cur = ym(new Date()), ms = [-5, -4, -3, -2, -1, 0].map((n) => addM(cur, n));
    const [data, H, ID] = await Promise.all([Promise.all(ms.map(txs)), api("/api/house").catch(() => null), api("/api/auth/me").catch(() => ({}))]);
    const me = H && H.people.find((p) => (H.viewing_partner ? p.id !== H.me : p.id === H.me));
    const income = me ? me.income_used : 0, spend = data.map(total), filled = spend.filter((s) => s > 0);
    const rates = income > 0 ? spend.map((s) => (income - s) / income * 100) : [];
    const done = spend.slice(0, -1).filter((s) => s > 0), avgSpend = done.length ? done.reduce((a, b) => a + b, 0) / done.length : 0;
    const now = new Date(), proj = spend[5] / now.getDate() * new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const tg = H ? H.goal.target_amount : 0, hs = H ? H.people.reduce((t2, p) => t2 + p.total, 0) : 0;
    const catNow = Object.entries(byCat(data[5])).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const nowD = new Date(), dim = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate(), daysLeft = dim - nowD.getDate() + 1;
    const left = me ? income - me.month_spent : 0, spentPct = income > 0 ? Math.min(100, Math.round((income - left) / income * 100)) : 0, dayPct = Math.round(nowD.getDate() / dim * 100);
    const hr = nowD.getHours(), greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening", ro = H && H.viewing_partner;
    const hero = `<section class="hero-card"><div><p class="muted">${greet}${ID.username ? ", " + esc(ID.username) : ""}${ro ? " · viewing partner (read-only)" : ""}</p>
      <h1>${money(Math.max(left, 0))} <span>left from take-home</span></h1>
      <p>${income > 0 ? `That's about <b>${money(Math.max(left, 0) / daysLeft)}/day</b> for the next ${daysLeft} days${me.month_to_savings > 0 ? " · " + money(me.month_to_savings) + " already moved to savings" : ""}.` : "Set your income in Plan to see what's left to spend."}</p>
      <div class="pace ${spentPct > dayPct + 5 ? "over" : ""}"><i style="width:${spentPct}%"></i><b style="left:${dayPct}%"></b></div>
      <small class="muted">${spentPct}% of take-home spent · ${dayPct}% of the month gone${spentPct > dayPct + 5 ? " — spending ahead of pace" : spentPct > 0 ? " — on pace" : ""}</small></div>
      ${ro ? "<div></div>" : `<form id="qa" class="qa"><b>Quick add</b><input id="qa-text" placeholder="e.g. 12.50 coffee" autocomplete="off"><select id="qa-cat">${$("#category").innerHTML}</select><button class="btn btn-primary" type="submit">Add expense</button><small id="qa-msg">Press / anywhere to jump here · N for the full form</small></form>`}</section>`;
    root.innerHTML = hero + `<div class="ins-row">
      ${tile("This month so far", money(spend[5]), "projected " + money(proj || 0))}
      ${tile("Avg monthly spend", money(avgSpend), "last " + done.length + " full months")}
      ${income > 0 ? tile("Savings rate (last full month)", Math.round(rates[4]) + "%", "of " + money(income) + " take-home", rates[4] >= 20 ? "down" : "") : tile("Savings rate", "—", "set income in Budget & salary")}
      ${tile("Highest month", money(Math.max(...spend)), ms[spend.indexOf(Math.max(...spend))])}
      ${tg > 0 ? tile("House fund", Math.round(hs / tg * 100) + "%", money(hs) + " of " + money(tg)) : tile("House fund", money(hs), "set a target in House Fund")}</div>
      <div class="ov-charts"><section class="card"><h2>6-month trend</h2><canvas id="ov-trend"></canvas></section>
      <section class="card"><h2>This month by category</h2><canvas id="ov-cats"></canvas></section></div>`;
    const qa = $("#qa");
    if (qa) {
      const cats = [...$("#qa-cat").options], msg = $("#qa-msg"), txt = $("#qa-text");
      txt.oninput = () => { const t = txt.value.toLowerCase(), hit = cats.find((o) => o.text && t.includes(o.text.toLowerCase())) || (cur => { const w = t.replace(/[\d.,$]/g, "").trim().split(/\s+/)[0]; const m = w && data[5].concat(data[4]).find((x) => (x.purchase || "").toLowerCase().includes(w)); return m && cats.find((o) => o.value === m.category); })(); if (hit) $("#qa-cat").value = hit.value; };
      qa.onsubmit = async (e) => { e.preventDefault(); const m = txt.value.match(/(\d+(?:[.,]\d{1,2})?)/); if (!m) { msg.textContent = "Start with an amount, e.g. 12.50 coffee"; return; }
        const body = { amount: Number(m[1].replace(",", ".")), date: new Date().toLocaleDateString("en-CA"), category: $("#qa-cat").value, cost_type: "variable", purchase: txt.value.replace(m[0], "").replace("$", "").trim() || $("#qa-cat").value, note: "", payment_method: "debit" };
        try { await api("/api/transactions", { method: "POST", body: JSON.stringify(body) }); $("#month-input").dispatchEvent(new Event("change")); await overview(); $("#qa-msg").textContent = "Added " + money(body.amount) + " to " + body.category + " ✓"; } catch (er) { msg.textContent = "⚠ " + er.message; } };
    }
    charts.forEach((c) => c.destroy()); charts = [];
    if (!window.Chart) return;
    const css = getComputedStyle(document.body), col = (v, f) => css.getPropertyValue(v).trim() || f;
    const acc = col("--accent", "#58a6ff"), sec = col("--secondary", "#3fb950"), ink = col("--muted", "#888");
    charts.push(new Chart($("#ov-trend"), { data: { labels: ms, datasets: [
      { type: "bar", label: "Spent", data: spend, backgroundColor: acc, borderRadius: 6 },
      ...(income > 0 ? [{ type: "line", label: "Take-home", data: ms.map(() => income), borderColor: sec, borderDash: [6, 4], pointRadius: 0 }] : [])] },
      options: { plugins: { legend: { labels: { color: ink } } }, scales: { x: { ticks: { color: ink } }, y: { ticks: { color: ink } } } } }));
    charts.push(new Chart($("#ov-cats"), { type: "doughnut", data: { labels: catNow.map((c) => c[0]), datasets: [{ data: catNow.map((c) => c[1]), borderWidth: 0 }] },
      options: { plugins: { legend: { position: "bottom", labels: { color: ink } } } } }));
  }
  const esc = (s) => escapeHtml(String(s ?? ""));
  document.addEventListener("keydown", (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "n") { e.preventDefault(); open(true); }
    if (e.key === "/") { e.preventDefault(); $('.tab[data-tab="overview"]').click(); setTimeout(() => $("#qa-text") && $("#qa-text").focus(), 400); }
  });
  window.addEventListener("load", () => setTimeout(() => $('.tab[data-tab="overview"]').click(), 50)); // land on Home
  document.querySelectorAll('[data-tab="overview"]').forEach((b) => b.addEventListener("click", overview));
})();
