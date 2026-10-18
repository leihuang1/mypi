import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  DeviceInfo,
  ModelRef,
  MyPiClient,
  SessionSummary,
  ThinkingLevel,
} from "@mypi/shared";
import { FileBrowserPanel } from "../components/FileBrowserPanel";

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function NewSessionScreen({
  client,
  device,
  onCreated,
  onCancel,
}: {
  client: MyPiClient;
  device: DeviceInfo;
  onCreated: (session: SessionSummary) => void;
  onCancel: () => void;
}) {
  const [currentDir, setCurrentDir] = useState<string>(
    device.startDirs[0] || "",
  );
  const [sessionName, setSessionName] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelRef>(
    device.defaultModel,
  );
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    device.defaultThinkingLevel || "high",
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const createReqIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      createReqIdRef.current += 1;
    };
  }, []);

  const handleCancel = () => {
    createReqIdRef.current += 1;
    setCreating(false);
    onCancel();
  };

  const handleCreate = async () => {
    if (!currentDir.trim()) {
      setError("Please select a project working directory.");
      return;
    }
    const reqId = ++createReqIdRef.current;
    setCreating(true);
    setError(null);
    try {
      const created = await client.createSession({
        name: sessionName.trim() || undefined,
        cwd: currentDir.trim(),
        model: selectedModel,
        thinkingLevel,
      });
      if (!mountedRef.current || createReqIdRef.current !== reqId) {
        return;
      }
      onCreated(created);
    } catch (err) {
      if (!mountedRef.current || createReqIdRef.current !== reqId) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current && createReqIdRef.current === reqId) {
        setCreating(false);
      }
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>New Durable Session</Text>
        <Pressable onPress={handleCancel} style={styles.cancelBtn}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>
          1. PROJECT DIRECTORY WORKBENCH (REMOTE)
        </Text>
        <FileBrowserPanel
          client={client}
          initialPath={currentDir || undefined}
          startDirs={device.startDirs}
          showFiles={true}
          onSelectDirectory={(dirPath) => setCurrentDir(dirPath)}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>2. MODEL & THINKING LEVEL</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillsRow}
        >
          {device.models.map((m) => {
            const key = `${m.provider}/${m.modelId}`;
            const active =
              selectedModel.provider === m.provider &&
              selectedModel.modelId === m.modelId;
            return (
              <Pressable
                key={key}
                style={[styles.modelPill, active ? styles.modelPillActive : null]}
                onPress={() =>
                  setSelectedModel({ provider: m.provider, modelId: m.modelId })
                }
              >
                <Text
                  style={[
                    styles.modelPillText,
                    active ? styles.modelPillTextActive : null,
                  ]}
                >
                  {m.provider}/{m.modelId}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <Text style={styles.fieldLabel}>Thinking Effort</Text>
        <View style={styles.thinkingRow}>
          {THINKING_LEVELS.map((lvl) => {
            const active = thinkingLevel === lvl;
            return (
              <Pressable
                key={lvl}
                style={[
                  styles.thinkingPill,
                  active ? styles.thinkingPillActive : null,
                ]}
                onPress={() => setThinkingLevel(lvl)}
              >
                <Text
                  style={[
                    styles.thinkingPillText,
                    active ? styles.thinkingPillTextActive : null,
                  ]}
                >
                  {lvl}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.fieldLabel}>Session Title (Optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="Auto-named from project folder or first message"
          placeholderTextColor="#4b5563"
          value={sessionName}
          onChangeText={setSessionName}
        />

        {error && <Text style={styles.errorText}>{error}</Text>}

        <Pressable
          style={[styles.createBtn, creating ? styles.btnDisabled : null]}
          onPress={handleCreate}
          disabled={creating}
        >
          {creating ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <Text style={styles.createBtnText}>
              Start Durable Session in {currentDir.split("/").pop() || "Folder"}
            </Text>
          )}
        </Pressable>
      </View>
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
    fontSize: 19,
    fontWeight: "700",
  },
  cancelBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#1f2937",
    borderRadius: 6,
  },
  cancelBtnText: {
    color: "#d1d5db",
    fontSize: 13,
    fontWeight: "600",
  },
  card: {
    backgroundColor: "#141821",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#262d3d",
    padding: 14,
    gap: 10,
  },
  sectionTitle: {
    color: "#60a5fa",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.7,
  },
  pillsRow: {
    gap: 8,
    paddingVertical: 4,
  },
  modelPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#0d1017",
    borderWidth: 1,
    borderColor: "#262d3d",
  },
  modelPillActive: {
    backgroundColor: "#1e3a8a",
    borderColor: "#60a5fa",
  },
  modelPillText: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 12,
  },
  modelPillTextActive: {
    color: "#ffffff",
    fontWeight: "700",
  },
  fieldLabel: {
    color: "#d1d5db",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
  },
  thinkingRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  thinkingPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#0d1017",
    borderWidth: 1,
    borderColor: "#262d3d",
  },
  thinkingPillActive: {
    backgroundColor: "#065f46",
    borderColor: "#34d399",
  },
  thinkingPillText: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 12,
  },
  thinkingPillTextActive: {
    color: "#ecfdf5",
    fontWeight: "700",
  },
  input: {
    backgroundColor: "#0b0e14",
    borderWidth: 1,
    borderColor: "#2e3646",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#f3f4f6",
    fontSize: 13,
  },
  errorText: {
    color: "#f87171",
    fontSize: 12,
  },
  createBtn: {
    backgroundColor: "#2563eb",
    paddingVertical: 13,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 6,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  createBtnText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
});
