// Downloads (and, when the chosen format needs it, merges) a formatId
// returned by getVideoInfo() (extraction.ts) — resolves a fresh download
// URL via the PO token WebView (potoken.ts), fetches it in throttle-
// resistant chunks, and hands off to the native module for muxing/
// duration-fix when needed.
//
// formatId shapes, as produced by extraction.ts:
//   c<itag>        — already-combined single file, just download it
//   v<itag>:a<itag> — separate video-only + audio-only, needs a merge
//   a<itag>         — audio-only, just download it

import { Platform } from "react-native";
import { File, Paths } from "expo-file-system";
import { getCachedFormat, extractVideoId } from "./extraction";
import { extractDownloadFormats } from "./potoken";
import type { ExtractedFormat, ExtractResult, DownloadResult } from "./types";
import NativeModule from "./NativeModule";

type ParsedFormatId =
  | { kind: "combined"; itag: number }
  | { kind: "pair"; videoItag: number; audioItag: number }
  | { kind: "audio"; itag: number };

function parseFormatId(formatId: string): ParsedFormatId {
  const combined = formatId.match(/^c(\d+)$/);
  if (combined) return { kind: "combined", itag: Number(combined[1]) };

  const pair = formatId.match(/^v(\d+):a(\d+)$/);
  if (pair) return { kind: "pair", videoItag: Number(pair[1]), audioItag: Number(pair[2]) };

  const audio = formatId.match(/^a(\d+)$/);
  if (audio) return { kind: "audio", itag: Number(audio[1]) };

  throw new Error(`Unrecognized formatId "${formatId}" — expected one from getVideoInfo().`);
}

/** Nearest-height/bitrate match when the exact itag isn't in the WebView's (MWEB) format list — itags are near-universally stable across YouTube clients, so this should rarely trigger, but a real fallback beats a hard failure over a purely cosmetic itag mismatch. */
function closestFormat(
  candidates: ExtractedFormat[],
  target: { itag: number; height?: number; bitrate?: number },
  isVideo: boolean,
): ExtractedFormat | undefined {
  const exact = candidates.find((f) => f.itag === target.itag);
  if (exact) return exact;
  if (!candidates.length) return undefined;

  const key = isVideo ? "height" : "bitrate";
  const targetValue = target[key as "height" | "bitrate"] ?? 0;
  return candidates
    .slice()
    .sort(
      (a, b) =>
        Math.abs((a[key as "height" | "bitrate"] ?? 0) - targetValue) -
        Math.abs((b[key as "height" | "bitrate"] ?? 0) - targetValue),
    )[0];
}

/** Picks a download URL out of an already-fetched ExtractResult — kept separate from extractDownloadFormats() so a video+audio pair download never triggers two concurrent BotGuard mints for the same video (each one launches real network requests inside the WebView, and two at once has been observed to race and break the youtube.com page state). */
function pickDownloadUrl(
  result: ExtractResult,
  cached: { itag: number; height?: number; bitrate?: number; hasVideo: boolean },
): { url: string; headers: Record<string, string> } {
  const pool = cached.hasVideo ? result.videoFormats : result.audioFormats;
  const match = closestFormat(pool, cached, cached.hasVideo);
  if (!match) {
    throw new Error(
      `No ${cached.hasVideo ? "video" : "audio"} format available from the PO token extractor for this video.`,
    );
  }
  return { url: match.url, headers: { "User-Agent": result.userAgent } };
}

/** Best-effort cleanup — a leftover temp file is a nuisance, never worth failing the caller over. */
function safeDelete(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {
    // ignore
  }
}

// YouTube's CDN throttles a googlevideo stream to real-time playback speed
// within a single continuous connection, but a fresh Range request resets
// that throttle — this is how yt-dlp gets full-speed downloads (it chunks
// every YouTube stream the same way). Fetching in 10MB Range requests
// instead of one long streamed request gets the same full-speed result
// on-device.
const CHUNK_SIZE = 10 * 1024 * 1024;

/**
 * Downloads `url` into `destination` using 10MB Range requests instead of
 * one long streamed request — defeats CDN throttling that limits a single
 * continuous connection to real-time playback speed (the same trick
 * yt-dlp uses). Works against any server that honors Range requests, not
 * just YouTube's — a generically useful primitive on its own.
 */
export async function downloadFileChunked(
  url: string,
  headers: Record<string, string>,
  destination: File,
): Promise<File> {
  if (destination.exists) destination.delete();
  destination.create({ intermediates: true });

  let offset = 0;
  let total: number | undefined;

  do {
    const end = offset + CHUNK_SIZE - 1;
    const res = await fetch(url, {
      headers: { ...headers, Range: `bytes=${offset}-${end}` },
    });
    if (!res.ok) {
      throw new Error(`Chunked download failed: HTTP ${res.status}`);
    }
    const chunk = new Uint8Array(await res.arrayBuffer());
    destination.write(chunk, { append: true });
    offset += chunk.byteLength;

    if (total === undefined) {
      const match = res.headers.get("content-range")?.match(/\/(\d+)$/);
      // No content-range means the server ignored the Range request and
      // returned the whole file in one go — offset already equals total.
      total = match ? Number(match[1]) : offset;
    }
  } while (offset < total);

  return destination;
}

/**
 * Downloads a format returned by `getVideoInfo()` end to end: resolves a
 * fresh URL (or a video+audio pair) via the mounted `<PoTokenProvider/>`,
 * chunk-downloads it, and — when the format needs it — muxes the pair (or
 * corrects a duration-doubling bug present in certain single-file
 * downloads on iOS) via the native module. Requires a `<PoTokenProvider/>`
 * to already be mounted (see potoken.ts).
 *
 * `destination` is the full final `File` you want written — pick its
 * extension to match the chosen `FormatOption.ext` ("mp4" for video,
 * "m4a" for audio).
 */
export async function downloadMedia(
  webpageUrl: string,
  formatId: string,
  destination: File,
): Promise<DownloadResult> {
  const videoId = extractVideoId(webpageUrl);
  if (!videoId) {
    throw new Error("Couldn't find a YouTube video ID in that URL.");
  }

  const parsed = parseFormatId(formatId);
  const stamp = Date.now();

  if (parsed.kind === "combined" || parsed.kind === "audio") {
    const itag = parsed.itag;
    const cached = getCachedFormat(videoId, itag);
    if (!cached) {
      throw new Error(
        "This video's format info has expired — call getVideoInfo() again before downloading.",
      );
    }
    const type: "video" | "audio" = parsed.kind === "audio" ? "audio" : "video";

    const extracted = await extractDownloadFormats(videoId);
    const resolved = pickDownloadUrl(extracted, cached);

    // Certain adaptive-stream downloads report double their real duration
    // via AVFoundation on iOS regardless of whether they went through a
    // video+audio merge — an iOS-only quirk (Android's MediaExtractor
    // doesn't share it) — so only iOS needs this fix-up pass.
    if (Platform.OS === "ios") {
      const rawDownload = new File(Paths.cache, `${videoId}-raw-${stamp}.${destination.name?.split(".").pop() ?? "tmp"}`);
      try {
        await downloadFileChunked(resolved.url, resolved.headers, rawDownload);
        await NativeModule.fixDuration(rawDownload.uri, destination.uri);
      } finally {
        safeDelete(rawDownload);
      }
    } else {
      await downloadFileChunked(resolved.url, resolved.headers, destination);
    }

    return { uri: destination.uri, fileSize: destination.size ?? 0, type };
  }

  // Adaptive pair — download both, then mux natively.
  const cachedVideo = getCachedFormat(videoId, parsed.videoItag);
  const cachedAudio = getCachedFormat(videoId, parsed.audioItag);
  if (!cachedVideo || !cachedAudio) {
    throw new Error(
      "This video's format info has expired — call getVideoInfo() again before downloading.",
    );
  }

  const tempVideo = new File(Paths.cache, `${videoId}-v${parsed.videoItag}-${stamp}.mp4`);
  const tempAudio = new File(Paths.cache, `${videoId}-a${parsed.audioItag}-${stamp}.m4a`);

  try {
    const extracted = await extractDownloadFormats(videoId);
    const resolvedVideo = pickDownloadUrl(extracted, cachedVideo);
    const resolvedAudio = pickDownloadUrl(extracted, cachedAudio);

    const [videoResult, audioResult] = await Promise.allSettled([
      downloadFileChunked(resolvedVideo.url, resolvedVideo.headers, tempVideo),
      downloadFileChunked(resolvedAudio.url, resolvedAudio.headers, tempAudio),
    ]);
    if (videoResult.status === "rejected") throw videoResult.reason;
    if (audioResult.status === "rejected") throw audioResult.reason;

    await NativeModule.mergeAudioVideo(tempVideo.uri, tempAudio.uri, destination.uri);

    if (!destination.exists) {
      throw new Error("Merge finished but the output file is missing.");
    }

    return { uri: destination.uri, fileSize: destination.size ?? 0, type: "video" };
  } finally {
    safeDelete(tempVideo);
    safeDelete(tempAudio);
  }
}
