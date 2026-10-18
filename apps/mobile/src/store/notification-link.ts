export function parseNotificationLink(value: string): { serverId: string; sessionId: string } | null {
  if (value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "mypi:" || url.host !== "session") return null;
    const serverId = url.searchParams.get("serverId") ?? "";
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(serverId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) return null;
    return { serverId, sessionId };
  } catch {
    return null;
  }
}
