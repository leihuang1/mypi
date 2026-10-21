import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  MyPiClient,
  normalizeBaseUrl,
  parsePairingInput,
} from "@mypi/shared";
import type { SavedServerProfile } from "../store/server-store";
import { colors, font, MONO_FONT, radius, space, touch } from "../theme";

export function PairServerScreen({
  savedServers,
  activeServerId,
  onSaveProfile,
  onSelectServer,
  onDeleteServer,
  onCancel,
}: {
  savedServers: SavedServerProfile[];
  activeServerId: string | null;
  onSaveProfile: (profile: { name: string; url: string; token: string }) => Promise<void>;
  onSelectServer: (id: string) => Promise<void>;
  onDeleteServer: (id: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [pairingInput, setPairingInput] = useState("");
  const [name, setName] = useState("MacBook");
  const [url, setUrl] = useState("http://192.168.75.84:4780");
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const scanLockedRef = useRef(false);

  const connectWithCandidates = async (
    urlsToTry: string[],
    cleanToken: string,
    preferredName?: string,
  ) => {
    setTesting(true);
    setError(null);
    let lastErr: unknown = null;

    for (const candidate of urlsToTry) {
      const cleanUrl = normalizeBaseUrl(candidate);
      try {
        const client = new MyPiClient({ baseUrl: cleanUrl, token: cleanToken });
        const device = await client.getDevice();
        setUrl(cleanUrl);
        setToken(cleanToken);
        await onSaveProfile({
          name: preferredName?.trim() || name.trim() || device.name || cleanUrl,
          url: cleanUrl,
          token: cleanToken,
        });
        setTesting(false);
        return;
      } catch (err) {
        lastErr = err;
      }
    }

    setTesting(false);
    setError(
      `Connection failed (${urlsToTry.join(", ")}): ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  };

  const handleApplyUri = (text: string, autoConnect = false) => {
    setPairingInput(text);
    const parsed = parsePairingInput(text);
    if (parsed) {
      setUrl(parsed.url);
      setToken(parsed.token);
      if (parsed.name) setName(parsed.name);
      setError(null);
      if (autoConnect) {
        const candidates = [
          parsed.url,
          ...(parsed.fallbackUrls ?? []),
          "http://127.0.0.1:4780",
        ].filter((v, idx, arr) => Boolean(v) && arr.indexOf(v) === idx);
        void connectWithCandidates(candidates, parsed.token, parsed.name);
      }
    } else if (autoConnect) {
      setError("Invalid QR code format. Expected mypi://connect?... URI.");
    }
  };

  const handleOpenScanner = async () => {
    setError(null);
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        setError("Camera permission is required to scan the terminal QR code.");
        return;
      }
    }
    scanLockedRef.current = false;
    setScannerOpen(true);
  };

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scanLockedRef.current) return;
    scanLockedRef.current = true;
    setScannerOpen(false);
    handleApplyUri(data, true);
  };

  const handleTestAndSave = async () => {
    const cleanUrl = normalizeBaseUrl(url);
    const cleanToken = token.trim();
    if (!cleanUrl || !cleanToken) {
      setError("Please provide both Server URL and Bearer Token.");
      return;
    }
    await connectWithCandidates([cleanUrl], cleanToken, name);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Connect a server</Text>
        {onCancel && (
          <Pressable onPress={onCancel} style={styles.closeBtn} accessibilityLabel="Close">
            <Text style={styles.closeBtnText}>Done</Text>
          </Pressable>
        )}
      </View>

      <Text style={styles.subtitle}>
        Run <Text style={styles.code}>npm run server:start</Text> on your dev machine, then scan the QR code it prints.
      </Text>

      {/* Camera QR Scanner Modal */}
      <Modal
        visible={scannerOpen}
        animationType="slide"
        onRequestClose={() => setScannerOpen(false)}
      >
        <View style={styles.scannerContainer}>
          <View style={styles.scannerHeader}>
            <Text style={styles.scannerTitle}>Scan QR code</Text>
            <Pressable
              style={styles.scannerCloseBtn}
              onPress={() => setScannerOpen(false)}
            >
              <Text style={styles.scannerCloseText}>Cancel</Text>
            </Pressable>
          </View>

          <View style={styles.cameraWrapper}>
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              barcodeScannerSettings={{
                barcodeTypes: ["qr"],
              }}
              onBarcodeScanned={handleBarcodeScanned}
            />
            <View style={styles.scanOverlay}>
              <View style={styles.scanFrame} />
              <Text style={styles.scanHint}>
                Point the camera at the QR code in your terminal
              </Text>
            </View>
          </View>
        </View>
      </Modal>

      <View style={styles.card}>
        <Text style={styles.label}>Quick pair</Text>

        {Platform.OS !== "web" && (
          <Pressable style={styles.scanBtn} onPress={handleOpenScanner}>
            <Text style={styles.scanBtnText}>Scan QR code</Text>
          </Pressable>
        )}

        <TextInput
          style={styles.input}
          placeholder="…or paste a mypi://connect link"
          placeholderTextColor={colors.textFaint}
          value={pairingInput}
          onChangeText={(txt) => handleApplyUri(txt, false)}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Manual setup</Text>

        <Text style={styles.fieldLabel}>Server URL</Text>
        <View style={styles.presetRow}>
          {[
            { label: "USB", val: "http://127.0.0.1:4780" },
            { label: "Wi-Fi", val: "http://192.168.75.84:4780" },
            { label: "Tailscale", val: "http://100.125.236.126:4780" },
          ].map((preset) => (
            <Pressable
              key={preset.val}
              onPress={() => setUrl(preset.val)}
              style={[
                styles.presetBtn,
                url === preset.val ? styles.presetBtnActive : null,
              ]}
            >
              <Text style={[styles.presetBtnText, url === preset.val ? styles.presetBtnTextActive : null]}>{preset.label}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          style={styles.input}
          placeholder="http://192.168.1.10:4780 or http://100.x.y.z:4780"
          placeholderTextColor={colors.textFaint}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.fieldLabel}>Bearer token</Text>
        <TextInput
          style={styles.input}
          placeholder="mypi_..."
          placeholderTextColor={colors.textFaint}
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.fieldLabel}>Display name (optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="MacBook Pro"
          placeholderTextColor={colors.textFaint}
          value={name}
          onChangeText={setName}
        />

        {error && <Text style={styles.errorText}>{error}</Text>}

        <Pressable
          style={[styles.primaryBtn, testing ? styles.btnDisabled : null]}
          onPress={handleTestAndSave}
          disabled={testing}
        >
          {testing ? (
            <ActivityIndicator color={colors.onAccent} size="small" />
          ) : (
            <Text style={styles.primaryBtnText}>Test & connect</Text>
          )}
        </Pressable>
      </View>

      {savedServers.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>Saved servers</Text>
          {savedServers.map((srv) => {
            const isActive = srv.id === activeServerId;
            return (
              <View
                key={srv.id}
                style={[
                  styles.savedItem,
                  isActive ? styles.savedItemActive : null,
                ]}
              >
                <Pressable
                  style={styles.savedMain}
                  onPress={() => onSelectServer(srv.id)}
                >
                  <View style={styles.savedNameRow}>
                    <Text style={styles.savedName} numberOfLines={1}>
                      {srv.name}
                    </Text>
                    {isActive && <Text style={styles.activeBadge}>Active</Text>}
                  </View>
                  <Text style={styles.savedUrl} numberOfLines={1}>
                    {srv.url}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.deleteBtn}
                  onPress={() =>
                    Alert.alert("Remove server?", `"${srv.name}" and its token will be removed from this phone.`, [
                      { text: "Cancel", style: "cancel" },
                      { text: "Remove", style: "destructive", onPress: () => void onDeleteServer(srv.id) },
                    ])
                  }
                  accessibilityLabel={`Remove ${srv.name}`}
                >
                  <Text style={styles.deleteBtnText}>Remove</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.lg,
    gap: space.lg,
    paddingBottom: 48,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.md,
  },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: font.heading,
    fontWeight: "700",
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: font.small,
    fontWeight: "500",
    marginTop: space.xs,
    marginBottom: -space.xs,
  },
  errorText: {
    color: colors.dangerText,
    fontSize: font.small,
    lineHeight: 19,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  closeBtn: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
  },
  closeBtnText: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: "500",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: font.small,
    lineHeight: 20,
    marginTop: -space.sm,
  },
  code: {
    fontFamily: MONO_FONT,
    color: colors.text,
  },
  label: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: "600",
  },
  scanBtn: {
    minHeight: 48,
    justifyContent: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: "center",
  },
  scanBtnText: {
    color: colors.onAccent,
    fontSize: font.body,
    fontWeight: "600",
  },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  presetBtn: {
    minHeight: 36,
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderColor: "transparent",
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
  },
  presetBtnActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  presetBtnText: {
    color: colors.textMuted,
    fontSize: font.small,
    fontWeight: "500",
  },
  presetBtnTextActive: {
    color: colors.text,
  },
  input: {
    minHeight: 48,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.small,
  },
  primaryBtn: {
    minHeight: 48,
    justifyContent: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: "center",
    marginTop: space.xs,
  },
  primaryBtnText: {
    color: colors.onAccent,
    fontSize: font.body,
    fontWeight: "600",
  },
  savedItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: "transparent",
  },
  savedItemActive: {
    borderColor: colors.accent,
  },
  savedMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 60,
    justifyContent: "center",
    gap: 3,
  },
  savedNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  savedName: {
    flexShrink: 1,
    color: colors.text,
    fontSize: font.body,
    fontWeight: "600",
  },
  activeBadge: {
    color: colors.accentText,
    backgroundColor: colors.accentSoft,
    fontSize: font.caption,
    fontWeight: "500",
    paddingHorizontal: space.sm,
    paddingVertical: 1,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  savedUrl: {
    color: colors.textMuted,
    fontFamily: MONO_FONT,
    fontSize: font.caption,
  },
  deleteBtn: {
    flexShrink: 0,
    minHeight: touch,
    justifyContent: "center",
    paddingHorizontal: space.md,
  },
  deleteBtnText: {
    color: colors.dangerText,
    fontSize: font.small,
    fontWeight: "500",
  },
  scannerContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scannerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingTop: Platform.OS === "ios" ? 54 : 20,
    paddingBottom: space.md,
    backgroundColor: colors.bg,
  },
  scannerTitle: {
    color: colors.text,
    fontSize: font.title,
    fontWeight: "600",
  },
  scannerCloseBtn: {
    minHeight: 40,
    justifyContent: "center",
    backgroundColor: colors.surface,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
  },
  scannerCloseText: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: "500",
  },
  cameraWrapper: {
    flex: 1,
    position: "relative",
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    padding: space.xl,
    gap: 20,
  },
  scanFrame: {
    width: 240,
    height: 240,
    borderWidth: 3,
    borderColor: colors.onAccent,
    borderRadius: 24,
  },
  scanHint: {
    color: colors.onAccent,
    fontSize: font.small,
    fontWeight: "500",
    textAlign: "center",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
});
