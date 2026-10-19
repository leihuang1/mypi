import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

export function loadSessionViewStore(
  storage = new Map<string, string>(),
  setItem = async (key: string, value: string) => { storage.set(key, value); },
): typeof import("../src/store/session-view-store.js") {
  const source = fs.readFileSync(new URL("../src/store/session-view-store.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, console, setTimeout, clearTimeout,
    require: () => ({ getItem: async (key: string) => storage.get(key) ?? null, setItem }),
  });
  return exports as typeof import("../src/store/session-view-store.js");
}

// Exercise the real screen callbacks without requiring a native React renderer.
export function loadScreenHandlers<T extends Record<string, unknown>>(
  file: URL,
  names: string[],
  bindings: T,
): T & Record<string, (...args: any[]) => any> {
  const source = ts.createSourceFile(
    file.pathname,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declarations: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      names.includes(node.name.getText(source)) &&
      node.initializer
    ) {
      declarations.push(`var ${node.name.getText(source)} = ${node.initializer.getText(source)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(declarations.length > 0, "Expected screen callbacks");
  const { outputText } = ts.transpileModule(declarations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  vm.runInNewContext(outputText, bindings);
  return bindings as T & Record<string, (...args: any[]) => any>;
}
