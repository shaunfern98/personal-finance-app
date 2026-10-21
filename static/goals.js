// Goals tab: savings goals with photos, shared goals, contributions. Mounts above the House fund. Uses app.js globals api(), escapeHtml().
(() => {
  const $ = (s) => document.querySelector(s), esc = (s) => escapeHtml(String(s ?? ""));
  const money = (v) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(Number(v) || 0);
  const call = (p, m, b) => api(p, { method: m, body: b ? JSON.stringify(b) : undefined });
  const panel = $("#panel-savings"), root = document.createElement("section"); root.id = "goals-root"; panel.prepend(root);
  const dlg = document.createElement("dialog"); dlg.id = "goal-dlg"; document.body.appendChild(dlg);
  let G = [], partner = false, showDone = false, file = null;
  const ro = () => !!$("#view-banner");

  async function load() {
    try { const r = await api("/api/goals"); G = r.goals; partner = r.partner; } catch (e) { root.innerHTML = `<p class="muted">Could not load goals: ${esc(e.message)}</p>`; return; }
    render();
  }
  function pace(g) {
    const left = Math.max(0, g.target_amount - g.saved);
    if (g.completed) return "Done ✓"; if (g.target_amount > 0 && left === 0) return "Fully funded 🎉"; if (!g.target_date) return g.target_amount > 0 ? money(left) + " to go" : "";
    const days = Math.ceil((new Date(g.target_date + "T12:00:00") - new Date()) / 864e5);
    if (days < 0) return `${money(left)} to go · ${-days} days past due`;
    const wk = days <= 35, per = left / Math.max(wk ? days / 7 : days / 30.4, 1);
    return `${money(left)} to go · ${days} days left · save <b>${money(per)}/${wk ? "week" : "month"}</b>`;
  }
  function card(g) {
    const p = g.target_amount > 0 ? Math.min(100, g.saved / g.target_amount * 100) : 0, mine = g.mine && !ro();
    const img = g.photo ? `style="background-image:url('/api/goals/${g.id}/photo?v=${encodeURIComponent(g.photo)}')"` : "";
    const who = Object.entries(g.by).filter(([, v]) => v).map(([n, v]) => `${esc(n)} ${money(v)}`).join(" · ");
    return `<article class="goal-card ${g.completed ? "done" : ""}"><div class="goal-img ${g.photo ? "" : "noimg"}" ${img}>${g.photo ? "" : `<span>${esc(g.emoji)}</span>`}${g.shared ? '<em class="goal-tag">Shared</em>' : ""}</div>
      <div class="goal-body"><h3>${g.photo ? esc(g.emoji) + " " : ""}${esc(g.name)}</h3>
      <div class="goal-amt"><b>${money(g.saved)}</b><span class="muted">${g.target_amount > 0 ? " of " + money(g.target_amount) : " saved"}</span></div>
      <div class="goal-bar"><i style="width:${p}%"></i></div><p class="goal-pace">${pace(g)}</p>${g.shared && who ? `<p class="muted goal-who">${who}</p>` : ""}
      ${ro() ? "" : `<div class="goal-actions">${g.completed ? `<button class="btn btn-ghost btn-sm" data-a="reopen" data-id="${g.id}">Reopen</button>` : `<button class="btn btn-primary btn-sm" data-a="add" data-id="${g.id}">＋ Add money</button><button class="btn btn-ghost btn-sm" data-a="take" data-id="${g.id}">Take out</button>`}
        ${mine ? `<button class="btn btn-ghost btn-sm" data-a="edit" data-id="${g.id}" title="Edit">✏️</button>${g.completed ? "" : `<button class="btn btn-ghost btn-sm" data-a="done" data-id="${g.id}" title="Mark as bought">✓ Bought</button>`}` : ""}</div>`}</div></article>`;
  }
  function render() {
    const act = G.filter((g) => !g.completed), done = G.filter((g) => g.completed), tot = act.reduce((t, g) => t + g.saved, 0);
    root.innerHTML = `<div class="goals-head"><div><h2>Goals</h2><p class="muted">${act.length ? `${money(tot)} set aside across ${act.length} goal${act.length > 1 ? "s" : ""}. Money you add comes out of your house fund's cash savings, so nothing is counted twice.` : "Save toward things like winter tires or a trip — each goal gets its own progress, date and photo."}</p></div>${ro() ? "" : '<button class="btn btn-primary" data-a="new">＋ New goal</button>'}</div>
      ${act.length ? `<div class="goal-grid">${act.map(card).join("")}</div>` : ro() ? "" : `<div class="goal-empty"><p>Start with an idea:</p><div class="chips"><button data-a="new" data-pre="🛞|Winter tires|2000">🛞 Winter tires</button><button data-a="new" data-pre="✈️|Japan trip|8000">✈️ Japan trip</button><button data-a="new" data-pre="🎯||">🎯 Something else</button></div></div>`}
      ${done.length ? `<button class="btn btn-ghost btn-sm" data-a="toggle">${showDone ? "Hide" : "Show"} completed (${done.length})</button>${showDone ? `<div class="goal-grid" style="margin-top:.8rem">${done.map(card).join("")}</div>` : ""}` : ""}`;
  }
  const shrink = (f) => new Promise((res, rej) => { const img = new Image(); img.onload = () => { const W = 900, H = 506, c = document.createElement("canvas"); c.width = W; c.height = H; const r = Math.max(W / img.width, H / img.height), w = img.width * r, h = img.height * r;
    c.getContext("2d").drawImage(img, (W - w) / 2, (H - h) / 2, w, h); res(c.toDataURL("image/jpeg", 0.82)); }; img.onerror = () => rej(new Error("Could not read that image")); img.src = URL.createObjectURL(f); });

  function goalForm(g, pre) {
    file = null; const x = g || { emoji: pre ? pre[0] : "🎯", name: pre ? pre[1] : "", target_amount: pre ? pre[2] : "", target_date: "", shared: false };
    dlg.innerHTML = `<form method="dialog" class="gd"><h3>${g ? "Edit goal" : "New goal"}</h3>
      <label>Name<input id="gd-name" value="${esc(x.name)}" placeholder="e.g. Winter tires" required></label>
      <div class="gd-row"><label>Emoji<input id="gd-emoji" value="${esc(x.emoji)}" maxlength="4" style="width:5rem"></label><label>Target ($)<input id="gd-target" type="number" step="1" min="0" value="${x.target_amount}"></label></div>
      <label>Target date <span class="muted">(optional)</span><input id="gd-date" type="date" value="${esc(x.target_date || "")}"></label>
      <label>Photo <span class="muted">(so you remember what you're saving for)</span><input id="gd-photo" type="file" accept="image/*"></label><img id="gd-prev" class="gd-prev" ${g && g.photo ? `src="/api/goals/${g.id}/photo?v=${encodeURIComponent(g.photo)}"` : 'hidden'}>
      ${partner ? `<label class="gd-check"><input id="gd-shared" type="checkbox" ${x.shared ? "checked" : ""}> Shared goal — we both see it and can add money</label>` : ""}
      <p id="gd-err" class="neg"></p><div class="gd-btns">${g ? '<button type="button" id="gd-del" class="btn btn-ghost" style="margin-right:auto">Delete</button>' : ""}<button value="x" class="btn btn-ghost">Cancel</button><button id="gd-save" class="btn btn-primary">Save</button></div></form>`;
    dlg.showModal();
    $("#gd-photo").onchange = (e) => { file = e.target.files[0]; if (file) { $("#gd-prev").src = URL.createObjectURL(file); $("#gd-prev").hidden = false; } };
    if (g) $("#gd-del").onclick = async () => { if (confirm("Delete this goal and its history?")) { await call("/api/goals/" + g.id, "DELETE"); dlg.close(); load(); } };
    $("#gd-save").onclick = async (e) => { e.preventDefault(); const body = { name: $("#gd-name").value, emoji: $("#gd-emoji").value, target_amount: $("#gd-target").value, target_date: $("#gd-date").value, shared: $("#gd-shared") ? $("#gd-shared").checked : false };
      try { const r = g ? (await call("/api/goals/" + g.id, "PUT", body), { id: g.id }) : await call("/api/goals", "POST", body); if (file) await call(`/api/goals/${r.id}/photo`, "POST", { image: await shrink(file) }); dlg.close(); load(); } catch (er) { $("#gd-err").textContent = er.message; } };
  }
  function moneyForm(g, take) {
    dlg.innerHTML = `<form method="dialog" class="gd"><h3>${take ? "Take money out of" : "Add money to"} ${esc(g.emoji)} ${esc(g.name)}</h3>
      <label>Amount<input id="gm-amt" type="number" step="0.01" min="0" autofocus placeholder="0.00"></label><label>Note <span class="muted">(optional)</span><input id="gm-note"></label>
      <label class="gd-check"><input id="gm-sav" type="checkbox" checked> ${take ? "Return it to" : "Take it from"} my house-fund cash savings</label>
      <small class="muted">Untick if this is new money (a gift or bonus) that was never part of your monthly savings.</small>
      <p id="gm-err" class="neg"></p><div class="gd-btns"><button value="x" class="btn btn-ghost">Cancel</button><button id="gm-save" class="btn btn-primary">${take ? "Take out" : "Add"}</button></div></form>`;
    dlg.showModal();
    $("#gm-save").onclick = async (e) => { e.preventDefault(); const a = Number($("#gm-amt").value); if (!(a > 0)) { $("#gm-err").textContent = "Enter an amount"; return; }
      try { await call(`/api/goals/${g.id}/contribute`, "POST", { amount: take ? -a : a, note: $("#gm-note").value, from_savings: $("#gm-sav").checked }); dlg.close(); load(); } catch (er) { $("#gm-err").textContent = er.message; } };
  }
  root.addEventListener("click", async (e) => { const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a, g = G.find((x) => String(x.id) === b.dataset.id);
    if (a === "new") goalForm(null, b.dataset.pre ? b.dataset.pre.split("|") : null); else if (a === "edit") goalForm(g); else if (a === "add") moneyForm(g, false); else if (a === "take") moneyForm(g, true);
    else if (a === "toggle") { showDone = !showDone; render(); } else if (a === "reopen") { await call(`/api/goals/${g.id}/complete`, "POST", { done: false }); load(); }
    else if (a === "done" && confirm("Mark as bought? Its money goes back to your house-fund cash. Log the purchase as a normal expense so your spending stays accurate.")) { await call(`/api/goals/${g.id}/complete`, "POST", { done: true }); load(); } });
  document.querySelectorAll('[data-tab="savings"]').forEach((b) => b.addEventListener("click", load)); load();
})();
