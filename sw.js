// GeForce NOW proxy service worker — Scramjet v2 (2.0.67-alpha.2).
// Thin wrapper: the real routing lives in controller.sw.js.

importScripts("./controller.sw.js");

addEventListener("fetch", (e) => {
  if ($scramjetController.shouldRoute(e)) {
    e.respondWith($scramjetController.route(e));
  }
});
