# expo-youtube-downloader

On-device YouTube format fetching, throttle-resistant chunked downloading, and
native audio/video muxing for Expo / React Native apps. No server-side
`yt-dlp`, no video/audio ever proxied through your own backend — everything
except one tiny static-script relay (see below) runs on the phone.

Given a YouTube URL, this library gets you:

- **Metadata + a format list** (`getVideoInfo`) — title, thumbnail, duration,
  and every downloadable video/audio quality, resolved entirely on-device via
  [`youtubei.js`](https://github.com/LuanRT/YouTube.js)'s InnerTube client.
- **Fresh, working download URLs** (`PoTokenProvider` + `extractDownloadFormats`)
  — mints a YouTube PO Token and deciphers signed URLs inside a real,
  hidden WebView (BotGuard attestation needs a genuine JS engine; React
  Native's Hermes can't do this).
- **Throttle-resistant downloading** (`downloadFileChunked`) — YouTube's CDN
  throttles a single long-lived connection to real-time playback speed;
  chunked Range requests reset that throttle, the same trick `yt-dlp` uses.
  Works against any server that honors Range requests, not just YouTube.
- **Native muxing + a duration-fix** (`mergeAudioVideo`, `fixDuration`) — most
  YouTube formats above 1080p (and separately, all audio-only formats) come
  as split video-only + audio-only streams. This module muxes them into one
  playable file via `AVFoundation` (iOS) / `MediaExtractor`+`MediaMuxer`
  (Android) — no re-encoding — and works around a real AVFoundation bug where
  certain adaptive-stream files report **exactly 2x** their true duration.
- `downloadMedia` ties all of the above together into one call.

Use the whole pipeline, or just the pieces you need — e.g. `mergeAudioVideo`
and `fixDuration` work on any local video/audio files, nothing YouTube-specific
about them.

## Disclaimer

This is a technical demonstration of on-device media extraction, published in
the spirit of tools like `yt-dlp`. **You are responsible for how you use it.**
Downloading YouTube content may violate YouTube's Terms of Service depending
on what you download and what you do with it — respect content owners' rights,
don't redistribute copyrighted material without permission, and don't use this
against videos you don't have the right to download. The maintainers take no
responsibility for misuse.

This also relies on an unofficial, undocumented flow (BotGuard attestation +
PO Token minting) that YouTube can change or block at any time without
notice — expect it to occasionally need updates to keep working, same as
every other tool in this space.

## Install

```bash
npx expo install expo-youtube-downloader expo-file-system react-native-webview
```

This ships native code (the merge/duration-fix module) — it needs a
[development build](https://docs.expo.dev/develop/development-builds/introduction/),
**it will not work in Expo Go**.

## Why a proxy server is required

The WebView needs to fetch YouTube's own BotGuard interpreter script (a
static, unauthenticated JS file every real youtube.com visitor loads) — but
that host doesn't send CORS headers permitting a cross-origin `fetch()` read,
and youtube.com's own Trusted Types CSP blocks the obvious `<script src>`
workaround from injected JS. The fix is a one-route relay on a server you
control:

```
GET {proxyScriptUrl}?url=<url-encoded https:// URL> -> relays the response body verbatim, with CORS enabled
```

A complete, copy-pasteable reference implementation (~25 lines, Express) is
in [`example-server/proxy-script.js`](./example-server/proxy-script.js) —
including a hostname allowlist so it can't become an open proxy. It never
sees or touches any user or video data; it's a static-asset relay, nothing
else. Point `PoTokenProvider`'s `proxyScriptUrl` prop at wherever you deploy
it.

### It must be served over real HTTPS — this isn't optional

The `PoTokenProvider` WebView is genuinely navigated to `https://www.youtube.com`.
A real HTTPS page fetching a plain-HTTP resource is **Mixed Content**, and
WebKit blocks it unconditionally — this is a web-platform security boundary
enforced on the actual loaded page content, not an iOS app permission. **No
`Info.plist` ATS setting fixes this** — not `NSAllowsLocalNetworking`, not
`NSAllowsArbitraryLoadsInWebContent`, not even the blanket
`NSAllowsArbitraryLoads: true` — all of those govern the *app's own*
networking; they don't touch what a real webpage loaded inside a WKWebView
is allowed to fetch. The failure mode is a generic, unhelpful
`TypeError: Load failed` with no CORS-style message to point you at the
real cause — confirmed the hard way while building this.

- **Production**: deploy `proxy-script.js` behind whatever domain you're
  already serving HTTPS on (a few lines added to an existing Express app,
  or as a Vercel/Cloudflare Worker/etc. function) — nothing special needed,
  a real cert from a real domain just works.
- **Local development**: `localhost`/a LAN IP need a real (if self-signed)
  TLS cert — plain HTTP will not work even for local testing, and even a
  LAN IP is still "http://" from the page's perspective. See
  [`example/`](./example) for a complete working local HTTPS setup
  (`example-server/generate-certs.sh` + `https-dev-server.js`, trusted into
  the iOS Simulator's keychain).

## Usage

```tsx
// App root — mount exactly one PoTokenProvider. It's headless (renders
// nothing visible) and self-registers; no ref needed.
import { PoTokenProvider } from "expo-youtube-downloader";

export default function App() {
  return (
    <>
      <PoTokenProvider proxyScriptUrl="https://your-server.com/api/proxy-script" />
      {/* ...rest of your app */}
    </>
  );
}
```

```ts
// Anywhere else — the end-to-end flow
import { File, Paths } from "expo-file-system";
import { getVideoInfo, downloadMedia } from "expo-youtube-downloader";

const info = await getVideoInfo("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
// info.videoOptions / info.audioOptions — each a { formatId, label, ext, approxFileSize, ... }

const chosen = info.videoOptions[0]; // e.g. "Best available (1080p) MP4"
const destination = new File(Paths.document, `${info.id}.${chosen.ext}`);

const result = await downloadMedia(info.webpageUrl, chosen.formatId, destination);
// result.uri — ready to play, e.g. with expo-video
```

### Using the primitives directly

```ts
import {
  extractDownloadFormats,
  downloadFileChunked,
  mergeAudioVideo,
  fixDuration,
} from "expo-youtube-downloader";
import { File, Paths } from "expo-file-system";

// Resolve fresh URLs yourself instead of going through downloadMedia()
const formats = await extractDownloadFormats(videoId);
const best = formats.videoFormats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];

const dest = new File(Paths.cache, "video.mp4");
await downloadFileChunked(best.url, { "User-Agent": formats.userAgent }, dest);

// mergeAudioVideo/fixDuration work on ANY local files — nothing
// YouTube-specific about them
await mergeAudioVideo(videoFile.uri, audioFile.uri, outputFile.uri);
await fixDuration(inputFile.uri, outputFile.uri); // iOS only
```

## API

| Export | What it does |
|---|---|
| `getVideoInfo(url)` | Metadata + format list for a YouTube video, on-device. |
| `PoTokenProvider` | Headless component — mount once, required before resolving download URLs. |
| `extractDownloadFormats(videoId)` | Resolves fresh, ready-to-download URLs via the mounted `PoTokenProvider`. |
| `downloadFileChunked(url, headers, destination)` | Chunked Range-request download; defeats CDN throttling. Not YouTube-specific. |
| `mergeAudioVideo(videoPath, audioPath, outputPath)` | Native mux, no re-encode. iOS + Android. Not YouTube-specific. |
| `fixDuration(inputPath, outputPath)` | Corrects the AVFoundation duration-doubling bug. **iOS only.** |
| `downloadMedia(webpageUrl, formatId, destination)` | The whole pipeline in one call. |

Full types are in [`src/types.ts`](./src/types.ts).

## Platform notes

- **`fixDuration` is iOS-only.** The bug it works around — AVFoundation
  reporting exactly 2x a file's real duration for certain adaptive-stream
  MP4/M4A files (traced to an unusual per-track timescale) — doesn't exist in
  Android's `MediaExtractor`. Calling it on Android throws.
- **The PO Token WebView's User-Agent differs by platform on purpose.**
  Android's WebView is genuinely Chromium-based; claiming a Safari UA there
  is an impossible browser/engine combination that's trivially
  fingerprintable and empirically correlated with BotGuard rejecting tokens
  for protected videos. iOS's WebView is genuinely WebKit, so a Safari UA is
  consistent there. See `PoTokenProvider.tsx` if you need to touch this.
- **The WebView must render at a real, non-zero size.** It's positioned
  off-screen, not hidden via `display:none` or 0×0 — a zero-size WebView is
  itself an anomalous signal real browsers never produce.
- **`src/potokenBundle.generated.ts` contains a couple of `AIza...`-looking
  strings.** These are not leaked secrets — they're YouTube's own public
  InnerTube web-client keys (`WEB` / `WEB_EMBEDDED_PLAYER` / `WEB_CREATOR`)
  and the BotGuard attestation client key, hardcoded inside `youtubei.js`
  and `bgutils-js` themselves and pulled in by esbuild when the bundle is
  built. They identify which YouTube client is calling, not who — no
  OAuth, no billing account, no secret pairing. Every consumer of those two
  libraries (and most open-source YouTube tooling in general) ships the
  same values, and they're visible in youtube.com's own page JS. Safe to
  commit; flagged here so it doesn't look like an incident to a future
  contributor or a secret scanner.

## How it works (architecture)

1. `getVideoInfo()` — a direct on-device InnerTube call using the "IOS"
   client persona, cheap and currently unblocked, but only used here for
   metadata (title/thumbnail/heights/bitrates) — YouTube gates the actual
   *download* URLs this persona returns behind a PO Token now.
2. `PoTokenProvider` — a hidden WebView genuinely navigated to
   `https://www.youtube.com`, running `youtubei.js` + `bgutils-js` to perform
   real BotGuard attestation and mint a valid PO Token, then uses it (via the
   "MWEB" client persona) to fetch and decipher real, working download URLs.
   This needs a real browser JS engine (`eval`/`new Function`) that Hermes
   doesn't provide, which is why it runs in a WebView rather than in RN JS
   directly.
3. `downloadFileChunked()` — plain chunked HTTP downloading.
4. `mergeAudioVideo()` / `fixDuration()` — native, no-re-encode container
   muxing (`AVFoundation` / `MediaExtractor`+`MediaMuxer`) plus the duration
   fix.

The WebView bundle (`src/potokenBundle.generated.ts`) is built from
[`webview-src/potoken-entry.mjs`](./webview-src/potoken-entry.mjs) via
esbuild — regenerate it with `npm run build:potoken` after editing that file
or bumping `youtubei.js`/`bgutils-js`.

## License

MIT
