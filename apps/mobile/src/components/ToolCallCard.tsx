import React, { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ToolCallItem } from "@mypi/shared";
import { colors, font, MONO_FONT, radius, space } from "../theme";

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
      ? colors.warning
      : tool.status === "error" || tool.isError
        ? colors.danger
        : tool.status === "done"
          ? colors.success
          : colors.textFaint;

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.header}
        onPress={() => setExpanded((prev) => !prev)}
        accessibilityRole="button"
        accessibilityLabel={`${tool.toolName} ${tool.status}`}
        accessibilityState={{ expanded }}
      >
        <View style={[styles.dot, { backgroundColor: badgeColor }]} />
        <Text style={styles.toolName}>{tool.toolName}</Text>
        <Text style={styles.summary} numberOfLines={1}>
          {summary}
        </Text>
        <Text style={[styles.statusText, { color: badgeColor }]}>
          {expanded ? "▾" : "▸"}
        </Text>
      </Pressable>

      {expanded && (
        <View style={styles.body}>
          {summary ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Input</Text>
              <Text style={styles.codeText} selectable>
                {tool.toolName === "bash"
                  ? `$ ${summary}`
                  : JSON.stringify(tool.args, null, 2)}
              </Text>
            </View>
          ) : null}

          {tool.output ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Output</Text>
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
            <Text style={styles.runningHint}>Running…</Text>
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
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 42,
    paddingHorizontal: space.md,
    gap: space.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  toolName: {
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.small,
    fontWeight: "600",
  },
  summary: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: MONO_FONT,
    fontSize: font.caption,
  },
  statusText: {
    fontSize: font.small,
    paddingLeft: space.xs,
  },
  body: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    backgroundColor: colors.surfaceSunken,
    gap: space.md,
  },
  section: {
    gap: space.xs,
  },
  sectionLabel: {
    color: colors.textFaint,
    fontSize: font.caption,
    fontWeight: "600",
  },
  codeText: {
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.caption,
    lineHeight: 18,
  },
  errorText: {
    color: colors.dangerText,
  },
  runningHint: {
    color: colors.warning,
    fontSize: font.small,
  },
  diagText: {
    color: colors.warning,
    fontFamily: MONO_FONT,
    fontSize: font.caption,
    lineHeight: 18,
  },
});
