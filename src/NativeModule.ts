import { NativeModule, requireNativeModule } from "expo";

declare class ExpoYoutubeDownloaderNativeModule extends NativeModule<{}> {
  /**
   * Muxes a video-only file and an audio-only file into one .mp4 at
   * outputPath — no re-encoding, just container muxing. All three
   * arguments are full "file://" URIs (e.g. expo-file-system's
   * `File.uri`), not bare paths. Throws if either file has no usable
   * track, or if the export otherwise fails. Resolves to outputPath's
   * "file://" URI on success. iOS and Android.
   */
  mergeAudioVideo(videoPath: string, audioPath: string, outputPath: string): Promise<string>;

  /**
   * Re-saves a single audio- or video-file download at `outputPath`, with
   * its declared duration corrected to what the file's real sample data
   * actually is. **iOS only** — AVFoundation misreads the duration of
   * certain adaptive-stream files as exactly 2x their real length (a
   * timescale-interpretation quirk); Android's MediaExtractor doesn't
   * share this bug, so there's nothing to fix there. `inputPath`/
   * `outputPath` are full "file://" URIs. Resolves to outputPath's
   * "file://" URI on success. Calling this on Android throws.
   */
  fixDuration(inputPath: string, outputPath: string): Promise<string>;
}

export default requireNativeModule<ExpoYoutubeDownloaderNativeModule>("ExpoYoutubeDownloader");
