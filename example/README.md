# expo-youtube-downloader example

A minimal single-screen app exercising every API the library exports:
`getVideoInfo`, `PoTokenProvider`, `extractDownloadFormats`,
`downloadFileChunked`, `downloadMedia`, `mergeAudioVideo`, `fixDuration`.

Paste a YouTube URL, tap **getVideoInfo()**, then tap any format to download
it via `downloadMedia()` — or tap **Run primitives** to see the lower-level
functions called directly instead.

## Setup

This needs a [development build](https://docs.expo.dev/develop/development-builds/introduction/)
— it will not run in Expo Go (native code). It also needs the proxy relay
(see the root README's ["Why a proxy server is required"](../README.md#why-a-proxy-server-is-required))
running and reachable over **real HTTPS** — plain HTTP will not work, even
for local testing (see that section for why).

### 1. Start the local HTTPS proxy relay

```bash
cd example-server
npm install
./generate-certs.sh        # generates certs/ for your current LAN IP
npm run start:https        # serves proxy-script.js over HTTPS on :4443
```

### 2. Trust the cert on your test target

**iOS Simulator:**

```bash
xcrun simctl keychain <device-udid> add-root-cert ../example-server/certs/cert.pem
```

(`xcrun simctl list devices` to find `<device-udid>`.)

**Physical device:** AirDrop or email yourself `certs/cert.pem`, install the
profile, then enable full trust for it under Settings → General → About →
Certificate Trust Settings.

### 3. Point the app at your proxy

Edit `PROXY_SCRIPT_URL` in `App.tsx` to your Mac's LAN IP (`ipconfig getifaddr en0`):

```ts
const PROXY_SCRIPT_URL = "https://<your-lan-ip>:4443/proxy-script";
```

### 4. Install and run

```bash
npm install
npx expo run:ios      # or: npx expo run:android
```

## Not for production

`example-server/certs/` (gitignored) is a throwaway self-signed cert for
local testing only. A real deployment just needs the proxy relay behind
whatever real HTTPS domain you're already serving from — no self-signed
cert dance required there.
