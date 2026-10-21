import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { colors, font, radius, space } from "../theme";

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
        <Text style={styles.title}>New session</Text>
        <Pressable onPress={handleCancel} style={styles.cancelBtn}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>
          Project folder
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
        <Text style={styles.sectionTitle}>Model</Text>
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

        <Text style={styles.fieldLabel}>Thinking effort</Text>
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

        <Text style={styles.fieldLabel}>Title (optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="Named automatically if left blank"
          placeholderTextColor={colors.textFaint}
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
            <ActivityIndicator color={colors.onAccent} size="small" />
          ) : (
            <Text style={styles.createBtnText}>
              Start in {currentDir.split("/").pop() || "folder"}
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
  cancelBtn: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
  },
  cancelBtnText: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: "500",
  },
  sectionTitle: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: "600",
  },
  pillsRow: {
    gap: space.sm,
    paddingVertical: 2,
  },
  modelPill: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: "transparent",
  },
  modelPillActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  modelPillText: {
    color: colors.textMuted,
    fontSize: font.small,
  },
  modelPillTextActive: {
    color: colors.text,
    fontWeight: "600",
  },
  thinkingRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  thinkingPill: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: "transparent",
  },
  thinkingPillActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  thinkingPillText: {
    color: colors.textMuted,
    fontSize: font.small,
  },
  thinkingPillTextActive: {
    color: colors.text,
    fontWeight: "600",
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
    fontSize: font.body,
  },
  createBtn: {
    minHeight: 50,
    justifyContent: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: "center",
    marginTop: space.xs,
  },
  createBtnText: {
    color: colors.onAccent,
    fontSize: font.body,
    fontWeight: "600",
  },
});
