// Module-scope handle to the single <PoTokenProvider/> mounted somewhere
// in the consuming app — lets plain functions (download.ts) call into the
// WebView-based extractor without threading a React ref through every
// call site. See PoTokenProvider.tsx for what it actually does.
import type { ExtractResult } from "./types";

export interface PoTokenProviderHandle {
  extract(videoId: string): Promise<ExtractResult>;
}

let handle: PoTokenProviderHandle | null = null;

/** @internal called by <PoTokenProvider/> itself on mount/unmount — not for consumers to call directly. */
export function registerPoTokenProvider(h: PoTokenProviderHandle | null) {
  handle = h;
}

/**
 * Resolves fresh, ready-to-download googlevideo URLs for a video —
 * requires a `<PoTokenProvider proxyScriptUrl="..." />` to be mounted
 * somewhere in the tree first (see PoTokenProvider.tsx). Each call does a
 * real BotGuard attestation + InnerTube fetch, so cache the result if you
 * need it more than once for the same video — YouTube's own URLs expire
 * after a few hours regardless.
 */
export function extractDownloadFormats(videoId: string): Promise<ExtractResult> {
  if (!handle) {
    return Promise.reject(
      new Error(
        "expo-youtube-downloader: no <PoTokenProvider/> is mounted yet — render one near your app's root and try again once it's up (it self-registers on mount).",
      ),
    );
  }
  return handle.extract(videoId);
}
