export interface FormatOption {
  /** Opaque id — pass this straight to `resolveDownload()`/`downloadMedia()`. Encodes which itag(s) it refers to. */
  formatId: string;
  type: "video" | "audio";
  label: string;
  ext: string;
  approxFileSize: string | null;
  height?: number;
  bitrateKbps?: number;
}

export interface VideoInfo {
  id: string;
  title: string;
  thumbnail: string;
  durationSeconds: number;
  uploader: string;
  webpageUrl: string;
  videoOptions: FormatOption[];
  audioOptions: FormatOption[];
}

export interface ExtractedFormat {
  itag: number;
  height?: number;
  bitrate?: number;
  mimeType?: string;
  contentLength: number | null;
  /** Ready to download as-is — headers (User-Agent) already required, see `ExtractResult.userAgent`. */
  url: string;
}

export interface ExtractResult {
  title: string;
  /** Replay this as the `User-Agent` header on the actual download request — the URLs above are only valid for the client persona that minted them. */
  userAgent: string;
  videoFormats: ExtractedFormat[];
  audioFormats: ExtractedFormat[];
}

export interface DownloadResult {
  /** Local "file://" URI of the finished file. */
  uri: string;
  fileSize: number;
  type: "video" | "audio";
}
