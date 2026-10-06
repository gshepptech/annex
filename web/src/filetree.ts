// The editor's file list as a tree, Find over it, and what kind of file a path is. No DOM here,
// so it is tested with node --test.

export interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: string[];
}

// Paths as git lists them ("src/a.ts") -> nested folders, each with its own files by full path.
export function buildTree(files: string[]): Dir {
  const top: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split("/");
    let d = top;
    for (const name of parts.slice(0, -1)) {
      let next = d.dirs.get(name);
      if (!next) {
        next = { name, path: d.path ? `${d.path}/${name}` : name, dirs: new Map(), files: [] };
        d.dirs.set(name, next);
      }
      d = next;
    }
    d.files.push(f);
  }
  return top;
}

// Paths containing q (any case): names that start with it first, then shorter paths.
export function matchFiles(files: string[], q: string, limit = 200): string[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  return files
    .filter((f) => f.toLowerCase().includes(needle))
    .sort((a, b) => Number(!name(a).startsWith(needle)) - Number(!name(b).startsWith(needle)) || a.length - b.length || a.localeCompare(b))
    .slice(0, limit);
}

export type Lang = "ts" | "tsx" | "js" | "jsx" | "json" | "md" | "css" | "html" | "py" | "go";

const LANG_BY_EXT: Record<string, Lang> = {
  ts: "ts", mts: "ts", cts: "ts", tsx: "tsx",
  js: "js", mjs: "js", cjs: "js", jsx: "jsx",
  json: "json", jsonc: "json",
  md: "md", markdown: "md",
  css: "css",
  html: "html", htm: "html",
  py: "py",
  go: "go",
};

export function langOf(path: string): Lang | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANG_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

// The editor keeps a file's own line ending: CRLF if the file uses it anywhere, else LF.
export function lineSeparatorOf(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
