# GeForce Now proxy

Scramjet 1.1 + BareMux web proxy that opens GeForce Now
(`https://play.geforcenow.com`) inside a proxied frame.

## Transports

- **Bare (default):** uses the shared Bare backend at
  `barelink-landons-projects-e458b478.vercel.app/bare/`. Works with no setup.
  Override with `?bare=https://host/bare/`.
- **WISP:** point it at your own WISP server (Oracle Cloud free tier — see
  `wisp-server/` in the companion package) via the gear button, or
  `?wisp=wss://your-server/`. Uses the vendored libcurl transport
  (`libcurl-transport.mjs` + `libcurl.wasm`).

## Files

Flat layout on purpose — every file lives at the repo root so the whole
frontend uploads in one shot.

- `index.html` / `app.js` — UI + controller wiring
- `sw.js` — Scramjet service worker
- `scramjet.all.js` / `scramjet.sync.js` / `scramjet.wasm.wasm` — Scramjet 1.1
- `baremux.js` / `baremux-worker.js` / `baremux-worker-entry.js` — BareMux 2.1.9
- `bare-client.mjs` / `bare-transport.mjs` — Bare transport (v3 client)
- `libcurl-transport.mjs` / `libcurl.wasm` — libcurl transport 1.5.2 (WISP)

## Notes

- The game stream itself is WebRTC, direct from the browser — the proxy only
  loads the site. If the network blocks UDP/STUN, the stream can still fail.
- GeForce Now sees the backend server's IP (Vercel / Oracle datacenter). It may
  flag datacenter IPs.
- NVIDIA login happens inside the proxied frame; test it on the real device.
