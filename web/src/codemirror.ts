// CodeMirror 6 for the Files dialog. Loaded only when the dialog first opens (await import), and
// each language loads on its own when a file of that kind is opened, so the page's own script does
// not grow.
//
// Two things keep a save byte-for-byte what the person sees: the document's line separator is set
// from the file (CodeMirror otherwise turns CRLF into LF), and the text is read back with
// sliceDoc(), which joins lines with that separator (doc.toString() always uses "\n").

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { langOf, lineSeparatorOf, type Lang } from "./filetree.ts";

export interface Editor {
  text(): string;
  dirty(): boolean;
  markSaved(text: string): void;
  replace(text: string): void;
  focus(): void;
  destroy(): void;
}

const LANGS: Record<Lang, () => Promise<Extension>> = {
  ts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  js: async () => (await import("@codemirror/lang-javascript")).javascript(),
  jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  md: async () => (await import("@codemirror/lang-markdown")).markdown(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  py: async () => (await import("@codemirror/lang-python")).python(),
  go: async () => (await import("@codemirror/lang-go")).go(),
};

// Colours are the page's own tokens, so switching Light and Dark recolours the editor with no
// script; the dark compartment only flips CodeMirror's own dark-mode defaults.
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--sunk)", color: "var(--text)", fontSize: "0.82rem" },
  ".cm-scroller": { fontFamily: "var(--term)", lineHeight: "1.55" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--dim)", borderRight: "1px solid var(--rule)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--raised)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "color-mix(in srgb, var(--focus) 28%, transparent)" },
  "&.cm-focused": { outline: "none" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--rule)" },
  ".cm-textfield, .cm-button": { borderRadius: "var(--r)", border: "1px solid var(--rule-strong)", fontFamily: "var(--ui)", backgroundImage: "none", backgroundColor: "var(--panel)", color: "var(--text)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "transparent", outline: "1px solid var(--rule-strong)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--raised)", border: "1px solid var(--rule)", color: "var(--muted)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.string, t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.className], color: "var(--syn-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-fn)", fontWeight: "500" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-prop)" },
  { tag: t.heading, fontWeight: "600", color: "var(--text)" },
  { tag: [t.link, t.url], color: "var(--syn-type)" },
  { tag: t.invalid, color: "var(--bad)" },
]);

const isDark = () => document.documentElement.dataset.theme === "dark";

export function createEditor(parent: HTMLElement, o: { text: string; path: string; onChange: (dirty: boolean) => void }): Editor {
  const lang = new Compartment();
  const dark = new Compartment();
  let saved = o.text;
  let langExt: Extension = [];
  let view: EditorView;

  // Cmd/Ctrl+S is the dialog's (one save, wherever focus is); nothing here binds it.
  const stateFor = (text: string) =>
    EditorState.create({
      doc: text,
      extensions: [
        EditorState.lineSeparator.of(lineSeparatorOf(text)),
        lineNumbers(),
        foldGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        syntaxHighlighting(highlight),
        theme,
        lang.of(langExt),
        dark.of(EditorView.darkTheme.of(isDark())),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) o.onChange(u.state.sliceDoc() !== saved);
        }),
      ],
    });

  view = new EditorView({ state: stateFor(o.text), parent });

  const kind = langOf(o.path);
  if (kind) {
    void LANGS[kind]().then((ext) => {
      langExt = ext;
      view.dispatch({ effects: lang.reconfigure(ext) });
    }).catch(() => {
      // a language that fails to load leaves plain text, which still edits and saves
    });
  }

  const watch = new MutationObserver(() => view.dispatch({ effects: dark.reconfigure(EditorView.darkTheme.of(isDark())) }));
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return {
    text: () => view.state.sliceDoc(),
    dirty: () => view.state.sliceDoc() !== saved,
    markSaved(text) {
      saved = text;
      o.onChange(view.state.sliceDoc() !== saved);
    },
    // the file on disk again: a new document, with its own line ending, and an empty undo history
    replace(text) {
      saved = text;
      view.setState(stateFor(text));
      o.onChange(false);
    },
    focus: () => view.focus(),
    destroy() {
      watch.disconnect();
      view.destroy();
    },
  };
}
