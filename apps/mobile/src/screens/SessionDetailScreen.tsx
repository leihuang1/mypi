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
import { MarkdownText } from "../components/MarkdownText";
import { useWorkspaceChanges } from "../store/use-workspace-changes";
import { GitDiffPanel } from "../components/GitDiffPanel";
import { flushSessionViews, getSessionView, persistSessionViews, saveSessionView, sessionViewKey } from "../store/session-view-store";
import { ToolCallCard } from "../components/ToolCallCard";
import {
  type FailedSubmissionDraft,
  restoreFailedDraftToInput,
} from "../store/session-lifecycle";
import { colors, font, MONO_FONT, radius, space, touch } from "../theme";


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
        <Text style={styles.assistantRoleText}>Pi</Text>
        {item.status === "streaming" && (
          <Text style={styles.streamingBadge}>● Writing…</Text>
        )}
        {item.status === "aborted" && (
          <Text style={styles.abortedBadge}>Stopped</Text>
        )}
        {item.status === "error" && (
          <Text style={styles.errorBadge}>Error</Text>
        )}
      </View>

      {item.thinking ? (
        <View style={styles.thinkingBox}>
          <Pressable
            onPress={() => setShowThinking((prev) => !prev)}
            style={styles.thinkingHeader}
          >
            <Text style={styles.thinkingTitle}>
              {showThinking ? "▾" : "▸"} Thinking · {formatCompactNumber(item.thinking.length)} chars
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
        <MarkdownText text={item.text} />
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
    isNearBottomRef.current = false;
    saveSessionView(viewKey, { following: false });
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
    // A jump must not leave an old scroll animation competing with arriving content.
    scrollRef.current?.scrollToEnd({ animated: false });
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
    const pending = { ...request, error: "发送结果尚未确认" };
    saveSessionView(viewKey, { failedDraft: pending });
    let persisted = false;
    try {
      await persistSessionViews();
      persisted = true;
      // Record identity also distinguishes overlapping retries of the same request ID.
      if (getSessionView(viewKey).failedDraft !== pending) return;
      await client.sendMessage(targetSessionId, request);
      if (getSessionView(viewKey).failedDraft !== pending) return;
      saveSessionView(viewKey, { failedDraft: null });
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
        setFailedDraft(null);
        setConnError(null);
      }
    } catch (err) {
      if (getSessionView(viewKey).failedDraft !== pending) return;
      const detail = err instanceof Error ? err.message : String(err);
      const error = persisted ? detail : `无法保存消息，本次未发送。请检查设备存储后重试：${detail}`;
      saveSessionView(viewKey, { failedDraft: { ...request, error } });
      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
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

  const handleDismissFailedDraft = () => {
    saveSessionView(viewKey, { failedDraft: null });
    setFailedDraft(null);
  };

  const handleRestoreFailedDraft = () => {
    if (!failedDraft || sending) return;
    const restored = restoreFailedDraftToInput(
      inputTextRef.current,
      failedDraft,
    );
    updateInputText(restored.inputText);
    handleDismissFailedDraft();
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
      ? colors.success
      : connStatus === "connecting" || connStatus === "reconnecting"
        ? colors.warning
        : colors.danger;

  const ctxBarColor =
    contextPercent >= 85
      ? colors.danger
      : contextPercent >= 65
        ? colors.warning
        : colors.accent;

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
      {/* Compact header: session title, workspace, and chat/files tabs */}
      <View style={styles.topBar}>
        <Pressable
          onPress={onBack}
          style={styles.backIconBtn}
          accessibilityLabel="Back to sessions"
          hitSlop={6}
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
            {shortenPath(activeCwd)}
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
              Chat
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
            {formatCompactNumber(contextTokens)} / {formatCompactNumber(contextWindow)} · {contextPercent}%
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
            <Text style={styles.miniIconPillText}>Compact</Text>
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
            <Text style={styles.miniIconPillText}>Reset</Text>
          </Pressable>
        </View>
      </View>

      {/* Focused Top Popover 1: Session Rename & Working Directory (from tapping Title) */}
      {topSheet === "rename" && (
        <View style={styles.topPopoverCard}>
          <View style={styles.popoverHeaderRow}>
            <Text style={styles.popoverTitle}>Session</Text>
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
              placeholderTextColor={colors.textFaint}
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
              {activeCwd}
            </Text>
            <Pressable
              style={styles.popoverSecondaryBtn}
              onPress={() => {
                setTopSheet(null);
                setActiveTab("files");
              }}
            >
              <Text style={styles.popoverSecondaryBtnText}>Change folder</Text>
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
                ? "Compact context"
                : topSheet === "reset"
                  ? "Reset context"
                  : "Token usage"}
            </Text>
            <Pressable onPress={() => setTopSheet(null)}>
              <Text style={styles.popoverCloseText}>✕</Text>
            </Pressable>
          </View>

          <View style={styles.usageGrid}>
            {[
              ["Context", `${formatCompactNumber(contextTokens)} / ${formatCompactNumber(contextWindow)} (${contextPercent}%)`],
              ["Total", `${formatCompactNumber(liveState.usage.totalTokens)} tokens`],
              ["In / Out", `${formatCompactNumber(liveState.usage.inputTokens)} / ${formatCompactNumber(liveState.usage.outputTokens)}`],
              ["Cache read", formatCompactNumber(liveState.usage.cacheReadTokens)],
              ...(liveState.usage.totalCost > 0 ? [["Cost", `$${liveState.usage.totalCost.toFixed(4)}`]] : []),
            ].map(([label, value]) => (
              <View key={label} style={styles.usageRow}>
                <Text style={styles.usageLabel}>{label}</Text>
                <Text style={styles.usageValue}>{value}</Text>
              </View>
            ))}
          </View>
          {topSheet === "reset" && (
            <Text style={styles.sheetHint}>
              Starts a fresh context in this session. The transcript stays, but the model forgets it.
            </Text>
          )}

          {topSheet === "compact" && (
            <View style={styles.renameRow}>
              <TextInput
                style={[styles.popoverInput, { flex: 1 }]}
                placeholder="Focus for the summary (optional)"
                placeholderTextColor={colors.textFaint}
                value={compactInstructions}
                onChangeText={setCompactInstructions}
              />
              <Pressable
                style={styles.popoverPrimaryBtn}
                onPress={handleCompact}
                disabled={controlBusy}
              >
                <Text style={styles.popoverPrimaryBtnText}>
                  {controlBusy ? "…" : "Compact"}
                </Text>
              </Pressable>
            </View>
          )}

          {topSheet === "reset" && (
            <View style={styles.renameRow}>
              <TextInput
                style={[styles.popoverInput, { flex: 1 }]}
                placeholder="Handoff prompt (optional)"
                placeholderTextColor={colors.textFaint}
                value={resetPrompt}
                onChangeText={setResetPrompt}
              />
              <Pressable
                style={[styles.popoverPrimaryBtn, styles.popoverDangerBtn]}
                onPress={handleReset}
                disabled={controlBusy}
              >
                <Text style={styles.popoverPrimaryBtnText}>
                  {controlBusy ? "…" : "Reset"}
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
          <View style={styles.chatArea}>
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
                saveSessionView(viewKey, { offset: Math.max(0, contentOffset.y) });
                if (userScrollingRef.current || Platform.OS === "web") {
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
                  <Text style={styles.emptyChatTitle}>Ready when you are</Text>
                  <Text style={styles.emptyChatSub}>
                    Send a prompt below. Use @ to mention files, or tap the model chip to switch models.
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
                    Retrying (attempt {liveState.retry.attempt}):{" "}
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
          </View>

          {/* Bottom Composer Dock & Thumb-Reachable Quick Popovers */}
          <View style={styles.composerDock}>
            {/* Queued Inbox Items Strip with Withdraw */}
            {liveState.inbox.length > 0 && (
              <View style={styles.inboxQueueBox}>
                <Text style={styles.inboxQueueHeader}>
                  Queued · {liveState.inbox.length}
                </Text>
                {liveState.inbox.map((qItem) => (
                  <View key={qItem.id} style={styles.inboxItemRow}>
                    <Text style={styles.inboxTimingBadge}>
                      {qItem.mode === "steer" ? "Steer" : "Queue"}
                    </Text>
                    <Text style={styles.inboxItemText} numberOfLines={1}>
                      {qItem.text || `Submission #${qItem.id}`}
                    </Text>
                    <Pressable
                      style={styles.inboxAbortBtn}
                      onPress={() => handleAbortSubmission(qItem.id)}
                      hitSlop={6}
                    >
                      <Text style={styles.inboxAbortText}>Withdraw</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            {/* Bottom Tray 1: Quick Actions Menu (Toggled by ＋ button) */}
            {bottomTray === "actions" && (
              <View style={styles.bottomSheetCard}>
                <View style={styles.popoverHeaderRow}>
                  <Text style={styles.popoverTitle}>Actions</Text>
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
                    <Text style={styles.quickActionLabel}>Mention file</Text>
                  </Pressable>
                  <Pressable
                    style={styles.quickActionTile}
                    onPress={() => setBottomTray("model")}
                  >
                    <Text style={styles.quickActionIcon}>◆</Text>
                    <Text style={styles.quickActionLabel}>Model & effort</Text>
                  </Pressable>
                  <Pressable
                    style={styles.quickActionTile}
                    onPress={() => {
                      setBottomTray(null);
                      setTopSheet("compact");
                    }}
                  >
                    <Text style={styles.quickActionIcon}>⇲</Text>
                    <Text style={styles.quickActionLabel}>Compact context</Text>
                  </Pressable>
                  <Pressable
                    style={styles.quickActionTile}
                    onPress={() => {
                      setBottomTray(null);
                      setTopSheet("reset");
                    }}
                  >
                    <Text style={styles.quickActionIcon}>↺</Text>
                    <Text style={styles.quickActionLabel}>Reset context</Text>
                  </Pressable>
                  <Pressable
                    style={styles.quickActionTile}
                    onPress={() => {
                      setBottomTray(null);
                      setActiveTab("files");
                    }}
                  >
                    <Text style={styles.quickActionIcon}>▤</Text>
                    <Text style={styles.quickActionLabel}>Browse files</Text>
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
                        <Text style={styles.quickUpBtnText}>‹ Up</Text>
                      </Pressable>
                    ) : null}
                    <Text style={styles.popoverTitle} numberOfLines={1}>
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
                          @ this folder
                        </Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      onPress={() => {
                        setBottomTray(null);
                        setActiveTab("files");
                      }}
                    >
                      <Text style={styles.fullBrowserLink}>All files</Text>
                    </Pressable>
                    <Pressable onPress={() => setBottomTray(null)}>
                      <Text style={styles.popoverCloseText}>✕</Text>
                    </Pressable>
                  </View>
                </View>

                <TextInput
                  style={styles.popoverInput}
                  placeholder="Filter this folder"
                  placeholderTextColor={colors.textFaint}
                  value={quickFilter}
                  onChangeText={setQuickFilter}
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                {loadingQuickFiles ? (
                  <ActivityIndicator
                    color={colors.accent}
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
                            {d.name}/
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
                          {f.name}
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
                    Model & thinking effort
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
                    Delivery unconfirmed
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
                    <Text style={styles.failedRetryBtnText}>Retry</Text>
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
                    onPress={handleDismissFailedDraft}
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
                    ? "Steer or queue a message…"
                    : "Message Pi…"
                }
                placeholderTextColor={colors.textFaint}
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
                      {activeModel.modelId} · {activeThinking}
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
                            <Text style={styles.sendPillText}>Steer</Text>
                          </Pressable>
                          <Pressable
                            style={styles.queuePillBtn}
                            onPress={() => handleSend("followUp")}
                            disabled={sending || Boolean(failedDraft)}
                          >
                            <Text style={styles.queuePillText}>Queue</Text>
                          </Pressable>
                        </>
                      ) : null}
                      <Pressable
                        style={styles.stopPillBtn}
                        onPress={handleAbort}
                      >
                        <Text style={styles.sendPillText}>Stop</Text>
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
                      <Text style={styles.sendIconText}>↑</Text>
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
  changesEntry: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.md, minHeight: touch, backgroundColor: colors.surface, borderRadius: radius.md },
  changesEntryText: { color: colors.text, fontSize: font.small, fontWeight: "500" },
  changesEntryHint: { color: colors.textMuted, fontSize: font.small },
  newMessages: {
    position: "absolute",
    alignSelf: "center",
    bottom: space.md,
    paddingHorizontal: space.lg,
    minHeight: 36,
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  newMessagesText: { color: colors.onAccent, fontSize: font.small, fontWeight: "600" },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: space.xs,
    paddingRight: space.md,
    paddingVertical: space.sm,
    backgroundColor: colors.bg,
    gap: space.xs,
  },
  backIconBtn: {
    width: touch,
    height: touch,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  backIconText: {
    color: colors.text,
    fontSize: 30,
    fontWeight: "300",
    lineHeight: 32,
    marginTop: -3,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    minHeight: touch,
    justifyContent: "center",
    gap: 2,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  sessionTitle: {
    flexShrink: 1,
    color: colors.text,
    fontSize: font.title,
    fontWeight: "600",
  },
  editHintIcon: {
    color: colors.textFaint,
    fontSize: font.caption,
  },
  cwdText: {
    color: colors.textMuted,
    fontFamily: MONO_FONT,
    fontSize: font.caption,
  },
  tabGroup: {
    flexDirection: "row",
    flexShrink: 0,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    padding: 3,
  },
  tabBtn: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  tabBtnActive: {
    backgroundColor: colors.surfaceRaised,
  },
  tabBtnText: {
    color: colors.textMuted,
    fontSize: font.small,
    fontWeight: "500",
  },
  tabBtnTextActive: {
    color: colors.text,
    fontWeight: "600",
  },
  telemetryBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: space.sm,
  },
  ctxSummaryPress: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
    minHeight: 32,
  },
  miniProgressTrack: {
    width: 40,
    height: 6,
    backgroundColor: colors.surfaceRaised,
    borderRadius: 3,
    overflow: "hidden",
  },
  miniProgressFill: {
    height: "100%",
    borderRadius: 3,
  },
  ctxMetaText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: font.caption,
  },
  telemetryActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  miniIconPill: {
    height: 32,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  miniIconPillActive: {
    backgroundColor: colors.accentSoft,
  },
  miniIconPillText: {
    color: colors.textMuted,
    fontSize: font.caption,
    fontWeight: "500",
  },
  topPopoverCard: {
    backgroundColor: colors.surface,
    marginHorizontal: space.md,
    marginTop: space.sm,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  popoverHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 32,
  },
  popoverTitle: {
    flexShrink: 1,
    color: colors.text,
    fontSize: font.body,
    fontWeight: "600",
  },
  popoverCloseText: {
    color: colors.textMuted,
    fontSize: 18,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  renameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  popoverInput: {
    minHeight: touch,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: colors.text,
    fontSize: font.body,
  },
  popoverPrimaryBtn: {
    minHeight: touch,
    backgroundColor: colors.accent,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  popoverDangerBtn: {
    backgroundColor: colors.danger,
  },
  popoverPrimaryBtnText: {
    color: colors.onAccent,
    fontSize: font.body,
    fontWeight: "600",
  },
  cwdSwitchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  cwdDrawerText: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: MONO_FONT,
    fontSize: font.caption,
  },
  popoverSecondaryBtn: {
    minHeight: 40,
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
  },
  popoverSecondaryBtnText: {
    color: colors.accentText,
    fontSize: font.small,
    fontWeight: "500",
  },
  usageGrid: {
    gap: 6,
  },
  usageRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: space.md,
  },
  usageLabel: {
    color: colors.textMuted,
    fontSize: font.small,
  },
  usageValue: {
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.small,
  },
  sheetHint: {
    color: colors.textMuted,
    fontSize: font.small,
    lineHeight: 19,
  },
  filesTabContainer: {
    flex: 1,
    padding: space.md,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.dangerSoft,
    marginHorizontal: space.md,
    marginTop: space.sm,
    borderRadius: radius.md,
    paddingLeft: space.md,
    paddingRight: space.xs,
    paddingVertical: space.xs,
    gap: space.sm,
  },
  errorBannerText: {
    flex: 1,
    color: colors.dangerText,
    fontSize: font.small,
    lineHeight: 18,
    paddingVertical: space.xs,
  },
  reconnectBtn: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  reconnectBtnText: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: "600",
  },
  chatArea: {
    flex: 1,
  },
  chatScroll: {
    flex: 1,
  },
  chatContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    gap: space.lg,
  },
  emptyChatBox: {
    marginTop: 64,
    paddingHorizontal: space.xl,
    alignItems: "center",
    gap: space.sm,
  },
  emptyChatTitle: {
    color: colors.text,
    fontSize: font.title,
    fontWeight: "600",
  },
  emptyChatSub: {
    color: colors.textMuted,
    fontSize: font.small,
    textAlign: "center",
    lineHeight: 20,
  },
  userRow: {
    alignItems: "flex-end",
  },
  userBubble: {
    maxWidth: "86%",
    backgroundColor: colors.accentSoft,
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userText: {
    color: colors.text,
    fontSize: font.body,
    lineHeight: 22,
  },
  assistantBubble: {
    gap: space.sm,
  },
  roleHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  assistantRoleText: {
    color: colors.textMuted,
    fontSize: font.caption,
    fontWeight: "600",
  },
  streamingBadge: {
    color: colors.success,
    fontSize: font.caption,
  },
  abortedBadge: {
    color: colors.warning,
    fontSize: font.caption,
  },
  errorBadge: {
    color: colors.danger,
    fontSize: font.caption,
  },
  thinkingBox: {
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong,
    paddingLeft: space.md,
    gap: 6,
  },
  thinkingHeader: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 32,
  },
  thinkingTitle: {
    color: colors.textMuted,
    fontSize: font.small,
  },
  thinkingBody: {
    color: colors.textMuted,
    fontSize: font.small,
    lineHeight: 20,
  },
  errorMessageText: {
    color: colors.dangerText,
    fontFamily: MONO_FONT,
    fontSize: font.small,
    lineHeight: 19,
  },
  systemRow: {
    alignItems: "center",
    paddingVertical: space.xs,
  },
  systemText: {
    color: colors.textFaint,
    fontSize: font.caption,
    textAlign: "center",
  },
  retryBanner: {
    backgroundColor: colors.warningSoft,
    padding: space.md,
    borderRadius: radius.md,
  },
  retryText: {
    color: colors.warning,
    fontSize: font.small,
    lineHeight: 19,
  },
  composerDock: {
    backgroundColor: colors.bg,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    gap: space.sm,
  },
  inboxQueueBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  inboxQueueHeader: {
    color: colors.textMuted,
    fontSize: font.caption,
    fontWeight: "600",
  },
  inboxItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 36,
  },
  inboxTimingBadge: {
    color: colors.warning,
    backgroundColor: colors.warningSoft,
    fontSize: font.caption,
    fontWeight: "600",
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  inboxItemText: {
    flex: 1,
    color: colors.text,
    fontSize: font.small,
  },
  inboxAbortBtn: {
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  inboxAbortText: {
    color: colors.dangerText,
    fontSize: font.small,
    fontWeight: "500",
  },
  bottomSheetCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.md,
  },
  quickActionsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  quickActionTile: {
    flexGrow: 1,
    flexBasis: "45%",
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: touch + 4,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
  },
  quickActionIcon: {
    width: 20,
    textAlign: "center",
    color: colors.accentText,
    fontSize: font.body,
    fontWeight: "700",
  },
  quickActionLabel: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: "500",
  },
  inlineHeaderLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
  },
  quickUpBtn: {
    flexShrink: 0,
    minHeight: 32,
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
  },
  quickUpBtnText: {
    color: colors.accentText,
    fontSize: font.small,
    fontWeight: "500",
  },
  inlineHeaderRight: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  mentionCurrentDirBtn: {
    minHeight: 32,
    justifyContent: "center",
    backgroundColor: colors.accentSoft,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
  },
  mentionCurrentDirText: {
    color: colors.accentText,
    fontSize: font.caption,
    fontWeight: "600",
  },
  fullBrowserLink: {
    color: colors.accentText,
    fontSize: font.small,
    fontWeight: "500",
    paddingVertical: space.xs,
  },
  quickMentionScroll: {
    maxHeight: 200,
  },
  quickMentionList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  quickDirGroup: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  quickDirMainPress: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: space.md,
  },
  quickDirText: {
    color: colors.accentText,
    fontFamily: MONO_FONT,
    fontSize: font.small,
  },
  quickDirAtBtn: {
    minHeight: 36,
    justifyContent: "center",
    backgroundColor: colors.accentSoft,
    paddingHorizontal: space.md,
  },
  quickDirAtText: {
    color: colors.accentText,
    fontFamily: MONO_FONT,
    fontSize: font.small,
    fontWeight: "700",
  },
  quickMentionChip: {
    minHeight: 36,
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
  },
  quickMentionChipText: {
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.small,
  },
  emptyQuickText: {
    color: colors.textFaint,
    fontSize: font.small,
  },
  drawerPillsRow: {
    gap: space.sm,
    paddingVertical: 2,
  },
  drawerPill: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: "transparent",
  },
  drawerPillActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  drawerPillText: {
    color: colors.textMuted,
    fontSize: font.small,
  },
  drawerPillTextActive: {
    color: colors.text,
    fontWeight: "600",
  },
  drawerThinkingRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  drawerThinkingPill: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: "transparent",
  },
  drawerThinkingPillActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  composerCard: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  chatInput: {
    color: colors.text,
    fontSize: font.body,
    lineHeight: 22,
    minHeight: 26,
    maxHeight: 140,
    paddingHorizontal: space.xs,
    paddingVertical: 0,
  },
  composerToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  composerToolsLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  toolCircleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  plusIconBox: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  plusIconBoxRotated: {
    transform: [{ rotate: "45deg" }],
  },
  plusBarH: {
    position: "absolute",
    width: 14,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.textMuted,
  },
  plusBarV: {
    position: "absolute",
    width: 2,
    height: 14,
    borderRadius: 1,
    backgroundColor: colors.textMuted,
  },
  toolAtBtnText: {
    color: colors.textMuted,
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 20,
    textAlign: "center",
    includeFontPadding: false,
  },
  toolPillBtn: {
    height: 38,
    paddingHorizontal: space.md,
    borderRadius: 19,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 1,
  },
  toolPillBtnActive: {
    backgroundColor: colors.accentSoft,
  },
  toolPillBtnText: {
    color: colors.accentText,
    fontSize: font.caption,
    fontWeight: "600",
  },
  toolPillModelText: {
    color: colors.textMuted,
    fontSize: font.caption,
    fontWeight: "500",
  },
  composerToolsRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  sendPillBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendPillBtnDisabled: {
    backgroundColor: colors.surfaceRaised,
  },
  sendIconText: {
    color: colors.onAccent,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 22,
    includeFontPadding: false,
  },
  sendPillText: {
    color: colors.onAccent,
    fontSize: font.small,
    fontWeight: "600",
  },
  steerPillBtn: {
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  queuePillBtn: {
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  queuePillText: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: "500",
  },
  stopPillBtn: {
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  failedDraftBox: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    paddingLeft: space.md,
    paddingRight: space.xs,
    paddingVertical: space.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  failedDraftTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  failedDraftTitle: {
    color: colors.dangerText,
    fontSize: font.caption,
    fontWeight: "600",
  },
  failedDraftPreview: {
    color: colors.text,
    fontSize: font.small,
  },
  failedDraftActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },
  failedRetryBtn: {
    minHeight: 36,
    justifyContent: "center",
    backgroundColor: colors.danger,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  failedRetryBtnText: {
    color: colors.onAccent,
    fontSize: font.small,
    fontWeight: "600",
  },
  failedRestoreBtn: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  failedRestoreBtnText: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: "500",
  },
  failedDismissBtn: {
    minWidth: 36,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  failedDismissBtnText: {
    color: colors.dangerText,
    fontSize: font.body,
  },
});
