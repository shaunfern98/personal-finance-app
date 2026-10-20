// Sidebar icons + profile/couple photos. Exposes window.PIC for other scripts. Loaded after app.js (uses api()).
(() => {
  const $ = (s) => document.querySelector(s);
  const IC = { overview: "🏠", expenses: "🧾", reports: "📊", dashboard: "📈", investing: "💼", savings: "🏡", budget: "⚙️" };
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
})();
