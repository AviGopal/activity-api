/**
 * Env-read scanner for the env-read ratchet (test/ratchet/env-read-ratchet.test.ts).
 *
 * Dependency-free, regex/token-ish over file text. It finds the NAMES a vessel's source reads from the
 * process environment, so the ratchet can pin them. Forms it recognises (ENV = process.env | Bun.env |
 * import.meta.env, optional chaining allowed):
 *   ENV.X · ENV["X"] · ENV['X'] · ENV[`X`] · "X" in ENV · const { A, B: b, C = 1 } = ENV
 *   aliases: `const e = ENV` / `let e = a ?? ENV` / a parameter default `e = ENV`, then e.X · e["X"] ·
 *            const { A } = e  (scoped to the file that declares the alias)
 *   helpers: a function whose FIRST parameter is used as ENV[param] (e.g. `env(key, fallback)`,
 *            `parseEnvInt(key, d)`), then every call `helper("X", …)` in the declaring file and in files
 *            that import that helper by name from it.
 * Anything it cannot reduce to a literal name — ENV[expr], e[expr], a rest element `...rest` in an env
 * destructure, a helper called with a non-literal first argument — is recorded as
 * `<dynamic>@file:<expression>#n`: the read's expression with all whitespace (and so all blanked comments)
 * removed, and n its occurrence index among identical expressions in that file. The pin is NOT a line
 * number, so an edit that only shifts lines in the file leaves every pin intact, while a new dynamic
 * read (a new expression, or another occurrence of an existing one) is a new name.
 *
 * Comments are blanked before matching (line numbers kept), and a match that STARTS inside a string or
 * template text (a log message, a prompt, generated code for another program) is not a read of this
 * vessel; `${…}` holes in templates are code and are scanned.
 *
 * RESIDUALS (not caught; see the test.todo entries in the ratchet test):
 *   - an env object passed as an ARGUMENT to a function (`f(process.env)`) and read inside it through a
 *     parameter WITHOUT an `= process.env` default;
 *   - a helper that takes the key as a non-first parameter, or a helper reached through a second-hand
 *     alias (`const g = env; g("X")`) or a namespace import (`cfg.env("X")`);
 *   - spreading/iterating the whole env (`{ ...process.env }`, `Object.entries(process.env)`) — that is a
 *     pass-through, not a read of a name, and is not recorded.
 */

import { readdirSync, readFileSync } from "node:fs";

export interface SourceFile {
  /** Repo-relative path, forward slashes (e.g. "src/config.ts"). */
  path: string;
  text: string;
}

export interface EnvRead {
  /** The env name, or `<dynamic>@path:<expression>#n` for a read whose name is not a literal. */
  name: string;
  /** For a dynamic read: its normalised expression and source offset (used to assign `#n`). */
  expr?: string;
  offset?: number;
  path: string;
  line: number;
  form: string;
}

const ENV_SRC = String.raw`(?:\bprocess\s*\??\.\s*env|\bBun\s*\??\.\s*env|\bimport\s*\.\s*meta\s*\.\s*env)\b`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

export interface Lexed {
  /** The source with comments blanked to spaces (newlines kept, so offsets and line numbers hold). */
  code: string;
  /** 1 where the offset is inside a string, template text, or regex literal (not a `${…}` hole). */
  inString: Uint8Array;
}

/** Blank comments and mark string/template-text/regex offsets. Best-effort JS lexing. */
export function lex(src: string): Lexed {
  const out: string[] = [];
  const inString = new Uint8Array(src.length);
  const mark = (a: number, b: number): void => { inString.fill(1, a, Math.min(b, src.length)); };
  let i = 0;
  const n = src.length;
  // Stack of template-literal brace depths: when inside `${`, we push the brace depth.
  const tmplStack: number[] = [];
  let braceDepth = 0;
  let lastSignificant = ""; // last non-space char emitted in code state (for regex heuristic)
  let lastWord = "";
  const regexPrecedingWords = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      out.push(blank(src.slice(i, j)));
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j === -1 ? n : j + 2;
      out.push(blank(src.slice(i, j)));
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      j = Math.min(n, j + 1);
      mark(i, j);
      out.push(src.slice(i, j));
      i = j;
      lastSignificant = c;
      lastWord = "";
      continue;
    }
    if (c === "`" || (c === "}" && tmplStack.length > 0 && tmplStack[tmplStack.length - 1] === braceDepth)) {
      // Template literal body (fresh, or resumed after a `${ … }` hole closes).
      if (c === "}") tmplStack.pop();
      let j = i + 1;
      let opened = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "`") { j += 1; break; }
        if (d === "$" && src[j + 1] === "{") { j += 2; tmplStack.push(braceDepth); opened = true; break; }
        j += 1;
      }
      mark(i, j); // the `${` and the resuming `}` count as template text, so brackets inside holes balance
      out.push(src.slice(i, j));
      i = j;
      lastSignificant = opened ? "{" : "`";
      lastWord = "";
      continue;
    }
    if (c === "/") {
      const regexCtx = lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant) || regexPrecedingWords.has(lastWord);
      if (regexCtx) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          const d = src[j];
          if (d === "\\") { j += 2; continue; }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) { j += 1; break; }
          j += 1;
        }
        while (j < n && /[a-z]/i.test(src[j]!)) j += 1;
        mark(i, j);
        out.push(src.slice(i, j));
        i = j;
        lastSignificant = "/";
        lastWord = "";
        continue;
      }
    }
    if (c === "{") braceDepth += 1;
    else if (c === "}") braceDepth -= 1;
    if (/[A-Za-z_$0-9]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j]!)) j += 1;
      const word = src.slice(i, j);
      out.push(word);
      lastWord = word;
      lastSignificant = word[word.length - 1]!;
      // A word char is not a regex-preceding punctuator; keyword check uses lastWord.
      if (!regexPrecedingWords.has(word)) lastSignificant = "a";
      else lastSignificant = "";
      i = j;
      continue;
    }
    out.push(c);
    if (!/\s/.test(c)) { lastSignificant = c === ")" || c === "]" ? "a" : c; lastWord = ""; }
    i += 1;
  }
  return { code: out.join(""), inString };
}

const lineAt = (text: string, idx: number): number => {
  let line = 1;
  for (let k = 0; k < idx && k < text.length; k++) if (text.charCodeAt(k) === 10) line += 1;
  return line;
};

const LIT = String.raw`(?:"([^"\\\n]*)"|'([^'\\\n]*)'|` + "`([^`$\\\\]*)`" + ")";
const litOf = (m: RegExpExecArray, base: number): string | undefined => m[base] ?? m[base + 1] ?? m[base + 2];

/** Parse the inside of a `{ … }` destructuring pattern into names; `...rest` yields null (dynamic). */
function destructureNames(body: string): Array<string | null> {
  const names: Array<string | null> = [];
  let depth = 0;
  let cur = "";
  const parts: string[] = [];
  for (const ch of body) {
    if ("{[(".includes(ch)) depth += 1;
    if ("}])".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (p.startsWith("...")) { names.push(null); continue; }
    const quoted = /^\[?\s*(?:"([^"]+)"|'([^']+)')\s*\]?\s*:/.exec(p);
    if (quoted) { names.push(quoted[1] ?? quoted[2]!); continue; }
    if (p.startsWith("[")) { names.push(null); continue; }
    const id = new RegExp(`^(${IDENT})`).exec(p);
    if (id) names.push(id[1]!);
  }
  return names;
}

/** The declared name immediately left of the `=` at `eqIdx`, skipping a type annotation (`env: Record<a, b>`). */
function aliasNameBefore(text: string, eqIdx: number): string | null {
  let depth = 0;
  let k = eqIdx - 1;
  for (; k >= 0 && eqIdx - k < 300; k--) {
    const ch = text[k]!;
    if (ch === ">") depth += 1;
    else if (ch === "<") depth -= 1;
    else if (depth <= 0 && "(,;{\n".includes(ch)) break;
  }
  const seg = text.slice(k + 1, eqIdx).trim().replace(/^(?:export\s+)?(?:const|let|var|readonly|private|public|protected)\s+/, "");
  const m = new RegExp(String.raw`^(${IDENT})\s*\??\s*(?::|$)`).exec(seg);
  if (!m || ["process", "Bun", "return"].includes(m[1]!)) return null;
  return m[1]!;
}

interface Helper { name: string; file: string }

/** Whitespace (including blanked comments) removed: the pin survives reformatting and line shifts. */
const normaliseExpr = (e: string): string => e.replace(/\s+/g, "");

/** Index of the bracket closing the one at `open` (skipping string contents); bounded. */
function closeOf(code: string, inString: Uint8Array, open: number): number {
  let depth = 0;
  for (let k = open; k < code.length && k - open < 400; k++) {
    if (inString[k]) continue;
    const ch = code[k]!;
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch) && --depth === 0) return k;
  }
  return Math.min(code.length - 1, open + 400);
}

/** End (exclusive) of the first call argument after the `(` at `open`. */
function firstArgEnd(code: string, inString: Uint8Array, open: number): number {
  let depth = 0;
  for (let k = open + 1; k < code.length && k - open < 400; k++) {
    if (inString[k]) continue;
    const ch = code[k]!;
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) { if (depth === 0) return k; depth -= 1; }
    else if (ch === "," && depth === 0) return k;
  }
  return Math.min(code.length, open + 400);
}
interface LexedFile { path: string; code: string; inString: Uint8Array }

/** The helper whose FIRST parameter is `param`, declared in the 600 chars before `at` (closest wins). */
function enclosingHelper(code: string, at: number, param: string): string | null {
  const before = code.slice(Math.max(0, at - 600), at);
  const fn = new RegExp(String.raw`(?:function\s+(${IDENT})\s*(?:<[^>]*>)?\s*\(\s*${param}\b|(?:const|let|var)\s+(${IDENT})\s*(?::[^=]*)?=\s*(?:async\s*)?\(\s*${param}\b)`, "g");
  let last: RegExpExecArray | null = null;
  for (let f; (f = fn.exec(before)); ) last = f;
  return last ? (last[1] ?? last[2])! : null;
}

/** Direct and aliased reads in one lexed file; also the helpers it declares. */
function scanFile(f: LexedFile): { reads: EnvRead[]; helpers: Helper[] } {
  const { path, code, inString } = f;
  const reads: EnvRead[] = [];
  const helpers: Helper[] = [];
  const push = (name: string | null, idx: number, form: string, expr = ""): void => {
    const line = lineAt(code, idx);
    if (name !== null) reads.push({ name, path, line, form });
    else reads.push({ name: "", path, line, form, expr: normaliseExpr(expr), offset: idx });
  };
  // A match that starts inside a string/template text (a message, generated code) is not a read.
  // (`"X" in ENV` starts with its string key, so it is judged by its LAST char, the env reference.)
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void, atEnd = false): void => {
    for (let m; (m = re.exec(code)); ) if (!inString[atEnd ? m.index + m[0].length - 1 : m.index]) fn(m);
  };

  // Aliases declared in this file: `x = ENV`, `x = a ?? ENV` (const/let/var, or a parameter default).
  const aliases = new Set<string>();
  each(new RegExp(String.raw`${ENV_SRC}(?!\s*(?:\?\.|\.|\[))`, "g"), (m) => {
    const lineStart = code.lastIndexOf("\n", m.index - 1) + 1;
    const left = code.slice(Math.max(lineStart, m.index - 160), m.index);
    const eq = /(?<![=!<>])=(?![=>])\s*(?:[\w$.?]+\s*(?:\?\?|\|\|)\s*)*$/.exec(left);
    if (!eq) return;
    const name = aliasNameBefore(code, m.index - left.length + eq.index);
    if (name) aliases.add(name);
  });

  // Bases: ENV itself plus each alias (alias reads count only within this file).
  const bases: Array<{ src: string; kind: string }> = [{ src: ENV_SRC, kind: "env" }];
  for (const a of aliases) bases.push({ src: String.raw`(?<![\w$.])${a.replace(/\$/g, "\\$")}\b`, kind: `alias:${a}` });

  for (const { src: base, kind } of bases) {
    each(new RegExp(String.raw`${base}\s*(?:\?\.|\.)\s*(${IDENT})`, "g"), (m) => push(m[1]!, m.index, `${kind}.X`));
    each(new RegExp(String.raw`${base}\s*(?:\?\.)?\s*\[`, "g"), (m) => {
      const after = code.slice(m.index + m[0].length, m.index + m[0].length + 300);
      const lit = new RegExp(String.raw`^\s*${LIT}\s*\]`).exec(after);
      if (lit) return push(litOf(lit, 1)!, m.index, `${kind}["X"]`);
      const close = closeOf(code, inString, m.index + m[0].length - 1);
      push(null, m.index, `${kind}[expr]`, code.slice(m.index, close + 1));
      const p = new RegExp(String.raw`^\s*(${IDENT})\s*\]`).exec(after);
      if (p && kind === "env") {
        const h = enclosingHelper(code, m.index, p[1]!);
        if (h) helpers.push({ name: h, file: path });
      }
    });
    each(new RegExp(String.raw`${LIT}\s+in\s+${base}`, "g"), (m) => push(litOf(m, 1)!, m.index, `"X" in ${kind}`), true);
    each(new RegExp(String.raw`\{([^{}]*)\}\s*(?::[^=;\n]{0,200}?)?=\s*${base}(?!\s*(?:\?\.|\.|\[))`, "g"), (m) => {
      for (const nm of destructureNames(m[1]!)) push(nm, m.index, `{…} = ${kind}`, m[0]);
    });
  }
  return { reads, helpers };
}

const stripExt = (p: string): string => p.replace(/\.(ts|tsx|js|mjs)$/, "");

/** Scan a set of files. Paths must be repo-relative with forward slashes. */
export function scanEnvReads(files: SourceFile[]): EnvRead[] {
  const lexed: LexedFile[] = files.map((f) => ({ path: f.path, ...lex(f.text) }));
  const all: EnvRead[] = [];
  const queue: Helper[] = [];
  for (const f of lexed) {
    const r = scanFile(f);
    all.push(...r.reads);
    queue.push(...r.helpers);
  }
  // Helper call sites: in the declaring file, and in files importing the helper by name from it. A
  // helper calling another helper with its own first parameter (`envInt(key) → env(key)`) is itself a
  // helper; iterate to a fixpoint.
  const seen = new Set<string>();
  while (queue.length > 0) {
    const h = queue.shift()!;
    const hk = `${h.file}#${h.name}`;
    if (seen.has(hk)) continue;
    seen.add(hk);
    const declBase = stripExt(h.file).split("/").pop()!;
    const imp = new RegExp(String.raw`import\s*(?:type\s*)?\{[^}]*\b${h.name}\b[^}]*\}\s*from\s*["'][^"']*/${declBase}(?:\.[jt]s)?["']`);
    for (const f of lexed) {
      if (f.path !== h.file && !imp.test(f.code)) continue;
      const call = new RegExp(String.raw`(?<![\w$.])${h.name}\s*(?:<[^>()]*>)?\(\s*`, "g");
      for (let m; (m = call.exec(f.code)); ) {
        if (f.inString[m.index]) continue;
        if (/function\s+$/.test(f.code.slice(Math.max(0, m.index - 12), m.index))) continue; // the declaration
        const after = f.code.slice(m.index + m[0].length, m.index + m[0].length + 300);
        const line = lineAt(f.code, m.index);
        const lit = new RegExp(String.raw`^${LIT}`).exec(after);
        if (lit) { all.push({ name: litOf(lit, 1)!, path: f.path, line, form: `${h.name}("X")` }); continue; }
        const p = new RegExp(String.raw`^(${IDENT})\s*[,)]`).exec(after);
        const outer = p ? enclosingHelper(f.code, m.index, p[1]!) : null;
        if (outer && outer !== h.name) queue.push({ name: outer, file: f.path });
        else {
          const open = m.index + m[0].lastIndexOf("(");
          const argEnd = firstArgEnd(f.code, f.inString, open);
          const expr = normaliseExpr(`${h.name}(${f.code.slice(open + 1, argEnd)})`);
          all.push({ name: "", path: f.path, line, form: `${h.name}(expr)`, expr, offset: m.index });
        }
      }
    }
  }
  // Name each dynamic read by file + normalised expression + occurrence index, in source order.
  const dyn = all.filter((r) => r.expr !== undefined).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.offset! - b.offset!));
  const seenExpr = new Map<string, number>();
  for (const r of dyn) {
    const k = `${r.path}:${r.expr}`;
    const n = (seenExpr.get(k) ?? 0) + 1;
    seenExpr.set(k, n);
    r.name = `<dynamic>@${k}#${n}`;
  }
  return all;
}

/** Load src/**\/*.ts (excluding *.test.ts and test/fixture dirs) under `root`. Node/Bun fs only. */
export function loadSources(root: string): SourceFile[] {
  const SKIP_DIRS = new Set(["test", "tests", "__tests__", "fixtures", "__fixtures__", "node_modules"]);
  const out: SourceFile[] = [];
  const walk = (rel: string): void => {
    for (const ent of readdirSync(`${root}/${rel}`, { withFileTypes: true })) {
      const r = `${rel}/${ent.name}`;
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(r); continue; }
      if (!ent.isFile() || !r.endsWith(".ts") || r.endsWith(".test.ts")) continue;
      out.push({ path: r, text: readFileSync(`${root}/${r}`, "utf8") });
    }
  };
  walk("src");
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
