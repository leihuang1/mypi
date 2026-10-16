import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
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

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

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
        <Text style={styles.title}>Connect to MyPi Daemon</Text>
        {onCancel && (
          <Pressable onPress={onCancel} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>Close</Text>
          </Pressable>
        )}
      </View>

      <Text style={styles.subtitle}>
        Run `npm run server:start` on your dev machine. Scan the QR code printed in your terminal or connect manually below.
      </Text>

      {/* Camera QR Scanner Modal */}
      <Modal
        visible={scannerOpen}
        animationType="slide"
        onRequestClose={() => setScannerOpen(false)}
      >
        <View style={styles.scannerContainer}>
          <View style={styles.scannerHeader}>
            <Text style={styles.scannerTitle}>Scan Terminal QR Code</Text>
            <Pressable
              style={styles.scannerCloseBtn}
              onPress={() => setScannerOpen(false)}
            >
              <Text style={styles.scannerCloseText}>✕ Cancel</Text>
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
                Point your camera at the QR code shown by `npm run server:start`
              </Text>
            </View>
          </View>
        </View>
      </Modal>

      <View style={styles.card}>
        <Text style={styles.label}>QUICK PAIR (QR SCAN OR PASTE URI)</Text>

        {Platform.OS !== "web" && (
          <Pressable style={styles.scanBtn} onPress={handleOpenScanner}>
            <Text style={styles.scanBtnText}>📷 Scan Terminal QR Code</Text>
          </Pressable>
        )}

        <TextInput
          style={styles.input}
          placeholder="Or paste mypi://connect?url=...&token=..."
          placeholderTextColor="#4b5563"
          value={pairingInput}
          onChangeText={(txt) => handleApplyUri(txt, false)}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>SERVER DETAILS</Text>

        <Text style={styles.fieldLabel}>Server URL (Tap preset or edit)</Text>
        <View style={styles.presetRow}>
          {[
            { label: "USB (127.0.0.1)", val: "http://127.0.0.1:4780" },
            { label: "Wi-Fi (192.168.75.84)", val: "http://192.168.75.84:4780" },
            {
              label: "Tailscale (100.125.236.126)",
              val: "http://100.125.236.126:4780",
            },
          ].map((preset) => (
            <Pressable
              key={preset.val}
              onPress={() => setUrl(preset.val)}
              style={[
                styles.presetBtn,
                url === preset.val ? styles.presetBtnActive : null,
              ]}
            >
              <Text style={styles.presetBtnText}>{preset.label}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          style={styles.input}
          placeholder="http://192.168.1.10:4780 or http://100.x.y.z:4780"
          placeholderTextColor="#4b5563"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.fieldLabel}>Bearer Token</Text>
        <TextInput
          style={styles.input}
          placeholder="mypi_..."
          placeholderTextColor="#4b5563"
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.fieldLabel}>Display Name (Optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="MacBook Pro"
          placeholderTextColor="#4b5563"
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
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <Text style={styles.primaryBtnText}>Test & Connect</Text>
          )}
        </Pressable>
      </View>

      {savedServers.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>SAVED SERVERS</Text>
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
                  <Text style={styles.savedName} numberOfLines={1}>
                    {srv.name} {isActive ? "• ACTIVE" : ""}
                  </Text>
                  <Text style={styles.savedUrl} numberOfLines={1}>
                    {srv.url}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.deleteBtn}
                  onPress={() => onDeleteServer(srv.id)}
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
    backgroundColor: "#0b0e14",
  },
  content: {
    padding: 16,
    gap: 16,
    paddingBottom: 40,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    color: "#f9fafb",
    fontSize: 20,
    fontWeight: "700",
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#1f2937",
    borderRadius: 6,
  },
  closeBtnText: {
    color: "#d1d5db",
    fontSize: 13,
    fontWeight: "600",
  },
  subtitle: {
    color: "#9ca3af",
    fontSize: 13,
    lineHeight: 19,
  },
  card: {
    backgroundColor: "#141821",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#262d3d",
    padding: 14,
    gap: 10,
  },
  label: {
    color: "#60a5fa",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  scanBtn: {
    backgroundColor: "#059669",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#10b981",
  },
  scanBtnText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  presetBtn: {
    backgroundColor: "#0d1017",
    borderColor: "#262d3d",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  presetBtnActive: {
    backgroundColor: "#1e3a8a",
    borderColor: "#60a5fa",
  },
  presetBtnText: {
    color: "#e5e7eb",
    fontSize: 11,
    fontWeight: "600",
  },
  fieldLabel: {
    color: "#d1d5db",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
  },
  input: {
    backgroundColor: "#0b0e14",
    borderWidth: 1,
    borderColor: "#2e3646",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#f3f4f6",
    fontFamily: MONO_FONT,
    fontSize: 13,
  },
  errorText: {
    color: "#f87171",
    fontSize: 12,
    marginTop: 4,
  },
  primaryBtn: {
    backgroundColor: "#2563eb",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 6,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  primaryBtnText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  savedItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#0d1017",
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  savedItemActive: {
    borderColor: "#3b82f6",
  },
  savedMain: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  savedName: {
    color: "#f3f4f6",
    fontSize: 14,
    fontWeight: "600",
  },
  savedUrl: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 12,
  },
  deleteBtn: {
    flexShrink: 0,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  deleteBtnText: {
    color: "#f87171",
    fontSize: 12,
    fontWeight: "600",
  },
  scannerContainer: {
    flex: 1,
    backgroundColor: "#0b0e14",
  },
  scannerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "ios" ? 54 : 20,
    paddingBottom: 14,
    backgroundColor: "#141821",
    borderBottomWidth: 1,
    borderBottomColor: "#262d3d",
  },
  scannerTitle: {
    color: "#f9fafb",
    fontSize: 18,
    fontWeight: "700",
  },
  scannerCloseBtn: {
    backgroundColor: "#374151",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  scannerCloseText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "600",
  },
  cameraWrapper: {
    flex: 1,
    position: "relative",
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    gap: 20,
  },
  scanFrame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: "#10b981",
    borderRadius: 16,
    backgroundColor: "rgba(16, 185, 129, 0.05)",
  },
  scanHint: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    backgroundColor: "rgba(11, 14, 20, 0.8)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
});
