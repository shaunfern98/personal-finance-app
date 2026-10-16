// House Fund tab + partner view switch. Loaded after app.js (uses its global api()).
(() => {
  const $ = (s) => document.querySelector(s);
  const money = (v) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(v) || 0);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => Number(v) || 0;
  const call = (path, method, body) => api(path, { method, body: body ? JSON.stringify(body) : undefined });
  const today = () => new Date().toLocaleDateString("en-CA");
  let H = null, P = null, note = "";

  async function act(promise, ok) {
    try { await promise; note = ok || ""; } catch (e) { note = "⚠ " + e.message; }
    await load();
  }

  async function load() {
    try { [H, P] = await Promise.all([api("/api/house"), api("/api/partner")]); } catch (e) { note = "⚠ " + e.message; }
    render(); chrome();
  }

  function chrome() {
    let btn = $("#btn-view");
    if (P && P.linked) {
      if (!btn) {
        btn = document.createElement("button");
        btn.id = "btn-view"; btn.type = "button"; btn.className = "btn btn-ghost btn-sm";
        $("#btn-logout").before(btn);
        btn.onclick = async () => { await call("/api/partner/view", "POST", { who: P.viewing_partner ? "me" : "partner" }); location.reload(); };
      }
      btn.textContent = P.viewing_partner ? "← Back to mine" : "👀 " + P.partner_name + "'s view";
    } else if (btn) btn.remove();
    let ban = $("#view-banner");
    if (P && P.viewing_partner) {
      if (!ban) { ban = document.createElement("div"); ban.id = "view-banner"; $(".layout").prepend(ban); }
      ban.textContent = "Viewing " + P.partner_name + "'s data — read-only. Nothing you do here changes their records.";
    } else if (ban) ban.remove();
  }

  function ring(p) {
    const r = 62, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, p));
    return `<svg viewBox="0 0 160 160" class="hf-ring" role="img" aria-label="${Math.round(f * 100)}% of house goal">
      <circle cx="80" cy="80" r="${r}" fill="none" stroke="var(--stroke)" stroke-width="14"/>
      <circle cx="80" cy="80" r="${r}" fill="none" stroke="var(--accent)" stroke-width="14" stroke-linecap="round"
        stroke-dasharray="${c * f} ${c}" transform="rotate(-90 80 80)"/>
      <text x="80" y="78" text-anchor="middle" class="hf-pct">${Math.round(f * 100)}%</text>
      <text x="80" y="100" text-anchor="middle" class="hf-sub">of goal</text></svg>`;
  }

  function render() {
    const root = $("#house-root"); if (!root || !H) return;
    const ro = H.viewing_partner, g = H.goal, ppl = H.people;
    const total = ppl.reduce((t, x) => t + x.total, 0), cash = ppl.reduce((t, x) => t + x.cash, 0), inv = ppl.reduce((t, x) => t + x.invested, 0);
    const avg = ppl.reduce((t, x) => t + x.avg_monthly, 0), target = num(g.target_amount), left = Math.max(0, target - total);
    let pace = "Set a target to see your pace.";
    if (target > 0) {
      if (!left) pace = "Goal reached 🎉";
      else {
        const bits = [];
        if (avg > 0) { const mo = Math.ceil(left / avg), d = new Date(); d.setMonth(d.getMonth() + mo); bits.push(`At your recent pace (${money(avg)}/mo) that's about ${mo} months, around ${d.toLocaleDateString("en-CA", { month: "short", year: "numeric" })}.`); }
        else bits.push("No positive monthly savings yet — it needs at least one full logged month.");
        if (g.target_date) { const t = new Date(g.target_date), n = new Date(), ml = (t.getFullYear() - n.getFullYear()) * 12 + t.getMonth() - n.getMonth(); if (ml > 0) { const need = left / ml; bits.push(`To hit ${g.target_date} you need ${money(need)}/mo${avg >= need ? " — on track ✅" : ` — about ${money(need - avg)}/mo short.`}`); } }
        pace = bits.join(" ");
      }
    }
    const w = (v) => (total > 0 ? Math.max(0, v) / total * 100 : 0);
    const form = (inner) => (ro ? "" : inner);
    const accts = H.accounts.map((a) => { const own = a.user_id === H.me && !ro; const who = ppl.find((p) => p.id === a.user_id); return `<tr><td>${esc(a.name)}${a.user_id === H.me ? "" : ` <span class="muted">(${esc(who ? who.username : "partner")})</span>`}</td><td>${esc(a.account_type)}</td>
      <td class="right">${own ? `<input class="hf-bal" data-id="${a.id}" type="number" step="0.01" value="${num(a.balance)}">` : money(a.balance)}</td>
      <td>${own ? `<input class="hf-cnt" data-id="${a.id}" type="checkbox"${a.counts_toward_house ? " checked" : ""}>` : (a.counts_toward_house ? "✓" : "")}</td>
      <td>${own ? `<button class="btn btn-ghost btn-sm hf-del" data-id="${a.id}">✕</button>` : ""}</td></tr>`; }).join("");
    const deps = H.deposits.map((d) => `<tr><td>${esc(d.deposit_date)}</td><td>${d.kind === "extra" ? "Extra deposit" : "Moved to account"}</td><td>${esc(d.note)}</td><td class="right">${money(d.amount)}</td><td>${d.user_id === H.me && !ro ? `<button class="btn btn-ghost btn-sm hf-deld" data-id="${d.id}">✕</button>` : ""}</td></tr>`).join("");
    root.innerHTML = `
      ${note ? `<p class="hf-note">${esc(note)}</p>` : ""}
      <section class="card card--glow hf-hero"><div>${ring(target > 0 ? total / target : 0)}</div><div>
        <p class="muted">House fund${ppl.length > 1 ? " · combined" : ""}</p>
        <h2>${money(total)}${target > 0 ? ` <span class="muted">of ${money(target)}</span>` : ""}</h2>
        <p>${target > 0 ? money(left) + " to go. " : ""}${esc(pace)}</p>
        <div class="hf-split"><span class="hf-cash" style="width:${w(cash)}%"></span><span class="hf-inv" style="width:${w(inv)}%"></span></div>
        <small class="muted">● Cash savings ${money(cash)} &nbsp; ● Investments ${money(inv)}</small>
        ${ppl.length > 1 ? `<div class="hf-people">${ppl.map((p) => `<div><span class="muted">${esc(p.username)}</span><strong>${money(p.total)}</strong></div>`).join("")}</div>` : ""}
      </div></section>
      ${form(`<section class="card"><h3>Goal &amp; starting point</h3>
        <p class="muted">Each completed month adds <b>take-home income − spending</b> (income comes from Budget &amp; salary; spending in “savings” type categories like Joint Savings counts as saved, not spent). Only months with logged expenses count.</p>
        <div class="hf-form"><label>House target<input id="hf-target" type="number" step="100" value="${num(g.target_amount)}"></label>
        <label>Target date<input id="hf-date" type="date" value="${esc(g.target_date || "")}"></label>
        <label>Count savings from<input id="hf-start" type="month" value="${esc(g.tracking_start || today().slice(0, 7))}"></label>
        <label>Your starting cash<input id="hf-cash" type="number" step="0.01" value="${num(g.starting_cash)}"></label>
        <button id="hf-save" class="btn btn-primary">Save goal</button></div></section>`)}
      <section class="card"><h3>Investment &amp; savings accounts</h3>
        <p class="muted">Enter each account's current value (ETFs included) and update it when you like. Untick one to leave it out of the house total.</p>
        <div class="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th class="right">Value</th><th>Counts</th><th></th></tr></thead><tbody>${accts || '<tr><td colspan="5" class="muted">No accounts yet.</td></tr>'}</tbody></table></div>
        ${form(`<div class="hf-form"><label>Name<input id="ha-name" placeholder="e.g. FHSA – XEQT"></label><label>Type<select id="ha-type">${H.account_types.map((t) => `<option>${t}</option>`).join("")}</select></label>
        <label>Current value<input id="ha-bal" type="number" step="0.01"></label><button id="ha-add" class="btn btn-ghost">Add account</button></div>`)}</section>
      <section class="card"><h3>Log a savings move</h3>
        ${form(`<p class="muted"><b>Extra deposit</b>: money from outside your monthly surplus (tax refund, gift, bonus). <b>Moved to account</b>: cash you moved into an account above, so it isn't counted twice — then update that account's value.</p>
        <div class="hf-form"><label>Amount<input id="hd-amt" type="number" step="0.01"></label><label>Type<select id="hd-kind"><option value="extra">Extra deposit</option><option value="invest">Moved to account</option></select></label>
        <label>Date<input id="hd-date" type="date" value="${today()}"></label><label>Note<input id="hd-note"></label><button id="hd-add" class="btn btn-ghost">Log it</button></div>`)}
        ${deps ? `<div class="table-wrap"><table><tbody>${deps}</tbody></table></div>` : ""}</section>
      <section class="card"><h3>Partner sharing</h3>${P && P.linked
        ? `<p>Linked with <b>${esc(P.partner_name)}</b>. You can each view the other's expenses, reports and savings (read-only).</p><button id="hp-unlink" class="btn btn-ghost btn-sm">Stop sharing</button>`
        : P && P.pending
          ? `<p class="muted">Waiting for your partner to link your username from their House Fund tab. Nothing is shared until they do.</p><button id="hp-unlink" class="btn btn-ghost btn-sm">Cancel</button>`
          : `<p class="muted">Enter your partner's username. Sharing starts only when they enter yours too.</p><div class="hf-form"><label>Partner username<input id="hp-name"></label><button id="hp-link" class="btn btn-ghost">Link</button></div>`}</section>`;
  }

  document.addEventListener("click", (ev) => {
    const t = ev.target, v = (s) => $(s).value, id = t.dataset && t.dataset.id;
    if (!t.closest("#house-root")) return;
    if (t.id === "hf-save") act(call("/api/house/goal", "PUT", { target_amount: v("#hf-target"), target_date: v("#hf-date"), tracking_start: v("#hf-start"), starting_cash: v("#hf-cash") }), "Goal saved");
    else if (t.id === "ha-add") act(call("/api/house/accounts", "POST", { name: v("#ha-name"), account_type: v("#ha-type"), balance: v("#ha-bal") }), "Account added");
    else if (t.classList.contains("hf-del")) { if (confirm("Remove this account from tracking?")) act(call("/api/house/accounts/" + id, "DELETE")); }
    else if (t.id === "hd-add") act(call("/api/house/deposits", "POST", { kind: v("#hd-kind"), amount: v("#hd-amt"), deposit_date: v("#hd-date"), note: v("#hd-note") }), "Logged");
    else if (t.classList.contains("hf-deld")) { if (confirm("Delete this entry?")) act(call("/api/house/deposits/" + id, "DELETE")); }
    else if (t.id === "hp-link") act(call("/api/partner/link", "POST", { username: v("#hp-name") }), "Link saved");
    else if (t.id === "hp-unlink") act(call("/api/partner/link", "DELETE"), "Sharing stopped");
  });
  document.addEventListener("change", (ev) => {
    const t = ev.target, id = t.dataset && t.dataset.id;
    if (t.classList.contains("hf-bal")) act(call("/api/house/accounts/" + id, "PUT", { balance: t.value }));
    else if (t.classList.contains("hf-cnt")) act(call("/api/house/accounts/" + id, "PUT", { counts_toward_house: t.checked }));
  });

  document.querySelectorAll('[data-tab="savings"]').forEach((b) => b.addEventListener("click", load));
  load();
})();
