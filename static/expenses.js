// New transactions experience: search, chips, day-grouped cards, edit/delete. Same API & data as before. Loaded after app.js.
(() => {
  const $ = (s) => document.querySelector(s), esc = (s) => escapeHtml(String(s ?? ""));
  const money = (v) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(v) || 0);
  const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const old = $("#panel-list"); if (!old) return;
  old.style.display = "none";
  const box = document.createElement("section"); box.id = "tx-new"; box.className = "card"; old.after(box);
  const dlg = document.createElement("dialog"); dlg.id = "tx-dlg"; document.body.appendChild(dlg);
  let items = [], q = "", cat = "", pay = "", sort = "new";
  const ro = () => !!$("#view-banner");

  async function load() {
    const m = $("#month-input").value; if (!m) return;
    items = await api("/api/transactions?month=" + m).then((r) => r.items || []).catch(() => []);
    render();
  }
  function render() {
    const cats = [...new Set(items.map((t) => t.category))].sort();
    let list = items.filter((t) => (!cat || t.category === cat) && (!pay || t.payment_method === pay) && (!q || (t.purchase + " " + t.category + " " + (t.note || "")).toLowerCase().includes(q)));
    list = list.slice().sort(sort === "big" ? (a, b) => b.amount - a.amount : (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    const days = {}; list.forEach((t) => (days[t.date] = days[t.date] || []).push(t));
    const keys = Object.keys(days).sort((a, b) => (sort === "big" ? 0 : a < b ? 1 : -1));
    const dl = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" });
    const row = (t) => `<div class="tx-row"><span class="tx-dot" style="background:hsl(${hue(t.category)} 65% 60%)"></span>
      <div class="tx-main"><b>${esc(t.purchase || t.category)}</b><small>${esc(t.category)} · ${esc(t.payment_method)}${t.credit_card ? " · " + esc(t.credit_card) : ""}${t.is_recurring ? " · 🔁" : ""}${t.note ? " · " + esc(t.note) : ""}</small></div>
      <strong class="tx-amt">${money(t.amount)}</strong>${ro() ? "" : `<span class="tx-act"><button data-e="${t.id}" title="Edit">✏️</button><button data-d="${t.id}" title="Delete">🗑</button></span>`}</div>`;
    box.innerHTML = `<div class="tx-head"><h2>Transactions</h2><span class="muted">${list.length} · ${money(list.reduce((t, x) => t + x.amount, 0))}</span></div>
      <div class="tx-bar"><input id="tx-q" placeholder="🔍 Search purchases, notes, categories…" value="${esc(q)}">
      <div class="seg">${[["", "All"], ["credit", "Credit"], ["debit", "Debit"]].map(([v, l]) => `<button data-p="${v}" class="${pay === v ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="seg"><button data-s="new" class="${sort === "new" ? "on" : ""}">Newest</button><button data-s="big" class="${sort === "big" ? "on" : ""}">Largest</button></div></div>
      <div class="chips"><button data-c="" class="${cat === "" ? "on" : ""}">All</button>${cats.map((c) => `<button data-c="${esc(c)}" class="${cat === c ? "on" : ""}"><i style="background:hsl(${hue(c)} 65% 60%)"></i>${esc(c)}</button>`).join("")}</div>
      ${sort === "big" ? `<div class="tx-day">${list.map(row).join("")}</div>` : keys.map((d) => `<div class="tx-day"><div class="tx-dayhead"><span>${dl(d)}</span><span>${money(days[d].reduce((t, x) => t + x.amount, 0))}</span></div>${days[d].map(row).join("")}</div>`).join("")}
      ${list.length ? "" : '<p class="muted" style="text-align:center;padding:2rem">Nothing matches — try clearing a filter.</p>'}`;
    const qi = $("#tx-q"); if (document.activeElement && document.activeElement.id === "tx-q") qi.focus();
  }
  const refresh = async () => { $("#month-input").dispatchEvent(new Event("change")); await load(); };

  box.addEventListener("input", (e) => { if (e.target.id === "tx-q") { q = e.target.value.toLowerCase(); render(); const i = $("#tx-q"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.c !== undefined) { cat = d.c; render(); } else if (d.p !== undefined) { pay = d.p; render(); } else if (d.s) { sort = d.s; render(); }
    else if (d.d && confirm("Delete this transaction?")) { await api("/api/transactions/" + d.d, { method: "DELETE" }); refresh(); }
    else if (d.e) edit(items.find((t) => String(t.id) === d.e));
  });
  function edit(t) {
    dlg.innerHTML = `<form method="dialog" class="tx-form"><h3>Edit transaction</h3>
      <label>Amount<input id="e-amt" type="number" step="0.01" value="${t.amount}"></label><label>Purchase<input id="e-pur" value="${esc(t.purchase)}"></label>
      <label>Date<input id="e-date" type="date" value="${t.date}"></label><label>Category<select id="e-cat">${$("#category").innerHTML}</select></label>
      <label>Note<input id="e-note" value="${esc(t.note || "")}"></label><div class="tx-formbtns"><button value="x" class="btn btn-ghost">Cancel</button><button id="e-save" value="y" class="btn btn-primary">Save</button></div></form>`;
    $("#e-cat").value = t.category; dlg.showModal();
    $("#e-save").onclick = async (ev) => { ev.preventDefault(); try { await api("/api/transactions/" + t.id, { method: "PUT", body: JSON.stringify({ amount: Number($("#e-amt").value), purchase: $("#e-pur").value, date: $("#e-date").value, category: $("#e-cat").value, note: $("#e-note").value }) }); dlg.close(); refresh(); } catch (er) { alert(er.message); } };
  }
  let t0; new MutationObserver(() => { clearTimeout(t0); t0 = setTimeout(load, 200); }).observe($("#summary"), { childList: true });
  load();
})();
