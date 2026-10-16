import AsyncStorage from "@react-native-async-storage/async-storage";
import { normalizeBaseUrl } from "@mypi/shared";

export interface SavedServerProfile {
  id: string;
  name: string;
  url: string;
  token: string;
  updatedAt: number;
}

const STORAGE_KEY_SERVERS = "@mypi/servers_v1";
const STORAGE_KEY_ACTIVE_ID = "@mypi/active_server_id_v1";

export async function loadSavedServers(): Promise<{
  servers: SavedServerProfile[];
  activeId: string | null;
}> {
  try {
    const [rawServers, activeId] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY_SERVERS),
      AsyncStorage.getItem(STORAGE_KEY_ACTIVE_ID),
    ]);
    const servers: SavedServerProfile[] = rawServers
      ? JSON.parse(rawServers)
      : [];
    return {
      servers: Array.isArray(servers) ? servers : [],
      activeId: activeId || (servers[0]?.id ?? null),
    };
  } catch {
    return { servers: [], activeId: null };
  }
}

export async function saveServerProfile(profile: {
  name: string;
  url: string;
  token: string;
}): Promise<{ servers: SavedServerProfile[]; active: SavedServerProfile }> {
  const cleanUrl = normalizeBaseUrl(profile.url);
  const { servers } = await loadSavedServers();
  const existingIdx = servers.findIndex((s) => s.url === cleanUrl);

  const item: SavedServerProfile = {
    id: existingIdx >= 0 ? servers[existingIdx].id : `srv-${Date.now()}`,
    name: profile.name.trim() || cleanUrl.replace(/^https?:\/\//, ""),
    url: cleanUrl,
    token: profile.token.trim(),
    updatedAt: Date.now(),
  };

  const nextServers =
    existingIdx >= 0
      ? servers.map((s, idx) => (idx === existingIdx ? item : s))
      : [item, ...servers];

  await Promise.all([
    AsyncStorage.setItem(STORAGE_KEY_SERVERS, JSON.stringify(nextServers)),
    AsyncStorage.setItem(STORAGE_KEY_ACTIVE_ID, item.id),
  ]);

  return { servers: nextServers, active: item };
}

export async function setActiveServerId(id: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY_ACTIVE_ID, id);
}

export async function removeServerProfile(
  id: string,
): Promise<SavedServerProfile[]> {
  const { servers, activeId } = await loadSavedServers();
  const next = servers.filter((s) => s.id !== id);
  await AsyncStorage.setItem(STORAGE_KEY_SERVERS, JSON.stringify(next));
  if (activeId === id) {
    if (next[0]) {
      await AsyncStorage.setItem(STORAGE_KEY_ACTIVE_ID, next[0].id);
    } else {
      await AsyncStorage.removeItem(STORAGE_KEY_ACTIVE_ID);
    }
  }
  return next;
}
