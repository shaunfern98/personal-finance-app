// Expenses page v2: 3-way view (Mine / Partner / Both), 4 key KPIs, always-visible quick add, day-grouped list. Same API & data as before.
(() => {
  const $ = (s) => document.querySelector(s), esc = (s) => escapeHtml(String(s ?? ""));
  const money = (v) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(Number(v) || 0);
  const money2 = (v) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(v) || 0);
  const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const panel = $("#panel-expenses"), old = $("#panel-list"); if (!panel || !old) return;
  old.style.display = "none";
  const top = document.createElement("section"); top.id = "exp-top"; panel.prepend(top);
  const box = document.createElement("section"); box.id = "tx-new"; box.className = "card"; old.after(box);
  const viz = document.createElement("section"); viz.id = "exp-viz"; top.after(viz); let chart = null;
  const todayStr = () => new Date().toLocaleDateString("en-CA");
  const E = Object.assign({ pay: "debit", type: "variable", card: "", batch: false, cat: "" }, JSON.parse(localStorage.getItem("qa_state") || "{}")); E.date = todayStr();
  const saveE = () => localStorage.setItem("qa_state", JSON.stringify({ pay: E.pay, type: E.type, card: E.card, batch: E.batch }));
  function entryHtml() {
    const sg = (k, o) => `<div class="seg" data-k="${k}">${o.map(([v, l]) => `<button type="button" data-v="${v}" class="${E[k] === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
    return `<form id="qa2" class="entry"><div class="entry-main">${E.batch ? '<textarea id="qa2-text" rows="4" placeholder="One per line, e.g.&#10;12.50 coffee&#10;45 groceries&#10;2026-10-12 30 gas"></textarea>' : '<input id="qa2-text" placeholder="＋ Add expense — e.g. 12.50 coffee, then Enter" autocomplete="off">'}<button class="btn btn-primary" type="submit">${E.batch ? "Add all" : "Add"}</button></div>
      <div class="entry-opts"><select id="qa2-cat">${$("#category").innerHTML}</select><input id="qa2-date" type="date" value="${E.date}">${E.date !== todayStr() ? '<button type="button" id="qa2-today" class="btn btn-ghost btn-sm">↺ Today</button>' : ""}
      ${sg("pay", [["debit", "Debit"], ["credit", "Credit"]])}${E.pay === "credit" ? `<select id="qa2-card">${$("#credit_card_select").innerHTML}</select>` : ""}${sg("type", [["variable", "Variable"], ["fixed", "Fixed"]])}
      <button type="button" id="qa2-batch" class="btn btn-ghost btn-sm">${E.batch ? "Single entry" : "Add several"}</button><button type="button" id="qa2-full" class="btn btn-ghost btn-sm">Notes &amp; more</button></div>
      <small id="qa2-msg">${E.batch ? "One expense per line · Ctrl/⌘+Enter to add all · start a line with a date (2026-10-12) to override it" : "Your date, payment and type settings stay put, so you can keep adding."}</small></form>`;
  }
  function renderViz() {
    const [y, mo] = month.split("-").map(Number), dim = new Date(y, mo, 0).getDate(), now = new Date(), live = now.getFullYear() === y && now.getMonth() + 1 === mo, el = live ? now.getDate() : dim;
    const cum = (arr, upto) => { const d = Array(dim).fill(0); arr.forEach((t) => (d[Number(t.date.slice(8, 10)) - 1] += t.amount)); let s2 = 0; return d.map((v, i) => (i < upto ? (s2 += v) : null)); };
    const cur = cum(items, el), pre = cum(prev, dim), spent = cur[el - 1] || 0, prevTD = pre[el - 1] || 0, diff = spent - prevTD;
    const proj = live && el > 0 && spent > 0 ? Array.from({ length: dim }, (_, i) => (i >= el - 1 ? spent / el * (i + 1) : null)) : null;
    const cats = {}, pc = {}; items.forEach((t) => (cats[t.category] = (cats[t.category] || 0) + t.amount)); prev.filter((t) => Number(t.date.slice(8, 10)) <= el).forEach((t) => (pc[t.category] = (pc[t.category] || 0) + t.amount));
    const rows = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 8), mx = rows.length ? rows[0][1] : 1, tot = Object.values(cats).reduce((a, b) => a + b, 0) || 1;
    const inc = H ? H.people.filter((p) => who === "both" || (who === "me" ? p.id === H.me : p.id !== H.me)).reduce((t, p) => t + p.income_used, 0) : 0;
    viz.innerHTML = `<section class="card viz-pace"><h2>Spending pace</h2><p class="muted">${prevTD > 0 ? `You're <b class="${diff > 0 ? "neg" : "pos"}">${money(Math.abs(diff))} ${diff > 0 ? "ahead of" : "below"}</b> last month's pace` : "Cumulative spending through the month"}${proj ? ` · on track for <b>${money(proj[dim - 1])}</b>` : ""}</p><div class="viz-canvas"><canvas id="pace-c"></canvas></div></section>
      <section class="card viz-cats"><h2>Where it went</h2><p class="muted">Tap a category to filter the list below</p>${rows.map(([c, v]) => { const p = pc[c] || 0, dd = p > 0 ? Math.round((v - p) / p * 100) : null, col = `hsl(${hue(c)} 65% 55%)`;
        return `<button class="cat-row ${cat === c ? "on" : ""}" data-c="${esc(c)}"><span class="cr-top"><span><i style="background:${col}"></i>${esc(c)}</span><b>${money(v)}</b></span><span class="cr-bar"><em style="width:${v / mx * 100}%;background:${col}"></em></span><span class="cr-sub">${Math.round(v / tot * 100)}% of spending${dd === null ? "" : ` · <span class="${dd > 0 ? "neg" : "pos"}">${dd > 0 ? "▲" : "▼"} ${Math.abs(dd)}% vs last month</span>`}</span></button>`; }).join("") || '<p class="muted">Nothing logged yet.</p>'}</section>`;
    if (chart) chart.destroy(); chart = null; if (!window.Chart) return;
    const css = getComputedStyle(document.body), col = (v, f) => css.getPropertyValue(v).trim() || f, acc = col("--accent", "#86b8e8"), mu = col("--muted", "#9aa6b8"), ok = col("--success", "#5cc79a"), st = col("--stroke", "#3b4659");
    const ds = [{ label: "This month", data: cur, borderColor: acc, backgroundColor: acc + "26", fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 5, borderWidth: 3 }, { label: "Last month", data: pre, borderColor: mu, borderDash: [6, 5], tension: 0.3, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2 }];
    if (proj) ds.push({ label: "Projected", data: proj, borderColor: acc, borderDash: [2, 4], pointRadius: 0, borderWidth: 2 });
    if (inc > 0) ds.push({ label: "Take-home", data: Array(dim).fill(inc), borderColor: ok, borderDash: [10, 6], pointRadius: 0, borderWidth: 1.5 });
    chart = new Chart($("#pace-c"), { type: "line", data: { labels: Array.from({ length: dim }, (_, i) => i + 1), datasets: ds }, options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { color: mu, usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { title: (i) => "Day " + i[0].label, label: (c) => (c.parsed.y == null ? null : c.dataset.label + ": " + money(c.parsed.y)) } } },
      scales: { x: { ticks: { color: mu, maxTicksLimit: 10 }, grid: { display: false } }, y: { ticks: { color: mu, callback: (v) => money(v) }, grid: { color: st } } } } });
  }
  const dlg = document.createElement("dialog"); dlg.id = "tx-dlg"; document.body.appendChild(dlg);
  const prevM = (m) => { const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 2, 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
  let who = localStorage.getItem("exp_who") || "me", P = {}, H = null, items = [], prev = [], q = "", cat = "", pay = "", sort = "new", month = "";
  const hx = (m) => api(`/api/household/transactions?month=${m}&who=${who}`).then((r) => r.items || []).catch(() => []);

  async function load() {
    month = $("#month-input").value; if (!month) return;
    if (window.PIC && PIC.ready) await PIC.ready;
    P = await api("/api/partner").catch(() => ({}));
    if (!P.linked) who = "me";
    [items, prev, H] = await Promise.all([hx(month), hx(prevM(month)), api("/api/house?month=" + month).catch(() => null)]);
    render();
  }
  const refresh = async () => { $("#month-input").dispatchEvent(new Event("change")); await load(); };

  function renderTop() {
    const people = H ? H.people.filter((p) => who === "both" || (who === "me" ? p.id === H.me : p.id !== H.me)) : [];
    const income = people.reduce((t, p) => t + p.income_used, 0), spent = people.reduce((t, p) => t + p.month_spent, 0), toSav = people.reduce((t, p) => t + p.month_to_savings, 0);
    const saved = income - spent, rate = income > 0 ? Math.round(saved / income * 100) : null;
    const now = new Date(), [y, mo] = month.split("-").map(Number), dim = new Date(y, mo, 0).getDate(), live = now.getFullYear() === y && now.getMonth() + 1 === mo, el = live ? now.getDate() : dim;
    const tile = (l, v, s, c) => `<div class="ins-tile"><span class="muted">${l}</span><strong class="${c || ""}">${v}</strong><small>${s || ""}</small></div>`;
    const sum = (a) => a.reduce((t, x) => t + x.amount, 0), cats = {}; items.forEach((t) => (cats[t.category] = (cats[t.category] || 0) + t.amount));
    const topc = Object.entries(cats).sort((a, b) => b[1] - a[1])[0], big = items.slice().sort((a, b) => b.amount - a.amount)[0];
    const prevTD = prev.filter((t) => Number(t.date.slice(8, 10)) <= el), pt = sum(prevTD), d = pt > 0 ? Math.round((sum(items) - pt) / pt * 100) : null;
    const days = new Set(items.map((t) => t.date)).size, pc = {}; prevTD.forEach((t) => (pc[t.category] = (pc[t.category] || 0) + t.amount));
    const ups = Object.entries(cats).map(([c, v]) => [c, v - (pc[c] || 0), pc[c] || 0]).filter((x) => x[1] > 25 && x[2] > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
    const names = { me: "Mine", partner: P.partner_name || "Partner", both: "Both" };
    const av = (k) => (window.PIC ? PIC.html(k === "me" ? "me" : k === "partner" ? "partner" : "couple") : "");
    const seg = P.linked ? `<div class="seg who-seg">${["me", "partner", "both"].map((k) => `<button data-who="${k}" class="${who === k ? "on" : ""}">${av(k)}<span>${esc(names[k])}</span></button>`).join("")}</div>` : "<span></span>";
    const canAdd = who === "me", cats2 = $("#category").innerHTML;
    top.innerHTML = `<div class="who">${seg}<span class="muted">${who === "both" ? "Household total" : who === "partner" ? "Viewing " + esc(names.partner) + " (read-only)" : ""}</span></div>
      ${canAdd ? entryHtml() : '<div class="qa-bar" style="grid-template-columns:1fr"><span class="muted">Switch to “Mine” to add expenses.</span></div>'}
      <div class="kpi4">${tile("Income", income > 0 ? money(income) : "—", income > 0 ? "take-home / month" : "set it in Plan")}
        ${tile("Spent", money(spent), toSav > 0 ? "+ " + money(toSav) + " to savings" : items.length + " transactions")}
        ${tile("Saved so far", money(saved), rate === null ? "" : rate + "% of income", saved < 0 ? "neg" : "pos")}
        ${live ? tile("Projected month-end", money(spent / Math.max(el, 1) * dim), "at current pace") : tile("Daily average", money(spent / dim), "over " + dim + " days")}</div>
      <details id="exp-more"><summary>More insights</summary><div class="ins-row">
        ${tile("vs last month", d === null ? "—" : (d > 0 ? "+" : "") + d + "%", "same days, " + money(pt), d > 0 ? "neg" : "pos")}${tile("Top category", topc ? esc(topc[0]) : "—", topc ? money(topc[1]) : "")}
        ${tile("Biggest purchase", big ? money(big.amount) : "—", big ? esc(big.purchase || big.category) : "")}${tile("Days with spending", days, "of " + el)}</div>
        ${ups.length ? `<div class="ins-notes">${ups.map((x) => `<p>📈 <b>${esc(x[0])}</b> is up ${money(x[1])} vs the same point last month.</p>`).join("")}</div>` : ""}</details>`;
  }

  function renderList() {
    const cats = [...new Set(items.map((t) => t.category))].sort();
    let list = items.filter((t) => (!cat || t.category === cat) && (!pay || t.payment_method === pay) && (!q || (t.purchase + " " + t.category + " " + (t.note || "")).toLowerCase().includes(q)));
    list = list.slice().sort(sort === "big" ? (a, b) => b.amount - a.amount : (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    const days = {}; list.forEach((t) => (days[t.date] = days[t.date] || []).push(t));
    const keys = Object.keys(days).sort((a, b) => (a < b ? 1 : -1)), dl = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" });
    const row = (t) => `<div class="tx-row"><span class="tx-dot" style="background:hsl(${hue(t.category)} 65% 55%)"></span><div class="tx-main"><b>${esc(t.purchase || t.category)}${who !== "me" ? `<span class="owner">${esc(t.owner)}</span>` : ""}</b>
      <small>${esc(t.category)} · ${esc(t.payment_method)}${t.credit_card ? " · " + esc(t.credit_card) : ""}${t.is_recurring ? " · 🔁" : ""}${t.note ? " · " + esc(t.note) : ""}</small></div><strong class="tx-amt">${money2(t.amount)}</strong>
      ${t.own && who !== "partner" ? `<span class="tx-act"><button data-e="${t.id}" title="Edit">✏️</button><button data-d="${t.id}" title="Delete">🗑</button></span>` : ""}</div>`;
    box.innerHTML = `<div class="tx-head"><h2>Transactions</h2><span class="muted">${list.length} · ${money2(list.reduce((t, x) => t + x.amount, 0))}</span></div>
      <div class="tx-bar"><input id="tx-q" placeholder="🔍 Search purchases, notes, categories…" value="${esc(q)}"><div class="seg">${[["", "All"], ["credit", "Credit"], ["debit", "Debit"]].map(([v, l]) => `<button data-p="${v}" class="${pay === v ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="seg"><button data-s="new" class="${sort === "new" ? "on" : ""}">Newest</button><button data-s="big" class="${sort === "big" ? "on" : ""}">Largest</button></div></div>
      <div class="chips"><button data-c="" class="${cat === "" ? "on" : ""}">All</button>${cats.map((c) => `<button data-c="${esc(c)}" class="${cat === c ? "on" : ""}"><i style="background:hsl(${hue(c)} 65% 55%)"></i>${esc(c)}</button>`).join("")}</div>
      ${sort === "big" ? `<div class="tx-day">${list.map(row).join("")}</div>` : keys.map((d) => `<div class="tx-day"><div class="tx-dayhead"><span>${dl(d)}</span><span>${money2(days[d].reduce((t, x) => t + x.amount, 0))}</span></div>${days[d].map(row).join("")}</div>`).join("")}
      ${list.length ? "" : '<p class="muted" style="text-align:center;padding:2rem">Nothing here yet — add an expense above.</p>'}`;
  }
  const render = () => { const t = $("#qa2-text"), keep = t && t.value, foc = t && document.activeElement === t; renderTop(); renderList(); renderViz();
    const n = $("#qa2-text"); if (n && keep) n.value = keep; if (n && foc) n.focus(); const c = $("#qa2-cat"); if (c && E.cat) c.value = E.cat; const k = $("#qa2-card"); if (k) k.value = E.card; };
  window.addEventListener("pics", () => month && render());

  top.addEventListener("click", (e) => { if (e.target.id === "qa2-full") { $("#btn-add").click(); return; } const b = e.target.closest("button[data-who]"); if (b) { who = b.dataset.who; localStorage.setItem("exp_who", who); load(); } });
  const guess = (text) => { const t = text.toLowerCase(), opts = [...$("#category").options];
    const hit = opts.find((o) => o.text && t.includes(o.text.toLowerCase())) || (() => { const w = t.replace(/[\d.,$]/g, "").trim().split(/\s+/)[0]; const m = w && items.concat(prev).find((x) => (x.purchase || "").toLowerCase().includes(w)); return m && opts.find((o) => o.value === m.category); })();
    return hit ? hit.value : null; };
  top.addEventListener("input", (e) => { const id = e.target.id;
    if (id === "qa2-date") E.date = e.target.value; else if (id === "qa2-cat") E.cat = e.target.value; else if (id === "qa2-card") { E.card = e.target.value; saveE(); }
    else if (id === "qa2-text" && !E.batch) { const g = guess(e.target.value); if (g) { $("#qa2-cat").value = g; E.cat = g; } } });
  top.addEventListener("keydown", (e) => { if (e.target.id === "qa2-text" && E.batch && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#qa2").requestSubmit(); } });
  top.addEventListener("submit", async (e) => { e.preventDefault(); const raw = $("#qa2-text").value, msg = $("#qa2-msg");
    const lines = (E.batch ? raw.split("\n") : [raw]).map((x) => x.trim()).filter(Boolean); if (!lines.length) return; const sel = $("#qa2-cat"); let ok = 0;
    try { for (const ln of lines) { let date = E.date, txt = ln; const dm = txt.match(/^(\d{4}-\d{2}-\d{2})\s+/); if (dm) { date = dm[1]; txt = txt.slice(dm[0].length); }
        const m = txt.match(/(\d+(?:[.,]\d{1,2})?)/); if (!m) throw new Error('No amount found in "' + ln + '"'); const category = (E.batch && guess(txt)) || sel.value;
        await api("/api/transactions", { method: "POST", body: JSON.stringify({ amount: Number(m[1].replace(",", ".")), date, category, cost_type: E.type, purchase: txt.replace(m[0], "").replace("$", "").trim() || category, note: "", payment_method: E.pay, credit_card: E.pay === "credit" ? (E.card || null) : null }) }); ok++; } }
    catch (er) { msg.textContent = "⚠ " + er.message + (ok ? " (" + ok + " added before the error)" : ""); if (ok) await refresh(); return; }
    E.cat = sel.value; await refresh(); const mm = $("#qa2-msg"); if (mm) mm.textContent = "Added " + ok + " expense" + (ok > 1 ? "s" : "") + " ✓  (" + E.date + " · " + E.pay + " · " + E.type + ")"; const t = $("#qa2-text"); if (t) { t.value = ""; t.focus(); } });
  top.addEventListener("click", (e) => { const sb = e.target.closest(".seg[data-k] button"); if (sb) { E[sb.parentNode.dataset.k] = sb.dataset.v; saveE(); render(); return; }
    if (e.target.id === "qa2-today") { E.date = todayStr(); render(); } else if (e.target.id === "qa2-batch") { E.batch = !E.batch; saveE(); render(); } });
  viz.addEventListener("click", (e) => { const b = e.target.closest(".cat-row"); if (!b) return; cat = cat === b.dataset.c ? "" : b.dataset.c; renderList(); renderViz(); box.scrollIntoView({ behavior: "smooth", block: "start" }); });
  box.addEventListener("input", (e) => { if (e.target.id === "tx-q") { q = e.target.value.toLowerCase(); renderList(); const i = $("#tx-q"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
  box.addEventListener("click", async (e) => { const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.c !== undefined) { cat = d.c; renderList(); } else if (d.p !== undefined) { pay = d.p; renderList(); } else if (d.s) { sort = d.s; renderList(); }
    else if (d.d && confirm("Delete this transaction?")) { await api("/api/transactions/" + d.d, { method: "DELETE" }); refresh(); } else if (d.e) edit(items.find((t) => String(t.id) === d.e)); });
  function edit(t) {
    dlg.innerHTML = `<form method="dialog" class="tx-form"><h3>Edit transaction</h3><label>Amount<input id="e-amt" type="number" step="0.01" value="${t.amount}"></label><label>Purchase<input id="e-pur" value="${esc(t.purchase)}"></label>
      <label>Date<input id="e-date" type="date" value="${t.date}"></label><label>Category<select id="e-cat">${$("#category").innerHTML}</select></label><label>Note<input id="e-note" value="${esc(t.note || "")}"></label>
      <div class="tx-formbtns"><button value="x" class="btn btn-ghost">Cancel</button><button id="e-save" value="y" class="btn btn-primary">Save</button></div></form>`;
    $("#e-cat").value = t.category; dlg.showModal();
    $("#e-save").onclick = async (ev) => { ev.preventDefault(); try { await api("/api/transactions/" + t.id, { method: "PUT", body: JSON.stringify({ amount: Number($("#e-amt").value), purchase: $("#e-pur").value, date: $("#e-date").value, category: $("#e-cat").value, note: $("#e-note").value }) }); dlg.close(); refresh(); } catch (er) { alert(er.message); } };
  }
  let t0; new MutationObserver(() => { clearTimeout(t0); t0 = setTimeout(load, 250); }).observe($("#summary"), { childList: true });
  load();
})();
