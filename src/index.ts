// expo-youtube-downloader — on-device YouTube format fetching, a
// BotGuard/PO-Token WebView bridge, throttle-resistant chunked
// downloading, and native audio/video muxing + duration-fix.
// See README.md for setup (a PoTokenProvider + a tiny proxy server are
// both required) and usage examples.

import NativeModule from "./NativeModule";

export { getVideoInfo, extractVideoId, getCachedFormat } from "./extraction";
export { default as PoTokenProvider } from "./PoTokenProvider";
export type { PoTokenProviderProps } from "./PoTokenProvider";
export { extractDownloadFormats } from "./potoken";
export { downloadMedia, downloadFileChunked } from "./download";

/** Muxes a video-only file and an audio-only file into one .mp4 — no re-encoding, just container muxing. All three arguments are full "file://" URIs. iOS and Android. */
export const mergeAudioVideo: typeof NativeModule.mergeAudioVideo =
  NativeModule.mergeAudioVideo.bind(NativeModule);

/** Re-saves a single audio/video file with its declared duration corrected. **iOS only** — see NativeModule.ts for why; throws on Android. */
export const fixDuration: typeof NativeModule.fixDuration =
  NativeModule.fixDuration.bind(NativeModule);

export type {
  FormatOption,
  VideoInfo,
  ExtractedFormat,
  ExtractResult,
  DownloadResult,
} from "./types";
