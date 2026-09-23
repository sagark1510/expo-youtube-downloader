// Local-testing-only HTTPS wrapper around proxy-script.js's router, using a
// self-signed cert (see certs/). A real HTTPS page (youtube.com, where the
// PoTokenProvider WebView lives) cannot fetch a plain-HTTP subresource at
// all — that's WebKit's Mixed Content policy, not something any Info.plist
// ATS setting can override — so local testing needs a real (if self-signed)
// TLS listener. Not meant to be how a real deployment serves this; a real
// deployment already has a real cert via its normal domain.
import express from "express";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proxyScriptRouter } from "./proxy-script.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(proxyScriptRouter());

const options = {
  key: fs.readFileSync(path.join(dir, "certs", "key.pem")),
  cert: fs.readFileSync(path.join(dir, "certs", "cert.pem")),
};

const port = process.env.PORT || 4443;
https.createServer(options, app).listen(port, () => {
  console.log(`HTTPS proxy-script relay listening on https://localhost:${port}/proxy-script`);
});
