import React, { useEffect, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  type AssistantTranscriptItem,
  createInitialSessionState,
  type MyPiClient,
  reduceSseFrame,
  type SessionLiveState,
  type SessionSummary,
  type TranscriptItem,
} from "@mypi/shared";
import { GitDiffPanel } from "../components/GitDiffPanel";
import { ToolCallCard } from "../components/ToolCallCard";

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

function AssistantMessageCard({ item }: { item: AssistantTranscriptItem }) {
  const [showThinking, setShowThinking] = useState(false);

  return (
    <View style={styles.assistantBubble}>
      <View style={styles.roleHeader}>
        <Text style={styles.assistantRoleText}>PI AGENT</Text>
        {item.status === "streaming" && (
          <Text style={styles.streamingBadge}>● STREAMING</Text>
        )}
        {item.status === "aborted" && (
          <Text style={styles.abortedBadge}>ABORTED</Text>
        )}
        {item.status === "error" && (
          <Text style={styles.errorBadge}>ERROR</Text>
        )}
      </View>

      {item.thinking ? (
        <View style={styles.thinkingBox}>
          <Pressable
            onPress={() => setShowThinking((prev) => !prev)}
            style={styles.thinkingHeader}
          >
            <Text style={styles.thinkingTitle}>
              💭 Thinking ({item.thinking.length} chars) {showThinking ? "▾" : "▸"}
            </Text>
          </Pressable>
          {showThinking && (
            <Text style={styles.thinkingBody} selectable>
              {item.thinking}
            </Text>
          )}
        </View>
      ) : null}

      {item.text ? (
        <Text style={styles.assistantText} selectable>
          {item.text}
        </Text>
      ) : null}

      {item.errorMessage ? (
        <Text style={styles.errorMessageText} selectable>
          {item.errorMessage}
        </Text>
      ) : null}

      {item.toolCalls.map((tc) => (
        <ToolCallCard key={tc.callId} tool={tc} />
      ))}
    </View>
  );
}

function TranscriptItemRow({ item }: { item: TranscriptItem }) {
  if (item.kind === "user") {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userText} selectable>
            {item.text}
          </Text>
        </View>
      </View>
    );
  }

  if (item.kind === "assistant") {
    return <AssistantMessageCard item={item} />;
  }

  return (
    <View style={styles.systemRow}>
      <Text style={styles.systemText}>{item.text}</Text>
    </View>
  );
}

export function SessionDetailScreen({
  client,
  session,
  onBack,
}: {
  client: MyPiClient;
  session: SessionSummary;
  onBack: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"chat" | "git">("chat");
  const [liveState, setLiveState] = useState<SessionLiveState>(() =>
    createInitialSessionState(),
  );
  const [connStatus, setConnStatus] = useState<
    "connecting" | "connected" | "reconnecting" | "error"
  >("connecting");
  const [connError, setConnError] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const scrollRef = useRef<ScrollView | null>(null);

  // Subscribe to SSE durable stream and auto-reconnect on foreground wakeup
  useEffect(() => {
    const unsubscribe = client.subscribeSessionEvents(session.id, {
      onFrame: (frame) => {
        setLiveState((prev) => reduceSseFrame(prev, frame));
      },
      onStatusChange: (status, err) => {
        setConnStatus(status);
        setConnError(err ?? null);
      },
    });

    const appStateSub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        setStreamGeneration((g) => g + 1);
      }
    });

    return () => {
      unsubscribe();
      appStateSub.remove();
    };
  }, [client, session.id, streamGeneration]);

  const handleSend = async (whenBusy: "steer" | "followUp" = "steer") => {
    const text = inputText.trim();
    if (!text || sending) return;

    const requestId = `mobile-${session.id}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;

    setSending(true);
    setInputText("");
    try {
      await client.sendMessage(session.id, {
        requestId,
        content: text,
        whenBusy,
      });
    } catch (err) {
      setInputText(text);
      setConnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleAbort = async () => {
    try {
      await client.abortSession(session.id);
    } catch (err) {
      setConnError(err instanceof Error ? err.message : String(err));
    }
  };

  const statusColor =
    connStatus === "connected"
      ? "#10b981"
      : connStatus === "connecting" || connStatus === "reconnecting"
        ? "#f59e0b"
        : "#ef4444";

  const activeModel = liveState.model || session.model;
  const activeThinking = liveState.thinkingLevel || session.thinkingLevel;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Top Bar */}
      <View style={styles.topBar}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Sessions</Text>
        </Pressable>
        <View style={styles.titleBlock}>
          <Text style={styles.sessionTitle} numberOfLines={1}>
            {session.name}
          </Text>
          <Text style={styles.cwdText} numberOfLines={1}>
            {liveState.cwd || session.cwd}
          </Text>
        </View>
        <View style={styles.statusPill}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={styles.statusLabel}>
            {liveState.busy ? "BUSY" : connStatus.toUpperCase()}
          </Text>
        </View>
      </View>

      {/* Sub-header: Model info & Tab Switcher */}
      <View style={styles.subBar}>
        <Text style={styles.modelMetaText} numberOfLines={1}>
          {activeModel.provider}/{activeModel.modelId} ({activeThinking})
        </Text>
        <View style={styles.tabGroup}>
          <Pressable
            style={[
              styles.tabBtn,
              activeTab === "chat" ? styles.tabBtnActive : null,
            ]}
            onPress={() => setActiveTab("chat")}
          >
            <Text
              style={[
                styles.tabBtnText,
                activeTab === "chat" ? styles.tabBtnTextActive : null,
              ]}
            >
              Chat ({liveState.items.length})
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.tabBtn,
              activeTab === "git" ? styles.tabBtnActive : null,
            ]}
            onPress={() => setActiveTab("git")}
          >
            <Text
              style={[
                styles.tabBtnText,
                activeTab === "git" ? styles.tabBtnTextActive : null,
              ]}
            >
              Git Diff
            </Text>
          </Pressable>
        </View>
      </View>

      {connError && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText} numberOfLines={2}>
            {connError}
          </Text>
          <Pressable
            onPress={() => setStreamGeneration((g) => g + 1)}
            style={styles.reconnectBtn}
          >
            <Text style={styles.reconnectBtnText}>Reconnect</Text>
          </Pressable>
        </View>
      )}

      {activeTab === "git" ? (
        <GitDiffPanel client={client} sessionId={session.id} />
      ) : (
        <>
          <ScrollView
            ref={scrollRef}
            style={styles.chatScroll}
            contentContainerStyle={styles.chatContent}
            onContentSizeChange={() =>
              scrollRef.current?.scrollToEnd({ animated: true })
            }
          >
            {liveState.items.length === 0 ? (
              <View style={styles.emptyChatBox}>
                <Text style={styles.emptyChatTitle}>
                  Durable Session Ready
                </Text>
                <Text style={styles.emptyChatSub}>
                  Send a prompt below. Even if your phone locks or switches networks, Pi Durable keeps running on your dev machine and syncs back on reconnect.
                </Text>
              </View>
            ) : (
              liveState.items.map((item) => (
                <TranscriptItemRow key={item.id} item={item} />
              ))
            )}

            {liveState.retry && (
              <View style={styles.retryBanner}>
                <Text style={styles.retryText}>
                  Retrying model request (attempt #{liveState.retry.attempt}):{" "}
                  {liveState.retry.errorMessage}
                </Text>
              </View>
            )}
          </ScrollView>

          {/* Bottom Composer & Durable Controls */}
          <View style={styles.composerBar}>
            {liveState.busy && (
              <View style={styles.busyActionRow}>
                <Text style={styles.busyHintText}>
                  Agent is working... You can steer mid-run or abort:
                </Text>
                <Pressable style={styles.abortBtn} onPress={handleAbort}>
                  <Text style={styles.abortBtnText}>■ Abort</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.inputRow}>
              <TextInput
                style={styles.chatInput}
                placeholder={
                  liveState.busy
                    ? "Type instruction to steer or queue..."
                    : "Ask Pi to inspect, edit, or run tests..."
                }
                placeholderTextColor="#6b7280"
                value={inputText}
                onChangeText={setInputText}
                multiline
              />
              {liveState.busy ? (
                <View style={styles.busySendGroup}>
                  <Pressable
                    style={[
                      styles.steerBtn,
                      !inputText.trim() ? styles.btnDisabled : null,
                    ]}
                    onPress={() => handleSend("steer")}
                    disabled={!inputText.trim()}
                  >
                    <Text style={styles.steerBtnText}>⚡ Steer</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.queueBtn,
                      !inputText.trim() ? styles.btnDisabled : null,
                    ]}
                    onPress={() => handleSend("followUp")}
                    disabled={!inputText.trim()}
                  >
                    <Text style={styles.queueBtnText}>+ Queue</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  style={[
                    styles.sendBtn,
                    !inputText.trim() || sending ? styles.btnDisabled : null,
                  ]}
                  onPress={() => handleSend("steer")}
                  disabled={!inputText.trim() || sending}
                >
                  <Text style={styles.sendBtnText}>Send</Text>
                </Pressable>
              )}
            </View>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b0e14",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#141821",
    borderBottomWidth: 1,
    borderBottomColor: "#262d3d",
    gap: 10,
  },
  backBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#1f2937",
    borderRadius: 6,
  },
  backBtnText: {
    color: "#e5e7eb",
    fontSize: 12,
    fontWeight: "600",
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
  },
  sessionTitle: {
    color: "#f9fafb",
    fontSize: 15,
    fontWeight: "700",
  },
  cwdText: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: 5,
    backgroundColor: "#0d1017",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#262d3d",
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusLabel: {
    color: "#d1d5db",
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: "700",
  },
  subBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#10141d",
    borderBottomWidth: 1,
    borderBottomColor: "#1f2430",
    gap: 8,
  },
  modelMetaText: {
    flex: 1,
    minWidth: 0,
    color: "#93c5fd",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  tabGroup: {
    flexDirection: "row",
    flexShrink: 0,
    backgroundColor: "#0b0e14",
    borderRadius: 7,
    padding: 2,
    borderWidth: 1,
    borderColor: "#262d3d",
  },
  tabBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 5,
  },
  tabBtnActive: {
    backgroundColor: "#2563eb",
  },
  tabBtnText: {
    color: "#9ca3af",
    fontSize: 12,
    fontWeight: "600",
  },
  tabBtnTextActive: {
    color: "#ffffff",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#451a1a",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  errorBannerText: {
    flex: 1,
    color: "#fca5a5",
    fontSize: 12,
  },
  reconnectBtn: {
    backgroundColor: "#7f1d1d",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 5,
  },
  reconnectBtnText: {
    color: "#fecaca",
    fontSize: 11,
    fontWeight: "700",
  },
  chatScroll: {
    flex: 1,
  },
  chatContent: {
    padding: 12,
    gap: 12,
    paddingBottom: 24,
  },
  emptyChatBox: {
    marginTop: 48,
    padding: 20,
    backgroundColor: "#141821",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#262d3d",
    alignItems: "center",
    gap: 8,
  },
  emptyChatTitle: {
    color: "#f3f4f6",
    fontSize: 16,
    fontWeight: "700",
  },
  emptyChatSub: {
    color: "#9ca3af",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
  userRow: {
    alignItems: "flex-end",
  },
  userBubble: {
    maxWidth: "85%",
    backgroundColor: "#1e3a8a",
    borderColor: "#3b82f6",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  userText: {
    color: "#f9fafb",
    fontSize: 14,
    lineHeight: 20,
  },
  assistantBubble: {
    backgroundColor: "#141821",
    borderColor: "#262d3d",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  roleHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  assistantRoleText: {
    color: "#60a5fa",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: "700",
  },
  streamingBadge: {
    color: "#34d399",
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: "700",
  },
  abortedBadge: {
    color: "#fbbf24",
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: "700",
  },
  errorBadge: {
    color: "#f87171",
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: "700",
  },
  thinkingBox: {
    backgroundColor: "#0d1017",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#1f2430",
    padding: 8,
    gap: 6,
  },
  thinkingHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  thinkingTitle: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  thinkingBody: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 11,
    lineHeight: 16,
  },
  assistantText: {
    color: "#f3f4f6",
    fontSize: 14,
    lineHeight: 21,
  },
  errorMessageText: {
    color: "#fca5a5",
    fontFamily: MONO_FONT,
    fontSize: 12,
  },
  systemRow: {
    alignItems: "center",
    paddingVertical: 4,
  },
  systemText: {
    color: "#6b7280",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  retryBanner: {
    backgroundColor: "#422006",
    padding: 10,
    borderRadius: 8,
  },
  retryText: {
    color: "#fde68a",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  composerBar: {
    backgroundColor: "#141821",
    borderTopWidth: 1,
    borderTopColor: "#262d3d",
    padding: 10,
    gap: 8,
  },
  busyActionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1e1b4b",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  busyHintText: {
    flex: 1,
    color: "#c7d2fe",
    fontSize: 11,
  },
  abortBtn: {
    backgroundColor: "#dc2626",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 5,
  },
  abortBtnText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "700",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  chatInput: {
    flex: 1,
    backgroundColor: "#0b0e14",
    borderWidth: 1,
    borderColor: "#2e3646",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: "#f9fafb",
    fontSize: 14,
    maxHeight: 110,
  },
  sendBtn: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 8,
  },
  sendBtnText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  busySendGroup: {
    flexDirection: "row",
    gap: 6,
  },
  steerBtn: {
    backgroundColor: "#d97706",
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 8,
  },
  steerBtnText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  queueBtn: {
    backgroundColor: "#374151",
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 8,
  },
  queueBtnText: {
    color: "#e5e7eb",
    fontSize: 12,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.45,
  },
});
