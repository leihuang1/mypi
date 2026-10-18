import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

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
