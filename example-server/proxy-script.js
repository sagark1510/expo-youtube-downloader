// Minimal reference implementation of the proxy PoTokenProvider needs
// (its `proxyScriptUrl` prop) — relays YouTube's own BotGuard interpreter
// script (a static, unauthenticated JS asset served to every youtube.com
// visitor) so the on-device WebView can load it. It's needed purely
// because that script's host doesn't send CORS headers permitting
// cross-origin `fetch()` reads — browsers load it fine via a plain
// <script src>, but youtube.com's own Trusted Types policy blocks
// creating one of those from injected JS. No user or video data ever
// passes through this route, and no auth is required since the calling
// WebView has no app session — the hostname allowlist below is what
// keeps this from becoming an open proxy.
//
// Run standalone: `node example-server/proxy-script.js` (listens on
// PORT env var or 4000), or copy the route into your own Express app —
// it's completely self-contained.

import express from "express";

const ALLOWED_HOSTS = ["www.google.com", "www.gstatic.com", "www.youtube.com"];

export function proxyScriptRouter() {
  const router = express.Router();

  router.get("/proxy-script", async (req, res) => {
    const target = req.query.url;
    if (typeof target !== "string") {
      return res.status(400).json({ error: "Missing url query param" });
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return res.status(400).json({ error: "Invalid url" });
    }

    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.includes(parsed.hostname)) {
      return res.status(403).json({ error: "Host not allowed" });
    }

    try {
      const upstream = await fetch(parsed.toString());
      const text = await upstream.text();
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Content-Type", upstream.headers.get("content-type") || "text/javascript");
      res.status(upstream.status).send(text);
    } catch (err) {
      res.status(502).json({ error: "Upstream fetch failed", detail: String(err) });
    }
  });

  return router;
}

// Only start a standalone server when this file is run directly (`node
// example-server/proxy-script.js`) — importing proxyScriptRouter() into
// an existing app never triggers this.
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = express();
  app.use(proxyScriptRouter());
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`proxy-script relay listening on http://localhost:${port}/proxy-script`));
}
