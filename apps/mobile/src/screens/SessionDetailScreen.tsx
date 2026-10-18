import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Keyboard,
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
  type DeviceInfo,
  type DirectoryListing,
  type ModelRef,
  type MyPiClient,
  reduceSseFrame,
  type SendMessageRequest,
  type SessionLiveState,
  type SessionSummary,
  type ThinkingLevel,
  type TranscriptItem,
} from "@mypi/shared";
import { FileBrowserPanel } from "../components/FileBrowserPanel";
import { useWorkspaceChanges } from "../store/use-workspace-changes";
import { GitDiffPanel } from "../components/GitDiffPanel";
import { flushSessionViews, getSessionView, saveSessionView, sessionViewKey } from "../store/session-view-store";
import { ToolCallCard } from "../components/ToolCallCard";
import {
  type FailedSubmissionDraft,
  restoreFailedDraftToInput,
} from "../store/session-lifecycle";

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

function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1);
    return `${v.endsWith(".0") ? v.slice(0, -2) : v}M`;
  }
  if (n >= 1_000) {
    const v = (n / 1_000).toFixed(1);
    return `${v.endsWith(".0") ? v.slice(0, -2) : v}k`;
  }
  return String(n);
}

function shortenPath(fullPath: string): string {
  if (!fullPath) return "";
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length <= 2) return fullPath;
  return `…/${parts.slice(-2).join("/")}`;
}

function toRelativeMention(
  targetPath: string,
  baseCwd: string,
  isDir = false,
): string {
  const cleanBase = baseCwd.replace(/\/+$/, "");
  let rel = targetPath;
  if (targetPath === cleanBase) {
    rel = ".";
  } else if (targetPath.startsWith(`${cleanBase}/`)) {
    rel = targetPath.slice(cleanBase.length + 1);
  }
  if (isDir && !rel.endsWith("/")) {
    return `@${rel}/`;
  }
  return `@${rel}`;
}

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
  serverId,
  client,
  device,
  session,
  onSessionUpdated,
  onBack,
}: {
  serverId: string;
  client: MyPiClient;
  device?: DeviceInfo;
  session: SessionSummary;
  onSessionUpdated?: (updated: SessionSummary) => void;
  onBack: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"chat" | "files">("chat");
  const [showChanges, setShowChanges] = useState(false);
  const [liveState, setLiveState] = useState<SessionLiveState>(() =>
    createInitialSessionState(),
  );
  const [connStatus, setConnStatus] = useState<
    "connecting" | "connected" | "reconnecting" | "error"
  >("connecting");
  const [connError, setConnError] = useState<string | null>(null);
  const viewKey = sessionViewKey(serverId, session.id);
  const savedView = useRef(getSessionView(viewKey)).current;
  const [inputText, setInputText] = useState(savedView.draft);
  const [failedDraft, setFailedDraft] = useState<FailedSubmissionDraft | null>(savedView.failedDraft);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const restoreScrollRef = useRef(true);
  const userScrollingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const scrollRef = useRef<ScrollView | null>(null);
  const attachScroll = useCallback((node: ScrollView | null) => {
    if (node !== scrollRef.current) restoreScrollRef.current = true;
    scrollRef.current = node;
  }, []);
  const isNearBottomRef = useRef(savedView.following);
  const mountedRef = useRef(true);
  const currentSessionIdRef = useRef(session.id);
  currentSessionIdRef.current = session.id;
  const inputTextRef = useRef(inputText);
  inputTextRef.current = inputText;

  const updateInputText = (
    next: string | ((prev: string) => string),
  ): void => {
    const resolved =
      typeof next === "function" ? next(inputTextRef.current) : next;
    inputTextRef.current = resolved;
    setInputText(resolved);
    saveSessionView(viewKey, { draft: resolved });
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    saveSessionView(viewKey, { failedDraft });
  }, [viewKey, failedDraft]);

  useEffect(() => () => flushSessionViews(), []);

  // Separated Top Popovers:
  // - "rename": tapped top session title -> rename session or jump to CWD
  // - "compact" | "reset" | "usage": tapped telemetry bar / compact / reset icons
  const [topSheet, setTopSheet] = useState<
    "rename" | "usage" | "compact" | "reset" | null
  >(null);

  // Bottom Composer Quick Tray:
  // - "actions": tapped ＋ button -> quick action grid
  // - "mention": tapped @ File pill -> inline quick file/folder @-mention picker
  // - "model": tapped model pill -> live model & thinking switcher
  const [bottomTray, setBottomTray] = useState<
    "actions" | "mention" | "model" | null
  >(null);

  const [sessionTitleDraft, setSessionTitleDraft] = useState(session.name);
  const [compactInstructions, setCompactInstructions] = useState("");
  const [resetPrompt, setResetPrompt] = useState("");
  const [controlBusy, setControlBusy] = useState(false);

  // Quick @-mention inline directory browser state
  const [quickBrowsePath, setQuickBrowsePath] = useState<string>(session.cwd);
  const [quickListing, setQuickListing] = useState<DirectoryListing | null>(
    null,
  );
  const [quickFilter, setQuickFilter] = useState("");
  const [loadingQuickFiles, setLoadingQuickFiles] = useState(false);

  const workspace = useWorkspaceChanges(client, session.id, liveState.cwd || session.cwd);
  const openChanges = () => {
    Keyboard.dismiss();
    setBottomTray(null);
    setShowChanges(true);
    workspace.refresh();
  };

  // Subscribe to SSE durable stream and auto-reconnect on foreground wakeup
  useEffect(() => {
    const unsubscribe = client.subscribeSessionEvents(session.id, {
      onFrame: (frame) => {
        if (frame.type === "snapshot") setSnapshotReady(true);
        if (frame.type === "snapshot" || (frame.type === "events" && frame.events.some(
          (event) => event.type === "tool_execution_end" || event.type === "run_end",
        ))) workspace.refresh();
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
      } else {
        flushSessionViews();
      }
    });

    return () => {
      unsubscribe();
      appStateSub.remove();
    };
  }, [client, session.id, streamGeneration]);

  const activeModel = liveState.model || session.model;
  const activeThinking = liveState.thinkingLevel || session.thinkingLevel;
  const activeCwd = liveState.cwd || session.cwd;

  // Keep quickBrowsePath synced when session CWD changes
  useEffect(() => {
    setQuickBrowsePath(activeCwd);
  }, [activeCwd]);

  // Auto-scroll only when near bottom and transcript messages/streaming actually advance
  const lastTranscriptItem = liveState.items[liveState.items.length - 1];
  const transcriptAdvanceKey = useMemo(() => {
    if (!lastTranscriptItem) return "0";
    if (lastTranscriptItem.kind === "assistant") {
      const toolOutLen = lastTranscriptItem.toolCalls.reduce(
        (acc, t) => acc + t.output.length + t.status.length,
        0,
      );
      return `${liveState.items.length}:${lastTranscriptItem.id}:${lastTranscriptItem.status}:${lastTranscriptItem.thinking.length}:${lastTranscriptItem.text.length}:${lastTranscriptItem.toolCalls.length}:${toolOutLen}`;
    }
    return `${liveState.items.length}:${lastTranscriptItem.id}:${lastTranscriptItem.text.length}`;
  }, [liveState.items.length, lastTranscriptItem]);

  useEffect(() => {
    if (!snapshotReady) return;
    if (activeTab === "chat" && !showChanges && isNearBottomRef.current) {
      saveSessionView(viewKey, { advanceKey: transcriptAdvanceKey });
    } else if (transcriptAdvanceKey !== getSessionView(viewKey).advanceKey) {
      setHasNewMessages(true);
    }
  }, [transcriptAdvanceKey, activeTab, snapshotReady, viewKey, showChanges]);

  const scrollToLatest = () => {
    isNearBottomRef.current = true;
    setHasNewMessages(false);
    saveSessionView(viewKey, { following: true, advanceKey: transcriptAdvanceKey });
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  const restoreOrFollowScroll = () => {
    if (!snapshotReady || showChanges || userScrollingRef.current) return;
    if (isNearBottomRef.current) {
      scrollRef.current?.scrollToEnd({ animated: false });
    } else if (restoreScrollRef.current) {
      scrollRef.current?.scrollTo({ y: getSessionView(viewKey).offset, animated: false });
    }
    restoreScrollRef.current = false;
  };

  const modelMeta = useMemo(
    () =>
      device?.models.find(
        (m) =>
          m.provider === activeModel.provider &&
          m.modelId === activeModel.modelId,
      ),
    [device?.models, activeModel.provider, activeModel.modelId],
  );

  const contextWindow = modelMeta?.contextWindow || 200_000;
  const contextTokens = liveState.usage.contextTokens || 0;
  const contextPercent = Math.min(
    100,
    Math.round((contextTokens / contextWindow) * 100),
  );

  // Load quickBrowsePath files when inline @-mention tray opens or navigates
  useEffect(() => {
    if (bottomTray !== "mention") return;
    const targetDir = quickBrowsePath || activeCwd;
    let cancelled = false;
    setLoadingQuickFiles(true);
    client
      .listDirs(targetDir, { includeHidden: false })
      .then((res) => {
        if (!cancelled) setQuickListing(res);
      })
      .catch(() => {
        // Ignore
      })
      .finally(() => {
        if (!cancelled) setLoadingQuickFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bottomTray, quickBrowsePath, activeCwd, client]);

  const submitMessage = async (request: SendMessageRequest) => {
    const targetSessionId = session.id;
    setSending(true);
    try {
      await client.sendMessage(targetSessionId, request);
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setFailedDraft(null);
        setConnError(null);
      }
    } catch (err) {
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        const error = err instanceof Error ? err.message : String(err);
        // A lost response does not mean the server rejected this request.
        setFailedDraft({ ...request, error });
        setConnError(error);
      }
    } finally {
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setSending(false);
      }
    }
  };

  const handleSend = async (whenBusy: "steer" | "followUp" = "steer") => {
    const content = inputTextRef.current.trim();
    if (!content || sending || failedDraft) return;

    const requestId = `mobile-${session.id}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    isNearBottomRef.current = true;
    updateInputText("");
    setBottomTray(null);
    await submitMessage({ requestId, content, whenBusy });
  };

  const handleRetryFailedDraft = async () => {
    if (!failedDraft || sending) return;
    const { error, ...request } = failedDraft;
    await submitMessage(request);
  };

  const handleRestoreFailedDraft = () => {
    if (!failedDraft || sending) return;
    const restored = restoreFailedDraftToInput(
      inputTextRef.current,
      failedDraft,
    );
    updateInputText(restored.inputText);
    setFailedDraft(null);
  };

  const handleAbort = async () => {
    const targetSessionId = session.id;
    try {
      await client.abortSession(targetSessionId);
    } catch (err) {
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setConnError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handleAbortSubmission = async (submissionId: number) => {
    const targetSessionId = session.id;
    try {
      await client.abortSubmission(targetSessionId, submissionId);
    } catch (err) {
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setConnError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handleUpdateSessionConfig = async (patch: {
    name?: string;
    model?: ModelRef;
    thinkingLevel?: ThinkingLevel;
    cwd?: string;
  }) => {
    const targetSessionId = session.id;
    setControlBusy(true);
    try {
      const updated = await client.updateSession(targetSessionId, patch);
      onSessionUpdated?.(updated);
      if (
        !mountedRef.current ||
        currentSessionIdRef.current !== targetSessionId
      ) {
        return;
      }
      setLiveState((prev) => ({
        ...prev,
        cwd: updated.cwd,
        model: updated.model,
        thinkingLevel: updated.thinkingLevel,
      }));
      if (patch.name) {
        setTopSheet(null);
      }
    } catch (err) {
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setConnError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setControlBusy(false);
      }
    }
  };

  const handleCompact = async () => {
    if (controlBusy) return;
    const targetSessionId = session.id;
    setControlBusy(true);
    try {
      await client.compactSession(targetSessionId, {
        instructions: compactInstructions.trim() || undefined,
      });
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setCompactInstructions("");
        setTopSheet(null);
      }
    } catch (err) {
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setConnError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setControlBusy(false);
      }
    }
  };

  const handleReset = async () => {
    if (controlBusy) return;
    const targetSessionId = session.id;
    setControlBusy(true);
    try {
      await client.resetSession(targetSessionId, {
        handoff: resetPrompt.trim() || undefined,
      });
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setResetPrompt("");
        setTopSheet(null);
      }
    } catch (err) {
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setConnError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setControlBusy(false);
      }
    }
  };

  const handleMentionPath = (mentionToken: string) => {
    updateInputText((prev) => {
      const trimmed = prev.trimEnd();
      if (!trimmed) return `${mentionToken} `;
      return `${trimmed} ${mentionToken} `;
    });
    setBottomTray(null);
    setActiveTab("chat");
  };

  const statusColor =
    connStatus === "connected"
      ? "#10b981"
      : connStatus === "connecting" || connStatus === "reconnecting"
        ? "#f59e0b"
        : "#ef4444";

  const ctxBarColor =
    contextPercent >= 85
      ? "#ef4444"
      : contextPercent >= 65
        ? "#f59e0b"
        : "#3b82f6";

  const filteredQuickDirs = useMemo(() => {
    const dirs = quickListing?.dirs ?? [];
    const q = quickFilter.trim().toLowerCase();
    if (!q) return dirs.slice(0, 12);
    return dirs.filter((d) => d.name.toLowerCase().includes(q)).slice(0, 12);
  }, [quickListing?.dirs, quickFilter]);

  const filteredQuickFiles = useMemo(() => {
    const files = quickListing?.files ?? [];
    const q = quickFilter.trim().toLowerCase();
    if (!q) return files.slice(0, 20);
    return files.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 20);
  }, [quickListing?.files, quickFilter]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Row 1: Compact Top Header (Back Icon + Session Title/CWD + 3-Way View Tabs) */}
      <View style={styles.topBar}>
        <Pressable
          onPress={onBack}
          style={styles.backIconBtn}
          accessibilityLabel="Back to sessions"
        >
          <Text style={styles.backIconText}>‹</Text>
        </Pressable>

        <Pressable
          style={styles.titleBlock}
          onPress={() =>
            setTopSheet((prev) => (prev === "rename" ? null : "rename"))
          }
        >
          <View style={styles.titleLine}>
            <View
              style={[styles.statusDot, { backgroundColor: statusColor }]}
            />
            <Text style={styles.sessionTitle} numberOfLines={1}>
              {session.name}
            </Text>
            <Text style={styles.editHintIcon}>✎</Text>
          </View>
          <Text style={styles.cwdText} numberOfLines={1}>
            📁 {shortenPath(activeCwd)}
          </Text>
        </Pressable>

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
              activeTab === "files" ? styles.tabBtnActive : null,
            ]}
            onPress={() => setActiveTab("files")}
          >
            <Text
              style={[
                styles.tabBtnText,
                activeTab === "files" ? styles.tabBtnTextActive : null,
              ]}
            >
              Files
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Row 2: Slim Telemetry & Context Lifecycle Strip (Distinct from Title Popover) */}
      <View style={styles.telemetryBar}>
        <Pressable
          style={styles.ctxSummaryPress}
          onPress={() =>
            setTopSheet((prev) => (prev === "usage" ? null : "usage"))
          }
        >
          <View style={styles.miniProgressTrack}>
            <View
              style={[
                styles.miniProgressFill,
                {
                  width: `${Math.max(4, contextPercent)}%`,
                  backgroundColor: ctxBarColor,
                },
              ]}
            />
          </View>
          <Text style={styles.ctxMetaText} numberOfLines={1}>
            Ctx {formatCompactNumber(contextTokens)} /{" "}
            {formatCompactNumber(contextWindow)} ({contextPercent}%)
            {liveState.usage.totalCost > 0
              ? ` · $${liveState.usage.totalCost.toFixed(2)}`
              : ""}
          </Text>
        </Pressable>

        <View style={styles.telemetryActions}>
          <Pressable
            style={[
              styles.miniIconPill,
              topSheet === "compact" ? styles.miniIconPillActive : null,
            ]}
            onPress={() =>
              setTopSheet((prev) => (prev === "compact" ? null : "compact"))
            }
          >
            <Text style={styles.miniIconPillText}>🗜 Compact</Text>
          </Pressable>
          <Pressable
            style={[
              styles.miniIconPill,
              topSheet === "reset" ? styles.miniIconPillActive : null,
            ]}
            onPress={() =>
              setTopSheet((prev) => (prev === "reset" ? null : "reset"))
            }
          >
            <Text style={styles.miniIconPillText}>↺ Reset</Text>
          </Pressable>
        </View>
      </View>

      {/* Focused Top Popover 1: Session Rename & Working Directory (from tapping Title) */}
      {topSheet === "rename" && (
        <View style={styles.topPopoverCard}>
          <View style={styles.popoverHeaderRow}>
            <Text style={styles.popoverTitle}>SESSION TITLE & WORKSPACE</Text>
            <Pressable onPress={() => setTopSheet(null)}>
              <Text style={styles.popoverCloseText}>✕</Text>
            </Pressable>
          </View>
          <View style={styles.renameRow}>
            <TextInput
              style={[styles.popoverInput, { flex: 1 }]}
              value={sessionTitleDraft}
              onChangeText={setSessionTitleDraft}
              placeholder="Session title"
              placeholderTextColor="#6b7280"
            />
            <Pressable
              style={styles.popoverPrimaryBtn}
              onPress={() =>
                handleUpdateSessionConfig({ name: sessionTitleDraft })
              }
              disabled={controlBusy || !sessionTitleDraft.trim()}
            >
              <Text style={styles.popoverPrimaryBtnText}>Save</Text>
            </Pressable>
          </View>
          <View style={styles.cwdSwitchRow}>
            <Text style={styles.cwdDrawerText} numberOfLines={1}>
              📁 {activeCwd}
            </Text>
            <Pressable
              style={styles.popoverSecondaryBtn}
              onPress={() => {
                setTopSheet(null);
                setActiveTab("files");
              }}
            >
              <Text style={styles.popoverSecondaryBtnText}>Switch CWD →</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Focused Top Popover 2: Token Breakdown / Compact / Reset (from Telemetry Strip) */}
      {(topSheet === "usage" ||
        topSheet === "compact" ||
        topSheet === "reset") && (
        <View style={styles.topPopoverCard}>
          <View style={styles.popoverHeaderRow}>
            <Text style={styles.popoverTitle}>
              {topSheet === "compact"
                ? "🗜 COMPACT CONTEXT WINDOW"
                : topSheet === "reset"
                  ? "↺ RESET SESSION CONTEXT"
                  : "SESSION TOKEN TELEMETRY"}
            </Text>
            <Pressable onPress={() => setTopSheet(null)}>
              <Text style={styles.popoverCloseText}>✕</Text>
            </Pressable>
          </View>

          <Text style={styles.usageBreakdownText}>
            Active Context: {formatCompactNumber(contextTokens)} /{" "}
            {formatCompactNumber(contextWindow)} ({contextPercent}%) • Session
            Total: {formatCompactNumber(liveState.usage.totalTokens)} tok (In{" "}
            {formatCompactNumber(liveState.usage.inputTokens)} · Out{" "}
            {formatCompactNumber(liveState.usage.outputTokens)} · Cache{" "}
            {formatCompactNumber(liveState.usage.cacheReadTokens)})
            {liveState.usage.totalCost > 0
              ? ` · $${liveState.usage.totalCost.toFixed(4)}`
              : ""}
          </Text>

          {topSheet === "compact" && (
            <View style={styles.renameRow}>
              <TextInput
                style={[styles.popoverInput, { flex: 1 }]}
                placeholder="Optional focus instructions for summary..."
                placeholderTextColor="#6b7280"
                value={compactInstructions}
                onChangeText={setCompactInstructions}
              />
              <Pressable
                style={styles.popoverPrimaryBtn}
                onPress={handleCompact}
                disabled={controlBusy}
              >
                <Text style={styles.popoverPrimaryBtnText}>
                  {controlBusy ? "..." : "Compact"}
                </Text>
              </Pressable>
            </View>
          )}

          {topSheet === "reset" && (
            <View style={styles.renameRow}>
              <TextInput
                style={[styles.popoverInput, { flex: 1 }]}
                placeholder="Optional handoff prompt after reset..."
                placeholderTextColor="#6b7280"
                value={resetPrompt}
                onChangeText={setResetPrompt}
              />
              <Pressable
                style={[
                  styles.popoverPrimaryBtn,
                  { backgroundColor: "#dc2626" },
                ]}
                onPress={handleReset}
                disabled={controlBusy}
              >
                <Text style={styles.popoverPrimaryBtnText}>
                  {controlBusy ? "..." : "Reset"}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      {(connError || liveState.lastError) && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText} numberOfLines={2}>
            {connError || liveState.lastError}
          </Text>
          <Pressable
            onPress={() => {
              setConnError(null);
              setLiveState((prev) => ({ ...prev, lastError: undefined }));
              setStreamGeneration((g) => g + 1);
            }}
            style={styles.reconnectBtn}
          >
            <Text style={styles.reconnectBtnText}>
              {connError ? "Reconnect" : "Dismiss"}
            </Text>
          </Pressable>
        </View>
      )}

      {activeTab === "files" ? (
        <View style={styles.filesTabContainer}>
          <FileBrowserPanel
            client={client}
            initialPath={activeCwd}
            startDirs={device?.startDirs ?? []}
            sessionCwd={activeCwd}
            showFiles={true}
            fullHeight={true}
            onSetSessionCwd={async (newCwd) => {
              await handleUpdateSessionConfig({ cwd: newCwd });
            }}
            onMentionPath={(mentionToken) => {
              handleMentionPath(mentionToken);
            }}
          />
        </View>
      ) : (
        <>
          <ScrollView
            ref={attachScroll}
            style={styles.chatScroll}
            contentContainerStyle={styles.chatContent}
            scrollEventThrottle={32}
            onContentSizeChange={restoreOrFollowScroll}
            onLayout={restoreOrFollowScroll}
            onScrollBeginDrag={() => { userScrollingRef.current = true; }}
            onScrollEndDrag={() => { userScrollingRef.current = false; }}
            onMomentumScrollBegin={() => { userScrollingRef.current = true; }}
            onMomentumScrollEnd={() => { userScrollingRef.current = false; }}
            onScroll={(e) => {
              const { layoutMeasurement, contentOffset, contentSize } =
                e.nativeEvent;
              const distanceFromBottom =
                contentSize.height -
                (layoutMeasurement.height + contentOffset.y);
              if (!snapshotReady || restoreScrollRef.current) return;
              if (userScrollingRef.current) {
                isNearBottomRef.current = distanceFromBottom <= 48;
                if (isNearBottomRef.current) setHasNewMessages(false);
                saveSessionView(viewKey, {
                  offset: Math.max(0, contentOffset.y),
                  following: isNearBottomRef.current,
                  ...(isNearBottomRef.current ? { advanceKey: transcriptAdvanceKey } : {}),
                });
              }
            }}
          >
            {liveState.items.length === 0 ? (
              <View style={styles.emptyChatBox}>
                <Text style={styles.emptyChatTitle}>
                  Durable Session Ready
                </Text>
                <Text style={styles.emptyChatSub}>
                  Send a prompt below, or use the quick toolbar next to the input box to @-mention files, switch models, or manage context.
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

          {hasNewMessages && (
            <Pressable style={styles.newMessages} onPress={scrollToLatest} accessibilityRole="button">
              <Text style={styles.newMessagesText}>新消息 ↓</Text>
            </Pressable>
          )}

          {/* Bottom Composer Dock & Thumb-Reachable Quick Popovers */}
          <View style={styles.composerDock}>
            {/* Queued Inbox Items Strip with Withdraw */}
            {liveState.inbox.length > 0 && (
              <View style={styles.inboxQueueBox}>
                <Text style={styles.inboxQueueHeader}>
                  QUEUED SUBMISSIONS ({liveState.inbox.length})
                </Text>
                {liveState.inbox.map((qItem) => (
                  <View key={qItem.id} style={styles.inboxItemRow}>
                    <Text style={styles.inboxTimingBadge}>
                      {qItem.mode === "steer" ? "⚡ STEER" : "⏳ QUEUE"}
                    </Text>
                    <Text style={styles.inboxItemText} numberOfLines={1}>
                      {qItem.text || `Submission #${qItem.id}`}
                    </Text>
                    <Pressable
                      style={styles.inboxAbortBtn}
                      onPress={() => handleAbortSubmission(qItem.id)}
                    >
                      <Text style={styles.inboxAbortText}>✕ Withdraw</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            {/* Bottom Tray 1: Quick Actions Menu (Toggled by ＋ button) */}
            {bottomTray === "actions" && (
              <View style={styles.bottomSheetCard}>
                <View style={styles.popoverHeaderRow}>
                  <Text style={styles.popoverTitle}>QUICK SESSION ACTIONS</Text>
                  <Pressable onPress={() => setBottomTray(null)}>
                    <Text style={styles.popoverCloseText}>✕</Text>
                  </Pressable>
                </View>
                <View style={styles.quickActionsGrid}>
                  <Pressable
                    style={styles.quickActionTile}
                    onPress={() => setBottomTray("mention")}
                  >
                    <Text style={styles.quickActionIcon}>@</Text>
                    <Text style={styles.quickActionLabel}>Mention File</Text>
                  </Pressable>
                  <Pressable
                    style={styles.quickActionTile}
                    onPress={() => setBottomTray("model")}
                  >
                    <Text style={styles.quickActionIcon}>⚡</Text>
                    <Text style={styles.quickActionLabel}>Model & Effort</Text>
                  </Pressable>
                  <Pressable
                    style={styles.quickActionTile}
                    onPress={() => {
                      setBottomTray(null);
                      setTopSheet("compact");
                    }}
                  >
                    <Text style={styles.quickActionIcon}>🗜</Text>
                    <Text style={styles.quickActionLabel}>Compact Ctx</Text>
                  </Pressable>
                  <Pressable
                    style={styles.quickActionTile}
                    onPress={() => {
                      setBottomTray(null);
                      setTopSheet("reset");
                    }}
                  >
                    <Text style={styles.quickActionIcon}>↺</Text>
                    <Text style={styles.quickActionLabel}>Reset Ctx</Text>
                  </Pressable>
                  <Pressable
                    style={styles.quickActionTile}
                    onPress={() => {
                      setBottomTray(null);
                      setActiveTab("files");
                    }}
                  >
                    <Text style={styles.quickActionIcon}>📁</Text>
                    <Text style={styles.quickActionLabel}>Browse Files</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Bottom Tray 2: Inline Quick @-Mention File Picker (Toggled by @ button) */}
            {bottomTray === "mention" && (
              <View style={styles.bottomSheetCard}>
                <View style={styles.popoverHeaderRow}>
                  <View style={styles.inlineHeaderLeft}>
                    {quickBrowsePath !== activeCwd && quickListing?.parent ? (
                      <Pressable
                        style={styles.quickUpBtn}
                        onPress={() => {
                          setQuickFilter("");
                          setQuickBrowsePath(quickListing.parent!);
                        }}
                      >
                        <Text style={styles.quickUpBtnText}>⬆ Up</Text>
                      </Pressable>
                    ) : null}
                    <Text style={styles.popoverTitle} numberOfLines={1}>
                      📁{" "}
                      {toRelativeMention(
                        quickBrowsePath || activeCwd,
                        activeCwd,
                        true,
                      ).slice(1)}
                    </Text>
                  </View>

                  <View style={styles.inlineHeaderRight}>
                    {quickBrowsePath !== activeCwd ? (
                      <Pressable
                        style={styles.mentionCurrentDirBtn}
                        onPress={() =>
                          handleMentionPath(
                            toRelativeMention(quickBrowsePath, activeCwd, true),
                          )
                        }
                      >
                        <Text style={styles.mentionCurrentDirText}>
                          + @Folder
                        </Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      onPress={() => {
                        setBottomTray(null);
                        setActiveTab("files");
                      }}
                    >
                      <Text style={styles.fullBrowserLink}>Files ↗</Text>
                    </Pressable>
                    <Pressable onPress={() => setBottomTray(null)}>
                      <Text style={styles.popoverCloseText}>✕</Text>
                    </Pressable>
                  </View>
                </View>

                <TextInput
                  style={styles.popoverInput}
                  placeholder="Filter current folder (tap folder to open, file to @)..."
                  placeholderTextColor="#6b7280"
                  value={quickFilter}
                  onChangeText={setQuickFilter}
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                {loadingQuickFiles ? (
                  <ActivityIndicator
                    color="#60a5fa"
                    size="small"
                    style={{ marginVertical: 10 }}
                  />
                ) : (
                  <ScrollView
                    style={styles.quickMentionScroll}
                    contentContainerStyle={styles.quickMentionList}
                    nestedScrollEnabled
                  >
                    {filteredQuickDirs.map((d) => (
                      <View key={d.path} style={styles.quickDirGroup}>
                        <Pressable
                          style={styles.quickDirMainPress}
                          onPress={() => {
                            setQuickFilter("");
                            setQuickBrowsePath(d.path);
                          }}
                        >
                          <Text style={styles.quickDirText}>
                            📁 {d.name}/ ›
                          </Text>
                        </Pressable>
                        <Pressable
                          style={styles.quickDirAtBtn}
                          onPress={() =>
                            handleMentionPath(
                              toRelativeMention(d.path, activeCwd, true),
                            )
                          }
                        >
                          <Text style={styles.quickDirAtText}>@</Text>
                        </Pressable>
                      </View>
                    ))}
                    {filteredQuickFiles.map((f) => (
                      <Pressable
                        key={f.path}
                        style={styles.quickMentionChip}
                        onPress={() =>
                          handleMentionPath(
                            toRelativeMention(f.path, activeCwd, false),
                          )
                        }
                      >
                        <Text style={styles.quickMentionChipText}>
                          📄 {f.name}
                        </Text>
                      </Pressable>
                    ))}
                    {filteredQuickDirs.length === 0 &&
                      filteredQuickFiles.length === 0 && (
                        <Text style={styles.emptyQuickText}>
                          No matching files in this folder.
                        </Text>
                      )}
                  </ScrollView>
                )}
              </View>
            )}

            {/* Bottom Tray 3: Thumb-Reachable Model & Thinking Switcher */}
            {bottomTray === "model" && device && device.models.length > 0 && (
              <View style={styles.bottomSheetCard}>
                <View style={styles.popoverHeaderRow}>
                  <Text style={styles.popoverTitle}>
                    SWITCH MODEL & THINKING EFFORT
                  </Text>
                  <Pressable onPress={() => setBottomTray(null)}>
                    <Text style={styles.popoverCloseText}>✕</Text>
                  </Pressable>
                </View>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ flexGrow: 0 }}
                  contentContainerStyle={styles.drawerPillsRow}
                >
                  {device.models.map((m) => {
                    const active =
                      activeModel.provider === m.provider &&
                      activeModel.modelId === m.modelId;
                    return (
                      <Pressable
                        key={`${m.provider}/${m.modelId}`}
                        style={[
                          styles.drawerPill,
                          active ? styles.drawerPillActive : null,
                        ]}
                        onPress={() =>
                          handleUpdateSessionConfig({
                            model: { provider: m.provider, modelId: m.modelId },
                          })
                        }
                      >
                        <Text
                          style={[
                            styles.drawerPillText,
                            active ? styles.drawerPillTextActive : null,
                          ]}
                        >
                          {m.provider}/{m.modelId}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>

                <View style={styles.drawerThinkingRow}>
                  {THINKING_LEVELS.map((lvl) => {
                    const active = activeThinking === lvl;
                    return (
                      <Pressable
                        key={lvl}
                        style={[
                          styles.drawerThinkingPill,
                          active ? styles.drawerThinkingPillActive : null,
                        ]}
                        onPress={() =>
                          handleUpdateSessionConfig({ thinkingLevel: lvl })
                        }
                      >
                        <Text
                          style={[
                            styles.drawerPillText,
                            active ? styles.drawerPillTextActive : null,
                          ]}
                        >
                          {lvl}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            {failedDraft && (
              <View style={styles.failedDraftBox}>
                <View style={styles.failedDraftTextCol}>
                  <Text style={styles.failedDraftTitle}>
                    Delivery unconfirmed:
                  </Text>
                  <Text style={styles.failedDraftPreview} numberOfLines={2}>
                    {failedDraft.content}
                  </Text>
                </View>
                <View style={styles.failedDraftActions}>
                  <Pressable
                    style={styles.failedRetryBtn}
                    onPress={handleRetryFailedDraft}
                    disabled={sending}
                    accessibilityLabel="Retry failed message"
                  >
                    <Text style={styles.failedRetryBtnText}>↻ Retry</Text>
                  </Pressable>
                  <Pressable
                    style={styles.failedRestoreBtn}
                    onPress={handleRestoreFailedDraft}
                    disabled={sending}
                    accessibilityLabel="Restore failed message for editing"
                  >
                    <Text style={styles.failedRestoreBtnText}>Restore</Text>
                  </Pressable>
                  <Pressable
                    style={styles.failedDismissBtn}
                    onPress={() => setFailedDraft(null)}
                    disabled={sending}
                    accessibilityLabel="Dismiss failed message"
                  >
                    <Text style={styles.failedDismissBtnText}>✕</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {(workspace.info?.files.length ?? 0) > 0 && (
              <Pressable style={styles.changesEntry} onPress={openChanges} accessibilityRole="button">
                <Text style={styles.changesEntryText}>{workspace.info!.files.length} 个文件有改动</Text>
                <Text style={styles.changesEntryHint}>{workspace.stale ? "暂未更新 · " : ""}›</Text>
              </Pressable>
            )}
            {workspace.stale && !workspace.info?.files.length && (
              <Pressable onPress={workspace.refresh} style={styles.changesEntry}>
                <Text style={styles.changesEntryHint}>改动暂未更新 · 重试</Text>
              </Pressable>
            )}

            {/* Unified Two-Row Modern Composer Card */}
            <View style={styles.composerCard}>
              <TextInput
                style={styles.chatInput}
                placeholder={
                  liveState.busy
                    ? "Type instruction to steer mid-run or queue..."
                    : "Ask Pi to inspect, edit, or @-mention files..."
                }
                placeholderTextColor="#6b7280"
                value={inputText}
                accessibilityLabel="Message"
                onChangeText={updateInputText}
                multiline
              />

              {/* Perfectly Aligned Bottom Action Toolbar inside Composer Card */}
              <View style={styles.composerToolbar}>
                <View style={styles.composerToolsLeft}>
                  <Pressable
                    style={[
                      styles.toolCircleBtn,
                      bottomTray === "actions"
                        ? styles.toolPillBtnActive
                        : null,
                    ]}
                    onPress={() =>
                      setBottomTray((prev) =>
                        prev === "actions" ? null : "actions",
                      )
                    }
                    accessibilityLabel="Quick actions"
                  >
                    <View
                      style={[
                        styles.plusIconBox,
                        bottomTray === "actions"
                          ? styles.plusIconBoxRotated
                          : null,
                      ]}
                    >
                      <View style={styles.plusBarH} />
                      <View style={styles.plusBarV} />
                    </View>
                  </Pressable>

                  <Pressable
                    style={[
                      styles.toolCircleBtn,
                      bottomTray === "mention"
                        ? styles.toolPillBtnActive
                        : null,
                    ]}
                    onPress={() =>
                      setBottomTray((prev) =>
                        prev === "mention" ? null : "mention",
                      )
                    }
                    accessibilityLabel="Mention file"
                  >
                    <Text style={styles.toolAtBtnText}>@</Text>
                  </Pressable>

                  <Pressable
                    style={[
                      styles.toolPillBtn,
                      bottomTray === "model" ? styles.toolPillBtnActive : null,
                    ]}
                    onPress={() =>
                      setBottomTray((prev) =>
                        prev === "model" ? null : "model",
                      )
                    }
                    accessibilityLabel="Switch model and thinking level"
                  >
                    <Text style={styles.toolPillModelText} numberOfLines={1}>
                      ⚡ {activeModel.modelId} · {activeThinking}
                    </Text>
                  </Pressable>
                </View>

                <View style={styles.composerToolsRight}>
                  {liveState.busy ? (
                    <>
                      {inputText.trim().length > 0 ? (
                        <>
                          <Pressable
                            style={styles.steerPillBtn}
                            onPress={() => handleSend("steer")}
                            disabled={sending || Boolean(failedDraft)}
                          >
                            <Text style={styles.sendPillText}>⚡ Steer</Text>
                          </Pressable>
                          <Pressable
                            style={styles.queuePillBtn}
                            onPress={() => handleSend("followUp")}
                            disabled={sending || Boolean(failedDraft)}
                          >
                            <Text style={styles.queuePillText}>+ Queue</Text>
                          </Pressable>
                        </>
                      ) : null}
                      <Pressable
                        style={styles.stopPillBtn}
                        onPress={handleAbort}
                      >
                        <Text style={styles.sendPillText}>■ Stop</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      style={[
                        styles.sendPillBtn,
                        !inputText.trim() || sending || failedDraft
                          ? styles.sendPillBtnDisabled
                          : null,
                      ]}
                      onPress={() => handleSend("steer")}
                      disabled={!inputText.trim() || sending || Boolean(failedDraft)}
                      accessibilityLabel="Send message"
                    >
                      <Text style={styles.sendPillText}>↑ Send</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            </View>
          </View>
        </>
      )}
      <GitDiffPanel
        key={activeCwd}
        info={workspace.info}
        stale={workspace.stale}
        visible={showChanges}
        onClose={() => setShowChanges(false)}
        onRefresh={workspace.refresh}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  changesEntry: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, paddingVertical: 12, minHeight: 44 },
  changesEntryText: { color: "#cbd5e1", fontSize: 12 },
  changesEntryHint: { color: "#94a3b8", fontSize: 12 },
  newMessages: {
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
    marginVertical: 6,
  },
  newMessagesText: { color: "#93c5fd", fontSize: 12, fontWeight: "600" },
  container: {
    flex: 1,
    backgroundColor: "#0b0e14",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#141821",
    borderBottomWidth: 1,
    borderBottomColor: "#222938",
    gap: 8,
  },
  backIconBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#1f2937",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#374151",
  },
  backIconText: {
    color: "#f3f4f6",
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 22,
    marginTop: -2,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  sessionTitle: {
    flexShrink: 1,
    color: "#f9fafb",
    fontSize: 14,
    fontWeight: "700",
  },
  editHintIcon: {
    color: "#6b7280",
    fontSize: 11,
  },
  cwdText: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 10,
  },
  tabGroup: {
    flexDirection: "row",
    flexShrink: 0,
    backgroundColor: "#0b0e14",
    borderRadius: 8,
    padding: 2,
    borderWidth: 1,
    borderColor: "#262d3d",
  },
  tabBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  tabBtnActive: {
    backgroundColor: "#2563eb",
  },
  tabBtnText: {
    color: "#9ca3af",
    fontSize: 11,
    fontWeight: "600",
  },
  tabBtnTextActive: {
    color: "#ffffff",
  },
  telemetryBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: "#10141d",
    borderBottomWidth: 1,
    borderBottomColor: "#1f2430",
    gap: 8,
  },
  ctxSummaryPress: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    minWidth: 0,
  },
  miniProgressTrack: {
    width: 32,
    height: 5,
    backgroundColor: "#1f2937",
    borderRadius: 3,
    overflow: "hidden",
  },
  miniProgressFill: {
    height: "100%",
    borderRadius: 3,
  },
  ctxMetaText: {
    flex: 1,
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 10,
  },
  telemetryActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  miniIconPill: {
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: "#182030",
    borderWidth: 1,
    borderColor: "#283246",
    alignItems: "center",
    justifyContent: "center",
  },
  miniIconPillActive: {
    backgroundColor: "#1e3a8a",
    borderColor: "#60a5fa",
  },
  miniIconPillText: {
    color: "#cbd5e1",
    fontSize: 10,
    fontWeight: "600",
  },
  topPopoverCard: {
    backgroundColor: "#131824",
    borderBottomWidth: 1,
    borderBottomColor: "#2e3646",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  popoverHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  popoverTitle: {
    color: "#60a5fa",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  popoverCloseText: {
    color: "#9ca3af",
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 4,
  },
  renameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  popoverInput: {
    backgroundColor: "#0b0e14",
    borderWidth: 1,
    borderColor: "#2e3646",
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: "#f9fafb",
    fontSize: 12,
  },
  popoverPrimaryBtn: {
    height: 32,
    backgroundColor: "#2563eb",
    paddingHorizontal: 12,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  popoverPrimaryBtnText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  cwdSwitchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cwdDrawerText: {
    flex: 1,
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  popoverSecondaryBtn: {
    backgroundColor: "#1f2937",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#374151",
  },
  popoverSecondaryBtnText: {
    color: "#93c5fd",
    fontSize: 11,
    fontWeight: "600",
  },
  usageBreakdownText: {
    color: "#d1d5db",
    fontFamily: MONO_FONT,
    fontSize: 10,
    lineHeight: 15,
  },
  filesTabContainer: {
    flex: 1,
    padding: 12,
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
    paddingBottom: 20,
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
  composerDock: {
    backgroundColor: "#121620",
    borderTopWidth: 1,
    borderTopColor: "#232a3b",
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
  },
  inboxQueueBox: {
    backgroundColor: "#0d1017",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#374151",
    padding: 8,
    gap: 5,
  },
  inboxQueueHeader: {
    color: "#93c5fd",
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: "700",
  },
  inboxItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#141821",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 5,
  },
  inboxTimingBadge: {
    color: "#fbbf24",
    fontFamily: MONO_FONT,
    fontSize: 9,
    fontWeight: "700",
  },
  inboxItemText: {
    flex: 1,
    color: "#e5e7eb",
    fontSize: 12,
  },
  inboxAbortBtn: {
    backgroundColor: "#7f1d1d",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
  },
  inboxAbortText: {
    color: "#fecaca",
    fontSize: 10,
    fontWeight: "700",
  },
  bottomSheetCard: {
    backgroundColor: "#0d111a",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2b3548",
    padding: 10,
    gap: 8,
  },
  quickActionsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  quickActionTile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#161c2a",
    borderWidth: 1,
    borderColor: "#283246",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  quickActionIcon: {
    color: "#60a5fa",
    fontFamily: MONO_FONT,
    fontSize: 13,
    fontWeight: "700",
  },
  quickActionLabel: {
    color: "#e5e7eb",
    fontSize: 12,
    fontWeight: "600",
  },
  inlineHeaderLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  quickUpBtn: {
    flexShrink: 0,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  quickUpBtnText: {
    color: "#93c5fd",
    fontSize: 10,
    fontWeight: "700",
  },
  inlineHeaderRight: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  mentionCurrentDirBtn: {
    backgroundColor: "#1e3a8a",
    borderWidth: 1,
    borderColor: "#3b82f6",
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  mentionCurrentDirText: {
    color: "#dbeafe",
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: "700",
  },
  fullBrowserLink: {
    color: "#93c5fd",
    fontSize: 11,
    fontWeight: "600",
  },
  quickMentionScroll: {
    maxHeight: 145,
  },
  quickMentionList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  quickDirGroup: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#141c2e",
    borderWidth: 1,
    borderColor: "#2b3b5c",
    borderRadius: 6,
    overflow: "hidden",
  },
  quickDirMainPress: {
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  quickDirText: {
    color: "#93c5fd",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: "600",
  },
  quickDirAtBtn: {
    backgroundColor: "#1e3a8a",
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderLeftWidth: 1,
    borderLeftColor: "#2b3b5c",
  },
  quickDirAtText: {
    color: "#dbeafe",
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: "700",
  },
  quickMentionChip: {
    backgroundColor: "#151c2c",
    borderWidth: 1,
    borderColor: "#29354d",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  quickMentionChipText: {
    color: "#dbeafe",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  emptyQuickText: {
    color: "#6b7280",
    fontSize: 11,
    fontStyle: "italic",
  },
  drawerPillsRow: {
    gap: 6,
    paddingVertical: 2,
  },
  drawerPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#141821",
    borderWidth: 1,
    borderColor: "#262d3d",
  },
  drawerPillActive: {
    backgroundColor: "#1e3a8a",
    borderColor: "#60a5fa",
  },
  drawerPillText: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  drawerPillTextActive: {
    color: "#ffffff",
    fontWeight: "700",
  },
  drawerThinkingRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  drawerThinkingPill: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 5,
    backgroundColor: "#141821",
    borderWidth: 1,
    borderColor: "#262d3d",
  },
  drawerThinkingPillActive: {
    backgroundColor: "#065f46",
    borderColor: "#34d399",
  },
  composerCard: {
    backgroundColor: "#0b0e14",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#2a3346",
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
  },
  chatInput: {
    color: "#f9fafb",
    fontSize: 14,
    lineHeight: 20,
    minHeight: 26,
    maxHeight: 110,
    paddingHorizontal: 2,
    paddingVertical: 0,
  },
  composerToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  composerToolsLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  toolCircleBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#172030",
    borderWidth: 1,
    borderColor: "#2d3a52",
    alignItems: "center",
    justifyContent: "center",
  },
  plusIconBox: {
    width: 12,
    height: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  plusIconBoxRotated: {
    transform: [{ rotate: "45deg" }],
  },
  plusBarH: {
    position: "absolute",
    width: 12,
    height: 2,
    borderRadius: 1,
    backgroundColor: "#93c5fd",
  },
  plusBarV: {
    position: "absolute",
    width: 2,
    height: 12,
    borderRadius: 1,
    backgroundColor: "#93c5fd",
  },
  toolAtBtnText: {
    color: "#93c5fd",
    fontFamily: MONO_FONT,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 15,
    textAlign: "center",
    includeFontPadding: false,
    transform: [{ translateY: -0.5 }],
  },
  toolPillBtn: {
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: "#172030",
    borderWidth: 1,
    borderColor: "#2d3a52",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 1,
  },
  toolPillBtnActive: {
    backgroundColor: "#1e3a8a",
    borderColor: "#60a5fa",
  },
  toolPillBtnText: {
    color: "#93c5fd",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: "700",
  },
  toolPillModelText: {
    color: "#cbd5e1",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: "600",
  },
  composerToolsRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  sendPillBtn: {
    height: 30,
    paddingHorizontal: 14,
    borderRadius: 15,
    backgroundColor: "#2563eb",
    alignItems: "center",
    justifyContent: "center",
  },
  sendPillBtnDisabled: {
    backgroundColor: "#1e293b",
    opacity: 0.6,
  },
  sendPillText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  steerPillBtn: {
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: "#d97706",
    alignItems: "center",
    justifyContent: "center",
  },
  queuePillBtn: {
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: "#374151",
    alignItems: "center",
    justifyContent: "center",
  },
  queuePillText: {
    color: "#e5e7eb",
    fontSize: 11,
    fontWeight: "600",
  },
  stopPillBtn: {
    height: 30,
    paddingHorizontal: 11,
    borderRadius: 15,
    backgroundColor: "#dc2626",
    alignItems: "center",
    justifyContent: "center",
  },
  failedDraftBox: {
    backgroundColor: "#2a1215",
    borderWidth: 1,
    borderColor: "#7f1d1d",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  failedDraftTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  failedDraftTitle: {
    color: "#fca5a5",
    fontSize: 10,
    fontWeight: "700",
  },
  failedDraftPreview: {
    color: "#fecaca",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  failedDraftActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  failedRetryBtn: {
    backgroundColor: "#b91c1c",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  failedRetryBtnText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "700",
  },
  failedRestoreBtn: {
    backgroundColor: "#1f2937",
    borderWidth: 1,
    borderColor: "#374151",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  failedRestoreBtnText: {
    color: "#e5e7eb",
    fontSize: 11,
    fontWeight: "600",
  },
  failedDismissBtn: {
    paddingHorizontal: 5,
    paddingVertical: 4,
  },
  failedDismissBtnText: {
    color: "#fca5a5",
    fontSize: 12,
    fontWeight: "700",
  },
});
