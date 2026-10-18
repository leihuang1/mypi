import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  DirectoryListing,
  FilePreviewResponse,
  MyPiClient,
} from "@mypi/shared";

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function toRelativeOrShortPath(targetPath: string, baseDir?: string): string {
  if (!baseDir) return targetPath;
  const cleanBase = baseDir.replace(/\/+$/, "");
  if (targetPath === cleanBase) return ".";
  if (targetPath.startsWith(`${cleanBase}/`)) {
    return targetPath.slice(cleanBase.length + 1);
  }
  return targetPath;
}

export function FileBrowserPanel({
  client,
  initialPath,
  startDirs = [],
  sessionCwd,
  showFiles = true,
  fullHeight = false,
  onSelectDirectory,
  onSetSessionCwd,
  onMentionPath,
}: {
  client: MyPiClient;
  initialPath?: string;
  startDirs?: string[];
  sessionCwd?: string;
  showFiles?: boolean;
  fullHeight?: boolean;
  onSelectDirectory?: (dirPath: string) => void;
  onSetSessionCwd?: (dirPath: string) => Promise<void> | void;
  onMentionPath?: (mentionToken: string, fullPath: string) => void;
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Manual path input bar
  const [showPathInput, setShowPathInput] = useState(false);
  const [pathInputValue, setPathInputValue] = useState("");

  // New folder / Git clone forms
  const [activeAction, setActiveAction] = useState<"mkdir" | "clone" | null>(
    null,
  );
  const [newDirName, setNewDirName] = useState("");
  const [newDirGitInit, setNewDirGitInit] = useState(true);
  const [cloneRepoUrl, setCloneRepoUrl] = useState("");
  const [cloneFolderName, setCloneFolderName] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  // File preview state
  const [previewFile, setPreviewFile] = useState<FilePreviewResponse | null>(
    null,
  );
  const [loadingFile, setLoadingFile] = useState(false);

  // Sequence numbers to prevent out-of-order responses from overwriting latest selection
  const dirReqIdRef = useRef(0);
  const previewReqIdRef = useRef(0);

  const clearPreviewState = () => {
    previewReqIdRef.current += 1;
    setPreviewFile(null);
    setLoadingFile(false);
  };

  const loadDir = async (
    targetPath?: string,
    hiddenOverride?: boolean,
  ): Promise<void> => {
    const reqId = ++dirReqIdRef.current;
    const useHidden =
      hiddenOverride !== undefined ? hiddenOverride : includeHidden;
    setLoading(true);
    setError(null);
    try {
      const res = await client.listDirs(targetPath, {
        includeHidden: useHidden,
      });
      if (dirReqIdRef.current !== reqId) return;
      setListing(res);
      setPathInputValue(res.path);
      onSelectDirectory?.(res.path);
    } catch (err) {
      if (dirReqIdRef.current !== reqId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (dirReqIdRef.current === reqId) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadDir(initialPath || sessionCwd || startDirs[0] || undefined);
    return () => {
      dirReqIdRef.current += 1;
      previewReqIdRef.current += 1;
    };
  }, []);

  const currentPath = listing?.path || initialPath || "";
  const isBookmarked = Boolean(
    currentPath && listing?.bookmarks?.includes(currentPath),
  );

  // Build clickable breadcrumbs from currentPath
  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    const parts = currentPath.split("/").filter(Boolean);
    const items: Array<{ label: string; path: string }> = [
      { label: "/", path: "/" },
    ];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      items.push({ label: part, path: acc });
    }
    return items;
  }, [currentPath]);

  const filteredDirs = useMemo(() => {
    const dirs = listing?.dirs ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return dirs;
    return dirs.filter((d) => d.name.toLowerCase().includes(q));
  }, [listing?.dirs, searchQuery]);

  const filteredFiles = useMemo(() => {
    if (!showFiles) return [];
    const files = listing?.files ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.name.toLowerCase().includes(q));
  }, [listing?.files, searchQuery, showFiles]);

  const handleToggleHidden = () => {
    const next = !includeHidden;
    setIncludeHidden(next);
    void loadDir(currentPath || undefined, next);
  };

  const handleToggleBookmark = async () => {
    if (!currentPath) return;
    try {
      const res = await client.updateBookmark({
        path: currentPath,
        bookmarked: !isBookmarked,
      });
      setListing((prev) =>
        prev ? { ...prev, bookmarks: res.bookmarks } : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleJumpPath = () => {
    if (!pathInputValue.trim()) return;
    setShowPathInput(false);
    void loadDir(pathInputValue.trim());
  };

  const handleCreateDir = async () => {
    if (!currentPath || !newDirName.trim() || actionBusy) return;
    setActionBusy(true);
    setError(null);
    try {
      const created = await client.createDirectory({
        parentPath: currentPath,
        name: newDirName.trim(),
        gitInit: newDirGitInit,
      });
      setNewDirName("");
      setActiveAction(null);
      await loadDir(created.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleGitClone = async () => {
    if (!currentPath || !cloneRepoUrl.trim() || actionBusy) return;
    setActionBusy(true);
    setError(null);
    try {
      const cloned = await client.gitClone({
        targetParentDir: currentPath,
        repoUrl: cloneRepoUrl.trim(),
        folderName: cloneFolderName.trim() || undefined,
      });
      setCloneRepoUrl("");
      setCloneFolderName("");
      setActiveAction(null);
      await loadDir(cloned.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleOpenFilePreview = async (filePath: string) => {
    const reqId = ++previewReqIdRef.current;
    setLoadingFile(true);
    setError(null);
    try {
      const preview = await client.readFilePreview(filePath);
      if (previewReqIdRef.current !== reqId) return;
      setPreviewFile(preview);
    } catch (err) {
      if (previewReqIdRef.current !== reqId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (previewReqIdRef.current === reqId) {
        setLoadingFile(false);
      }
    }
  };

  const triggerMention = (fullPath: string, isDir = false) => {
    if (!onMentionPath) return;
    const rel = toRelativeOrShortPath(fullPath, sessionCwd || currentPath);
    const formatted = isDir && !rel.endsWith("/") ? `@${rel}/` : `@${rel}`;
    onMentionPath(formatted, fullPath);
  };

  const quickBookmarks = listing?.bookmarks ?? [];
  const quickRecents = (listing?.recentDirs ?? []).filter(
    (r) => !quickBookmarks.includes(r),
  );

  return (
    <View style={[styles.wrapper, fullHeight ? styles.wrapperFull : null]}>
      {/* Current Path Header + Bookmark + Direct Jump */}
      <View style={styles.pathBar}>
        <View style={styles.pathTopRow}>
          <Text style={styles.pathBadge}>PATH</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.breadcrumbScroll}
            contentContainerStyle={styles.breadcrumbRow}
          >
            {breadcrumbs.map((bc, idx) => (
              <React.Fragment key={bc.path}>
                {idx > 0 && <Text style={styles.breadcrumbSep}>›</Text>}
                <Pressable
                  style={styles.breadcrumbChip}
                  onPress={() => {
                    clearPreviewState();
                    void loadDir(bc.path);
                  }}
                >
                  <Text style={styles.breadcrumbText}>{bc.label}</Text>
                </Pressable>
              </React.Fragment>
            ))}
          </ScrollView>

          <Pressable
            onPress={handleToggleBookmark}
            style={[
              styles.iconBtn,
              isBookmarked ? styles.iconBtnBookmarked : null,
            ]}
          >
            <Text style={styles.iconBtnText}>{isBookmarked ? "★" : "☆"}</Text>
          </Pressable>

          <Pressable
            onPress={() => {
              setPathInputValue(currentPath);
              setShowPathInput((prev) => !prev);
            }}
            style={styles.iconBtn}
          >
            <Text style={styles.iconBtnText}>✎ Jump</Text>
          </Pressable>
        </View>

        {showPathInput && (
          <View style={styles.jumpInputRow}>
            <TextInput
              style={styles.jumpInput}
              value={pathInputValue}
              onChangeText={setPathInputValue}
              placeholder="Enter path (e.g. ~/code/project)"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={handleJumpPath}
            />
            <Pressable style={styles.jumpGoBtn} onPress={handleJumpPath}>
              <Text style={styles.jumpGoBtnText}>Go</Text>
            </Pressable>
          </View>
        )}

        {/* Session CWD Switcher Banner when browsing inside a session */}
        {onSetSessionCwd && currentPath && (
          <View style={styles.cwdBannerRow}>
            {sessionCwd === currentPath ? (
              <Text style={styles.cwdActiveBadge} numberOfLines={1}>
                ✓ Active Session CWD
              </Text>
            ) : (
              <Pressable
                style={styles.setCwdBtn}
                onPress={() => onSetSessionCwd(currentPath)}
              >
                <Text style={styles.setCwdBtnText} numberOfLines={1}>
                  📌 Set "{currentPath.split("/").pop() || "/"}" as CWD
                </Text>
              </Pressable>
            )}
            {onMentionPath && (
              <Pressable
                style={styles.mentionCwdBtn}
                onPress={() => triggerMention(currentPath, true)}
              >
                <Text style={styles.mentionCwdBtnText}>@ Folder</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>

      {/* Bookmarks & Recent Quick Access Chips */}
      {(quickBookmarks.length > 0 ||
        quickRecents.length > 0 ||
        listing?.parent) && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.quickScroll}
          contentContainerStyle={styles.quickRow}
        >
          {listing?.parent && (
            <Pressable
              style={styles.upChip}
              onPress={() => {
                clearPreviewState();
                void loadDir(listing.parent!);
              }}
            >
              <Text style={styles.upChipText}>⬆ Parent</Text>
            </Pressable>
          )}
          {quickBookmarks.map((b) => (
            <Pressable
              key={`bm-${b}`}
              style={[
                styles.bookmarkChip,
                b === currentPath ? styles.chipActive : null,
              ]}
              onPress={() => {
                clearPreviewState();
                void loadDir(b);
              }}
            >
              <Text style={styles.bookmarkChipText}>
                ★ {b.split("/").pop() || b}
              </Text>
            </Pressable>
          ))}
          {quickRecents.slice(0, 6).map((r) => (
            <Pressable
              key={`rec-${r}`}
              style={[
                styles.recentChip,
                r === currentPath ? styles.chipActive : null,
              ]}
              onPress={() => {
                clearPreviewState();
                void loadDir(r);
              }}
            >
              <Text style={styles.recentChipText}>
                🕒 {r.split("/").pop() || r}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Search Filter + Hidden Toggle + Mkdir / Git Clone Toolbar */}
      <View style={styles.toolbarRow}>
        <TextInput
          style={styles.filterInput}
          placeholder={`Filter ${
            (listing?.dirs.length ?? 0) +
            (showFiles ? (listing?.files?.length ?? 0) : 0)
          } items...`}
          placeholderTextColor="#6b7280"
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          style={[
            styles.toolBtn,
            includeHidden ? styles.toolBtnActive : null,
          ]}
          onPress={handleToggleHidden}
        >
          <Text
            style={[
              styles.toolBtnText,
              includeHidden ? styles.toolBtnTextActive : null,
            ]}
          >
            .*
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.toolBtn,
            activeAction === "mkdir" ? styles.toolBtnActive : null,
          ]}
          onPress={() =>
            setActiveAction((prev) => (prev === "mkdir" ? null : "mkdir"))
          }
        >
          <Text style={styles.toolBtnText}>+ Folder</Text>
        </Pressable>
        <Pressable
          style={[
            styles.toolBtn,
            activeAction === "clone" ? styles.toolBtnActive : null,
          ]}
          onPress={() =>
            setActiveAction((prev) => (prev === "clone" ? null : "clone"))
          }
        >
          <Text style={styles.toolBtnText}>⬇ Clone</Text>
        </Pressable>
      </View>

      {/* Inline Mkdir Form */}
      {activeAction === "mkdir" && (
        <View style={styles.actionCard}>
          <Text style={styles.actionTitle}>
            Create New Directory in {currentPath.split("/").pop() || "/"}
          </Text>
          <TextInput
            style={styles.actionInput}
            placeholder="Folder name (e.g. my-new-app)"
            placeholderTextColor="#6b7280"
            value={newDirName}
            onChangeText={setNewDirName}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.actionFooter}>
            <Pressable
              style={styles.checkboxRow}
              onPress={() => setNewDirGitInit((prev) => !prev)}
            >
              <Text style={styles.checkboxText}>
                {newDirGitInit ? "☑" : "☐"} Initialize Git repo (git init)
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.actionSubmitBtn,
                !newDirName.trim() || actionBusy ? styles.btnDisabled : null,
              ]}
              onPress={handleCreateDir}
              disabled={!newDirName.trim() || actionBusy}
            >
              <Text style={styles.actionSubmitText}>
                {actionBusy ? "Creating..." : "Create"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Inline Git Clone Form */}
      {activeAction === "clone" && (
        <View style={styles.actionCard}>
          <Text style={styles.actionTitle}>
            Git Clone into {currentPath.split("/").pop() || "/"}
          </Text>
          <TextInput
            style={styles.actionInput}
            placeholder="Repository URL (https://... or git@...)"
            placeholderTextColor="#6b7280"
            value={cloneRepoUrl}
            onChangeText={setCloneRepoUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.actionFooter}>
            <TextInput
              style={[styles.actionInput, { flex: 1 }]}
              placeholder="Optional target folder name"
              placeholderTextColor="#6b7280"
              value={cloneFolderName}
              onChangeText={setCloneFolderName}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              style={[
                styles.actionSubmitBtn,
                !cloneRepoUrl.trim() || actionBusy ? styles.btnDisabled : null,
              ]}
              onPress={handleGitClone}
              disabled={!cloneRepoUrl.trim() || actionBusy}
            >
              <Text style={styles.actionSubmitText}>
                {actionBusy ? "Cloning..." : "Clone"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      {/* File Content Preview Card */}
      {loadingFile ? (
        <View style={styles.previewCard}>
          <ActivityIndicator color="#60a5fa" size="small" />
          <Text style={styles.previewMeta}>Reading file preview...</Text>
        </View>
      ) : previewFile ? (
        <View style={styles.previewCard}>
          <View style={styles.previewHeader}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.previewTitle} numberOfLines={1}>
                📄 {previewFile.name}
              </Text>
              <Text style={styles.previewMeta} numberOfLines={1}>
                {formatBytes(previewFile.size)}
                {previewFile.truncated ? " • Truncated to 64 KB" : ""}
              </Text>
            </View>
            {onMentionPath && (
              <Pressable
                style={styles.mentionChip}
                onPress={() => triggerMention(previewFile.path, false)}
              >
                <Text style={styles.mentionChipText}>@ Mention in Chat</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.closePreviewBtn}
              onPress={() => clearPreviewState()}
            >
              <Text style={styles.closePreviewText}>✕ Close</Text>
            </Pressable>
          </View>
          {previewFile.isBinary ? (
            <Text style={styles.binaryWarning}>
              Binary file detected ({formatBytes(previewFile.size)}). Use @ Mention to ask Pi to inspect it.
            </Text>
          ) : (
            <ScrollView
              style={styles.previewCodeScroll}
              nestedScrollEnabled
            >
              <Text style={styles.previewCodeText} selectable>
                {previewFile.content || "(Empty file)"}
              </Text>
            </ScrollView>
          )}
        </View>
      ) : null}

      {/* Directory & File List */}
      {loading ? (
        <ActivityIndicator color="#60a5fa" style={{ marginVertical: 18 }} />
      ) : (
        <ScrollView
          style={fullHeight ? styles.entriesScrollFull : styles.entriesScroll}
          contentContainerStyle={styles.entriesContent}
          nestedScrollEnabled
        >
          {filteredDirs.map((d) => (
            <View key={d.path} style={styles.entryRow}>
              <Pressable
                style={styles.entryMainPress}
                onPress={() => {
                  clearPreviewState();
                  void loadDir(d.path);
                }}
              >
                <Text style={styles.entryIcon}>
                  {d.isGitRepo ? "📦" : "📁"}
                </Text>
                <Text style={styles.dirName} numberOfLines={1}>
                  {d.name}
                </Text>
                {d.isGitRepo && <Text style={styles.gitBadge}>GIT</Text>}
              </Pressable>
              {onMentionPath && (
                <Pressable
                  style={styles.rowMentionBtn}
                  onPress={() => triggerMention(d.path, true)}
                >
                  <Text style={styles.rowMentionText}>@</Text>
                </Pressable>
              )}
            </View>
          ))}

          {showFiles &&
            filteredFiles.map((f) => (
              <View key={f.path} style={styles.entryRow}>
                <Pressable
                  style={styles.entryMainPress}
                  onPress={() => handleOpenFilePreview(f.path)}
                >
                  <Text style={styles.entryIcon}>📄</Text>
                  <Text style={styles.fileName} numberOfLines={1}>
                    {f.name}
                  </Text>
                  <Text style={styles.fileSizeText}>{formatBytes(f.size)}</Text>
                </Pressable>
                {onMentionPath && (
                  <Pressable
                    style={styles.rowMentionBtn}
                    onPress={() => triggerMention(f.path, false)}
                  >
                    <Text style={styles.rowMentionText}>@</Text>
                  </Pressable>
                )}
              </View>
            ))}

          {filteredDirs.length === 0 && filteredFiles.length === 0 && (
            <Text style={styles.emptyText}>
              {searchQuery
                ? `No items matching "${searchQuery}"`
                : "No subdirectories or files in this folder."}
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 8,
  },
  wrapperFull: {
    flex: 1,
  },
  pathBar: {
    backgroundColor: "#0b0e14",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2e3646",
    padding: 8,
    gap: 8,
  },
  pathTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pathBadge: {
    flexShrink: 0,
    color: "#60a5fa",
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: "700",
    backgroundColor: "#172554",
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  breadcrumbScroll: {
    flex: 1,
    minWidth: 0,
  },
  breadcrumbRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingRight: 8,
  },
  breadcrumbSep: {
    color: "#4b5563",
    fontSize: 12,
  },
  breadcrumbChip: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: "#141821",
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  breadcrumbText: {
    color: "#e5e7eb",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  iconBtn: {
    flexShrink: 0,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "#1f2937",
    borderRadius: 5,
  },
  iconBtnBookmarked: {
    backgroundColor: "#422006",
    borderWidth: 1,
    borderColor: "#f59e0b",
  },
  iconBtnText: {
    color: "#f3f4f6",
    fontSize: 11,
    fontWeight: "600",
  },
  jumpInputRow: {
    flexDirection: "row",
    gap: 6,
  },
  jumpInput: {
    flex: 1,
    minWidth: 0,
    backgroundColor: "#141821",
    borderWidth: 1,
    borderColor: "#3b82f6",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: "#f9fafb",
    fontFamily: MONO_FONT,
    fontSize: 12,
  },
  jumpGoBtn: {
    flexShrink: 0,
    backgroundColor: "#2563eb",
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: 6,
  },
  jumpGoBtnText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  cwdBannerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#1f2430",
  },
  cwdActiveBadge: {
    flex: 1,
    minWidth: 0,
    color: "#34d399",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: "600",
  },
  setCwdBtn: {
    flexShrink: 1,
    minWidth: 0,
    backgroundColor: "#1e3a8a",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#3b82f6",
  },
  setCwdBtnText: {
    color: "#dbeafe",
    fontSize: 11,
    fontWeight: "600",
  },
  mentionCwdBtn: {
    flexShrink: 0,
    backgroundColor: "#1f2937",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  mentionCwdBtnText: {
    color: "#93c5fd",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: "600",
  },
  quickScroll: {
    flexGrow: 0,
  },
  quickRow: {
    gap: 6,
    paddingVertical: 2,
    alignItems: "center",
  },
  upChip: {
    backgroundColor: "#1e293b",
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
  },
  upChipText: {
    color: "#93c5fd",
    fontSize: 11,
    fontWeight: "600",
  },
  bookmarkChip: {
    backgroundColor: "#271a07",
    borderWidth: 1,
    borderColor: "#92400e",
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
  },
  bookmarkChipText: {
    color: "#fcd34d",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  recentChip: {
    backgroundColor: "#111827",
    borderWidth: 1,
    borderColor: "#374151",
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
  },
  recentChipText: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 11,
  },
  chipActive: {
    borderColor: "#60a5fa",
  },
  toolbarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  filterInput: {
    flex: 1,
    minWidth: 0,
    backgroundColor: "#0b0e14",
    borderWidth: 1,
    borderColor: "#262d3d",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: "#f3f4f6",
    fontSize: 12,
  },
  toolBtn: {
    flexShrink: 0,
    backgroundColor: "#1f2937",
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#374151",
  },
  toolBtnActive: {
    backgroundColor: "#1e3a8a",
    borderColor: "#60a5fa",
  },
  toolBtnText: {
    color: "#d1d5db",
    fontSize: 11,
    fontWeight: "600",
  },
  toolBtnTextActive: {
    color: "#ffffff",
  },
  actionCard: {
    backgroundColor: "#0d1017",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3b82f6",
    padding: 10,
    gap: 8,
  },
  actionTitle: {
    color: "#93c5fd",
    fontSize: 12,
    fontWeight: "700",
  },
  actionInput: {
    backgroundColor: "#141821",
    borderWidth: 1,
    borderColor: "#2e3646",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    color: "#f9fafb",
    fontFamily: MONO_FONT,
    fontSize: 12,
  },
  actionFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  checkboxRow: {
    flex: 1,
    paddingVertical: 4,
  },
  checkboxText: {
    color: "#d1d5db",
    fontSize: 12,
  },
  actionSubmitBtn: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  actionSubmitText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  errorText: {
    color: "#f87171",
    fontSize: 12,
  },
  previewCard: {
    backgroundColor: "#0b0e14",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3b82f6",
    padding: 10,
    gap: 8,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  previewTitle: {
    color: "#f9fafb",
    fontFamily: MONO_FONT,
    fontSize: 12,
    fontWeight: "700",
  },
  previewMeta: {
    color: "#9ca3af",
    fontFamily: MONO_FONT,
    fontSize: 10,
  },
  mentionChip: {
    backgroundColor: "#1e3a8a",
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#60a5fa",
  },
  mentionChipText: {
    color: "#ffffff",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: "700",
  },
  closePreviewBtn: {
    backgroundColor: "#1f2937",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 5,
  },
  closePreviewText: {
    color: "#d1d5db",
    fontSize: 11,
    fontWeight: "600",
  },
  binaryWarning: {
    color: "#fbbf24",
    fontSize: 12,
    fontStyle: "italic",
  },
  previewCodeScroll: {
    maxHeight: 240,
    backgroundColor: "#080a0f",
    padding: 8,
    borderRadius: 6,
  },
  previewCodeText: {
    color: "#e5e7eb",
    fontFamily: MONO_FONT,
    fontSize: 11,
    lineHeight: 16,
  },
  entriesScroll: {
    maxHeight: 280,
  },
  entriesScrollFull: {
    flex: 1,
  },
  entriesContent: {
    gap: 5,
    paddingBottom: 20,
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0d1017",
    borderRadius: 7,
    borderWidth: 1,
    borderColor: "#1f2430",
    overflow: "hidden",
  },
  entryMainPress: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  entryIcon: {
    fontSize: 13,
  },
  dirName: {
    flex: 1,
    color: "#f3f4f6",
    fontFamily: MONO_FONT,
    fontSize: 12,
    fontWeight: "600",
  },
  fileName: {
    flex: 1,
    color: "#d1d5db",
    fontFamily: MONO_FONT,
    fontSize: 12,
  },
  fileSizeText: {
    color: "#6b7280",
    fontFamily: MONO_FONT,
    fontSize: 10,
  },
  gitBadge: {
    backgroundColor: "#065f46",
    color: "#6ee7b7",
    fontFamily: MONO_FONT,
    fontSize: 9,
    fontWeight: "700",
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  rowMentionBtn: {
    backgroundColor: "#172554",
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderLeftWidth: 1,
    borderLeftColor: "#1e3a8a",
  },
  rowMentionText: {
    color: "#93c5fd",
    fontFamily: MONO_FONT,
    fontSize: 12,
    fontWeight: "700",
  },
  emptyText: {
    color: "#9ca3af",
    fontSize: 12,
    fontStyle: "italic",
    paddingVertical: 10,
    textAlign: "center",
  },
});
