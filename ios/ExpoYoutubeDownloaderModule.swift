import ExpoModulesCore
import AVFoundation

// Muxes a separately-downloaded video-only file and audio-only file into
// one playable .mp4 — no re-encoding, just container muxing via
// AVMutableComposition/AVAssetExportSession's passthrough preset. This is
// the piece an on-device adaptive-stream download pipeline needs whenever
// its source only hands back separate video-only + audio-only tracks
// (rather than one already-combined file) — see the package README for
// the full investigation this is based on.
//
// Only muxes formats that are already remux-compatible (H.264 video +
// AAC audio) — this module doesn't attempt to handle arbitrary codec
// combinations.
public class ExpoYoutubeDownloaderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoYoutubeDownloader")

    AsyncFunction("mergeAudioVideo") { (videoPath: String, audioPath: String, outputPath: String) -> String in
      try await Self.merge(videoPath: videoPath, audioPath: audioPath, outputPath: outputPath)
    }

    AsyncFunction("fixDuration") { (inputPath: String, outputPath: String) -> String in
      try await Self.fixDuration(inputPath: inputPath, outputPath: outputPath)
    }
  }

  private enum MergeError: Error, LocalizedError {
    case noVideoTrack
    case noAudioTrack
    case noTracks
    case couldNotAddVideoTrack
    case couldNotAddAudioTrack
    case exportSessionUnavailable
    case exportFailed(String)

    var errorDescription: String? {
      switch self {
      case .noVideoTrack: return "No video track found in the downloaded video file."
      case .noAudioTrack: return "No audio track found in the downloaded audio file."
      case .noTracks: return "The downloaded file has no video or audio track."
      case .couldNotAddVideoTrack: return "Could not add a video track to the output composition."
      case .couldNotAddAudioTrack: return "Could not add an audio track to the output composition."
      case .exportSessionUnavailable: return "Could not create an AVAssetExportSession."
      case .exportFailed(let reason): return "Merging audio and video failed: \(reason)"
      }
    }
  }

  // AVFoundation's own `.duration` (and even a track's raw sample
  // presentation timestamps read via AVAssetReader) have been confirmed —
  // by direct comparison against ffprobe on the exact same file — to
  // report EXACTLY 2x the real duration for certain adaptive-stream MP4s
  // (a timescale-interpretation quirk tied to an unusual per-track
  // timescale, e.g. 15360 rather than something standard). Every
  // AVFoundation duration/timeRange API is equally wrong for these files,
  // so trusting any of them silently produces a composition clipped to 2x
  // the real length — plays real content, then sits on silence/a frozen
  // frame for the "phantom" doubled remainder.
  //
  // The fix: never trust the declared duration. Derive the real duration
  // independently by counting actual samples — video frame count divided
  // by the nominal frame rate, audio packet count times frames-per-packet
  // divided by sample rate — neither of which touches the buggy per-sample
  // timestamp math. Confirmed byte-for-byte against ffprobe on multiple
  // real downloads.
  private static func realVideoDuration(track: AVAssetTrack, asset: AVAsset) async throws -> Double {
    let nominalFrameRate = try await track.load(.nominalFrameRate)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = false
    reader.add(output)
    reader.startReading()
    var frameCount = 0
    while let sampleBuffer = output.copyNextSampleBuffer() {
      frameCount += CMSampleBufferGetNumSamples(sampleBuffer)
    }
    guard nominalFrameRate > 0 else { return 0 }
    return Double(frameCount) / Double(nominalFrameRate)
  }

  private static func realAudioDuration(track: AVAssetTrack, asset: AVAsset) async throws -> Double {
    let formatDescs = try await track.load(.formatDescriptions)
    guard let asbd = formatDescs.first.flatMap({ CMAudioFormatDescriptionGetStreamBasicDescription($0) }) else {
      return 0
    }
    let sampleRate = asbd.pointee.mSampleRate
    // For compressed audio (AAC), each CMSampleBuffer's "sample count" is
    // the number of encoded packets it holds, not PCM sample-frames — each
    // packet covers mFramesPerPacket PCM frames (1024 for AAC-LC).
    let framesPerPacket = Double(asbd.pointee.mFramesPerPacket)
    guard sampleRate > 0, framesPerPacket > 0 else { return 0 }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = false
    reader.add(output)
    reader.startReading()
    var packetCount: Int64 = 0
    while let sampleBuffer = output.copyNextSampleBuffer() {
      packetCount += Int64(CMSampleBufferGetNumSamples(sampleBuffer))
    }
    return Double(packetCount) * framesPerPacket / sampleRate
  }

  // Takes full "file://" URIs (what expo-file-system's File.uri already
  // gives us) rather than bare paths, via URL(string:) — avoids fragile
  // "file://" prefix-stripping and percent-encoding bugs on the JS side.
  private static func merge(videoPath: String, audioPath: String, outputPath: String) async throws -> String {
    guard let videoURL = URL(string: videoPath),
          let audioURL = URL(string: audioPath),
          let outputURL = URL(string: outputPath) else {
      throw MergeError.exportFailed("one or more file:// URIs could not be parsed")
    }

    if FileManager.default.fileExists(atPath: outputURL.path) {
      try FileManager.default.removeItem(at: outputURL)
    }

    let videoAsset = AVURLAsset(url: videoURL)
    let audioAsset = AVURLAsset(url: audioURL)

    guard let sourceVideoTrack = try await videoAsset.loadTracks(withMediaType: .video).first else {
      throw MergeError.noVideoTrack
    }
    guard let sourceAudioTrack = try await audioAsset.loadTracks(withMediaType: .audio).first else {
      throw MergeError.noAudioTrack
    }

    let videoDurationSeconds = try await realVideoDuration(track: sourceVideoTrack, asset: videoAsset)
    let audioDurationSeconds = try await realAudioDuration(track: sourceAudioTrack, asset: audioAsset)
    // Adaptive video/audio streams for the same video are rarely frame-
    // identical in length — clip to the shorter of the two rather than
    // leaving a silent or frozen tail.
    let clipSeconds = min(videoDurationSeconds, audioDurationSeconds)
    let range = CMTimeRange(start: .zero, duration: CMTime(seconds: clipSeconds, preferredTimescale: 600))

    let composition = AVMutableComposition()

    // addMutableTrack returns Optional — unwrapped explicitly rather than
    // with `?.` below, so a failure here throws instead of silently
    // producing a file that's missing its video or audio track.
    guard
      let compositionVideoTrack = composition.addMutableTrack(
        withMediaType: .video,
        preferredTrackID: kCMPersistentTrackID_Invalid
      )
    else {
      throw MergeError.couldNotAddVideoTrack
    }
    try compositionVideoTrack.insertTimeRange(range, of: sourceVideoTrack, at: .zero)
    // Preserves the source's orientation (e.g. portrait video) — without
    // this the merged file plays back rotated on some players.
    compositionVideoTrack.preferredTransform = try await sourceVideoTrack.load(.preferredTransform)

    guard
      let compositionAudioTrack = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
      )
    else {
      throw MergeError.couldNotAddAudioTrack
    }
    try compositionAudioTrack.insertTimeRange(range, of: sourceAudioTrack, at: .zero)

    guard
      let exportSession = AVAssetExportSession(
        asset: composition,
        presetName: AVAssetExportPresetPassthrough
      )
    else {
      throw MergeError.exportSessionUnavailable
    }
    exportSession.outputURL = outputURL
    exportSession.outputFileType = .mp4
    exportSession.timeRange = range

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      exportSession.exportAsynchronously {
        switch exportSession.status {
        case .completed:
          continuation.resume(returning: ())
        case .failed, .cancelled:
          let reason = exportSession.error?.localizedDescription ?? "unknown error"
          continuation.resume(throwing: MergeError.exportFailed(reason))
        default:
          continuation.resume(throwing: MergeError.exportFailed("unexpected status \(exportSession.status.rawValue)"))
        }
      }
    }

    return outputURL.absoluteString
  }

  // Single-file downloads (audio-only, or a combined/progressive video+audio
  // stream — no merge needed) never went through `merge()` above, so they
  // never got the real-duration fix either: a plain chunked download of
  // exactly what the CDN sends, played back by a native player reading
  // THIS file's own declared duration — which is the same AVFoundation
  // misread (~2x) for these adaptive-stream files, confirmed on audio-only
  // downloads too, not just the video+audio pair case `merge()` already
  // covers. Fixes it the same way: passthrough-export the file to itself
  // (effectively) but constrained to the real, independently-measured
  // duration, so the saved file's own metadata is finally correct — no
  // player-side changes needed, since the file it reads is just right now.
  private static func fixDuration(inputPath: String, outputPath: String) async throws -> String {
    guard let inputURL = URL(string: inputPath), let outputURL = URL(string: outputPath) else {
      throw MergeError.exportFailed("one or more file:// URIs could not be parsed")
    }

    if FileManager.default.fileExists(atPath: outputURL.path) {
      try FileManager.default.removeItem(at: outputURL)
    }

    let asset = AVURLAsset(url: inputURL)
    let videoTrack = try await asset.loadTracks(withMediaType: .video).first
    let audioTrack = try await asset.loadTracks(withMediaType: .audio).first
    guard videoTrack != nil || audioTrack != nil else {
      throw MergeError.noTracks
    }

    var durations: [Double] = []
    if let videoTrack {
      durations.append(try await realVideoDuration(track: videoTrack, asset: asset))
    }
    if let audioTrack {
      durations.append(try await realAudioDuration(track: audioTrack, asset: asset))
    }
    // Same "clip to the shorter of the two" reasoning as merge() — a
    // combined stream's video/audio tracks are rarely frame-identical
    // either.
    guard let clipSeconds = durations.min(), clipSeconds > 0 else {
      throw MergeError.exportFailed("Could not determine the file's real duration.")
    }
    let range = CMTimeRange(start: .zero, duration: CMTime(seconds: clipSeconds, preferredTimescale: 600))

    guard
      let exportSession = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough)
    else {
      throw MergeError.exportSessionUnavailable
    }
    exportSession.outputURL = outputURL
    exportSession.outputFileType = videoTrack != nil ? .mp4 : .m4a
    exportSession.timeRange = range

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      exportSession.exportAsynchronously {
        switch exportSession.status {
        case .completed:
          continuation.resume(returning: ())
        case .failed, .cancelled:
          let reason = exportSession.error?.localizedDescription ?? "unknown error"
          continuation.resume(throwing: MergeError.exportFailed(reason))
        default:
          continuation.resume(throwing: MergeError.exportFailed("unexpected status \(exportSession.status.rawValue)"))
        }
      }
    }

    return outputURL.absoluteString
  }
}
