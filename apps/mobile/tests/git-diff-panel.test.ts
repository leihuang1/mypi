import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { it } from "node:test";
import ts from "typescript";

// Render the real component's element tree and callbacks without a native renderer.
function panel() {
  const slots: any[] = [];
  let cursor = 0;
  const useState = (initial: any) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  };
  const react = {
    useState,
    useRef: (initial: any) => useState({ current: initial })[0],
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
  };
  const native = {
    ...Object.fromEntries(["FlatList", "Modal", "Pressable", "SafeAreaView", "Text", "View"].map((name) => [name, name])),
    Platform: { OS: "android" }, StyleSheet: { create: (styles: any) => styles, absoluteFillObject: {} },
  };
  const context = { exports: {} as any, require: (name: string) => {
    if (name === "react") return react;
    assert.equal(name, "react-native");
    return native;
  } };
  const source = fs.readFileSync(new URL("../src/components/GitDiffPanel.tsx", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, context);
  return (props: any) => { cursor = 0; return context.exports.GitDiffPanel(props); };
}

const nodes = (node: any): any[] => node && typeof node === "object"
  ? [node, ...node.props.children.flat(Infinity).flatMap(nodes)] : [];
const height = (tree: any) => Object.assign({}, ...nodes(tree).find((node) => node.type === "SafeAreaView").props.style.filter(Boolean)).height;

it("opens files full-screen without size toggles, preserving the snapshot and list offset on return", () => {
  const render = panel();
  const file = { path: "test.txt", status: "?", additions: 1, deletions: 0, diff: "+old" };
  let closed = false;
  const props = { visible: true, stale: false, info: { files: [file] }, onClose: () => { closed = true; }, onRefresh: () => {} };
  let tree = render(props);
  assert.equal(height(tree), "72%");
  assert.equal(nodes(tree).some((node) => /展开阅读|收起阅读/.test(node.props.accessibilityLabel ?? "")), false);
  const list = nodes(tree).find((node) => node.type === "FlatList");
  const offsets: number[] = [];
  list.props.ref.current = { scrollToOffset: ({ offset }: { offset: number }) => offsets.push(offset) };
  list.props.onScroll({ nativeEvent: { contentOffset: { y: 320 } } });
  list.props.renderItem({ item: file }).props.onPress();
  tree = render(props);
  assert.equal(height(tree), "100%");
  props.info.files = [{ ...file, diff: "+new" }];
  tree = render(props);
  assert.equal(nodes(tree).filter((node) => node.type === "FlatList").at(-1).props.data[0], "+old");
  tree.props.onRequestClose();
  tree = render(props);
  assert.equal(height(tree), "72%");
  assert.equal(closed, false);
  nodes(tree).find((node) => node.type === "FlatList").props.onLayout();
  assert.deepEqual(offsets, [320]);
  tree.props.onRequestClose();
  assert.equal(closed, true);
});
