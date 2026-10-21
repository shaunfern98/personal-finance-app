// Investing tab: holdings per account with live (delayed) prices, portfolio value, day change, allocation. Replaces the simple version in more.js.
(() => {
  const $ = (s) => document.querySelector(s), esc = (s) => escapeHtml(String(s ?? ""));
  const money = (v, d = 0) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: d }).format(Number(v) || 0);
  const call = (p, m, b) => api(p, { method: m, body: b ? JSON.stringify(b) : undefined });
  const panel = $("#panel-investing"), root = $("#investing-root"); let H = null, D = null, chart = null, note = "", busy = false;
  const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "muted"), sign = (v, f) => (v > 0 ? "+" : v < 0 ? "−" : "") + f(Math.abs(v));

  async function load() {
    if (busy) return; busy = true;
    try { [H, D] = await Promise.all([api("/api/house"), api("/api/holdings")]); render(); } catch (e) { root.innerHTML = `<p class="muted">Could not load your portfolio: ${esc(e.message)}</p>`; }
    busy = false;
  }
  function render() {
    const hold = D.holdings, ro = !!$("#view-banner"), hv = hold.reduce((t, h) => t + (h.value || 0), 0), day = hold.reduce((t, h) => t + (h.day_change || 0), 0);
    const cash = H.accounts.reduce((t, a) => t + a.balance, 0), cost = hold.reduce((t, h) => t + (h.value != null && h.cost ? h.cost : 0), 0), gain = hold.reduce((t, h) => t + (h.gain || 0), 0);
    const when = D.as_of ? new Date(D.as_of * 1000).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }) : null;
    const by = {}; hold.forEach((h) => (by[h.account_id] = by[h.account_id] || []).push(h));
    const owners = Object.fromEntries(H.people.map((p) => [p.id, p.username]));
    const rows = (a) => (by[a.id] || []).map((h) => `<tr><td><b>${esc(h.symbol)}</b><small>${esc(h.name)}</small></td>
      <td class="right">${h.own && !ro ? `<input class="ph-edit" data-id="${h.id}" data-f="shares" type="number" step="any" value="${h.shares}">` : h.shares}</td>
      <td class="right">${h.own && !ro ? `<input class="ph-edit" data-id="${h.id}" data-f="avg_cost" type="number" step="any" value="${h.avg_cost ?? ""}" placeholder="—">` : (h.avg_cost ?? "—")}</td>
      <td class="right">${h.price != null ? h.price.toLocaleString("en-CA", { maximumFractionDigits: 2 }) + `<small>${esc(h.currency || "")}</small>` : "—"}</td>
      <td class="right ${cls(h.change_pct)}">${h.change_pct != null ? sign(h.change_pct, (v) => v.toFixed(2) + "%") : "—"}</td>
      <td class="right"><b>${h.value != null ? money(h.value) : "—"}</b>${h.gain != null ? `<small class="${cls(h.gain)}">${sign(h.gain, money)} total</small>` : ""}</td>
      <td>${h.own && !ro ? `<button class="btn btn-ghost btn-sm ph-del" data-id="${h.id}">✕</button>` : ""}</td></tr>`).join("");
    const acct = H.accounts.map((a) => { const own = a.user_id === H.me && !ro, v = (by[a.id] || []).reduce((t, h) => t + (h.value || 0), 0);
      return `<section class="card ph-acct"><div class="ph-ah"><div><h2>${esc(a.name)} <span class="muted">${esc(a.account_type)}${a.user_id !== H.me ? " · " + esc(owners[a.user_id] || "partner") : ""}</span></h2></div>
        <div class="right"><b>${money(v + a.balance)}</b><small class="muted">${money(v)} holdings + ${money(a.balance)} cash</small></div></div>
        ${(by[a.id] || []).length ? `<div class="table-wrap"><table class="mx ph-t"><thead><tr><th>Holding</th><th>Shares</th><th>Avg cost</th><th>Price</th><th>Today</th><th>Value</th><th></th></tr></thead><tbody>${rows(a)}</tbody></table></div>` : '<p class="muted">No holdings yet.</p>'}
        ${own ? `<div class="ph-form" data-acc="${a.id}"><input class="ph-sym" placeholder="Ticker — AAPL, VFV.TO, XEQT.TO" autocapitalize="characters"><input class="ph-sh" type="number" step="any" placeholder="Shares"><input class="ph-cost" type="number" step="any" placeholder="Avg cost / share (optional)"><button class="btn btn-ghost ph-add">＋ Add</button><small class="ph-hint muted"></small></div>` : ""}</section>`; }).join("");
    root.innerHTML = `<div class="rp"><section class="card hero-card ph-hero"><div><p class="muted"><span class="live">●</span> ${D.unavailable.length ? "Live prices unavailable — showing last known" : "Live"} · prices delayed up to ~15 min${when ? " · updated " + when : ""} <button class="btn btn-ghost btn-sm" id="ph-refresh">↻</button></p>
        <h1>${money(hv + cash)} <span>total in accounts</span></h1><p>Holdings <b>${money(hv)}</b> · Cash <b>${money(cash)}</b>${hold.length ? ` · Today <b class="${cls(day)}">${sign(day, money)}${hv ? " (" + sign(day / (hv - day) * 100, (v) => v.toFixed(2) + "%") + ")" : ""}</b>` : ""}${cost ? ` · All-time <b class="${cls(gain)}">${sign(gain, money)}</b>` : ""}</p>
        ${D.unavailable.length ? `<small class="neg">No price for: ${D.unavailable.map(esc).join(", ")} — check the ticker (Canadian listings end in .TO).</small>` : ""}${note ? `<p class="neg">${esc(note)}</p>` : ""}</div><div class="viz-canvas" style="height:190px"><canvas id="ph-chart"></canvas></div></section>${acct || '<section class="card"><p class="muted">Add an account in the House Fund tab first, then add its holdings here.</p></section>'}
      <p class="muted ph-foot">Prices from Yahoo Finance, ~15 min delayed. USD holdings are converted to CAD at the current rate. Once an account has holdings, set its cash balance (in House Fund) to the cash portion only, so holdings aren't counted twice.</p></div>`;
    if (chart) chart.destroy(); chart = null; if (!window.Chart) return;
    const top = hold.filter((h) => h.value).sort((a, b) => b.value - a.value), labels = top.slice(0, 7).map((h) => h.symbol), data = top.slice(0, 7).map((h) => h.value), rest = top.slice(7).reduce((t, h) => t + h.value, 0);
    if (rest) { labels.push("Other"); data.push(rest); } if (cash) { labels.push("Cash"); data.push(cash); } if (!data.length) return;
    chart = new Chart($("#ph-chart"), { type: "doughnut", data: { labels, datasets: [{ data, borderWidth: 0 }] }, options: { maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "right", labels: { color: getComputedStyle(document.body).getPropertyValue("--muted"), boxWidth: 10, usePointStyle: true } }, tooltip: { callbacks: { label: (c) => c.label + ": " + money(c.parsed) } } } } });
  }
  let t0; root.addEventListener("input", (e) => { if (!e.target.classList.contains("ph-sym")) return; clearTimeout(t0); const f = e.target.closest(".ph-form"), hint = f.querySelector(".ph-hint"), s = e.target.value.trim();
    if (s.length < 1) { hint.textContent = ""; return; } t0 = setTimeout(async () => { try { const q = await api("/api/quote?symbol=" + encodeURIComponent(s)); hint.className = "ph-hint pos"; hint.textContent = `${q.name} — ${q.price.toLocaleString("en-CA", { maximumFractionDigits: 2 })} ${q.currency}`; } catch (er) { hint.className = "ph-hint neg"; hint.textContent = er.message; } }, 500); });
  root.addEventListener("click", async (e) => { const b = e.target.closest("button"); if (!b) return;
    if (b.id === "ph-refresh") { load(); } else if (b.classList.contains("ph-del")) { if (confirm("Remove this holding?")) { await call("/api/holdings/" + b.dataset.id, "DELETE"); load(); } }
    else if (b.classList.contains("ph-add")) { const f = b.closest(".ph-form"); try { await call("/api/holdings", "POST", { account_id: Number(f.dataset.acc), symbol: f.querySelector(".ph-sym").value, shares: f.querySelector(".ph-sh").value, avg_cost: f.querySelector(".ph-cost").value }); note = ""; load(); } catch (er) { note = er.message; render(); } } });
  root.addEventListener("change", async (e) => { const t = e.target; if (!t.classList.contains("ph-edit")) return; const h = D.holdings.find((x) => String(x.id) === t.dataset.id);
    try { await call("/api/holdings/" + h.id, "PUT", { symbol: h.symbol, shares: t.dataset.f === "shares" ? t.value : h.shares, avg_cost: t.dataset.f === "avg_cost" ? t.value : h.avg_cost }); note = ""; } catch (er) { note = er.message; } load(); });
  document.querySelectorAll('[data-tab="investing"]').forEach((b) => b.addEventListener("click", load));
  setInterval(() => { if (!panel.hidden && !document.hidden && !root.contains(document.activeElement.closest?.(".ph-form") || null)) load(); }, 60000);
})();
