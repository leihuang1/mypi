import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { colors, font, MONO_FONT, radius, space, touch } from "../theme";

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
  const breadcrumbRef = useRef<ScrollView>(null);
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
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.breadcrumbScroll}
            contentContainerStyle={styles.breadcrumbRow}
            ref={breadcrumbRef}
            onContentSizeChange={() => breadcrumbRef.current?.scrollToEnd({ animated: false })}
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
            accessibilityLabel={isBookmarked ? "Remove bookmark" : "Bookmark this folder"}
          >
            <Text style={[styles.iconBtnText, isBookmarked ? styles.iconBtnTextBookmarked : null]}>{isBookmarked ? "★" : "☆"}</Text>
          </Pressable>

          <Pressable
            onPress={() => {
              setPathInputValue(currentPath);
              setShowPathInput((prev) => !prev);
            }}
            style={styles.iconBtn}
            accessibilityLabel="Go to path"
          >
            <Text style={styles.iconBtnText}>✎</Text>
          </Pressable>
        </View>

        {showPathInput && (
          <View style={styles.jumpInputRow}>
            <TextInput
              style={styles.jumpInput}
              value={pathInputValue}
              onChangeText={setPathInputValue}
              placeholder="Enter path (e.g. ~/code/project)"
              placeholderTextColor={colors.textFaint}
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
                ✓ Session folder
              </Text>
            ) : (
              <Pressable
                style={styles.setCwdBtn}
                onPress={() => onSetSessionCwd(currentPath)}
              >
                <Text style={styles.setCwdBtnText} numberOfLines={1}>
                  Use "{currentPath.split("/").pop() || "/"}" as session folder
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
              <Text style={styles.upChipText}>‹ Parent</Text>
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
          } items`}
          placeholderTextColor={colors.textFaint}
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
          <Text style={styles.toolBtnText}>New</Text>
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
          <Text style={styles.toolBtnText}>Clone</Text>
        </Pressable>
      </View>

      {/* Inline Mkdir Form */}
      {activeAction === "mkdir" && (
        <View style={styles.actionCard}>
          <Text style={styles.actionTitle}>
            New folder in {currentPath.split("/").pop() || "/"}
          </Text>
          <TextInput
            style={styles.actionInput}
            placeholder="Folder name (e.g. my-new-app)"
            placeholderTextColor={colors.textFaint}
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
                {newDirGitInit ? "☑" : "☐"} Initialize Git repo
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
                {actionBusy ? "Creating…" : "Create"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Inline Git Clone Form */}
      {activeAction === "clone" && (
        <View style={styles.actionCard}>
          <Text style={styles.actionTitle}>
            Clone into {currentPath.split("/").pop() || "/"}
          </Text>
          <TextInput
            style={styles.actionInput}
            placeholder="Repository URL (https://... or git@...)"
            placeholderTextColor={colors.textFaint}
            value={cloneRepoUrl}
            onChangeText={setCloneRepoUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.actionFooter}>
            <TextInput
              style={[styles.actionInput, { flex: 1 }]}
              placeholder="Optional target folder name"
              placeholderTextColor={colors.textFaint}
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
                {actionBusy ? "Cloning…" : "Clone"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      {/* File Content Preview Card */}
      {loadingFile ? (
        <View style={styles.previewCard}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.previewMeta}>Loading preview…</Text>
        </View>
      ) : previewFile ? (
        <View style={styles.previewCard}>
          <View style={styles.previewHeader}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.previewTitle} numberOfLines={1}>
                {previewFile.name}
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
                <Text style={styles.mentionChipText}>@ Mention</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.closePreviewBtn}
              onPress={() => clearPreviewState()}
            >
              <Text style={styles.closePreviewText}>✕</Text>
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
        <ActivityIndicator color={colors.accent} style={{ marginVertical: 18 }} />
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
                {d.isGitRepo && <Text style={styles.gitBadge}>git</Text>}
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
    gap: space.sm,
  },
  wrapperFull: {
    flex: 1,
  },
  pathBar: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.sm,
    gap: space.sm,
  },
  pathTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
  },
  breadcrumbScroll: {
    flex: 1,
    minWidth: 0,
  },
  breadcrumbRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingRight: space.sm,
  },
  breadcrumbSep: {
    color: colors.textFaint,
    fontSize: font.small,
  },
  breadcrumbChip: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 6,
    borderRadius: radius.sm,
  },
  breadcrumbText: {
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.small,
  },
  iconBtn: {
    flexShrink: 0,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
  },
  iconBtnBookmarked: {
    backgroundColor: colors.warningSoft,
  },
  iconBtnText: {
    color: colors.textMuted,
    fontSize: font.title,
  },
  iconBtnTextBookmarked: {
    color: colors.warning,
  },
  jumpInputRow: {
    flexDirection: "row",
    gap: space.sm,
  },
  jumpInput: {
    flex: 1,
    minWidth: 0,
    minHeight: touch,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.small,
  },
  jumpGoBtn: {
    flexShrink: 0,
    minHeight: touch,
    backgroundColor: colors.accent,
    paddingHorizontal: space.lg,
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  jumpGoBtnText: {
    color: colors.onAccent,
    fontSize: font.small,
    fontWeight: "600",
  },
  cwdBannerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  cwdActiveBadge: {
    flex: 1,
    minWidth: 0,
    color: colors.success,
    fontSize: font.small,
    fontWeight: "500",
    paddingHorizontal: space.xs,
  },
  setCwdBtn: {
    flexShrink: 1,
    minWidth: 0,
    minHeight: 36,
    justifyContent: "center",
    backgroundColor: colors.accentSoft,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  setCwdBtnText: {
    color: colors.accentText,
    fontSize: font.small,
    fontWeight: "500",
  },
  mentionCwdBtn: {
    flexShrink: 0,
    minHeight: 36,
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  mentionCwdBtnText: {
    color: colors.accentText,
    fontSize: font.small,
    fontWeight: "500",
  },
  quickScroll: {
    flexGrow: 0,
  },
  quickRow: {
    gap: space.sm,
    paddingVertical: 2,
    alignItems: "center",
  },
  upChip: {
    minHeight: 34,
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  upChipText: {
    color: colors.accentText,
    fontSize: font.small,
    fontWeight: "500",
  },
  bookmarkChip: {
    minHeight: 34,
    justifyContent: "center",
    backgroundColor: colors.warningSoft,
    borderWidth: 1,
    borderColor: "transparent",
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  bookmarkChipText: {
    color: colors.warning,
    fontSize: font.small,
  },
  recentChip: {
    minHeight: 34,
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "transparent",
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  recentChipText: {
    color: colors.textMuted,
    fontSize: font.small,
  },
  chipActive: {
    borderColor: colors.accent,
  },
  toolbarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  filterInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: colors.text,
    fontSize: font.small,
  },
  toolBtn: {
    flexShrink: 0,
    minHeight: 40,
    justifyContent: "center",
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: "transparent",
  },
  toolBtnActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  toolBtnText: {
    color: colors.textMuted,
    fontSize: font.small,
    fontWeight: "500",
  },
  toolBtnTextActive: {
    color: colors.text,
  },
  actionCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.md,
  },
  actionTitle: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: "600",
  },
  actionInput: {
    minHeight: touch,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.small,
  },
  actionFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  checkboxRow: {
    flex: 1,
    minHeight: 40,
    justifyContent: "center",
  },
  checkboxText: {
    color: colors.text,
    fontSize: font.small,
  },
  actionSubmitBtn: {
    minHeight: 40,
    justifyContent: "center",
    backgroundColor: colors.accent,
    paddingHorizontal: space.lg,
    borderRadius: radius.sm,
  },
  actionSubmitText: {
    color: colors.onAccent,
    fontSize: font.small,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.45,
  },
  errorText: {
    color: colors.dangerText,
    fontSize: font.small,
    lineHeight: 19,
  },
  previewCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  previewTitle: {
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.small,
    fontWeight: "600",
  },
  previewMeta: {
    color: colors.textMuted,
    fontSize: font.caption,
  },
  mentionChip: {
    minHeight: 36,
    justifyContent: "center",
    backgroundColor: colors.accentSoft,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  mentionChipText: {
    color: colors.accentText,
    fontSize: font.small,
    fontWeight: "600",
  },
  closePreviewBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  closePreviewText: {
    color: colors.textMuted,
    fontSize: font.body,
  },
  binaryWarning: {
    color: colors.warning,
    fontSize: font.small,
    lineHeight: 19,
  },
  previewCodeScroll: {
    maxHeight: 280,
    backgroundColor: colors.surfaceSunken,
    padding: space.md,
    borderRadius: radius.sm,
  },
  previewCodeText: {
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.caption,
    lineHeight: 18,
  },
  entriesScroll: {
    maxHeight: 320,
  },
  entriesScrollFull: {
    flex: 1,
  },
  entriesContent: {
    paddingBottom: space.xl,
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  entryMainPress: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: touch + 4,
    paddingHorizontal: space.xs,
  },
  entryIcon: {
    fontSize: font.body,
  },
  dirName: {
    flex: 1,
    color: colors.text,
    fontSize: font.body,
    fontWeight: "500",
  },
  fileName: {
    flex: 1,
    color: colors.textMuted,
    fontSize: font.body,
  },
  fileSizeText: {
    color: colors.textFaint,
    fontSize: font.caption,
  },
  gitBadge: {
    backgroundColor: colors.successSoft,
    color: colors.success,
    fontSize: font.caption,
    fontWeight: "500",
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  rowMentionBtn: {
    width: touch,
    height: touch,
    alignItems: "center",
    justifyContent: "center",
  },
  rowMentionText: {
    color: colors.accentText,
    fontSize: font.title,
    fontWeight: "600",
  },
  emptyText: {
    color: colors.textFaint,
    fontSize: font.small,
    paddingVertical: space.xl,
    textAlign: "center",
  },
});
