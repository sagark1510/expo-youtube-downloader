// Regenerates src/potokenBundle.generated.ts from webview-src/potoken-entry.mjs.
// Run this whenever webview-src/potoken-entry.mjs changes, or when bumping
// youtubei.js/bgutils-js. See the package README for why this bundle
// exists: it runs BotGuard attestation + InnerTube MWEB extraction +
// signature decipher inside a real WebView (which has a real JS `eval`,
// unlike RN's Hermes engine) instead of on a server or in RN JS.

import * as esbuild from "esbuild";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, "..", "webview-src", "potoken-entry.mjs");
const outFile = path.join(dir, "..", "src", "potokenBundle.generated.ts");

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  logLevel: "info",
});

const code = result.outputFiles[0].text;

const banner = `// GENERATED FILE — do not hand-edit.
// Source: webview-src/potoken-entry.mjs
// Regenerate with: npm run build:potoken
//
// This bundle embeds the internals of youtubei.js and bgutils-js, which
// means it contains a couple of Google API keys (grep for "AIza"). These
// are YouTube's own public InnerTube web-client identifiers (WEB /
// WEB_EMBEDDED_PLAYER / WEB_CREATOR) and the BotGuard attestation client
// key — not secrets, not billing-scoped, not specific to this project.
// Every consumer of youtubei.js/bgutils-js ships the same values, and
// they're visible in youtube.com's own page JS. Safe to commit.
`;

const ts = `${banner}export const POTOKEN_BUNDLE_JS = ${JSON.stringify(code)};\n`;

await writeFile(outFile, ts);
console.log(`Wrote ${outFile} (${(ts.length / 1024).toFixed(0)} KB)`);
