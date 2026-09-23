// Example app for expo-youtube-downloader — exercises every exported API:
//   PoTokenProvider, getVideoInfo, extractDownloadFormats,
//   downloadFileChunked, downloadMedia, mergeAudioVideo, fixDuration
//
// Needs the reference proxy relay running over real HTTPS (plain HTTP
// will not work — see README.md) — see ../example-server, and this
// example's own README.md for the local-HTTPS setup steps.
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { File, Paths } from "expo-file-system";
import {
  PoTokenProvider,
  getVideoInfo,
  extractDownloadFormats,
  downloadFileChunked,
  downloadMedia,
  mergeAudioVideo,
  fixDuration,
  type VideoInfo,
  type FormatOption,
} from "expo-youtube-downloader";

// See example/README.md — needs a real HTTPS relay (plain HTTP will not
// work, even locally: this is Mixed Content, not an ATS setting). Replace
// with your Mac's LAN IP after running example-server/generate-certs.sh.
const PROXY_SCRIPT_URL = "https://YOUR_LAN_IP:4443/proxy-script";

type LogEntry = { id: number; text: string; isError?: boolean };
let nextLogId = 0;

export default function App() {
  const [url, setUrl] = useState("https://www.youtube.com/watch?v=jNQXAC9IVRw");
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [busyFormatId, setBusyFormatId] = useState<string | null>(null);
  const [runningPrimitives, setRunningPrimitives] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const log = useCallback((text: string, isError = false) => {
    console.log(text);
    setLogs((prev) => [{ id: nextLogId++, text, isError }, ...prev].slice(0, 40));
  }, []);

  const handleGetInfo = async () => {
    setLoadingInfo(true);
    setInfo(null);
    try {
      log(`getVideoInfo("${url}") …`);
      const result = await getVideoInfo(url);
      setInfo(result);
      log(
        `✓ "${result.title}" — ${result.videoOptions.length} video option(s), ${result.audioOptions.length} audio option(s)`,
      );
    } catch (e: any) {
      log(`✗ getVideoInfo failed: ${e?.message ?? e}`, true);
    } finally {
      setLoadingInfo(false);
    }
  };

  // The 90% path: one call resolves a URL, downloads it in throttle-
  // resistant chunks, and (when the format needs it) muxes/fixes it.
  const handleDownload = async (format: FormatOption) => {
    if (!info) return;
    setBusyFormatId(format.formatId);
    try {
      log(`downloadMedia(formatId="${format.formatId}") …`);
      const safeName = format.formatId.replace(/[^a-z0-9]/gi, "_");
      const destination = new File(Paths.document, `${info.id}-${safeName}.${format.ext}`);
      const result = await downloadMedia(info.webpageUrl, format.formatId, destination);
      log(`✓ saved ${result.uri} (${((result.fileSize ?? 0) / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e: any) {
      log(`✗ downloadMedia failed: ${e?.message ?? e}`, true);
    } finally {
      setBusyFormatId(null);
    }
  };

  // The low-level path: calls extractDownloadFormats, downloadFileChunked,
  // mergeAudioVideo, and fixDuration directly instead of going through
  // downloadMedia() — exercises every primitive the library exports.
  const handlePrimitivesDemo = async () => {
    if (!info) return;
    setRunningPrimitives(true);
    try {
      log("extractDownloadFormats(videoId) …");
      const extracted = await extractDownloadFormats(info.id);
      log(
        `✓ resolved ${extracted.videoFormats.length} video URL(s), ${extracted.audioFormats.length} audio URL(s)`,
      );

      const videoFmt = [...extracted.videoFormats].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
      const audioFmt = [...extracted.audioFormats].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
      if (!videoFmt || !audioFmt) throw new Error("No video/audio formats were resolved for this video.");

      const tempVideo = new File(Paths.cache, `${info.id}-primitive-v.mp4`);
      const tempAudio = new File(Paths.cache, `${info.id}-primitive-a.m4a`);

      log(`downloadFileChunked(video, ${videoFmt.height}p) …`);
      await downloadFileChunked(videoFmt.url, { "User-Agent": extracted.userAgent }, tempVideo);
      log(`✓ ${((tempVideo.size ?? 0) / 1024 / 1024).toFixed(1)} MB`);

      log("downloadFileChunked(audio) …");
      await downloadFileChunked(audioFmt.url, { "User-Agent": extracted.userAgent }, tempAudio);
      log(`✓ ${((tempAudio.size ?? 0) / 1024 / 1024).toFixed(1)} MB`);

      const merged = new File(Paths.document, `${info.id}-primitive-merged.mp4`);
      log("mergeAudioVideo(videoPath, audioPath, outputPath) …");
      await mergeAudioVideo(tempVideo.uri, tempAudio.uri, merged.uri);
      log(`✓ merged -> ${merged.uri}`);

      if (Platform.OS === "ios") {
        const fixed = new File(Paths.cache, `${info.id}-primitive-fixed.m4a`);
        log("fixDuration(inputPath, outputPath) — iOS only …");
        await fixDuration(tempAudio.uri, fixed.uri);
        log(`✓ duration-fixed -> ${fixed.uri}`);
      } else {
        log("fixDuration is iOS-only — skipped on Android");
      }
    } catch (e: any) {
      log(`✗ primitives demo failed: ${e?.message ?? e}`, true);
    } finally {
      setRunningPrimitives(false);
    }
  };

  return (
    <>
      {/* Mount exactly one, anywhere near the root. Headless — renders
          nothing visible — and self-registers, so no ref is needed. */}
      <PoTokenProvider proxyScriptUrl={PROXY_SCRIPT_URL} />
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.header}>expo-youtube-downloader</Text>
          <Text style={styles.subheader}>example app</Text>

          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="https://www.youtube.com/watch?v=..."
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.button} onPress={handleGetInfo} disabled={loadingInfo}>
            {loadingInfo ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>getVideoInfo()</Text>
            )}
          </TouchableOpacity>

          {info && (
            <View style={styles.card}>
              {!!info.thumbnail && <Image source={{ uri: info.thumbnail }} style={styles.thumb} />}
              <Text style={styles.title}>{info.title}</Text>
              <Text style={styles.meta}>
                {info.uploader} • {Math.floor(info.durationSeconds / 60)}m {info.durationSeconds % 60}s
              </Text>

              <Text style={styles.sectionLabel}>Video — downloadMedia()</Text>
              {info.videoOptions.map((f) => (
                <FormatRow
                  key={f.formatId}
                  format={f}
                  busy={busyFormatId === f.formatId}
                  disabled={busyFormatId !== null}
                  onPress={() => handleDownload(f)}
                />
              ))}

              <Text style={styles.sectionLabel}>Audio — downloadMedia()</Text>
              {info.audioOptions.map((f) => (
                <FormatRow
                  key={f.formatId}
                  format={f}
                  busy={busyFormatId === f.formatId}
                  disabled={busyFormatId !== null}
                  onPress={() => handleDownload(f)}
                />
              ))}

              <TouchableOpacity
                style={[styles.button, styles.secondaryButton]}
                onPress={handlePrimitivesDemo}
                disabled={runningPrimitives}
              >
                {runningPrimitives ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>
                    Run primitives: extractDownloadFormats + downloadFileChunked{"\n"}+ mergeAudioVideo + fixDuration
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          <Text style={styles.sectionLabel}>Log</Text>
          <View style={styles.log}>
            {logs.length === 0 && <Text style={styles.logEmpty}>Nothing yet — try "getVideoInfo()" above.</Text>}
            {logs.map((l) => (
              <Text key={l.id} style={[styles.logLine, l.isError && styles.logLineError]}>
                {l.text}
              </Text>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function FormatRow({
  format,
  busy,
  disabled,
  onPress,
}: {
  format: FormatOption;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.formatRow} onPress={onPress} disabled={disabled}>
      <View style={{ flex: 1 }}>
        <Text style={styles.formatLabel}>{format.label}</Text>
        {!!format.approxFileSize && <Text style={styles.formatMeta}>{format.approxFileSize}</Text>}
      </View>
      {busy && <ActivityIndicator size="small" color="#1DB954" />}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0D0D0D" },
  content: { padding: 16, paddingBottom: 48 },
  header: { color: "#FFF", fontSize: 22, fontWeight: "700" },
  subheader: { color: "#888", fontSize: 13, marginBottom: 16 },
  input: {
    backgroundColor: "#1A1A1A",
    color: "#FFF",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  button: {
    backgroundColor: "#1DB954",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    marginBottom: 16,
  },
  secondaryButton: { backgroundColor: "#333", marginTop: 8, marginBottom: 0 },
  buttonText: { color: "#FFF", fontWeight: "600", textAlign: "center" },
  card: { backgroundColor: "#161616", borderRadius: 12, padding: 12, marginBottom: 16 },
  thumb: { width: "100%", aspectRatio: 16 / 9, borderRadius: 8, marginBottom: 8, backgroundColor: "#000" },
  title: { color: "#FFF", fontSize: 16, fontWeight: "600" },
  meta: { color: "#999", fontSize: 12, marginTop: 2, marginBottom: 8 },
  sectionLabel: { color: "#1DB954", fontSize: 12, fontWeight: "700", marginTop: 12, marginBottom: 6 },
  formatRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1F1F1F",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  formatLabel: { color: "#FFF", fontSize: 14 },
  formatMeta: { color: "#888", fontSize: 12, marginTop: 1 },
  log: { backgroundColor: "#111", borderRadius: 8, padding: 10, minHeight: 80 },
  logEmpty: { color: "#666", fontSize: 12, fontStyle: "italic" },
  logLine: { color: "#0F0", fontSize: 11, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), marginBottom: 3 },
  logLineError: { color: "#F55" },
});
