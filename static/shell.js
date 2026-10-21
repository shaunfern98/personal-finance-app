// Sidebar icons + profile/couple photos. Exposes window.PIC for other scripts. Loaded after app.js (uses api()).
(() => {
  const $ = (s) => document.querySelector(s);
  const IC = { overview: "🏠", expenses: "🧾", reports: "📊", dashboard: "📈", investing: "💼", savings: "🎯", budget: "⚙️" };
  document.querySelectorAll("#main-tabs .tab").forEach((t) => { t.dataset.ico = IC[t.dataset.tab] || "•"; });
  const S = { me: null, partner: null, couple: null };
  const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const PIC = (window.PIC = {
    state: S,
    html(which) {
      if (which === "couple") return S.couple ? `<img class="av" src="/api/photo/couple?v=${encodeURIComponent(S.couple)}" alt="">` : '<span class="av av-i">💑</span>';
      const p = S[which]; if (!p) return '<span class="av av-i">?</span>';
      return p.v ? `<img class="av" src="/api/photo/avatar?uid=${p.id}&v=${encodeURIComponent(p.v)}" alt="">`
        : `<span class="av av-i" style="background:hsl(${hue(p.name)} 40% 42%)">${(p.name || "?")[0].toUpperCase()}</span>`;
    },
    async refresh() { try { Object.assign(S, await api("/api/photos")); } catch (e) { /* offline */ } paint(); window.dispatchEvent(new Event("pics")); },
  });
  const bar = $(".user-bar"), me = document.createElement("button"), cp = document.createElement("button");
  me.id = "me-avatar"; me.type = "button"; me.className = "av-btn"; me.title = "Change your profile picture";
  cp.id = "couple-btn"; cp.type = "button"; cp.className = "btn btn-ghost btn-sm"; cp.title = "Set your couple photo"; cp.textContent = "💑 Couple photo";
  bar.prepend(cp); bar.prepend(me);
  const paint = () => { me.innerHTML = PIC.html("me"); cp.style.display = S.partner ? "" : "none"; };
  function shrink(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => { const n = 480, s = Math.min(img.width, img.height), c = document.createElement("canvas"); c.width = c.height = n;
        c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, n, n); res(c.toDataURL("image/jpeg", 0.86)); };
      img.onerror = () => rej(new Error("Could not read that image")); img.src = URL.createObjectURL(file);
    });
  }
  function pick(kind) {
    const f = document.createElement("input"); f.type = "file"; f.accept = "image/*";
    f.onchange = async () => { if (!f.files[0]) return; try { await api("/api/photo/" + kind, { method: "POST", body: JSON.stringify({ image: await shrink(f.files[0]) }) }); } catch (e) { alert(e.message); } PIC.refresh(); };
    f.click();
  }
  me.onclick = () => pick("avatar"); cp.onclick = () => pick("couple");
  PIC.ready = PIC.refresh();

  // ---- Mobile: phone-width screens automatically get the mobile layout; the 📱 toggle can still force it on a desktop window ----
  const mq = matchMedia("(max-width: 900px)");
  const sync = () => document.body.classList.toggle("mobile-view", mq.matches || localStorage.getItem("mobile-view") === "1");
  mq.addEventListener("change", sync); sync();
  // "More" menu in the bottom bar so Charts and Investing stay reachable on mobile
  const nav = $(".bottom-nav");
  if (nav) {
    const more = document.createElement("button"), sheet = document.createElement("div");
    more.type = "button"; more.className = "bottom-nav-btn"; more.innerHTML = "☰<span>More</span>"; nav.appendChild(more);
    sheet.className = "more-sheet"; document.body.appendChild(sheet);
    [["dashboard", "📈 Charts"], ["investing", "💼 Investing"]].forEach(([t, l]) => { const b = document.createElement("button"); b.type = "button"; b.textContent = l;
      b.onclick = () => { $(`.tab[data-tab="${t}"]`).click(); sheet.classList.remove("open"); }; sheet.appendChild(b); });
    more.onclick = (e) => { e.stopPropagation(); sheet.classList.toggle("open"); }; document.addEventListener("click", () => sheet.classList.remove("open"));
  }
})();
