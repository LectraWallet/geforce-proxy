/* GeForce NOW proxy — Scramjet v2 (2.0.67-alpha.2) + libcurl over WISP.
   Flat static site: engine files live next to this page at the repo root.
   No BareMux / Bare fallback in v2 — WISP (Oracle VM) is the only transport. */

// WISP server (Oracle VM, baked in as the default). Override with
// ?wisp=wss://host/ or the settings bar below (saved to localStorage).
const DEFAULT_WISP_URL = "wss://gfn-wisp-qkxm.duckdns.org/";
const PARAMS = new URLSearchParams(location.search);
const SAVED_WISP = (localStorage.getItem("gfn_wisp") || "").trim();
const WISP_URL = PARAMS.get("wisp") || SAVED_WISP || DEFAULT_WISP_URL;

const DIR = new URL(".", location.href).pathname; // this page's directory, ends with "/"
const SW_URL = new URL("sw.js", new URL("./", location.href)).pathname;
// v2 proxied URLs: /~/sj/<controllerId>/<frameId>/<encoded real URL>
const PREFIX = "/~/sj/";
const HOME_URL = "https://play.geforcenow.com";

const $ = (id) => document.getElementById(id);
const urlInput = $("url");
const statusEl = $("status");
const backBtn = $("backBtn");
const fwdBtn = $("fwdBtn");
const reloadBtn = $("reloadBtn");

let controller = null;
let frame = null;
let iframe = null;
let ready = false;

function setStatus(t, err) {
  statusEl.textContent = t;
  statusEl.className = err ? "err" : "";
}

// Turn bar input into a URL: full URL stays, bare domain gets https://,
// anything else becomes a DuckDuckGo search.
function normalizeInput(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(v)) return "https://" + v;
  return "https://duckduckgo.com/?q=" + encodeURIComponent(v);
}

function decodeFrameUrl(rawHref) {
  try {
    const u = new URL(rawHref, location.origin);
    if (u.pathname.startsWith(PREFIX)) {
      const parts = u.pathname.slice(PREFIX.length).split("/");
      if (parts.length >= 3) {
        return decodeURIComponent(parts.slice(2).join("/")) + (u.hash || "");
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

// Account-linking / login pages (Epic, Steam, Xbox, ...) open in a REAL new
// tab instead of inside the frame: those OAuth pages render blank or break
// through the proxy, but work fine direct. GFN/NVIDIA hosts stay in-frame.
const IN_FRAME_HOSTS = [/^(.+\.)?geforcenow\.com$/, /^(.+\.)?nvidia\.com$/, /^(.+\.)?nvidiagrid\.net$/];
function isExternalUrl(real) {
  try {
    const host = new URL(real).hostname;
    return !IN_FRAME_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}
// Turn a link/open href from inside the frame into the real URL: decode a
// proxied /~/sj/... path, or keep an absolute URL as-is.
function realUrlFromHref(href) {
  const decoded = decodeFrameUrl(href || "");
  if (decoded) return decoded;
  return /^https?:\/\//i.test(href || "") ? href : "";
}
function attachLinkInterceptor() {
  if (!iframe) return;
  let doc = null;
  try { doc = iframe.contentDocument; } catch { return; }
  if (!doc || doc.__gfnLinkHook) return;
  doc.__gfnLinkHook = true;
  // Plain link clicks to outside hosts -> real new tab.
  doc.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    const real = realUrlFromHref(a.getAttribute("href"));
    if (real && isExternalUrl(real)) {
      e.preventDefault();
      e.stopPropagation();
      window.open(real, "_blank", "noopener");
    }
  }, true);
  // Popup opens (window.open) from inside the frame -> real new tab too.
  try {
    const cw = iframe.contentWindow;
    if (cw && !cw.__gfnOpenHook) {
      cw.__gfnOpenHook = true;
      const origOpen = cw.open.bind(cw);
      cw.open = (url, target, features) => {
        const real = realUrlFromHref(String(url || ""));
        if (real && isExternalUrl(real)) {
          window.open(real, "_blank", "noopener");
          return null;
        }
        if (!real) {
          // GFN opens a blank popup first, then sets its location. A fake
          // handle avoids a visible blank tab, but the popup must stay in
          // the proxy for NVIDIA/GeForce URLs so the login can post the
          // session back; a real tab (noopener) severs that and the login
          // loops back to the loginwall. So in-frame URLs open as a real
          // proxied popup, external ones open in a real tab.
          const openReal = (v) => {
            const r = realUrlFromHref(String(v || ""));
            if (!r) return;
            if (!isExternalUrl(r)) {
              try {
                const src = iframe.src || "";
                const m = src.match(/(\/~\/sj\/[^/]+\/[^/]+\/)/);
                if (m) {
                  origOpen(m[1] + encodeURIComponent(r), "_blank");
                  return;
                }
              } catch {
                /* fall through to a real tab */
              }
            }
            window.open(r, "_blank", "noopener");
          };
          const loc = {};
          Object.defineProperty(loc, "href", { set: openReal, get: () => "" });
          const handle = { closed: false, close() {}, focus() {} };
          Object.defineProperty(handle, "location", { set: openReal, get: () => loc });
          return handle;
        }
        return origOpen(url, target, features);
      };
    }
  } catch {
    /* cross-origin moment — the interval retries */
  }
}

function syncAddressBar() {
  if (!iframe) return;
  let raw = "";
  try {
    raw = iframe.contentWindow.location.href || "";
  } catch {
    raw = "";
  }
  if (!raw || raw.startsWith("about:")) raw = iframe.src || "";
  const real = decodeFrameUrl(raw);
  if (real && real !== urlInput.value && document.activeElement !== urlInput) {
    urlInput.value = real;
  }
  if (real) {
    try {
      history.replaceState(null, "", "#" + real);
    } catch {
      /* ignore */
    }
  }
}

// GFN sends logins to broken pages with an "undefined" id (product-matrix
// and consent both do it) and a reload then reports "login unsuccessful".
// Send any such dead link to the real GFN app instead. Only after the bad
// URL has sat still for 3s, so a login redirect that briefly passes through
// an "undefined" URL is not hijacked mid-login.
let lastBrokenRedirect = 0;
let brokenSeenAt = 0;
let brokenSeenUrl = "";
function fixBrokenRedirect() {
  if (!iframe || !frame) return;
  let raw = "";
  try {
    raw = iframe.contentWindow.location.href || "";
  } catch {
    raw = "";
  }
  if (!raw || raw.startsWith("about:")) raw = iframe.src || "";
  const real = decodeFrameUrl(raw);
  if (real && /\/undefined(\/|$|\?|#)/.test(real)) {
    if (real !== brokenSeenUrl) {
      brokenSeenUrl = real;
      brokenSeenAt = Date.now();
      return;
    }
    const now = Date.now();
    if (now - brokenSeenAt >= 3000 && now - lastBrokenRedirect > 5000) {
      lastBrokenRedirect = now;
      brokenSeenUrl = "";
      frame.go(HOME_URL);
    }
  } else {
    brokenSeenUrl = "";
  }
}

function go(raw) {
  const target = normalizeInput(raw);
  if (!target || !frame) return;
  setStatus("loading…");
  frame.go(target);
  urlInput.blur();
}

$("goBtn").onclick = () => go(urlInput.value);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") go(urlInput.value);
});
backBtn.onclick = () => frame && frame.back();
fwdBtn.onclick = () => frame && frame.forward();
reloadBtn.onclick = () => frame && frame.reload();
$("fsBtn").onclick = () => {
  if (!iframe) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else if (iframe.requestFullscreen) iframe.requestFullscreen();
  else if (iframe.webkitRequestFullscreen) iframe.webkitRequestFullscreen();
};

async function ensureServiceWorkerReady() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Workers require HTTPS or localhost.");
  }
  await navigator.serviceWorker.register(SW_URL, { scope: DIR });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      setTimeout(resolve, 1500);
    });
  }
}

async function init() {
  try {
    setStatus("registering worker…");
    await ensureServiceWorkerReady();
    const sw = navigator.serviceWorker.controller || (await navigator.serviceWorker.ready).active;
    if (!sw) throw new Error("No active service worker.");

    setStatus("connecting (wisp)…");
    const transport = new LibcurlTransport.LibcurlClient({ wisp: WISP_URL });
    const { Controller } = window.$scramjetController;
    controller = new Controller({
      serviceworker: sw,
      transport,
      config: {
        prefix: PREFIX,
        scramjetPath: DIR + "scramjet.js",
        wasmPath: DIR + "scramjet.wasm",
        injectPath: DIR + "controller.inject.js",
      },
    });
    await controller.wait();

    iframe = document.createElement("iframe");
    iframe.setAttribute(
      "allow",
      "fullscreen; autoplay; encrypted-media; camera; microphone; gamepad; pointer-lock"
    );
    $("frames").appendChild(iframe);
    frame = controller.createFrame(iframe);
    iframe.addEventListener("load", () => { syncAddressBar(); attachLinkInterceptor(); fixBrokenRedirect(); });
    setInterval(() => { syncAddressBar(); attachLinkInterceptor(); fixBrokenRedirect(); }, 500);

    backBtn.disabled = false;
    fwdBtn.disabled = false;
    reloadBtn.disabled = false;
    ready = true;

    const hashTarget = location.hash ? decodeURIComponent(location.hash.slice(1)) : "";
    const start = /^https?:\/\//i.test(hashTarget) ? hashTarget : HOME_URL;
    setStatus("ready (wisp)");
    frame.go(start);
  } catch (e) {
    console.error("[SJ] init failed:", e);
    setStatus("failed: " + (e && e.message ? e.message : e), true);
  }
}

// Settings bar (WISP URL saved to localStorage; reload applies it)
(function wireSettings() {
  const bar = $("settings");
  const wispInput = $("wispUrl");
  wispInput.value = localStorage.getItem("gfn_wisp") || DEFAULT_WISP_URL;
  $("setBtn").onclick = () => bar.classList.toggle("open");
  $("saveTransport").onclick = () => {
    localStorage.setItem("gfn_wisp", wispInput.value.trim());
    location.reload();
  };
})();

init();
