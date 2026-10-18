import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";

export interface MonitorState {
  enabledServerIds: string[];
  running: boolean;
  connections: Record<string, string>;
  notificationsAllowed: boolean;
  error?: string | null;
}

interface MonitorModule {
  getState(): Promise<MonitorState>;
  enable(serverJson: string): Promise<MonitorState>;
  disable(serverId: string): Promise<MonitorState>;
  syncServers(serversJson: string): Promise<MonitorState>;
  setViewing(serverId: string | null, sessionId: string | null, active: boolean): Promise<void>;
  addListener(event: "onState", listener: (state: MonitorState) => void): { remove(): void };
}

// Expo Go and non-Android builds stay usable without the optional native module.
export const monitor = Platform.OS === "android"
  ? requireOptionalNativeModule<MonitorModule>("MyPiMonitor")
  : null;
