// Welcome splash: ~1.5s, once per browser session, tap/key to skip, disabled for reduced-motion. Runs early (in <head>) to avoid a flash of the app.
(() => {
  try {
    if (sessionStorage.getItem("welcomed") || localStorage.getItem("welcome_off") === "1" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    sessionStorage.setItem("welcomed", "1");
  } catch (e) { return; }
  const T = { dusk: ["#1a202b", "#e3e8f0", "134,184,232"], moss: ["#131b17", "#e2ece5", "140,207,159"], plum: ["#1b1723", "#e8e3f0", "182,156,240"], sand: ["#d9d3c5", "#2d2a24", "61,125,110"], midnight: ["#0b1020", "#e8ecf8", "124,156,255"] };
  const [bg, ink, glow] = T[localStorage.getItem("theme")] || T.dusk;
  const h = new Date().getHours(), greet = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening", esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  const st = document.createElement("style");
  st.textContent = `#welcome{position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:radial-gradient(50rem 32rem at 50% 38%,rgba(${glow},.2),transparent),${bg};color:${ink};font-family:Inter,system-ui,-apple-system,sans-serif;transition:opacity .45s ease,visibility .45s;cursor:pointer}
#welcome.out{opacity:0;visibility:hidden}.w-wrap{text-align:center;padding:1rem}
.w-mark{width:76px;height:76px;margin:0 auto 1.2rem;border-radius:22px;background:linear-gradient(135deg,rgb(${glow}),#86d1b5);box-shadow:0 18px 50px -12px rgba(${glow},.65);animation:wPop .7s cubic-bezier(.2,.9,.3,1.25) both}
.w-title{font-size:1.55rem;font-weight:700;letter-spacing:-.02em;animation:wUp .6s .25s both}.w-sub{margin-top:.4rem;opacity:.65;animation:wUp .6s .45s both}
.w-bar{width:120px;height:3px;border-radius:9px;background:rgba(127,127,127,.25);margin:1.4rem auto 0;overflow:hidden}.w-bar i{display:block;height:100%;background:linear-gradient(90deg,rgb(${glow}),#86d1b5);transform-origin:left;animation:wBar 1.2s .15s ease-out both}
@keyframes wPop{from{opacity:0;transform:scale(.6) rotate(-8deg)}}@keyframes wUp{from{opacity:0;transform:translateY(10px)}}@keyframes wBar{from{transform:scaleX(0)}}`;
  const box = document.createElement("div"); box.id = "welcome"; box.setAttribute("aria-hidden", "true");
  const name = localStorage.getItem("last_user") || "";
  box.innerHTML = `<div class="w-wrap"><div class="w-mark"></div><div class="w-title">${greet}<span id="w-name">${name ? ", " + esc(name) : ""}</span></div><div class="w-sub">Our Personal Finances</div><div class="w-bar"><i></i></div></div>`;
  document.documentElement.append(st, box);
  fetch("/api/auth/me").then((r) => r.json()).then((d) => { if (d && d.username) { localStorage.setItem("last_user", d.username); const n = document.getElementById("w-name"); if (n) n.textContent = ", " + d.username; } }).catch(() => {});
  let done = false;
  const close = () => { if (done) return; done = true; box.classList.add("out"); setTimeout(() => { box.remove(); st.remove(); }, 600); };
  box.addEventListener("pointerdown", close); addEventListener("keydown", close, { once: true }); setTimeout(close, 1600);
})();
