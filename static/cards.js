// Credit cards visual on the Expenses tab: photo, owed balance, due date, monthly spend. Re-renders whenever expenses reload.
(() => {
  const $ = (s) => document.querySelector(s), esc = (s) => escapeHtml(String(s ?? ""));
  const money = (v) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(Number(v) || 0);
  const call = (p, m, b) => api(p, { method: m, body: b ? JSON.stringify(b) : undefined });
  const anchor = $("#tx-new"); if (!anchor) return;
  const sec = document.createElement("section"); sec.id = "exp-cards"; anchor.after(sec);
  const dlg = document.createElement("dialog"); dlg.id = "cc-dlg"; document.body.appendChild(dlg);
  let C = null; const who = () => localStorage.getItem("exp_who") || "me", ro = () => !!$("#view-banner");
  const HUE = { Visa: 218, Mastercard: 18, Amex: 165, Other: 270 };
  const fmtDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-CA", { month: "short", day: "numeric" });

  async function load() { try { C = await api("/api/cards/overview"); } catch (e) { return; } render(); window.dispatchEvent(new Event("cardschanged")); }
  function chip(c) {
    if (!c.due_date) return `<span class="cc-chip">${c.own && !ro() ? "Set your due date" : "No due date set"}</span>`;
    if (c.overdue) return `<span class="cc-chip bad">Overdue by ${-c.due_in} day${c.due_in === -1 ? "" : "s"}</span>`;
    return `<span class="cc-chip ${c.due_in <= 3 ? "warn" : ""}">${c.paid ? "Paid ✓ · next due " : "Due "}${fmtDate(c.due_date)} · ${c.due_in === 0 ? "today" : "in " + c.due_in + " day" + (c.due_in === 1 ? "" : "s")}</span>`;
  }
  function tile(c) {
    const mx = Math.max(...c.months.map((m) => m.amt), 1), h = HUE[c.card_type] ?? 270, own = c.own && !ro();
    const face = c.photo ? `style="background-image:linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.55)),url('/api/cards/${c.id}/photo?v=${encodeURIComponent(c.photo)}')"` : `style="background:linear-gradient(135deg,hsl(${h} 55% 42%),hsl(${(h + 40) % 360} 60% 28%))"`;
    const label = { statement: "statement balance", cycle: "spent since last statement", month: "spent this month" }[c.owed_kind];
    return `<article class="cc"><div class="cc-face ${own ? "edit" : ""}" ${face} ${own ? `data-photo="${c.id}" title="Click to add a photo of this card"` : ""}><span class="cc-type">${esc(c.card_type)}${c.own ? "" : " · " + esc(c.owner)}</span><span class="cc-name">${esc(c.nickname)}</span><span class="cc-num">•••• ${esc(c.last_four || "••••")}</span>${own && !c.photo ? '<span class="cc-cam">📷 Add photo</span>' : ""}</div>
      <div class="cc-body">${chip(c)}<div class="cc-owed"><b class="${c.overdue ? "neg" : ""}">${money(c.owed)}</b><span>${label}</span></div>
      ${c.owed_kind === "statement" && c.cycle_spend ? `<p class="cc-sub">+ ${money(c.cycle_spend)} spent since the statement closed</p>` : ""}
      <div class="cc-bars">${c.months.map((m, i) => `<div title="${m.m}: ${money(m.amt)}"><i class="${i === 5 ? "now" : ""}" style="height:${Math.max(3, m.amt / mx * 44)}px"></i><span>${"JFMAMJJASOND"[Number(m.m.slice(5)) - 1]}</span></div>`).join("")}</div>
      ${c.credit_limit ? `<div class="cc-util"><div><i style="width:${Math.min(100, (c.owed_kind === "cycle" ? c.cycle_spend : c.owed + c.cycle_spend) / c.credit_limit * 100)}%"></i></div><small>${Math.round((c.owed + (c.owed_kind === "statement" ? c.cycle_spend : 0)) / c.credit_limit * 100)}% of ${money(c.credit_limit)} limit</small></div>` : ""}
      ${own ? `<div class="cc-act">${c.due_date && c.owed_kind !== "month" ? `<button class="btn btn-ghost btn-sm" data-pay="${c.id}" data-paid="${c.paid ? 0 : 1}">${c.paid ? "Undo paid" : "✓ Mark paid"}</button>` : ""}<button class="btn btn-ghost btn-sm" data-set="${c.id}">⚙ Dates &amp; limit</button></div>` : ""}</div></article>`;
  }
  function render() {
    const w = who(), list = C.cards.filter((c) => w === "both" || (w === "me" ? c.own : !c.own));
    if (!list.length) { sec.innerHTML = `<section class="card"><h2>Credit cards</h2><p class="muted">${C.cards.length ? "No cards in this view." : "Add your credit cards under Plan → Credit Cards, then come back here to add a photo, due date and see spending per month."}</p></section>`; return; }
    const spent = list.reduce((t, c) => t + c.months[5].amt, 0), nxt = list.filter((c) => c.due_date && !c.paid || c.overdue).sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
    sec.innerHTML = `<section class="card"><div class="cc-head"><div><h2>Credit cards</h2><p class="muted">${money(spent)} charged this month across ${list.length} card${list.length > 1 ? "s" : ""}${nxt ? ` · next bill: <b>${esc(nxt.nickname)}</b> ${nxt.overdue ? '<b class="neg">overdue</b>' : fmtDate(nxt.due_date)}` : ""}</p></div></div><div class="cc-row">${list.map(tile).join("")}</div></section>`;
  }
  const shrink = (f) => new Promise((res, rej) => { const img = new Image(); img.onload = () => { const W = 640, H = 404, c = document.createElement("canvas"); c.width = W; c.height = H; const r = Math.max(W / img.width, H / img.height);
    const w = img.width * r, h = img.height * r; c.getContext("2d").drawImage(img, (W - w) / 2, (H - h) / 2, w, h); res(c.toDataURL("image/jpeg", 0.85)); }; img.onerror = () => rej(new Error("Could not read that image")); img.src = URL.createObjectURL(f); });
  sec.addEventListener("click", async (e) => {
    const p = e.target.closest("[data-photo]"), pay = e.target.closest("[data-pay]"), set = e.target.closest("[data-set]");
    if (p) { const f = document.createElement("input"); f.type = "file"; f.accept = "image/*"; f.onchange = async () => { if (!f.files[0]) return; try { await call(`/api/cards/${p.dataset.photo}/photo`, "POST", { image: await shrink(f.files[0]) }); } catch (er) { alert(er.message); } load(); }; f.click(); }
    else if (pay) { try { await call(`/api/cards/${pay.dataset.pay}/paid`, "POST", { paid: pay.dataset.paid === "1" }); } catch (er) { alert(er.message); } load(); }
    else if (set) { const c = C.cards.find((x) => String(x.id) === set.dataset.set);
      dlg.innerHTML = `<form method="dialog" class="gd"><h3>${esc(c.nickname)} — billing details</h3><div class="gd-row"><label>Statement closes on day<input id="cc-sd" type="number" min="1" max="31" value="${c.statement_day ?? ""}" placeholder="e.g. 20"></label><label>Payment due on day<input id="cc-dd" type="number" min="1" max="31" value="${c.due_day ?? ""}" placeholder="e.g. 15"></label></div>
        <label>Credit limit <span class="muted">(optional)</span><input id="cc-lim" type="number" step="100" value="${c.credit_limit ?? ""}"></label><small class="muted">Both dates are on your statement or in your card's app. With them, the balance shown is what's due on the next due date, and the due date appears on your calendar.</small>
        <div class="gd-btns"><button value="x" class="btn btn-ghost">Cancel</button><button id="cc-save" class="btn btn-primary">Save</button></div></form>`; dlg.showModal();
      $("#cc-save").onclick = async (ev) => { ev.preventDefault(); await call(`/api/cards/${c.id}/meta`, "PUT", { statement_day: $("#cc-sd").value, due_day: $("#cc-dd").value, credit_limit: $("#cc-lim").value }); dlg.close(); load(); }; }
  });
  window.addEventListener("expload", load); load();
})();
