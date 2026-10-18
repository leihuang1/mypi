import { useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, PermissionsAndroid, Platform } from "react-native";
import { monitor, type MonitorState } from "../../modules/mypi-monitor";
import { parseNotificationLink } from "./notification-link";
import type { SavedServerProfile } from "./server-store";

export function useNotifications({ servers, server, sessionId, onOpen }: {
  servers: SavedServerProfile[];
  server: SavedServerProfile | null;
  sessionId?: string;
  onOpen: (serverId: string, sessionId: string) => Promise<void>;
}) {
  const [state, setState] = useState<MonitorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changing = useRef(false);
  const initialUrl = useRef<string | null>(null);
  const opening = useRef<string | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const enabled = Boolean(server && state?.enabledServerIds.includes(server.id));
  const running = Boolean(enabled && state?.running);

  useEffect(() => {
    if (!monitor) return;
    let cancelled = false;
    const update = (next: MonitorState) => { if (!cancelled) setState(next); };
    const refresh = () => {
      void monitor?.getState().then(update).catch(() => {
        if (!cancelled) setError("无法读取后台监听状态，请重新打开 App");
      });
    };
    const listener = monitor.addListener("onState", update);
    const appState = AppState.addEventListener("change", (next) => { if (next === "active") refresh(); });
    refresh();
    return () => { cancelled = true; listener.remove(); appState.remove(); };
  }, []);

  useEffect(() => {
    if (!monitor || !servers.length || AppState.currentState !== "active") return;
    let cancelled = false;
    // Update credentials for already-enabled servers; never implicitly enable or restart monitoring.
    void monitor.syncServers(JSON.stringify(servers)).then((next) => {
      if (!cancelled) setState(next);
    }).catch(() => { if (!cancelled) setError("监听配置暂未更新，请重新打开 App"); });
    return () => { cancelled = true; };
  }, [servers]);

  useEffect(() => {
    if (!monitor) return;
    const update = (active: boolean) => {
      void monitor?.setViewing(server?.id ?? null, sessionId ?? null, active).catch(() => {});
    };
    update(AppState.currentState === "active");
    const listener = AppState.addEventListener("change", (next) => update(next === "active"));
    return () => { listener.remove(); update(false); };
  }, [server?.id, sessionId]);

  useEffect(() => {
    const open = async (url: string, initial = false) => {
      const target = parseNotificationLink(url);
      if (!target || !servers.some((item) => item.id === target.serverId) || opening.current === url) return;
      if (initial && initialUrl.current === url) return;
      if (initial) initialUrl.current = url;
      opening.current = url;
      try {
        await onOpenRef.current(target.serverId, target.sessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "无法打开通知对应的会话";
        setError(message);
        Alert.alert("暂时无法打开会话", message);
      } finally { opening.current = null; }
    };
    const listener = Linking.addEventListener("url", ({ url }) => { void open(url); });
    void Linking.getInitialURL().then((url) => { if (url) return open(url, true); }).catch(() => {});
    return () => listener.remove();
  }, [servers]);

  const toggle = async () => {
    if (!server || !monitor || changing.current) return;
    changing.current = true;
    setBusy(true);
    setError(null);
    try {
      const current = await monitor.getState();
      if (current.enabledServerIds.includes(server.id) && current.running) {
        setState(await monitor.disable(server.id));
      } else {
        if (Platform.OS === "android" && Number(Platform.Version) >= 33) {
          const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
          const granted = await PermissionsAndroid.check(permission) ||
            await PermissionsAndroid.request(permission) === PermissionsAndroid.RESULTS.GRANTED;
          if (!granted) throw new Error("未授予通知权限，聊天和 diff 不受影响。可在系统设置中允许 MyPi 通知。");
        }
        setState(await monitor.enable(JSON.stringify(server)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { changing.current = false; setBusy(false); }
  };

  const unregister = async (target: SavedServerProfile) => {
    if (monitor) setState(await monitor.disable(target.id));
  };

  const hint = !monitor ? "需安装 Android 原生 App，Expo Go 不支持后台监听"
    : enabled && !state?.running ? "监听已暂停，点击恢复"
    : running ? state?.connections[server!.id] ?? "正在启动监听…"
    : "直接连接开发机 · 开启后显示常驻通知";

  return {
    enabled, running, supported: Boolean(monitor), busy: busy || Boolean(monitor && !state),
    error: error ?? state?.error, hint, toggle, unregister,
  };
}
