package expo.modules.youtubedownloader

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.nio.ByteBuffer

// Android counterpart to the iOS AVFoundation module — muxes a separately-
// downloaded video-only file and audio-only file into one .mp4 via
// MediaExtractor/MediaMuxer, Android's built-in no-re-encode container-
// muxing APIs. See the package README for why this exists (adaptive
// streams come back as separate audio/video tracks).
//
// No fixDuration() here (unlike the iOS module) — the duration-doubling
// bug this package works around on iOS is an AVFoundation-specific
// timescale-interpretation quirk, confirmed not to affect Android's
// MediaExtractor for the same files.

private class MergeError(message: String) : CodedException(message)

class ExpoYoutubeDownloaderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoYoutubeDownloader")

    AsyncFunction("mergeAudioVideo") { videoUri: String, audioUri: String, outputUri: String ->
      merge(videoUri, audioUri, outputUri)
    }
  }

  private fun pathFromUri(uri: String): String =
    Uri.parse(uri).path ?: throw MergeError("Could not resolve a file path from URI: $uri")

  private fun selectTrack(extractor: MediaExtractor, mimePrefix: String): Int {
    for (i in 0 until extractor.trackCount) {
      val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
      if (mime.startsWith(mimePrefix)) return i
    }
    throw MergeError("No $mimePrefix track found in the downloaded file.")
  }

  private fun trackDurationUs(extractor: MediaExtractor, trackIndex: Int): Long {
    val format = extractor.getTrackFormat(trackIndex)
    return if (format.containsKey(MediaFormat.KEY_DURATION)) {
      format.getLong(MediaFormat.KEY_DURATION)
    } else {
      Long.MAX_VALUE
    }
  }

  // Adaptive video/audio streams for the same video are rarely
  // frame-identical in length — copying up to maxPresentationTimeUs
  // clips both tracks to the shorter of the two, same as the iOS
  // module, rather than leaving a silent or frozen tail.
  private fun copyTrack(
    extractor: MediaExtractor,
    muxer: MediaMuxer,
    muxerTrackIndex: Int,
    maxPresentationTimeUs: Long,
  ) {
    val buffer = ByteBuffer.allocate(1 * 1024 * 1024)
    val bufferInfo = MediaCodec.BufferInfo()

    while (true) {
      buffer.clear()
      val sampleSize = extractor.readSampleData(buffer, 0)
      if (sampleSize < 0) break

      val presentationTimeUs = extractor.sampleTime
      if (presentationTimeUs > maxPresentationTimeUs) break

      bufferInfo.offset = 0
      bufferInfo.size = sampleSize
      bufferInfo.presentationTimeUs = presentationTimeUs
      bufferInfo.flags = extractor.sampleFlags

      muxer.writeSampleData(muxerTrackIndex, buffer, bufferInfo)
      extractor.advance()
    }
  }

  private fun merge(videoUri: String, audioUri: String, outputUri: String): String {
    val videoPath = pathFromUri(videoUri)
    val audioPath = pathFromUri(audioUri)
    val outputPath = pathFromUri(outputUri)

    val outputFile = File(outputPath)
    if (outputFile.exists()) outputFile.delete()

    val videoExtractor = MediaExtractor()
    val audioExtractor = MediaExtractor()
    var muxer: MediaMuxer? = null

    try {
      videoExtractor.setDataSource(videoPath)
      audioExtractor.setDataSource(audioPath)

      val videoTrackIndex = selectTrack(videoExtractor, "video/")
      val audioTrackIndex = selectTrack(audioExtractor, "audio/")

      val minDurationUs = minOf(
        trackDurationUs(videoExtractor, videoTrackIndex),
        trackDurationUs(audioExtractor, audioTrackIndex),
      )

      videoExtractor.selectTrack(videoTrackIndex)
      audioExtractor.selectTrack(audioTrackIndex)

      val createdMuxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      muxer = createdMuxer
      val muxerVideoTrack = createdMuxer.addTrack(videoExtractor.getTrackFormat(videoTrackIndex))
      val muxerAudioTrack = createdMuxer.addTrack(audioExtractor.getTrackFormat(audioTrackIndex))
      createdMuxer.start()

      copyTrack(videoExtractor, createdMuxer, muxerVideoTrack, minDurationUs)
      copyTrack(audioExtractor, createdMuxer, muxerAudioTrack, minDurationUs)

      createdMuxer.stop()
    } catch (e: MergeError) {
      throw e
    } catch (e: Exception) {
      throw MergeError("Merging audio and video failed: ${e.message}")
    } finally {
      videoExtractor.release()
      audioExtractor.release()
      try {
        muxer?.release()
      } catch (e: Exception) {
        // Already released or never started — nothing else to do.
      }
    }

    return outputUri
  }
}
