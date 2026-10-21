import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  type DeviceInfo,
  MyPiClient,
  type SessionSummary,
} from "@mypi/shared";
import { NewSessionScreen } from "./src/screens/NewSessionScreen";
import { PairServerScreen } from "./src/screens/PairServerScreen";
import { SessionDetailScreen } from "./src/screens/SessionDetailScreen";
import { useNotifications } from "./src/store/use-notifications";
import { loadSessionViews, removeSessionView } from "./src/store/session-view-store";
import type { AppScreenName } from "./src/store/session-lifecycle";
import {
  loadSavedServers,
  removeServerProfile,
  type SavedServerProfile,
  saveServerProfile,
  setActiveServerId,
} from "./src/store/server-store";
import { colors, font, MONO_FONT, radius, space, touch } from "./src/theme";


export default function App() {
  const [servers, setServers] = useState<SavedServerProfile[]>([]);
  const [activeServerId, setActiveId] = useState<string | null>(null);
  const [screen, setScreen] = useState<AppScreenName>("sessions");

  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hubReqIdRef = useRef(0);
  const navEpochRef = useRef(0);
  const screenRef = useRef<AppScreenName>(screen);
  screenRef.current = screen;
  const activeServerIdRef = useRef<string | null>(null);
  activeServerIdRef.current = activeServerId;

  const navigateToScreen = (nextScreen: AppScreenName) => {
    navEpochRef.current += 1;
    screenRef.current = nextScreen;
    setScreen(nextScreen);
  };

  const activeServer = useMemo(
    () => servers.find((s) => s.id === activeServerId) ?? null,
    [servers, activeServerId],
  );

  const client = useMemo(
    () =>
      activeServer
        ? new MyPiClient({
            baseUrl: activeServer.url,
            token: activeServer.token,
          })
        : null,
    [activeServer],
  );

  const resetServerScopedState = () => {
    hubReqIdRef.current += 1;
    navEpochRef.current += 1;
    setDevice(null);
    setSessions([]);
    setActiveSession(null);
    setError(null);
  };

  useEffect(() => {
    (async () => {
      const [stored] = await Promise.all([loadSavedServers(), loadSessionViews()]);
      setServers(stored.servers);
      setActiveId(stored.activeId);
      activeServerIdRef.current = stored.activeId;
      if (stored.servers.length === 0) {
        navigateToScreen("pair");
      }
      setLoading(false);
    })();
  }, []);

  const refreshHub = async () => {
    if (!client || !activeServerId) return;
    const reqId = ++hubReqIdRef.current;
    const targetServerId = activeServerId;
    setLoading(true);
    setError(null);
    try {
      const [dev, sessList] = await Promise.all([
        client.getDevice(),
        client.listSessions(),
      ]);
      if (
        hubReqIdRef.current !== reqId ||
        activeServerIdRef.current !== targetServerId
      ) {
        return;
      }
      setDevice(dev);
      setSessions(sessList);
    } catch (err) {
      if (
        hubReqIdRef.current !== reqId ||
        activeServerIdRef.current !== targetServerId
      ) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (
        hubReqIdRef.current === reqId &&
        activeServerIdRef.current === targetServerId
      ) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (client && screen === "sessions") {
      void refreshHub();
    }
  }, [client, screen]);

  const handleSaveProfile = async (profile: {
    name: string;
    url: string;
    token: string;
  }) => {
    const res = await saveServerProfile(profile);
    if (res.active.id !== activeServerIdRef.current) {
      resetServerScopedState();
    }
    setServers(res.servers);
    setActiveId(res.active.id);
    activeServerIdRef.current = res.active.id;
    navigateToScreen("sessions");
  };

  const handleSelectServer = async (id: string) => {
    await setActiveServerId(id);
    if (id !== activeServerIdRef.current) {
      resetServerScopedState();
    }
    setActiveId(id);
    activeServerIdRef.current = id;
    navigateToScreen("sessions");
  };

  const handleDeleteServer = async (id: string) => {
    const target = servers.find((item) => item.id === id);
    if (target) {
      try { await notifications.unregister(target); }
      catch (err) {
        setError(`无法停止该服务器的监听：${err instanceof Error ? err.message : String(err)}`);
        navigateToScreen("sessions");
        return;
      }
    }
    const next = await removeServerProfile(id);
    const nextActiveId = next[0]?.id ?? null;
    if (nextActiveId !== activeServerIdRef.current) {
      resetServerScopedState();
    }
    setServers(next);
    setActiveId(nextActiveId);
    activeServerIdRef.current = nextActiveId;
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!client) return;
    const targetServerId = activeServerId;
    try {
      await client.deleteSession(sessionId);
      if (targetServerId) removeSessionView(targetServerId, sessionId);
      if (activeServerIdRef.current !== targetServerId) return;
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setActiveSession((prev) => (prev?.id === sessionId ? null : prev));
    } catch (err) {
      if (activeServerIdRef.current !== targetServerId) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmArchiveSession = (sess: SessionSummary) => {
    Alert.alert(
      "Archive session?",
      `"${sess.name}" will be removed from this list.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Archive", style: "destructive", onPress: () => void handleDeleteSession(sess.id) },
      ],
    );
  };

  const currentNavEpoch = navEpochRef.current;

  const handleSessionCreated = (created: SessionSummary) => {
    if (activeServerIdRef.current !== activeServerId) return;
    setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
    if (screenRef.current === "new-session" && navEpochRef.current === currentNavEpoch) {
      setActiveSession(created);
      navigateToScreen("session-detail");
    }
  };

  const handleSessionUpdated = (updated: SessionSummary) => {
    if (activeServerIdRef.current !== activeServerId) return;
    setActiveSession((prev) => prev?.id === updated.id ? updated : prev);
    setSessions((prev) => prev.map((s) => s.id === updated.id ? updated : s));
  };

  const handleNotificationOpen = async (serverId: string, sessionId: string) => {
    const target = servers.find((item) => item.id === serverId);
    if (!target) return;
    const epoch = ++navEpochRef.current;
    const targetClient = new MyPiClient({ baseUrl: target.url, token: target.token });
    const [summary, dev] = await Promise.all([targetClient.getSession(sessionId), targetClient.getDevice()]);
    if (epoch !== navEpochRef.current) return;
    await setActiveServerId(serverId);
    if (epoch !== navEpochRef.current) return;
    resetServerScopedState();
    setActiveId(serverId);
    activeServerIdRef.current = serverId;
    setDevice(dev);
    setActiveSession(summary);
    navigateToScreen("session-detail");
  };

  const notifications = useNotifications({
    servers,
    server: activeServer,
    sessionId: screen === "session-detail" ? activeSession?.id : undefined,
    onOpen: handleNotificationOpen,
  });

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />

      {screen === "pair" || !client ? (
        <PairServerScreen
          savedServers={servers}
          activeServerId={activeServerId}
          onSaveProfile={handleSaveProfile}
          onSelectServer={handleSelectServer}
          onDeleteServer={handleDeleteServer}
          onCancel={activeServer ? () => navigateToScreen("sessions") : undefined}
        />
      ) : screen === "new-session" && device ? (
        <NewSessionScreen
          client={client}
          device={device}
          onCreated={handleSessionCreated}
          onCancel={() => navigateToScreen("sessions")}
        />
      ) : screen === "session-detail" && activeSession ? (
        <SessionDetailScreen
          key={`${activeServerId}:${activeSession.id}`}
          serverId={activeServerId!}
          client={client}
          device={device ?? undefined}
          session={activeSession}
          onSessionUpdated={handleSessionUpdated}
          onBack={() => {
            setActiveSession(null);
            navigateToScreen("sessions");
          }}
        />
      ) : (
        <View style={styles.hubContainer}>
          <View style={styles.hubHeader}>
            <Pressable
              style={styles.hubHeaderLeft}
              onPress={() => navigateToScreen("pair")}
              accessibilityRole="button"
              accessibilityLabel="Manage servers"
            >
              <Text style={styles.brandTitle} numberOfLines={1}>
                MyPi
              </Text>
              <View style={styles.serverLine}>
                <View
                  style={[
                    styles.serverDot,
                    { backgroundColor: error ? colors.danger : device ? colors.success : colors.textFaint },
                  ]}
                />
                <Text style={styles.serverSubtitle} numberOfLines={1}>
                  {activeServer?.name}
                  {device?.hostname ? ` · ${device.hostname}` : ""}
                </Text>
                <Text style={styles.serverChevron}>›</Text>
              </View>
            </Pressable>
            <Pressable
              style={[styles.newBtn, !device ? styles.btnDisabled : null]}
              onPress={() => device && navigateToScreen("new-session")}
              disabled={!device}
              accessibilityRole="button"
              accessibilityLabel="New session"
            >
              <Text style={styles.newBtnText}>+ New</Text>
            </Pressable>
          </View>

          {error && (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable style={styles.retryBtn} onPress={refreshHub}>
                <Text style={styles.retryBtnText}>Retry</Text>
              </Pressable>
            </View>
          )}

          <ScrollView
            style={styles.sessionList}
            contentContainerStyle={styles.sessionListContent}
            refreshControl={
              <RefreshControl
                refreshing={loading && sessions.length > 0}
                onRefresh={refreshHub}
                tintColor={colors.accent}
                colors={[colors.accent]}
                progressBackgroundColor={colors.surface}
              />
            }
          >
            <Pressable
              onPress={notifications.toggle}
              disabled={notifications.busy || !notifications.supported}
              style={styles.notificationCard}
              accessibilityRole="switch"
              accessibilityLabel="后台监听与本地通知"
              accessibilityState={{ checked: notifications.running, disabled: notifications.busy || !notifications.supported }}
            >
              <View style={styles.notificationTextCol}>
                <Text style={styles.notificationTitle}>后台监听与通知</Text>
                <Text style={styles.notificationHint}>{notifications.hint}</Text>
              </View>
              {!notifications.supported ? (
                <Text style={styles.notificationUnsupported}>
                  {Platform.OS === "android" ? "需原生版" : "仅 Android"}
                </Text>
              ) : notifications.busy ? (
                <ActivityIndicator color={colors.accent} size="small" />
              ) : (
                <View style={[styles.switchTrack, notifications.running ? styles.switchTrackOn : null]}>
                  <View style={[styles.switchThumb, notifications.running ? styles.switchThumbOn : null]} />
                </View>
              )}
            </Pressable>
            {notifications.error && <Text style={styles.notificationError}>{notifications.error}</Text>}

            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Sessions</Text>
              <Text style={styles.sectionCount}>
                {loading && sessions.length === 0 ? "" : sessions.length}
              </Text>
            </View>

            {loading && sessions.length === 0 ? (
              <ActivityIndicator
                color={colors.accent}
                style={{ marginTop: 40 }}
                size="large"
              />
            ) : sessions.length === 0 ? (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyTitle}>No sessions yet</Text>
                <Text style={styles.emptySubtitle}>
                  Pick a project folder on {device?.hostname || "your dev machine"} and start coding from your phone.
                </Text>
                {device && (
                  <Pressable
                    style={styles.primaryCta}
                    onPress={() => navigateToScreen("new-session")}
                  >
                    <Text style={styles.primaryCtaText}>Create first session</Text>
                  </Pressable>
                )}
              </View>
            ) : (
              sessions.map((sess) => (
                <Pressable
                  key={sess.id}
                  style={({ pressed }) => [styles.sessionCard, pressed ? styles.sessionCardPressed : null]}
                  onPress={() => {
                    setActiveSession(sess);
                    navigateToScreen("session-detail");
                  }}
                  onLongPress={() => confirmArchiveSession(sess)}
                >
                  <View style={styles.sessionCardTop}>
                    <Text style={styles.sessionName} numberOfLines={1}>
                      {sess.name}
                    </Text>
                    <View style={[styles.statusChip, sess.busy ? styles.statusChipBusy : null]}>
                      <View
                        style={[
                          styles.busyDot,
                          { backgroundColor: sess.busy ? colors.warning : colors.success },
                        ]}
                      />
                      <Text style={[styles.statusChipText, sess.busy ? { color: colors.warning } : null]}>
                        {sess.busy ? "Running" : "Idle"}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.sessionCwd} numberOfLines={1} ellipsizeMode="head">
                    {sess.cwd}
                  </Text>

                  <View style={styles.sessionMetaRow}>
                    <Text style={styles.sessionModelBadge} numberOfLines={1}>
                      {sess.model.modelId} · {sess.thinkingLevel}
                    </Text>
                    <Text style={styles.sessionEntriesText}>
                      {sess.entryCount} entries
                    </Text>
                    <Pressable
                      onPress={() => confirmArchiveSession(sess)}
                      style={styles.archiveBtn}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Archive ${sess.name}`}
                    >
                      <Text style={styles.archiveBtnText}>Archive</Text>
                    </Pressable>
                  </View>
                </Pressable>
              ))
            )}
          </ScrollView>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  hubContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  hubHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
    gap: space.md,
  },
  hubHeaderLeft: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  brandTitle: {
    color: colors.text,
    fontSize: font.heading,
    fontWeight: "700",
  },
  serverLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 24,
  },
  serverDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  serverSubtitle: {
    flexShrink: 1,
    color: colors.textMuted,
    fontSize: font.small,
  },
  serverChevron: {
    color: colors.textFaint,
    fontSize: font.title,
  },
  newBtn: {
    minHeight: touch,
    justifyContent: "center",
    backgroundColor: colors.accent,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
  },
  newBtnText: {
    color: colors.onAccent,
    fontSize: font.body,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.45,
  },
  errorCard: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  errorText: {
    flex: 1,
    color: colors.dangerText,
    fontSize: font.small,
    lineHeight: 19,
  },
  retryBtn: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceRaised,
  },
  retryBtnText: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: "600",
  },
  sessionList: {
    flex: 1,
  },
  sessionListContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.xs,
    paddingBottom: 48,
    gap: space.md,
  },
  notificationCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    paddingHorizontal: space.lg,
    minHeight: 64,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
  },
  notificationTextCol: {
    flex: 1,
    gap: 3,
  },
  notificationTitle: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: "500",
  },
  notificationHint: {
    color: colors.textMuted,
    fontSize: font.caption,
    lineHeight: 17,
  },
  notificationUnsupported: {
    color: colors.textFaint,
    fontSize: font.caption,
  },
  notificationError: {
    color: colors.warning,
    fontSize: font.small,
    lineHeight: 19,
    marginTop: -space.xs,
  },
  switchTrack: {
    width: 44,
    height: 26,
    borderRadius: 13,
    padding: 3,
    backgroundColor: colors.borderStrong,
  },
  switchTrackOn: {
    backgroundColor: colors.accent,
  },
  switchThumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.text,
  },
  switchThumbOn: {
    transform: [{ translateX: 18 }],
    backgroundColor: colors.onAccent,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: space.sm,
    marginTop: space.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: font.title,
    fontWeight: "600",
  },
  sectionCount: {
    color: colors.textFaint,
    fontSize: font.small,
  },
  emptyBox: {
    marginTop: space.lg,
    padding: space.xl,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    alignItems: "center",
    gap: space.sm,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: font.title,
    fontWeight: "600",
  },
  emptySubtitle: {
    color: colors.textMuted,
    fontSize: font.small,
    textAlign: "center",
    lineHeight: 20,
  },
  primaryCta: {
    marginTop: space.sm,
    minHeight: touch,
    justifyContent: "center",
    backgroundColor: colors.accent,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
  },
  primaryCtaText: {
    color: colors.onAccent,
    fontSize: font.body,
    fontWeight: "600",
  },
  sessionCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
    gap: 6,
  },
  sessionCardPressed: {
    backgroundColor: colors.surfaceRaised,
  },
  sessionCardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  sessionName: {
    flex: 1,
    color: colors.text,
    fontSize: font.title,
    fontWeight: "600",
  },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.successSoft,
  },
  statusChipBusy: {
    backgroundColor: colors.warningSoft,
  },
  statusChipText: {
    color: colors.success,
    fontSize: font.caption,
    fontWeight: "500",
  },
  busyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  sessionCwd: {
    color: colors.textMuted,
    fontFamily: MONO_FONT,
    fontSize: font.caption,
  },
  sessionMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  sessionModelBadge: {
    flexShrink: 1,
    color: colors.accentText,
    fontSize: font.caption,
  },
  sessionEntriesText: {
    flex: 1,
    color: colors.textFaint,
    fontSize: font.caption,
  },
  archiveBtn: {
    minHeight: 40,
    justifyContent: "center",
    paddingLeft: space.md,
  },
  archiveBtnText: {
    color: colors.textFaint,
    fontSize: font.caption,
    fontWeight: "500",
  },
});
