// A hidden-but-real WebView that mints YouTube PO Tokens and extracts
// deciphered download URLs — see README.md. Runs the bundle built from
// webview-src/potoken-entry.mjs (regenerate via `npm run build:potoken`
// after editing that file) inside a real browser engine navigated to
// https://www.youtube.com itself, because two things it needs — BotGuard
// attestation and signature decipher — both require a real JS
// `eval`/`new Function`, which RN's Hermes engine doesn't allow.
//
// Mount exactly one of these near the root of your app (it's an
// invisible, headless component — renders nothing visible) and call
// `extractDownloadFormats()` (see potoken.ts) from anywhere once it's
// mounted; no ref needed, this self-registers.
//
// IMPORTANT: this WebView must render at a real, non-zero size and must
// never use display:none. A 0x0 or display:none WebView is itself an
// anomalous signal (real browsers/tabs don't report zero viewport
// dimensions) that's plausibly part of what YouTube's bot detection
// checks for. Instead it's rendered at a real, phone-screen-plausible
// size and pushed off-screen via a large negative offset, fully opaque
// and interactive as far as the page itself can tell.
import React, { useCallback, useEffect, useRef } from "react";
import { Dimensions, Platform, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { POTOKEN_BUNDLE_JS } from "./potokenBundle.generated";
import { registerPoTokenProvider } from "./potoken";
import type { ExtractResult } from "./types";

export interface PoTokenProviderProps {
  /**
   * Base URL of a small server-side relay for YouTube's BotGuard
   * interpreter script — **required**. The WebView can't fetch it
   * directly (cross-origin, no CORS headers, and youtube.com's own
   * Trusted Types policy blocks a `<script src>` workaround). See
   * README.md ("Why a proxy server is required") and `example-server/`
   * for a ~25-line reference Express route you can copy as-is. Called as
   * `GET {proxyScriptUrl}?url=<encoded-https-url>` — must relay the
   * upstream response body verbatim with permissive CORS.
   */
  proxyScriptUrl: string;
}

type PendingRequest = {
  resolve: (r: ExtractResult) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const READY_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 45_000;

const { width, height } = Dimensions.get("window");

// A desktop UA keeps the WebView on www.youtube.com instead of getting
// redirected to m.youtube.com (see the WebView's userAgent prop comment
// below) — but it must claim a browser family that actually matches the
// WebView's real underlying engine. iOS's WebView is genuinely WebKit
// (same engine family as real Safari), so a Safari UA is consistent. The
// Android WebView is genuinely Chromium-based — claiming to be Safari
// there is an impossible browser/engine combination (Safari has never
// run on Chromium) that's trivially fingerprint-detectable, and
// empirically correlated with BotGuard rejecting PO tokens for
// monetized/protected videos on Android specifically (confirmed: the
// exact same video+itag got a 200 on iOS and a 403 on Android, with only
// this UA mismatch differing) — so Android gets a matching desktop
// Chrome UA instead.
const DESKTOP_USER_AGENT = Platform.select({
  ios: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  default:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

let requestCounter = 0;

export default function PoTokenProvider({ proxyScriptUrl }: PoTokenProviderProps) {
  const webviewRef = useRef<WebView>(null);
  // The WebView's injectedJavaScript runs exactly once, right after the
  // page loads — which can happen before extract() is ever called. So
  // "ready" must be recorded as durable state (isReadyRef), not just
  // resolved on a promise that might not exist yet when that one-time
  // message arrives.
  const isReadyRef = useRef(false);
  const readyPromiseRef = useRef<Promise<void> | null>(null);
  const readyResolveRef = useRef<(() => void) | null>(null);
  const pendingRequests = useRef(new Map<string, PendingRequest>());

  const getReadyPromise = useCallback(() => {
    if (isReadyRef.current) return Promise.resolve();
    if (!readyPromiseRef.current) {
      readyPromiseRef.current = new Promise<void>((resolve, reject) => {
        readyResolveRef.current = resolve;
        setTimeout(() => {
          if (!isReadyRef.current) {
            reject(new Error("PO token WebView never became ready (timed out loading youtube.com)"));
          }
        }, READY_TIMEOUT_MS);
      });
    }
    return readyPromiseRef.current;
  }, []);

  const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    let msg: any;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    if (msg.type === "ready") {
      isReadyRef.current = true;
      readyResolveRef.current?.();
      return;
    }

    if (msg.type === "log") {
      console.log("[expo-youtube-downloader:webview]", ...(msg.args ?? []));
      return;
    }

    if (msg.type === "result" && msg.requestId) {
      const pending = pendingRequests.current.get(msg.requestId);
      if (!pending) return;
      pendingRequests.current.delete(msg.requestId);
      clearTimeout(pending.timeout);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || "PO token extraction failed"));
      }
    }
  }, []);

  const extract = useCallback(
    async (videoId: string) => {
      await getReadyPromise();

      const requestId = `req_${Date.now()}_${requestCounter++}`;
      // Every failure mode here must end in a postMessage, or the RN side
      // hangs forever with nothing to log — including a failure to
      // JSON.stringify the result itself, which a bare `.then()` would
      // otherwise turn into a silent, uncaught promise rejection.
      const script = `
        (function () {
          function reportError(err) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: "result", requestId: ${JSON.stringify(requestId)}, ok: false, error: String((err && err.message) || err) }));
          }
          try {
            window.mintAndExtract(${JSON.stringify(videoId)})
              .then(function (result) {
                try {
                  window.ReactNativeWebView.postMessage(JSON.stringify({ type: "result", requestId: ${JSON.stringify(requestId)}, ok: true, result: result }));
                } catch (e2) {
                  reportError("stringify/post failed: " + (e2 && e2.message || e2));
                }
              })
              .catch(reportError);
          } catch (e) {
            reportError("synchronous throw: " + (e && e.message || e));
          }
          true;
        })();
      `;

      return new Promise<ExtractResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRequests.current.delete(requestId);
          reject(new Error("PO token extraction timed out"));
        }, EXTRACT_TIMEOUT_MS);

        pendingRequests.current.set(requestId, { resolve, reject, timeout });
        webviewRef.current?.injectJavaScript(script);
      });
    },
    [getReadyPromise],
  );

  // Self-registers with the module-scope bridge so plain async functions
  // elsewhere (extractDownloadFormats() in potoken.ts) can call into this
  // WebView without the caller managing a ref — mirrors how e.g. a toast
  // provider registers itself. Unregisters on unmount.
  useEffect(() => {
    registerPoTokenProvider({ extract });
    return () => registerPoTokenProvider(null);
  }, [extract]);

  // The proxy URL assignment is injected as its own leading statement
  // ahead of the bundle, rather than baked into the bundle at build time
  // — this is what makes the same prebuilt POTOKEN_BUNDLE_JS work for
  // every consumer's own server, configured purely via this prop.
  const injected = `window.__EYD_PROXY_SCRIPT_URL__ = ${JSON.stringify(proxyScriptUrl)};\n${POTOKEN_BUNDLE_JS}`;

  return (
    <View style={styles.offscreenContainer} pointerEvents="none">
      <WebView
        ref={webviewRef}
        source={{ uri: "https://www.youtube.com" }}
        // With the WebView's default mobile-Safari user agent, YouTube
        // silently redirects www.youtube.com -> m.youtube.com. That broke
        // youtubei.js's internal player/iframe_api fetches, which are
        // hardcoded to https://www.youtube.com regardless of the page's
        // actual origin — a same-origin fetch on our real page became a
        // cross-origin one against a different host, and got blocked. A
        // desktop UA keeps us on www.youtube.com, matching that hardcoded
        // base (the InnerTube client we request — MWEB — is independent
        // of this; it's just what persona the API calls claim to be).
        userAgent={DESKTOP_USER_AGENT}
        style={styles.webview}
        injectedJavaScript={injected}
        onMessage={handleMessage}
        onError={(e: any) => console.log("[expo-youtube-downloader] webview error", e.nativeEvent)}
        javaScriptEnabled
        domStorageEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Positioned off the visible canvas rather than display:none/0x0 — see
  // the file header comment on why size/visibility matter here.
  offscreenContainer: {
    position: "absolute",
    top: 0,
    left: -width * 3,
    width,
    height,
    opacity: 1,
  },
  webview: {
    width,
    height,
  },
});
