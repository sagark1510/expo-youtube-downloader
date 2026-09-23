// On-device YouTube metadata + format-list extraction — no server round
// trip, a direct call to YouTube's InnerTube API run entirely on the
// phone via youtubei.js. Uses the InnerTube "IOS" client type (i.e.
// requests shaped like the official iOS app's — this is about which
// YouTube API persona is used, not which OS this code runs on), which
// returns fully resolved stream URLs (no PO token, no signature cipher)
// for ordinary public videos — verified in Node, iOS Simulator, on real
// iOS devices, and empirically on Android too (youtubei.js/react-native
// has nothing iOS-specific in it, just the same fetch/crypto globals RN
// provides on both platforms).
//
// IMPORTANT CAVEAT (as of 2026): YouTube has been tightening enforcement
// against exactly this kind of extraction — the IOS client's own
// googlevideo URLs now come back 403 at download time regardless of
// headers/IP (a GVS PO Token is required). This module therefore only
// uses the IOS client for cheap metadata (title/thumbnail/heights/
// bitrates/sizes for a format picker) — the itag/height/bitrate fields
// below are never actually blocked, only the *download* URLs those
// formats would otherwise carry are. The real, currently-working download
// URL for a chosen format is resolved separately and freshly via
// `extractDownloadFormats()` (see potoken.ts) at download time, not here.

import { Innertube, ClientType } from "youtubei.js/react-native";
import type { FormatOption, VideoInfo } from "./types";

/** "1.2 MB", "512 KB", "48 B" */
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

// Common resolution rungs to offer in a format picker. We don't have
// ffmpeg to transcode to an exact target height on-device: only a rung
// with a real matching itag is offered.
const RESOLUTION_LADDER = [2160, 1440, 1080, 720, 480, 360, 240, 144];

type CachedFormat = {
  itag: number;
  height?: number;
  bitrate?: number;
  contentLength?: number;
  mimeType?: string;
  hasVideo: boolean;
  hasAudio: boolean;
};

// videoId -> itag -> format, so a caller can look up a chosen format's
// height/bitrate (to match against extractDownloadFormats()'s own,
// separately-resolved format list) without a second network round trip.
// Session-lifetime only, cleared on process restart.
const formatCache = new Map<string, Map<number, CachedFormat>>();

/** @internal used by resolveDownloadFormat() — exported in case a caller wants to peek. */
export function getCachedFormat(videoId: string, itag: number): CachedFormat | undefined {
  return formatCache.get(videoId)?.get(itag);
}

/** Pulls the 11-character video id out of any watch/shorts/embed/youtu.be URL, or null if none is found (e.g. a playlist-only link). */
export function extractVideoId(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/,
  );
  return match ? match[1] : null;
}

let sharedClient: Promise<Innertube> | null = null;
function getClient(): Promise<Innertube> {
  if (!sharedClient) {
    sharedClient = Innertube.create({
      client_type: ClientType.IOS,
      generate_session_locally: true,
    });
  }
  return sharedClient;
}

// Prefers an mp4/H.264(+AAC) format over webm/AV1/VP9/Opus ones when both
// exist at the same rung — the native merge module's remux (no
// re-encode, just container muxing) needs a broadly device-compatible
// codec pair; mp4/avc1/aac is the safe combination.
function preferMp4<T extends { mimeType?: string }>(formats: T[]): T[] {
  const mp4Formats = formats.filter((f) => f.mimeType?.includes("mp4"));
  return mp4Formats.length ? mp4Formats : formats;
}

/**
 * Fetches a YouTube video's metadata and a ready-to-render list of
 * downloadable video/audio format options, entirely on-device. Each
 * `FormatOption.formatId` is an opaque string — hand it straight to
 * `resolveDownloadFormat()` (potoken.ts) or `downloadMedia()` (download.ts).
 */
export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error("Couldn't find a YouTube video ID in that URL.");
  }

  const yt = await getClient();
  const info = await yt.getBasicInfo(videoId);

  const status = info.playability_status?.status;
  if (status && status !== "OK") {
    throw new Error(
      info.playability_status?.reason ||
        `This video isn't available right now (${status}).`,
    );
  }

  const rawFormats = [
    ...(info.streaming_data?.formats ?? []),
    ...(info.streaming_data?.adaptive_formats ?? []),
  ];

  const mapped: CachedFormat[] = rawFormats
    .filter((f: any) => !!f.itag)
    .map((f: any) => ({
      itag: f.itag,
      height: f.height,
      bitrate: f.bitrate ?? f.average_bitrate,
      contentLength: f.content_length,
      mimeType: f.mime_type,
      hasVideo: !!f.has_video,
      hasAudio: !!f.has_audio,
    }));

  // YouTube's own response occasionally repeats the same itag verbatim —
  // dedupe by itag so the format list never shows the same option twice.
  const perItag = new Map<number, CachedFormat>();
  for (const f of mapped) perItag.set(f.itag, f);
  const extracted = Array.from(perItag.values());
  formatCache.set(videoId, perItag);

  const combined = extracted.filter((f) => f.hasVideo && f.hasAudio);
  const videoOnly = extracted.filter((f) => f.hasVideo && !f.hasAudio && f.height);
  const audioOnly = extracted.filter((f) => f.hasAudio && !f.hasVideo);

  // One shared "best" audio track, paired with every video-only rung —
  // same idea as yt-dlp's "+bestaudio" format selector.
  const bestAudio = preferMp4(audioOnly).sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];

  const videoOptions: FormatOption[] = [];

  // Real combined (single-file, already-muxed) formats first, if any
  // exist — no merge step needed for these at all.
  for (const f of combined.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))) {
    videoOptions.push({
      formatId: `c${f.itag}`,
      type: "video",
      label: `${f.height}p MP4`,
      height: f.height,
      ext: "mp4",
      approxFileSize: f.contentLength ? formatBytes(f.contentLength) : null,
    });
  }

  const availableHeights = new Set(videoOnly.map((f) => f.height!));
  const maxHeight = availableHeights.size ? Math.max(...availableHeights) : 0;

  for (const height of RESOLUTION_LADDER) {
    if (!availableHeights.has(height)) continue;
    const candidates = preferMp4(videoOnly.filter((f) => f.height === height));
    const best = candidates.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    if (!best || !bestAudio) continue;

    const sizeBytes =
      best.contentLength && bestAudio.contentLength
        ? best.contentLength + bestAudio.contentLength
        : null;

    videoOptions.push({
      formatId: `v${best.itag}:a${bestAudio.itag}`,
      type: "video",
      label: height === maxHeight ? `Best available (${height}p) MP4` : `${height}p MP4`,
      height,
      ext: "mp4",
      approxFileSize: sizeBytes ? formatBytes(sizeBytes) : null,
    });
  }

  // "Best available" first.
  videoOptions.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));

  const audioOptions: FormatOption[] = preferMp4(audioOnly)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
    .map((f) => ({
      formatId: `a${f.itag}`,
      type: "audio" as const,
      label: f.bitrate ? `AAC ~${Math.round(f.bitrate / 1000)} kbps` : "AAC audio",
      bitrateKbps: f.bitrate ? Math.round(f.bitrate / 1000) : undefined,
      ext: "m4a",
      approxFileSize: f.contentLength ? formatBytes(f.contentLength) : null,
    }));

  return {
    id: videoId,
    title: info.basic_info.title ?? "",
    thumbnail: info.basic_info.thumbnail?.[0]?.url ?? "",
    durationSeconds: info.basic_info.duration ?? 0,
    uploader: info.basic_info.author ?? "",
    webpageUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoOptions,
    audioOptions,
  };
}
