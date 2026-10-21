import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, font, MONO_FONT, radius, space } from "../theme";

// A small, dependency-free renderer for the Markdown subset agents usually emit:
// headings, lists, quotes, fenced code, rules, and inline bold/italic/code.
type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; marker: string; indent: number; text: string }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "para"; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flush();
      const body: string[] = [];
      // An unclosed fence (e.g. while streaming) runs to the end of the text.
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i]);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { flush(); blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ kind: "rule" }); continue; }
    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (list) {
      flush();
      const marker = /\d/.test(list[2]) ? list[2].replace(")", ".") : "•";
      blocks.push({ kind: "list", marker, indent: Math.min(3, Math.floor(list[1].length / 2)), text: list[3] });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) { flush(); blocks.push({ kind: "quote", text: quote[1] }); continue; }
    // Indented continuation lines belong to the preceding list item.
    const prev = blocks[blocks.length - 1];
    if (!para.length && prev?.kind === "list" && /^\s{2,}\S/.test(line)) {
      prev.text += `\n${line.trim()}`;
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*\n]*?)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[2] !== undefined) out.push(<Text key={key} style={styles.inlineCode}>{m[2]}</Text>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<Text key={key} style={styles.bold}>{renderInline(m[3] ?? m[4], key)}</Text>);
    else out.push(<Text key={key} style={styles.italic}>{m[5]}</Text>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownText({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <View style={styles.root}>
      {blocks.map((block, i) => {
        const key = String(i);
        switch (block.kind) {
          case "code":
            return (
              <ScrollView key={key} horizontal style={styles.codeBlock} contentContainerStyle={styles.codeContent} nestedScrollEnabled>
                <Text style={styles.codeText} selectable>{block.text || " "}</Text>
              </ScrollView>
            );
          case "heading":
            return (
              <Text key={key} style={[styles.heading, block.level <= 2 ? styles.headingLarge : null]} selectable>
                {renderInline(block.text, key)}
              </Text>
            );
          case "list":
            return (
              <View key={key} style={[styles.listRow, { paddingLeft: block.indent * 16 }]}>
                <Text style={[styles.body, styles.listMarker]}>{block.marker}</Text>
                <Text style={[styles.body, styles.listText]} selectable>{renderInline(block.text, key)}</Text>
              </View>
            );
          case "quote":
            return (
              <View key={key} style={styles.quote}>
                <Text style={[styles.body, styles.quoteText]} selectable>{renderInline(block.text, key)}</Text>
              </View>
            );
          case "rule":
            return <View key={key} style={styles.rule} />;
          default:
            return <Text key={key} style={styles.body} selectable>{renderInline(block.text, key)}</Text>;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 10,
  },
  body: {
    color: colors.text,
    fontSize: font.body,
    lineHeight: 23,
  },
  bold: {
    fontWeight: "700",
  },
  italic: {
    fontStyle: "italic",
  },
  inlineCode: {
    fontFamily: MONO_FONT,
    fontSize: font.small,
    color: colors.accentText,
    backgroundColor: colors.surfaceRaised,
  },
  heading: {
    color: colors.text,
    fontSize: font.body + 1,
    lineHeight: 24,
    fontWeight: "700",
    marginTop: space.xs,
  },
  headingLarge: {
    fontSize: font.title + 1,
    lineHeight: 26,
  },
  listRow: {
    flexDirection: "row",
    gap: space.sm,
    marginTop: -4,
  },
  listMarker: {
    minWidth: 16,
    color: colors.textMuted,
    textAlign: "right",
  },
  listText: {
    flex: 1,
  },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.borderStrong,
    paddingLeft: space.md,
  },
  quoteText: {
    color: colors.textMuted,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderStrong,
    marginVertical: space.xs,
  },
  codeBlock: {
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.sm,
  },
  codeContent: {
    padding: space.md,
  },
  codeText: {
    color: colors.text,
    fontFamily: MONO_FONT,
    fontSize: font.caption,
    lineHeight: 18,
  },
});
