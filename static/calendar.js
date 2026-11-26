// Overview calendar: card due dates (live from your cards), your events, goal dates + iPhone subscription. Mounts into #cal-slot rendered by ui.js.
(() => {
  const $ = (s) => document.querySelector(s), esc = (s) => escapeHtml(String(s ?? ""));
  const money = (v) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(Number(v) || 0);
  const call = (p, m, b) => api(p, { method: m, body: b ? JSON.stringify(b) : undefined });
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const root = document.createElement("section"); root.id = "cal-root"; root.className = "card";
  const dlg = document.createElement("dialog"); dlg.id = "cal-dlg"; document.body.appendChild(dlg);
  const slotIn = () => { const s = $("#cal-slot"); if (s && !s.contains(root)) s.appendChild(root); };
  new MutationObserver(slotIn).observe($("#overview-root"), { childList: true }); slotIn();
  let view = new Date(); view.setDate(1); let sel = iso(new Date()), items = [], partner = false;
  const ro = () => !!$("#view-banner"), ICON = { card: "💳", event: "📌", goal: "🎯" };

  async function load() {
    const first = new Date(view), start = new Date(first); start.setDate(1 - first.getDay());
    const end = new Date(start); end.setDate(start.getDate() + 41); const t = new Date(), up = new Date(t); up.setDate(t.getDate() + 45);
    const from = start < t ? start : t, to = end > up ? end : up;
    try { const r = await api(`/api/calendar/events?from=${iso(from)}&to=${iso(to)}`); items = r.items; partner = r.partner; } catch (e) { root.innerHTML = `<p class="muted">Could not load the calendar: ${esc(e.message)}</p>`; return; }
    render(start);
  }
  const label = (i) => (i.kind === "card" ? `${i.title}${i.amount != null ? " · " + money(i.amount) : ""}${i.paid ? " ✓" : ""}` : i.title);
  const row = (i, showDate) => `<div class="cal-row k-${i.kind} ${i.paid ? "paid" : ""} ${i.overdue ? "overdue" : ""}"><span class="cal-ico">${i.emoji || ICON[i.kind]}</span><div><b>${esc(label(i))}</b><small>${showDate ? new Date(i.date + "T12:00:00").toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" }) + " · " : ""}${i.kind === "event" && !i.mine ? esc(i.owner) + " · " : ""}${i.kind === "card" && !i.mine ? esc(i.owner) + "'s card · " : ""}${i.overdue ? "overdue" : i.kind === "card" ? (i.paid ? "paid" : "credit card bill") : i.kind === "goal" ? "goal date" : esc(i.note || (i.repeat !== "none" ? "repeats " + i.repeat : ""))}</small></div>
    ${i.kind === "event" && i.mine && !ro() ? `<button class="btn btn-ghost btn-sm" data-edit="${i.id}" data-d="${i.date}">✏️</button>` : ""}</div>`;
  function render(start) {
    const byDay = {}; items.forEach((i) => (byDay[i.date] = byDay[i.date] || []).push(i));
    const todayS = iso(new Date()), mo = view.getMonth(), cells = [];
    for (let k = 0; k < 42; k++) { const d = new Date(start); d.setDate(start.getDate() + k); const s = iso(d), its = byDay[s] || [];
      cells.push(`<button class="cal-d ${d.getMonth() !== mo ? "other" : ""} ${s === todayS ? "today" : ""} ${s === sel ? "sel" : ""}" data-day="${s}"><span class="n">${d.getDate()}</span>${its.slice(0, 2).map((i) => `<i class="cal-it k-${i.kind} ${i.paid ? "paid" : ""} ${i.overdue ? "overdue" : ""}">${i.emoji || ICON[i.kind]} <b>${esc(i.title)}</b></i>`).join("")}${its.length > 2 ? `<em>+${its.length - 2}</em>` : ""}</button>`); }
    const upcoming = items.filter((i) => i.date >= todayS && i.date <= iso(new Date(Date.now() + 45 * 864e5)) && !i.paid).slice(0, 7), day = byDay[sel] || [];
    root.innerHTML = `<div class="cal-head"><div><h2>Calendar</h2><p class="muted">Credit card due dates sync from your cards. Add anything else you need to remember.</p></div><div class="cal-tools"><button class="btn btn-ghost btn-sm" id="cal-sync">📱 Sync to iPhone</button>${ro() ? "" : '<button class="btn btn-primary btn-sm" id="cal-add">＋ Event</button>'}</div></div>
      <div class="cal-wrap"><div><div class="cal-nav"><button class="btn btn-ghost btn-sm" data-nav="-1">‹</button><b>${view.toLocaleDateString("en-CA", { month: "long", year: "numeric" })}</b><button class="btn btn-ghost btn-sm" data-nav="1">›</button><button class="btn btn-ghost btn-sm" data-nav="0">Today</button></div>
        <div class="cal-grid">${"SMTWTFS".split("").map((x) => `<span class="cal-dow">${x}</span>`).join("")}${cells.join("")}</div></div>
        <aside class="cal-side"><h3>${new Date(sel + "T12:00:00").toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" })}</h3>${day.length ? day.map((i) => row(i, false)).join("") : '<p class="muted">Nothing on this day.</p>'}${ro() ? "" : `<button class="btn btn-ghost btn-sm" id="cal-add-day">＋ Add on this day</button>`}
        <h3 style="margin-top:1.2rem">Coming up</h3>${upcoming.length ? upcoming.map((i) => row(i, true)).join("") : '<p class="muted">Nothing in the next 45 days.</p>'}</aside></div>`;
  }
  function eventForm(e, date) {
    const x = e || { title: "", event_date: date || sel, repeat: "none", remind_days: 1, note: "", shared: false };
    dlg.innerHTML = `<form method="dialog" class="gd"><h3>${e ? "Edit event" : "New event"}</h3><label>What<input id="ev-t" value="${esc(x.title)}" placeholder="e.g. Winter tires install" required></label>
      <div class="gd-row"><label>Date<input id="ev-d" type="date" value="${x.event_date}"></label><label>Repeats<select id="ev-r">${[["none", "Doesn't repeat"], ["monthly", "Monthly"], ["yearly", "Yearly"]].map(([v, l]) => `<option value="${v}" ${x.repeat === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <label>Remind me<select id="ev-m">${[[0, "No reminder"], [1, "1 day before"], [2, "2 days before"], [3, "3 days before"], [7, "1 week before"]].map(([v, l]) => `<option value="${v}" ${Number(x.remind_days) === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Note <span class="muted">(optional)</span><input id="ev-n" value="${esc(x.note)}"></label>${partner ? `<label class="gd-check"><input id="ev-s" type="checkbox" ${x.shared ? "checked" : ""}> Share with my partner</label>` : ""}
      <p id="ev-err" class="neg"></p><div class="gd-btns">${e ? '<button type="button" id="ev-del" class="btn btn-ghost" style="margin-right:auto">Delete</button>' : ""}<button value="x" class="btn btn-ghost">Cancel</button><button id="ev-save" class="btn btn-primary">Save</button></div></form>`; dlg.showModal();
    if (e) $("#ev-del").onclick = async () => { if (confirm("Delete this event" + (e.repeat !== "none" ? " (all repeats)" : "") + "?")) { await call("/api/calendar/events/" + e.id, "DELETE"); dlg.close(); load(); } };
    $("#ev-save").onclick = async (ev) => { ev.preventDefault(); const b = { title: $("#ev-t").value, event_date: $("#ev-d").value, repeat: $("#ev-r").value, remind_days: Number($("#ev-m").value), note: $("#ev-n").value, shared: $("#ev-s") ? $("#ev-s").checked : false };
      try { await (e ? call("/api/calendar/events/" + e.id, "PUT", b) : call("/api/calendar/events", "POST", b)); dlg.close(); load(); } catch (er) { $("#ev-err").textContent = er.message; } };
  }
  async function syncDialog(regen) {
    let u; try { u = await (regen ? call("/api/calendar/feed/regenerate", "POST") : api("/api/calendar/feed")); } catch (e) { alert(e.message); return; }
    dlg.innerHTML = `<form method="dialog" class="gd"><h3>📱 Add to your iPhone calendar</h3><p>Tap the button on your iPhone to subscribe — your card due dates, events and goal dates appear in the Calendar app.</p>
      <a class="btn btn-primary" href="${esc(u.webcal)}" style="text-align:center;text-decoration:none">Add to Apple Calendar</a><label>Or paste this link in Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar<input id="sy-u" value="${esc(u.https)}" readonly onclick="this.select()"></label>
      <button type="button" id="sy-copy" class="btn btn-ghost btn-sm">Copy link</button>
      <small class="muted">One-way: changes here show up on your phone (iPhone refreshes subscribed calendars every few hours), but events added on the phone don't come back. Reminders are included; iPhone may use its own default alert times for subscribed calendars. Anyone with this link can see your event titles and dates (never amounts), so don't share it — if it leaks, regenerate it.</small>
      <div class="gd-btns"><button type="button" id="sy-regen" class="btn btn-ghost" style="margin-right:auto">Regenerate link</button><button value="x" class="btn btn-primary">Done</button></div></form>`; dlg.showModal();
    $("#sy-copy").onclick = () => { navigator.clipboard.writeText(u.https); $("#sy-copy").textContent = "Copied ✓"; };
    $("#sy-regen").onclick = () => { if (confirm("This stops the old link working on any device already subscribed. Continue?")) { dlg.close(); syncDialog(true); } };
  }
  root.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.nav !== undefined) { const n = Number(b.dataset.nav); if (n === 0) { view = new Date(); view.setDate(1); sel = iso(new Date()); } else view.setMonth(view.getMonth() + n); load(); }
    else if (b.dataset.day) { sel = b.dataset.day; load(); } else if (b.id === "cal-add") eventForm(null, sel); else if (b.id === "cal-add-day") eventForm(null, sel);
    else if (b.id === "cal-sync") syncDialog(false); else if (b.dataset.edit) eventForm(items.find((i) => i.kind === "event" && String(i.id) === b.dataset.edit)); });
  window.addEventListener("cardschanged", load); document.querySelectorAll('[data-tab="overview"]').forEach((b) => b.addEventListener("click", () => setTimeout(load, 300))); load();
})();
