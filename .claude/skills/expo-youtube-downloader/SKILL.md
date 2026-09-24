---
name: expo-youtube-downloader
description: Use when integrating or debugging expo-youtube-downloader in an Expo/React Native app — fetching YouTube video/audio formats, downloading them on-device, muxing split video+audio streams, or troubleshooting PoTokenProvider/proxy relay/Mixed-Content errors. Covers install, required native dev build, the proxy relay it depends on, the API surface, and every platform gotcha discovered while building it.
---

# expo-youtube-downloader

On-device YouTube format extraction + throttle-resistant chunked download +
native audio/video muxing for Expo/React Native. No server ever touches
video/audio bytes — only a tiny static-script relay is server-side (see
below), everything else runs on the phone.

Repo: https://github.com/sagark1510/expo-youtube-downloader — read its
README for full detail; this skill is the condensed, task-oriented version.
If anything here conflicts with the README, the README (in the installed
package, under `node_modules/expo-youtube-downloader/README.md`) wins — it
may have moved on since this skill was written.

## Before writing any code, get these facts straight

1. **This ships native code.** It needs an Expo **development build**
   (`npx expo run:ios` / `run:android`, or an EAS dev-client build). It
   **will not work in Expo Go** — `requireNativeModule` will throw at
   runtime if you try. If the target project only has Expo Go, say so and
   ask before proceeding.
2. **A server-side proxy relay is mandatory, not optional.** Not for
   video/audio (that never leaves the device) — the in-app WebView needs
   to fetch YouTube's own BotGuard interpreter script, which doesn't send
   permissive CORS headers. See "The proxy relay" below before assuming
   this library is 100% serverless — it's *almost* fully on-device, with
   one small carve-out.
3. **That relay must be served over real HTTPS, even for local dev.**
   `PoTokenProvider`'s WebView is genuinely on `https://www.youtube.com`;
   fetching a plain-HTTP relay from there is Mixed Content, which WebKit
   blocks unconditionally. No `Info.plist` ATS setting works around this
   (not `NSAllowsLocalNetworking`, not `NSAllowsArbitraryLoadsInWebContent`,
   not the blanket `NSAllowsArbitraryLoads: true` — all tried, all
   ineffective, confirmed empirically). If you hit a bare
   `TypeError: Load failed` inside the WebView with no CORS-style message,
   this is almost certainly it — check the proxy is HTTPS before anything
   else.

## Install

```bash
npx expo install expo-youtube-downloader expo-file-system react-native-webview
```

Then a native rebuild: `npx expo run:ios` / `npx expo run:android` (or an
EAS dev-client build if you don't build locally).

## Set up the proxy relay

You need one route on a server you control:

```
GET {proxyScriptUrl}?url=<url-encoded https:// URL> -> relays the response body verbatim, with CORS enabled
```

A copy-pasteable ~25-line Express reference is at
`example-server/proxy-script.js` in the library repo (also on GitHub) —
includes a hostname allowlist (`www.google.com`, `www.gstatic.com`,
`www.youtube.com`) so it can't become an open proxy. It never sees user or
video data.

- **Production**: bolt this route onto whatever HTTPS domain you already
  serve from (existing Express app, or a Vercel/Cloudflare Worker function)
  — a real cert just works, nothing else needed.
- **Local dev**: plain `http://localhost` will NOT work (see Mixed Content
  above) — you need a real, even if self-signed, TLS cert. The repo's
  `example/` app has a working recipe: `example-server/generate-certs.sh`
  (self-signed cert for your current LAN IP) + `https-dev-server.js`, then
  trust it into the simulator with
  `xcrun simctl keychain <udid> add-root-cert <cert.pem>`.

## Mount PoTokenProvider once, at the app root

```tsx
import { PoTokenProvider } from "expo-youtube-downloader";

export default function App() {
  return (
    <>
      <PoTokenProvider proxyScriptUrl="https://your-server.com/api/proxy-script" />
      {/* rest of the app */}
    </>
  );
}
```

It's headless (renders nothing visible), self-registers on mount — no ref
needed. Mount exactly one, and mount it before calling
`extractDownloadFormats`/`downloadMedia` anywhere else (it needs to be in
the tree first). Do not render it inside `display:none` or a 0×0 container
— it must have a real, non-zero size, or BotGuard treats the anomalous
WebView geometry as a bot signal and rejects the token.

## The full pipeline in one call

```ts
import { File, Paths } from "expo-file-system";
import { getVideoInfo, downloadMedia } from "expo-youtube-downloader";

const info = await getVideoInfo("https://www.youtube.com/watch?v=VIDEO_ID");
// info.videoOptions / info.audioOptions: [{ formatId, label, ext, approxFileSize, ... }]

const chosen = info.videoOptions[0];
const destination = new File(Paths.document, `${info.id}.${chosen.ext}`);

const result = await downloadMedia(info.webpageUrl, chosen.formatId, destination);
// result.uri — ready to play (e.g. with expo-video)
```

## Or use the primitives directly

```ts
import {
  extractDownloadFormats,
  downloadFileChunked,
  mergeAudioVideo,
  fixDuration,
} from "expo-youtube-downloader";

const formats = await extractDownloadFormats(videoId);
const best = formats.videoFormats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
await downloadFileChunked(best.url, { "User-Agent": formats.userAgent }, dest);

// mergeAudioVideo/fixDuration work on ANY local video/audio files —
// nothing YouTube-specific about them, safe to reuse elsewhere.
await mergeAudioVideo(videoFile.uri, audioFile.uri, outputFile.uri);
await fixDuration(inputFile.uri, outputFile.uri); // iOS only, see below
```

## Full API

| Export | What it does |
|---|---|
| `getVideoInfo(url)` | Metadata + format list, on-device. |
| `PoTokenProvider` | Headless component, mount once at the root. |
| `extractDownloadFormats(videoId)` | Fresh, ready-to-download URLs via the mounted provider. |
| `downloadFileChunked(url, headers, destination)` | Chunked Range-request download; defeats CDN throttling. Not YouTube-specific. |
| `mergeAudioVideo(videoPath, audioPath, outputPath)` | Native mux, no re-encode, iOS + Android. Not YouTube-specific. |
| `fixDuration(inputPath, outputPath)` | Fixes an AVFoundation duration-doubling bug. **iOS only.** |
| `downloadMedia(webpageUrl, formatId, destination)` | The whole pipeline in one call. |

## Platform gotchas (each one cost real debugging time — don't relearn them)

- **`fixDuration` is iOS-only and throws on Android.** Works around a real
  AVFoundation bug: certain adaptive-stream MP4/M4A files report *exactly
  2x* their true duration (unusual per-track timescale). Android's
  `MediaExtractor` doesn't have this bug, so there's nothing to fix there
  — most video/audio players above 1080p or any audio-only download need
  `mergeAudioVideo` first (split streams), then `fixDuration` on iOS only.
- **Do not "fix" the WebView's User-Agent to be consistent across
  platforms.** It's intentionally different: Android's WebView is genuinely
  Chromium, so it sends a Chromium UA; iOS's is genuinely WebKit, so it
  sends a Safari UA. Forcing a Safari UA on Android WebView is an
  impossible browser/engine combination that's trivially fingerprintable
  and correlates with BotGuard rejecting tokens for protected videos.
- **`src/potokenBundle.generated.ts` (inside the installed package)
  contains `AIza...`-looking strings.** These are not a leaked secret from
  this library — they're YouTube's own public InnerTube web-client keys,
  hardcoded inside the `youtubei.js`/`bgutils-js` packages themselves and
  pulled in by esbuild when the bundle was built. No OAuth, no billing
  account behind them, every consumer of those libraries ships the same
  values. If a secret scanner flags them in a downstream project, this is
  a known non-issue — don't attempt to "fix" or redact them.
- **This relies on an unofficial, undocumented YouTube flow (BotGuard +
  PO Token).** It can break without notice if YouTube changes it. If
  extraction/download starts failing after previously working, suspect an
  upstream break before assuming an integration bug — check the library's
  GitHub issues / for a newer version first.

## Debugging checklist, in order of likelihood

1. `downloadMedia`/`extractDownloadFormats` throws a generic `Load failed`
   or times out → proxy relay is plain HTTP, not HTTPS (see Mixed Content
   above). Fix the relay's transport, not `Info.plist`.
2. Native module errors (`Cannot find native module 'ExpoYoutubeDownloader'`
   or similar) → app was run without a dev-client rebuild after install, or
   is running in Expo Go. Rebuild with `npx expo run:ios`/`run:android`.
2b. Metro throws `Failed to collapse: .../node_modules/invariant/invariant.js`
   or similar dedup errors → almost always caused by a symlinked local
   install (`file:../some-relative-path` to an uninstalled sibling package)
   combined with npm/yarn workspaces creating two resolution paths for the
   same file. Prefer installing via the registry, or a packed tarball
   (`npm pack`) over a raw symlinked `file:` dependency if this comes up.
3. `PoTokenProvider` never resolves / BotGuard-related rejection → check
   it's mounted with real, non-zero layout size, and that the per-platform
   User-Agent hasn't been overridden to something inconsistent with the
   WebView's real engine.
4. Correct-looking file, but duration reads 2x actual in a player → missing
   `fixDuration` call after `mergeAudioVideo`/`downloadMedia` on iOS.
