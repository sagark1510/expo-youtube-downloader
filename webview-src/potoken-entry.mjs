// Runs INSIDE a hidden WebView navigated to https://www.youtube.com (see
// ../src/PoTokenProvider.tsx) — same origin as the page (no CORS issues
// fetching youtube.com's own config/challenge scripts or hitting the
// InnerTube player endpoint), and a real browser JS engine (unlike RN's
// Hermes, this supports eval/new Function, which both BotGuard attestation
// and youtubei.js's signature decipher require). See the package README
// for the full investigation behind this approach.
//
// Exposes window.mintAndExtract(videoId) -> Promise<ExtractResult>, called
// by PoTokenProvider.tsx via injectJavaScript and relayed back over
// postMessage.

import { Innertube, Platform, UniversalCache } from "youtubei.js/web.bundle";
import { BotGuardClient } from "bgutils-js/botguard";
import { buildURL, parseLooseJSON, getHeaders } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";

function log(...args) {
  try {
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "log", args: args.map(String) }));
  } catch {}
  console.log("[expo-youtube-downloader]", ...args);
}

// youtube.com's own CSP enforces `require-trusted-types-for 'script'`,
// which blocks both a raw `new Function(str)()` and `<script src>`
// assignment from injected JS (confirmed empirically — both throw
// "Refused ... requires a 'Trusted Type' assignment"). The CSP's
// `trusted-types` directive doesn't restrict which policy names may be
// created, so we register our own rather than relying on one of
// YouTube's internal ones (whose names/behavior could change any time).
let trustedPolicy;
function getTrustedPolicy() {
  if (trustedPolicy !== undefined) return trustedPolicy;
  try {
    trustedPolicy = window.trustedTypes?.createPolicy
      ? window.trustedTypes.createPolicy("expo-youtube-downloader", {
          createScript: (s) => s,
          createScriptURL: (s) => s,
          createHTML: (s) => s,
        })
      : null;
  } catch (e) {
    trustedPolicy = null;
    log("trustedTypes.createPolicy threw:", e?.message);
  }
  return trustedPolicy;
}

function safeEval(code) {
  const policy = getTrustedPolicy();
  if (policy) {
    // `new Function(code)()` implicitly wraps `code` as a function body,
    // which is why a bare top-level `return` in it works — youtubei.js's
    // decipher output relies on exactly that. Plain eval() doesn't do
    // that wrapping (it runs as program code, where a bare `return`
    // outside a function is a SyntaxError), so replicate it by hand.
    return (0, eval)(policy.createScript(`(function(){${code}})()`));
  }
  return new Function(code)();
}

Platform.shim.eval = async (data) => safeEval(data.output);

// youtubei.js's web bundle sets shim.fetch to the unbound `globalThis.fetch`
// (node_modules/youtubei.js/dist/src/platform/web.js). WebKit's fetch has
// a strict receiver check — calling it as a plain method on some other
// object (as youtubei.js's internal call sites do) throws "Can only call
// Window.fetch on instances of Window". Chromium is lenient about this;
// WebKit (this WebView) is not. Rebinding fixes it without touching the
// library itself.
Platform.shim.fetch = window.fetch.bind(window);

async function mintPoTokenMinter() {
  // Already on https://www.youtube.com (same origin), so this reads our
  // own already-loaded page instead of a cross-origin fetch.
  const pageHtml = document.documentElement.outerHTML;
  const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  if (!ytConfig) throw new Error("Could not find ytcfg in page HTML");

  // BotGuardClient.create() expects window.yt.config_ to exist.
  window.yt = window.yt || {};
  window.yt.config_ = JSON.parse(ytConfig);

  const initialAttestationData = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
  if (!initialAttestationData) throw new Error("Could not find botguard challenge in page HTML");

  const challengeResponse = parseLooseJSON(initialAttestationData[1]).R;
  if (!challengeResponse?.bgChallenge) throw new Error("Could not get bgChallenge");

  const interpreterUrl =
    challengeResponse.bgChallenge.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  // A direct fetch() to this host (google.com, cross-origin from
  // youtube.com) gets CORS-blocked reading the response in a real
  // browser — the official BgUtils example only avoids this because it
  // runs in jsdom/Node, where fetch has no CORS enforcement at all. A
  // <script src> load would sidestep CORS but youtube.com's Trusted
  // Types policy blocks creating one from injected JS. So: relay it
  // through a small proxy server instead — see example-server/ in this
  // repo for a minimal reference implementation, and README.md for why
  // it's required and what it must (and must not) do.
  //
  // The proxy's base URL is set at runtime by PoTokenProvider (its
  // required `proxyScriptUrl` prop), via `window.__EYD_PROXY_SCRIPT_URL__`
  // — injected as a separate script that runs before this bundle, so the
  // bundle itself never bakes in any particular server.
  const proxyScriptUrl = window.__EYD_PROXY_SCRIPT_URL__;
  if (!proxyScriptUrl) {
    throw new Error(
      "expo-youtube-downloader: PoTokenProvider's proxyScriptUrl prop is required (see README.md).",
    );
  }
  const proxiedInterpreterUrl = `${proxyScriptUrl}?url=${encodeURIComponent(`https:${interpreterUrl}`)}`;
  const interpreterJavascript = await (await fetch(proxiedInterpreterUrl)).text();
  if (!interpreterJavascript) throw new Error("Could not load botguard VM");
  safeEval(interpreterJavascript);

  const botGuardClient = await BotGuardClient.create({
    program: challengeResponse.bgChallenge.program,
    globalName: challengeResponse.bgChallenge.globalName,
    globalObject: globalThis,
  });

  const requestKey = "O43z0dpjhgX20SCx4KAo";
  const webPoSignalOutput = [];
  const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

  const integrityTokenResponse = await fetch(buildURL("GenerateIT", true), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify([requestKey, botguardResponse]),
  });
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
    await integrityTokenResponse.json();

  return WebPoMinter.create(
    { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
    webPoSignalOutput,
  );
}

let sharedMinterPromise = null;
function getMinter() {
  if (!sharedMinterPromise) sharedMinterPromise = mintPoTokenMinter();
  return sharedMinterPromise;
}

function preferMp4(formats) {
  const mp4 = formats.filter((f) => f.mime_type?.includes("avc1") || f.mime_type?.includes("mp4a"));
  return mp4.length ? mp4 : formats;
}

// The one thing RN calls. Returns plain, ready-to-download URLs (User-Agent
// already baked in as a header the caller must replay) — no further eval,
// deciphering, or token logic needed on the RN side.
window.mintAndExtract = async function mintAndExtract(videoId) {
  const minter = await getMinter();
  const contentPoToken = await minter.mintAsWebsafeString(videoId);

  // Note: youtubei.js hardcodes its InnerTube/player-fetch base URL to
  // https://www.youtube.com regardless of the page's actual origin — the
  // WebView must actually be ON that host (see PoTokenProvider.tsx's
  // desktop User-Agent, which stops YouTube's mobile-UA redirect to
  // m.youtube.com) or these internal same-origin-looking fetches become
  // cross-origin and get blocked.
  const yt = await Innertube.create({
    client_type: "MWEB",
    generate_session_locally: true,
    cache: new UniversalCache(false),
  });
  const info = await yt.getBasicInfo(videoId);
  const status = info.playability_status?.status;
  if (status && status !== "OK") {
    throw new Error(info.playability_status?.reason || `Not playable (${status})`);
  }

  const userAgent = yt.session.context.client.userAgent;
  const adaptive = info.streaming_data?.adaptive_formats ?? [];

  const videoOnly = preferMp4(adaptive.filter((f) => f.has_video && !f.has_audio));
  const audioOnly = preferMp4(adaptive.filter((f) => f.has_audio && !f.has_video));

  const results = { title: info.basic_info.title, userAgent, videoFormats: [], audioFormats: [] };

  for (const f of videoOnly) {
    try {
      const url = `${await f.decipher(yt.session.player)}&pot=${contentPoToken}`;
      results.videoFormats.push({
        itag: f.itag,
        height: f.height,
        bitrate: f.bitrate,
        mimeType: f.mime_type,
        contentLength: f.content_length ? Number(f.content_length) : null,
        url,
      });
    } catch (e) {
      log("decipher failed for video itag", f.itag, e?.message);
    }
  }

  for (const f of audioOnly) {
    try {
      const url = `${await f.decipher(yt.session.player)}&pot=${contentPoToken}`;
      results.audioFormats.push({
        itag: f.itag,
        bitrate: f.bitrate,
        mimeType: f.mime_type,
        contentLength: f.content_length ? Number(f.content_length) : null,
        url,
      });
    } catch (e) {
      log("decipher failed for audio itag", f.itag, e?.message);
    }
  }

  log(`extracted ${results.videoFormats.length} video, ${results.audioFormats.length} audio formats for`, videoId);
  return results;
};

try {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "ready" }));
} catch {}
