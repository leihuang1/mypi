import { useEffect, useRef, useState } from "react";
import { Alert, AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { MyPiClient } from "@mypi/shared";
import type { SavedServerProfile } from "./server-store";

interface Preferences {
  deviceId: string;
  enabled: Record<string, boolean>;
}
const STORAGE_KEY = "@mypi/notifications_v1";
let viewing: { serverId?: string; sessionId?: string } = {};

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data;
      const sameSession = AppState.currentState === "active" && data.serverId === viewing.serverId && data.sessionId === viewing.sessionId;
      return { shouldShowAlert: !sameSession, shouldPlaySound: !sameSession, shouldSetBadge: false };
    },
  });
}

async function pushToken(): Promise<string> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) throw new Error("尚未配置 Expo projectId，请按 README 的推送配置步骤构建 App");
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

export function useNotifications({ servers, server, sessionId, onOpen }: {
  servers: SavedServerProfile[];
  server: SavedServerProfile | null;
  sessionId?: string;
  onOpen: (serverId: string, sessionId: string) => Promise<void>;
}) {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const opening = useRef<string | null>(null);
  const syncJob = useRef<Promise<void>>(Promise.resolve());
  const changing = useRef(false);
  viewing = { serverId: server?.id, sessionId };
  const enabled = Boolean(server && preferences?.enabled[server.id]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      const initial: Preferences = raw ? JSON.parse(raw) : {
        deviceId: `device-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        enabled: {},
      };
      return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(initial)).then(() => setPreferences(initial));
    }).catch(() => setError("无法读取本地通知设置，其他功能仍可正常使用"));
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const open = async (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data;
      if (!data || typeof data.serverId !== "string" || typeof data.sessionId !== "string" ||
        !servers.some((item) => item.id === data.serverId)) return;
      const id = response!.notification.request.identifier;
      if (opening.current === id) return;
      opening.current = id;
      try {
        await onOpenRef.current(data.serverId, data.sessionId);
        await Notifications.clearLastNotificationResponseAsync();
      } catch (err) {
        const message = err instanceof Error ? err.message : "无法打开通知对应的会话";
        setError(message);
        Alert.alert("暂时无法打开会话", message);
      } finally {
        opening.current = null;
      }
    };
    const listener = Notifications.addNotificationResponseReceivedListener((response) => { void open(response); });
    void Notifications.getLastNotificationResponseAsync().then(open).catch(() => {});
    return () => listener.remove();
  }, [servers]);

  // Re-register after token rotation/relaunch without requesting permission again.
  useEffect(() => {
    if (Platform.OS === "web" || !preferences) return;
    let cancelled = false;
    let syncing = false;
    const sync = async () => {
      if (syncing || changing.current || cancelled) return;
      const targets = servers.filter((item) => preferences.enabled[item.id]);
      if (!targets.length) return;
      syncing = true;
      try {
        const permission = await Notifications.getPermissionsAsync();
        const token = permission.granted ? await pushToken() : undefined;
        if (cancelled || changing.current) return;
        const results = await Promise.allSettled(targets.map(async (item) => {
          const client = new MyPiClient({ baseUrl: item.url, token: item.token });
          await client.registerNotifications({ deviceId: preferences.deviceId, serverId: item.id, enabled: Boolean(token), pushToken: token });
          if (viewing.serverId === item.id) {
            await client.updateNotificationPresence(preferences.deviceId, AppState.currentState === "active" ? viewing.sessionId ?? null : null);
          }
        }));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (!cancelled) setError(permission.granted ? null : "系统通知权限已关闭；可在系统设置中重新开启");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "通知设置暂未同步");
      } finally { syncing = false; }
    };
    const scheduleSync = () => {
      syncJob.current = syncJob.current.then(sync);
    };
    scheduleSync();
    const appState = AppState.addEventListener("change", (state) => { if (state === "active") scheduleSync(); });
    const tokenListener = Notifications.addPushTokenListener(scheduleSync);
    return () => { cancelled = true; appState.remove(); tokenListener.remove(); };
  }, [preferences, servers]);

  useEffect(() => {
    if (!server || !preferences || !enabled || Platform.OS === "web") return;
    const client = new MyPiClient({ baseUrl: server.url, token: server.token });
    const presence = (active: boolean) => {
      void client.updateNotificationPresence(preferences.deviceId, active ? sessionId ?? null : null).catch(() => {});
    };
    presence(AppState.currentState === "active");
    const interval = setInterval(() => presence(AppState.currentState === "active"), 25_000);
    const appState = AppState.addEventListener("change", (state) => presence(state === "active"));
    return () => { clearInterval(interval); appState.remove(); presence(false); };
  }, [server, preferences, enabled, sessionId]);

  const toggle = async () => {
    if (!server || !preferences || changing.current) return;
    changing.current = true;
    setBusy(true);
    setError(null);
    try {
      await syncJob.current;
      let token: string | undefined;
      if (!enabled) {
        if (Platform.OS === "web") throw new Error("后台系统推送需要 Android / iOS App");
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("runs", {
            name: "运行动态", importance: Notifications.AndroidImportance.DEFAULT,
            lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
            description: "运行结束与无法继续的执行异常", sound: "default",
          });
        }
        let permission = await Notifications.getPermissionsAsync();
        if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
        if (!permission.granted) throw new Error("未授予通知权限，其他功能不受影响。可在系统设置中开启通知。");
        token = await pushToken();
      }
      const client = new MyPiClient({ baseUrl: server.url, token: server.token });
      await client.registerNotifications({ deviceId: preferences.deviceId, serverId: server.id, enabled: !enabled, pushToken: token });
      const next = { ...preferences, enabled: { ...preferences.enabled, [server.id]: !enabled } };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setPreferences(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { changing.current = false; setBusy(false); }
  };

  const unregister = async (target: SavedServerProfile) => {
    if (!preferences?.enabled[target.id]) return;
    if (changing.current) throw new Error("通知设置正在同步，请稍后再试");
    changing.current = true;
    try {
      await syncJob.current;
      const client = new MyPiClient({ baseUrl: target.url, token: target.token });
      await client.registerNotifications({ deviceId: preferences.deviceId, serverId: target.id, enabled: false });
      const next = { ...preferences, enabled: { ...preferences.enabled, [target.id]: false } };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setPreferences(next);
    } finally { changing.current = false; }
  };

  return { enabled, busy, error, toggle, unregister };
}
