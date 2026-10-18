import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
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

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

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
      <StatusBar barStyle="light-content" backgroundColor="#0b0e14" />

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
          {/* Header */}
          <View style={styles.hubHeader}>
            <View style={styles.hubHeaderLeft}>
              <Text style={styles.brandTitle} numberOfLines={1}>
                MyPi Durable
              </Text>
              <Text
                style={styles.serverSubtitle}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {activeServer?.name} • {device?.platform || activeServer?.url}
              </Text>
            </View>
            <View style={styles.headerActions}>
              <Pressable
                style={styles.serverBtn}
                onPress={() => navigateToScreen("pair")}
              >
                <Text style={styles.serverBtnText}>⚙ Server</Text>
              </Pressable>
              <Pressable
                style={[styles.newBtn, !device ? styles.btnDisabled : null]}
                onPress={() => device && navigateToScreen("new-session")}
                disabled={!device}
              >
                <Text style={styles.newBtnText}>+ New</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.notificationRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.notificationTitle}>后台监听与通知</Text>
              <Text style={styles.notificationHint}>{notifications.hint}</Text>
            </View>
            <Pressable onPress={notifications.toggle} disabled={notifications.busy || !notifications.supported} style={styles.serverBtn} accessibilityRole="switch" accessibilityLabel="后台监听与本地通知" accessibilityState={{ checked: notifications.running, disabled: notifications.busy || !notifications.supported }}>
              <Text style={styles.serverBtnText}>{!notifications.supported ? (Platform.OS === "android" ? "需原生版" : "仅 Android") : notifications.busy ? "更新中…" : notifications.running ? "已开启" : notifications.enabled ? "恢复" : "开启"}</Text>
            </Pressable>
          </View>
          {notifications.error && <Text style={styles.notificationError}>{notifications.error}</Text>}

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
          >
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>
                DURABLE SESSIONS ({sessions.length})
              </Text>
              <Pressable onPress={refreshHub}>
                <Text style={styles.refreshLink}>
                  {loading ? "Loading..." : "↻ Refresh"}
                </Text>
              </Pressable>
            </View>

            {loading && sessions.length === 0 ? (
              <ActivityIndicator
                color="#60a5fa"
                style={{ marginTop: 40 }}
                size="large"
              />
            ) : sessions.length === 0 ? (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyTitle}>No Durable Sessions Yet</Text>
                <Text style={styles.emptySubtitle}>
                  Tap "+ New" to pick a project folder on {device?.hostname || "your dev machine"} and start coding from your phone.
                </Text>
                {device && (
                  <Pressable
                    style={styles.primaryCta}
                    onPress={() => navigateToScreen("new-session")}
                  >
                    <Text style={styles.primaryCtaText}>
                      + Create First Session
                    </Text>
                  </Pressable>
                )}
              </View>
            ) : (
              sessions.map((sess) => (
                <Pressable
                  key={sess.id}
                  style={styles.sessionCard}
                  onPress={() => {
                    setActiveSession(sess);
                    navigateToScreen("session-detail");
                  }}
                >
                  <View style={styles.sessionCardTop}>
                    <View style={styles.sessionTitleRow}>
                      <View
                        style={[
                          styles.busyDot,
                          {
                            backgroundColor: sess.busy ? "#f59e0b" : "#10b981",
                          },
                        ]}
                      />
                      <Text style={styles.sessionName} numberOfLines={1}>
                        {sess.name}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => handleDeleteSession(sess.id)}
                      style={styles.archiveBtn}
                    >
                      <Text style={styles.archiveBtnText}>Archive</Text>
                    </Pressable>
                  </View>

                  <Text style={styles.sessionCwd} numberOfLines={1}>
                    📁 {sess.cwd}
                  </Text>

                  <View style={styles.sessionMetaRow}>
                    <Text style={styles.sessionModelBadge}>
                      {sess.model.provider}/{sess.model.modelId} ({sess.thinkingLevel})
                    </Text>
                    <Text style={styles.sessionEntriesText}>
                      {sess.busy ? "● Running" : `${sess.entryCount} entries`}
                    </Text>
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
  notificationRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#262d3d" },
  notificationTitle: { color: "#cbd5e1", fontSize: 12, marginBottom: 4 },
  notificationHint: { color: "#94a3b8", fontSize: 10 },
  notificationError: { color: "#fbbf24", fontSize: 12, paddingHorizontal: 16, paddingTop: 10 },
  safeArea: {
    flex: 1,
    backgroundColor: "#0b0e14",
  },
  hubContainer: {
    flex: 1,
    backgroundColor: "#0b0e14",
  },
  hubHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "#141821",
    borderBottomWidth: 1,
    borderBottomColor: "#262d3d",
    gap: 12,
  },
  hubHeaderLeft: {
    flex: 1,
    minWidth: 0,
  },
  brandTitle: {
    color: "#f9fafb",
    fontSize: 20,
    fontWeight: "800",
  },
  serverSubtitle: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 11,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: 8,
  },
  serverBtn: {
    backgroundColor: "#1f2937",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#374151",
  },
  serverBtnText: {
    color: "#e5e7eb",
    fontSize: 13,
    fontWeight: "600",
  },
  newBtn: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  newBtnText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  errorCard: {
    margin: 14,
    padding: 12,
    backgroundColor: "#451a1a",
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  errorText: {
    flex: 1,
    color: "#fca5a5",
    fontSize: 12,
  },
  retryBtn: {
    backgroundColor: "#7f1d1d",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  retryBtnText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "600",
  },
  sessionList: {
    flex: 1,
  },
  sessionListContent: {
    padding: 16,
    gap: 12,
    paddingBottom: 40,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionTitle: {
    color: "#60a5fa",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  refreshLink: {
    color: "#93c5fd",
    fontSize: 12,
    fontWeight: "600",
  },
  emptyBox: {
    marginTop: 32,
    padding: 24,
    backgroundColor: "#141821",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#262d3d",
    alignItems: "center",
    gap: 10,
  },
  emptyTitle: {
    color: "#f9fafb",
    fontSize: 16,
    fontWeight: "700",
  },
  emptySubtitle: {
    color: "#9ca3af",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
  primaryCta: {
    marginTop: 6,
    backgroundColor: "#2563eb",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
  primaryCtaText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  sessionCard: {
    backgroundColor: "#141821",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#262d3d",
    padding: 14,
    gap: 8,
  },
  sessionCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  sessionTitleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  busyDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  sessionName: {
    flex: 1,
    color: "#f9fafb",
    fontSize: 15,
    fontWeight: "700",
  },
  archiveBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    backgroundColor: "#1f2937",
  },
  archiveBtnText: {
    color: "#9ca3af",
    fontSize: 11,
    fontWeight: "600",
  },
  sessionCwd: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 12,
  },
  sessionMetaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 2,
  },
  sessionModelBadge: {
    color: "#93c5fd",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  sessionEntriesText: {
    color: "#6b7280",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
});
