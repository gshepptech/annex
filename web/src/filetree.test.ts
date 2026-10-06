import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, langOf, lineSeparatorOf, matchFiles } from "./filetree.ts";

test("the tree nests folders and keeps each file's full path", () => {
  const t = buildTree(["README.md", "src/a.ts", "src/lib/b.ts", "src/lib/c.ts"]);
  assert.deepEqual(t.files, ["README.md"]);
  const src = t.dirs.get("src")!;
  assert.equal(src.path, "src");
  assert.deepEqual(src.files, ["src/a.ts"]);
  const lib = src.dirs.get("lib")!;
  assert.equal(lib.path, "src/lib");
  assert.deepEqual(lib.files, ["src/lib/b.ts", "src/lib/c.ts"]);
});

test("an empty list is an empty tree", () => {
  const t = buildTree([]);
  assert.equal(t.dirs.size, 0);
  assert.deepEqual(t.files, []);
});

test("Find puts names that start with what you typed first, then shorter paths", () => {
  const files = ["docs/old-main.md", "web/src/main.ts", "main.go", "server/domain.ts"];
  assert.deepEqual(matchFiles(files, "main"), ["main.go", "web/src/main.ts", "docs/old-main.md", "server/domain.ts"]);
  assert.deepEqual(matchFiles(files, "MAIN.GO"), ["main.go"], "any case");
  assert.deepEqual(matchFiles(files, "  "), []);
  assert.equal(matchFiles(files, "a", 2).length, 2);
});

test("every required language is known by its extension", () => {
  const cases: [string, string][] = [
    ["a.ts", "ts"], ["a.mts", "ts"], ["a.cts", "ts"], ["a.tsx", "tsx"],
    ["a.js", "js"], ["a.mjs", "js"], ["a.cjs", "js"], ["a.jsx", "jsx"],
    ["a.json", "json"], ["tsconfig.jsonc", "json"], ["README.md", "md"], ["x.markdown", "md"],
    ["s.css", "css"], ["i.html", "html"], ["i.HTM", "html"], ["x.py", "py"], ["dir.d/main.go", "go"],
  ];
  for (const [p, lang] of cases) assert.equal(langOf(p), lang, p);
});

test("an unknown kind, a dot-file or no extension has no language", () => {
  for (const p of ["Makefile", "a.rs", ".gitignore", "src.ts/Makefile"]) assert.equal(langOf(p), null, p);
});

test("the line ending is the file's own", () => {
  assert.equal(lineSeparatorOf("a\r\nb\r\n"), "\r\n");
  assert.equal(lineSeparatorOf("a\nb\r\n"), "\r\n", "mixed keeps CRLF");
  assert.equal(lineSeparatorOf("a\nb\n"), "\n");
  assert.equal(lineSeparatorOf("a\rb"), "\n", "a lone CR stays text");
  assert.equal(lineSeparatorOf(""), "\n");
});
