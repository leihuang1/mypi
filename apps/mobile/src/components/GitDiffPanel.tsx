import React, { useRef, useState } from "react";
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { GitFileStatus, GitStatusResponse } from "@mypi/shared";

const MONO_FONT = Platform.OS === "ios" ? "Menlo" : "monospace";

export function GitDiffPanel({ info, stale, visible, onClose, onRefresh }: {
  info?: GitStatusResponse;
  stale: boolean;
  visible: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState<GitFileStatus | null>(null);
  const [diffVersion, setDiffVersion] = useState(0);
  const listRef = useRef<FlatList<GitFileStatus>>(null);
  const listOffset = useRef(0);
  const files = info?.files ?? [];
  const latest = selected && files.find((file) => file.path === selected.path);
  const changed = selected && (latest?.diff ?? "") !== selected.diff;
  const close = () => {
    setSelected(null);
    onClose();
  };
  const back = () => setSelected(null);
  const names = new Map<string, number>();
  for (const file of files) {
    const name = file.path.split("/").pop()!;
    names.set(name, (names.get(name) ?? 0) + 1);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={selected ? back : close}>
      <View style={styles.overlay}>
        {!selected && <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="关闭改动面板" />}
        <SafeAreaView style={[styles.sheet, selected && styles.fullSheet]}>
          {!selected && <View style={styles.handle} />}
          <View style={styles.header}>
            {selected && <Pressable onPress={back} style={styles.button} accessibilityLabel="返回文件列表"><Text style={styles.link}>‹ 列表</Text></Pressable>}
            <View style={styles.titleBlock}>
              <Text style={styles.eyebrow}>工作区改动</Text>
              <Text style={styles.title} numberOfLines={1} ellipsizeMode="middle">
                {selected ? selected.path : `${files.length} 个文件`}
              </Text>
            </View>
            <Pressable onPress={close} style={styles.button} accessibilityLabel="关闭改动面板"><Text style={styles.close}>×</Text></Pressable>
          </View>
          <View style={styles.scopeRow}>
            <Text style={styles.caption}>相对 HEAD · 含暂存、未暂存及新增文本</Text>
            <Pressable onPress={onRefresh} hitSlop={8} accessibilityLabel="刷新工作区改动">
              <Text style={styles.link}>{stale ? "暂未更新 · 重试" : "↻"}</Text>
            </Pressable>
          </View>
          {changed && (
            <Pressable style={styles.updateBanner} onPress={() => {
              setSelected(latest ?? { ...selected, diff: "", additions: 0, deletions: 0 });
              setDiffVersion((v) => v + 1);
            }} accessibilityRole="button">
              <Text style={styles.link}>有新改动 · 更新</Text>
              <Text style={styles.caption}>当前阅读内容保持不变</Text>
            </Pressable>
          )}
          <View style={[styles.body, selected ? styles.hidden : null]}>
            <FlatList
              ref={listRef}
              data={files}
              keyExtractor={(file) => file.path}
              onScroll={(event) => {
                if (!selected) listOffset.current = event.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={32}
              onLayout={() => {
                if (!selected) listRef.current?.scrollToOffset({ offset: listOffset.current, animated: false });
              }}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={<Text style={styles.empty}>暂无可展示的文本改动</Text>}
              renderItem={({ item: file }) => {
                const name = file.path.split("/").pop()!;
                const directory = file.path.slice(0, -name.length).replace(/\/$/, "");
                const badge = file.status === "A" || file.status === "?" ? "新增" : file.status === "D" ? "删除" : null;
                return (
                  <Pressable style={styles.fileRow} onPress={() => setSelected(file)} accessibilityRole="button">
                    <View style={styles.titleBlock}>
                      <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
                      {(names.get(name) ?? 0) > 1 && <Text style={styles.caption} numberOfLines={1} ellipsizeMode="middle">{directory || "."}</Text>}
                    </View>
                    {badge && <Text style={styles.badge}>{badge}</Text>}
                    <Text style={styles.add}>+{file.additions}</Text>
                    <Text style={styles.del}>−{file.deletions}</Text>
                    <Text style={styles.caption}>›</Text>
                  </Pressable>
                );
              }}
            />
          </View>
          {selected && <FlatList
            key={`${selected.path}:${diffVersion}`}
            style={styles.body}
            data={selected.diff ? selected.diff.split(/\r?\n/) : []}
            keyExtractor={(_line, index) => String(index)}
            contentContainerStyle={styles.diffContent}
            ListEmptyComponent={<Text style={styles.empty}>该文件已无可展示的文本改动</Text>}
            renderItem={({ item: line }) => {
              const header = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ");
              const style = header ? styles.diffHeader : line.startsWith("@@") ? styles.hunk : line.startsWith("+") ? styles.addLine : line.startsWith("-") ? styles.delLine : styles.context;
              return <Text selectable style={[styles.diffLine, style]}>{line || " "}</Text>;
            }}
          />}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

// Values mirror src/theme.ts; kept inline so the panel stays importable by its renderer-free test.
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { height: "72%", backgroundColor: "#161a22", borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden" },
  fullSheet: { height: "100%", backgroundColor: "#0e1116", borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: "#343b4a", alignSelf: "center", marginTop: 10, marginBottom: 4 },
  header: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
  titleBlock: { flex: 1, minWidth: 0, gap: 2, paddingHorizontal: 8 },
  eyebrow: { color: "#a3abb9", fontSize: 12 },
  title: { color: "#e8ebf0", fontSize: 17, fontWeight: "600" },
  button: { minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" },
  link: { color: "#9cc0ff", fontSize: 14, fontWeight: "500" },
  close: { color: "#a3abb9", fontSize: 28, fontWeight: "300" },
  scopeRow: { paddingHorizontal: 16, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#262c38" },
  caption: { color: "#a3abb9", fontSize: 12, flexShrink: 1 },
  body: { flex: 1 },
  hidden: { display: "none" },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#262c38" },
  fileName: { color: "#e8ebf0", fontFamily: MONO_FONT, fontSize: 14 },
  badge: { color: "#a3abb9", fontSize: 12, borderRadius: 999, backgroundColor: "#1d222c", paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  add: { color: "#3ecf8e", fontFamily: MONO_FONT, fontSize: 13 },
  del: { color: "#f2685f", fontFamily: MONO_FONT, fontSize: 13 },
  empty: { color: "#a3abb9", textAlign: "center", padding: 32, fontSize: 14 },
  updateBanner: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: "#1b2b48", flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  diffContent: { paddingVertical: 10, paddingBottom: 32 },
  diffLine: { fontFamily: MONO_FONT, fontSize: 13, lineHeight: 20, paddingHorizontal: 14, minHeight: 20 },
  diffHeader: { color: "#a3abb9", backgroundColor: "#161a22" },
  hunk: { color: "#9cc0ff", backgroundColor: "#16233a", paddingVertical: 5 },
  addLine: { color: "#b6f0d3", backgroundColor: "#12302a" },
  delLine: { color: "#ffc9c4", backgroundColor: "#371c1f" },
  context: { color: "#b3bac6" },
});
