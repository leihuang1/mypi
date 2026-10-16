import React, { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ToolCallItem } from "@mypi/shared";

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

function summarizeToolArgs(tool: ToolCallItem): string {
  const args = tool.args || {};
  if (tool.toolName === "bash" && typeof args.command === "string") {
    return args.command;
  }
  if (typeof args.path === "string") {
    return args.path;
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  try {
    return JSON.stringify(args).slice(0, 80);
  } catch {
    return "";
  }
}

export function ToolCallCard({ tool }: { tool: ToolCallItem }) {
  const [expanded, setExpanded] = useState(tool.status === "running" || Boolean(tool.isError));
  const summary = summarizeToolArgs(tool);

  const badgeColor =
    tool.status === "running"
      ? "#f59e0b"
      : tool.status === "error" || tool.isError
        ? "#ef4444"
        : tool.status === "done"
          ? "#10b981"
          : "#6b7280";

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.header}
        onPress={() => setExpanded((prev) => !prev)}
      >
        <View style={[styles.dot, { backgroundColor: badgeColor }]} />
        <Text style={styles.toolName}>{tool.toolName}</Text>
        <Text style={styles.summary} numberOfLines={1}>
          {summary}
        </Text>
        <Text style={[styles.statusText, { color: badgeColor }]}>
          {tool.status.toUpperCase()} {expanded ? "▾" : "▸"}
        </Text>
      </Pressable>

      {expanded && (
        <View style={styles.body}>
          {summary ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>INPUT</Text>
              <Text style={styles.codeText} selectable>
                {tool.toolName === "bash"
                  ? `$ ${summary}`
                  : JSON.stringify(tool.args, null, 2)}
              </Text>
            </View>
          ) : null}

          {tool.output ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>OUTPUT</Text>
              <Text
                style={[
                  styles.codeText,
                  tool.isError ? styles.errorText : null,
                ]}
                selectable
              >
                {tool.output.length > 4000
                  ? `${tool.output.slice(0, 4000)}\n... [truncated ${tool.output.length - 4000} chars]`
                  : tool.output}
              </Text>
            </View>
          ) : tool.status === "running" ? (
            <Text style={styles.runningHint}>Running on remote host...</Text>
          ) : null}

          {tool.diagnostics && tool.diagnostics.length > 0 ? (
            <View style={styles.section}>
              {tool.diagnostics.map((d, i) => (
                <Text key={i} style={styles.diagText}>
                  [{d.severity}] {d.message}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#141821",
    borderColor: "#262d3d",
    borderWidth: 1,
    borderRadius: 8,
    marginTop: 8,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  toolName: {
    color: "#93c5fd",
    fontFamily: MONO_FONT,
    fontSize: 12,
    fontWeight: "700",
  },
  summary: {
    flex: 1,
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 12,
  },
  statusText: {
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: "700",
  },
  body: {
    borderTopColor: "#1f2430",
    borderTopWidth: 1,
    padding: 10,
    backgroundColor: "#0d1017",
    gap: 8,
  },
  section: {
    gap: 4,
  },
  sectionLabel: {
    color: "#6b7280",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  codeText: {
    color: "#d1d5db",
    fontFamily: MONO_FONT,
    fontSize: 11,
    lineHeight: 16,
  },
  errorText: {
    color: "#fca5a5",
  },
  runningHint: {
    color: "#fbbf24",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontStyle: "italic",
  },
  diagText: {
    color: "#fcd34d",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
});
