import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { GitFileStatus, GitStatusResponse, MyPiClient } from "@mypi/shared";

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

function DiffBlock({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return (
      <Text style={styles.emptyDiffText}>
        Binary or empty file diff.
      </Text>
    );
  }

  const lines = diff.split(/\r?\n/);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={true}>
      <View style={styles.diffLinesContainer}>
        {lines.map((line, idx) => {
          let lineStyle = styles.diffLineContext;
          let textStyle = styles.diffTextContext;
          if (line.startsWith("+++") || line.startsWith("---")) {
            lineStyle = styles.diffLineHeader;
            textStyle = styles.diffTextHeader;
          } else if (line.startsWith("@@")) {
            lineStyle = styles.diffLineHunk;
            textStyle = styles.diffTextHunk;
          } else if (line.startsWith("+")) {
            lineStyle = styles.diffLineAdd;
            textStyle = styles.diffTextAdd;
          } else if (line.startsWith("-")) {
            lineStyle = styles.diffLineDel;
            textStyle = styles.diffTextDel;
          }
          return (
            <View key={idx} style={[styles.diffLine, lineStyle]}>
              <Text style={[styles.diffText, textStyle]} selectable>
                {line || " "}
              </Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

function FileDiffCard({ file }: { file: GitFileStatus }) {
  const [expanded, setExpanded] = useState(true);

  const badgeBg =
    file.status === "A" || file.status === "?"
      ? "#065f46"
      : file.status === "D"
        ? "#7f1d1d"
        : "#1e3a8a";

  return (
    <View style={styles.fileCard}>
      <Pressable
        style={styles.fileHeader}
        onPress={() => setExpanded((prev) => !prev)}
      >
        <View style={[styles.statusBadge, { backgroundColor: badgeBg }]}>
          <Text style={styles.statusBadgeText}>{file.status}</Text>
        </View>
        <Text style={styles.filePath} numberOfLines={1}>
          {file.path}
        </Text>
        <View style={styles.statPills}>
          {file.additions > 0 && (
            <Text style={styles.addStat}>+{file.additions}</Text>
          )}
          {file.deletions > 0 && (
            <Text style={styles.delStat}>-{file.deletions}</Text>
          )}
          <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
        </View>
      </Pressable>
      {expanded && (
        <View style={styles.fileDiffBody}>
          <DiffBlock diff={file.diff} />
        </View>
      )}
    </View>
  );
}

export function GitDiffPanel({
  client,
  sessionId,
}: {
  client: MyPiClient;
  sessionId: string;
}) {
  const [gitInfo, setGitInfo] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadGitStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.getGitStatus(sessionId);
      setGitInfo(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadGitStatus();
  }, [sessionId]);

  if (loading && !gitInfo) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#60a5fa" />
        <Text style={styles.hintText}>Inspecting workspace git status...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.refreshBtn} onPress={loadGitStatus}>
          <Text style={styles.refreshBtnText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (!gitInfo || !gitInfo.isGitRepo) {
    return (
      <View style={styles.centered}>
        <Text style={styles.hintText}>
          Current working directory is not a Git repository.
        </Text>
        <Pressable style={styles.refreshBtn} onPress={loadGitStatus}>
          <Text style={styles.refreshBtnText}>Refresh</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.summaryBar}>
        <View style={styles.branchRow}>
          <Text style={styles.branchBadge}>⎇ {gitInfo.branch || "HEAD"}</Text>
          <Text style={styles.summaryStats}>
            {gitInfo.files.length} files changed (
            <Text style={styles.addStat}>+{gitInfo.summary.totalAdditions}</Text>{" "}
            / <Text style={styles.delStat}>-{gitInfo.summary.totalDeletions}</Text>)
          </Text>
        </View>
        <Pressable style={styles.refreshSmallBtn} onPress={loadGitStatus}>
          <Text style={styles.refreshSmallText}>
            {loading ? "..." : "↻ Refresh"}
          </Text>
        </Pressable>
      </View>

      {gitInfo.clean ? (
        <View style={styles.cleanBox}>
          <Text style={styles.cleanTitle}>Working tree clean</Text>
          <Text style={styles.hintText}>
            No uncommitted modifications or untracked files in this repository.
          </Text>
        </View>
      ) : (
        gitInfo.files.map((file) => (
          <FileDiffCard key={file.path} file={file} />
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b0e14",
  },
  content: {
    padding: 12,
    gap: 12,
    paddingBottom: 32,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    gap: 12,
    backgroundColor: "#0b0e14",
  },
  hintText: {
    color: "#9ca3af",
    fontSize: 13,
    textAlign: "center",
  },
  errorText: {
    color: "#f87171",
    fontSize: 13,
    textAlign: "center",
  },
  refreshBtn: {
    backgroundColor: "#1f2937",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#374151",
  },
  refreshBtnText: {
    color: "#e5e7eb",
    fontSize: 13,
    fontWeight: "600",
  },
  summaryBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#141821",
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#262d3d",
  },
  branchRow: {
    flex: 1,
    gap: 4,
  },
  branchBadge: {
    color: "#93c5fd",
    fontFamily: MONO_FONT,
    fontSize: 13,
    fontWeight: "700",
  },
  summaryStats: {
    color: "#9ca3af",
    fontSize: 12,
  },
  refreshSmallBtn: {
    backgroundColor: "#1e293b",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  refreshSmallText: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "600",
  },
  cleanBox: {
    padding: 32,
    alignItems: "center",
    gap: 6,
  },
  cleanTitle: {
    color: "#34d399",
    fontSize: 15,
    fontWeight: "700",
  },
  fileCard: {
    backgroundColor: "#141821",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#262d3d",
    overflow: "hidden",
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 8,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusBadgeText: {
    color: "#f9fafb",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: "700",
  },
  filePath: {
    flex: 1,
    color: "#e5e7eb",
    fontFamily: MONO_FONT,
    fontSize: 12,
    fontWeight: "600",
  },
  statPills: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  addStat: {
    color: "#34d399",
    fontFamily: MONO_FONT,
    fontSize: 12,
    fontWeight: "700",
  },
  delStat: {
    color: "#f87171",
    fontFamily: MONO_FONT,
    fontSize: 12,
    fontWeight: "700",
  },
  chevron: {
    color: "#9ca3af",
    fontSize: 12,
  },
  fileDiffBody: {
    borderTopWidth: 1,
    borderTopColor: "#1f2430",
    backgroundColor: "#0d1017",
    paddingVertical: 6,
  },
  diffLinesContainer: {
    minWidth: "100%",
  },
  diffLine: {
    paddingHorizontal: 10,
    paddingVertical: 1,
  },
  diffLineContext: {},
  diffLineHeader: {
    backgroundColor: "#111827",
  },
  diffLineHunk: {
    backgroundColor: "rgba(56, 189, 248, 0.12)",
  },
  diffLineAdd: {
    backgroundColor: "rgba(16, 185, 129, 0.15)",
  },
  diffLineDel: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
  },
  diffText: {
    fontFamily: MONO_FONT,
    fontSize: 11,
    lineHeight: 16,
  },
  diffTextContext: {
    color: "#9ca3af",
  },
  diffTextHeader: {
    color: "#9ca3af",
    fontWeight: "700",
  },
  diffTextHunk: {
    color: "#38bdf8",
  },
  diffTextAdd: {
    color: "#6ee7b7",
  },
  diffTextDel: {
    color: "#fca5a5",
  },
  emptyDiffText: {
    color: "#6b7280",
    fontFamily: MONO_FONT,
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});
