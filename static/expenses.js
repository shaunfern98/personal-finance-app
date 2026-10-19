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
  const dlg = document.createElement("dialog"); dlg.id = "tx-dlg"; document.body.appendChild(dlg);
  const prevM = (m) => { const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 2, 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
  let who = localStorage.getItem("exp_who") || "me", P = {}, H = null, items = [], prev = [], q = "", cat = "", pay = "", sort = "new", month = "";
  const hx = (m) => api(`/api/household/transactions?month=${m}&who=${who}`).then((r) => r.items || []).catch(() => []);

  async function load() {
    month = $("#month-input").value; if (!month) return;
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
    const seg = P.linked ? `<div class="seg">${["me", "partner", "both"].map((k) => `<button data-who="${k}" class="${who === k ? "on" : ""}">${esc(names[k])}</button>`).join("")}</div>` : "<span></span>";
    const canAdd = who === "me", cats2 = $("#category").innerHTML;
    top.innerHTML = `<div class="who">${seg}<span class="muted">${who === "both" ? "Household total" : who === "partner" ? "Viewing " + esc(names.partner) + " (read-only)" : ""}</span></div>
      ${canAdd ? `<form id="qa2" class="qa-bar"><input id="qa2-text" placeholder="＋ Quick add — e.g. 12.50 coffee, then Enter" autocomplete="off"><select id="qa2-cat">${cats2}</select><button class="btn btn-primary" type="submit">Add</button><button class="btn btn-ghost" type="button" id="qa2-full">More options</button><small id="qa2-msg">Amount first, then a description. Category is guessed from your words — change it if needed. Press N for the full form.</small></form>`
        : `<div class="qa-bar" style="grid-template-columns:1fr"><span class="muted">Switch to “Mine” to add expenses.</span></div>`}
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
  const render = () => { const keep = $("#qa2-text") && $("#qa2-text").value; renderTop(); renderList(); if (keep) $("#qa2-text").value = keep; };

  top.addEventListener("click", (e) => { if (e.target.id === "qa2-full") { $("#btn-add").click(); return; } const b = e.target.closest("button[data-who]"); if (b) { who = b.dataset.who; localStorage.setItem("exp_who", who); load(); } });
  top.addEventListener("input", (e) => { if (e.target.id !== "qa2-text") return; const t = e.target.value.toLowerCase(), sel = $("#qa2-cat"), opts = [...sel.options];
    const hit = opts.find((o) => o.text && t.includes(o.text.toLowerCase())) || (() => { const w = t.replace(/[\d.,$]/g, "").trim().split(/\s+/)[0]; const m = w && items.concat(prev).find((x) => (x.purchase || "").toLowerCase().includes(w)); return m && opts.find((o) => o.value === m.category); })(); if (hit) sel.value = hit.value; });
  top.addEventListener("submit", async (e) => { e.preventDefault(); const txt = $("#qa2-text").value, m = txt.match(/(\d+(?:[.,]\d{1,2})?)/), msg = $("#qa2-msg");
    if (!m) { msg.textContent = "Start with an amount, e.g. 12.50 coffee"; return; }
    const body = { amount: Number(m[1].replace(",", ".")), date: new Date().toLocaleDateString("en-CA"), category: $("#qa2-cat").value, cost_type: "variable", purchase: txt.replace(m[0], "").replace("$", "").trim() || $("#qa2-cat").value, note: "", payment_method: "debit" };
    try { await api("/api/transactions", { method: "POST", body: JSON.stringify(body) }); await refresh(); const mm = $("#qa2-msg"); if (mm) mm.textContent = "Added " + money2(body.amount) + " to " + body.category + " ✓"; $("#qa2-text").focus(); } catch (er) { msg.textContent = "⚠ " + er.message; } });
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
