import { parse, type ParserOptions, type ParserPlugin } from "@babel/parser";
import * as t from "@babel/types";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { recordTypeScriptModuleErasure } from "./javascriptModuleDeclaration.js";
import { recordJSDocImportDefaultMode } from "./typescriptImportResolutionMode.js";

/** Babel AST produced by REA's inert JavaScript parser boundary. */
export type ParsedJavaScriptSource = ReturnType<typeof parse>;

interface JSDocTypeImports {
  readonly declarations: readonly t.ImportDeclaration[];
  readonly complete: boolean;
}

const jsDocImports = new WeakMap<t.Program, JSDocTypeImports>();

/** Parser-owned erased requests; they never enter the runtime binding tree. */
export const parsedJSDocTypeImports = (program: t.Program): JSDocTypeImports =>
  jsDocImports.get(program) ?? { declarations: [], complete: true };

/** A decoration marker is line-leading trivia, never part of a quoted value. */
const isJSDocMargin = (value: string, offset: number): boolean => {
  if (value[offset] !== "*") return false;
  for (let cursor = offset - 1; cursor >= 0; cursor--) {
    const character = value[cursor];
    if (/\r|\n|\u2028|\u2029/u.test(character ?? "")) return true;
    if (character !== " " && character !== "\t") return false;
  }
  return true;
};

interface JSDocGrammarSpan {
  readonly end?: number;
  readonly scannedEnd: number;
}

/** A failed string still owns its scanned extent, preventing repeated remainder scans. */
const jsDocStringEnd = (value: string, start: number): JSDocGrammarSpan => {
  const quote = value[start];
  for (let cursor = start + 1; cursor < value.length; cursor++) {
    const character = value[cursor];
    if (character === quote) return { end: cursor + 1, scannedEnd: cursor + 1 };
    if (character === "\\") {
      cursor += 1;
      if (value[cursor] === "\r" && value[cursor + 1] === "\n") cursor += 1;
    } else if (character === "\r" || character === "\n")
      return { scannedEnd: cursor };
  }
  return { scannedEnd: value.length };
};

/** Bound grammar and malformed recovery before prose; Babel validates the declaration. */
const jsDocImportEnd = (value: string, start: number): JSDocGrammarSpan => {
  let braces = 0;
  let moduleEnd: number | undefined;
  for (let offset = start + 7; offset < value.length; offset++) {
    const character = value[offset];
    if (character === '"' || character === "'") {
      const quoted = jsDocStringEnd(value, offset);
      if (quoted.end === undefined) return quoted;
      offset = quoted.end - 1;
      if (braces === 0) {
        moduleEnd = quoted.end;
        break;
      }
    } else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "@") return { scannedEnd: offset };
  }
  if (moduleEnd === undefined) return { scannedEnd: value.length };
  let cursor = moduleEnd;
  while (/\s/u.test(value[cursor] ?? "") || isJSDocMargin(value, cursor))
    cursor += 1;
  const clause = /^(?:with|assert)\b/u.exec(value.slice(cursor));
  if (clause === null) return { end: moduleEnd, scannedEnd: moduleEnd };
  cursor += clause[0].length;
  while (/\s/u.test(value[cursor] ?? "") || isJSDocMargin(value, cursor))
    cursor += 1;
  if (value[cursor] !== "{") return { scannedEnd: cursor };
  for (; cursor < value.length; cursor++) {
    const character = value[cursor];
    if (character === '"' || character === "'") {
      const quoted = jsDocStringEnd(value, cursor);
      if (quoted.end === undefined) return quoted;
      cursor = quoted.end - 1;
    } else if (character === "{") braces += 1;
    else if (character === "}" && --braces === 0)
      return { end: cursor + 1, scannedEnd: cursor + 1 };
    else if (character === "@") return { scannedEnd: cursor };
  }
  return { scannedEnd: value.length };
};

/** Locate tags outside type annotations and Markdown code. */
const jsDocTags = (
  value: string,
): { name: string; offset: number; end?: number }[] => {
  const tags: { name: string; offset: number; end?: number }[] = [];
  let braces = 0;
  let quote = "";
  let annotation = false;
  let codeTicks = 0;
  for (let offset = 0; offset < value.length; offset++) {
    const character = value[offset];
    if (braces === 0 && character === "`") {
      let ticks = 1;
      while (value[offset + ticks] === "`") ticks += 1;
      if (codeTicks === 0) codeTicks = ticks;
      else if (codeTicks === ticks) codeTicks = 0;
      offset += ticks - 1;
      continue;
    }
    if (codeTicks > 0) continue;
    if (quote === "" && isJSDocMargin(value, offset)) continue;
    if (quote !== "") {
      if (character === "\\") offset += 1;
      else if (character === quote) quote = "";
    } else if (
      braces > 0 &&
      (character === '"' || character === "'" || character === "`")
    )
      quote = character;
    else if (character === "{" && (braces > 0 || annotation)) {
      braces += 1;
      annotation = false;
    } else if (character === "}" && braces > 0) braces -= 1;
    else if (character === "@" && braces === 0) {
      const name = /^[\w-]+/u.exec(value.slice(offset + 1))?.[0];
      if (name !== undefined) {
        const span =
          name === "import" ? jsDocImportEnd(value, offset) : undefined;
        const end = span?.end;
        tags.push({ name, offset, ...(end === undefined ? {} : { end }) });
        annotation = name !== "import";
        offset = Math.max(offset + name.length, (span?.scannedEnd ?? 0) - 1);
      }
    } else if (!/\s/u.test(character ?? "")) annotation = false;
  }
  return tags;
};

/** Strip documentation margins only outside literal strings, without changing spans. */
const normalizeJSDocImport = (
  value: string,
  start: number,
  end: number | undefined,
): string => {
  const parts: string[] = [" "];
  let segment = start + 1;
  let quote = "";
  const limit = end ?? value.length;
  for (let offset = segment; offset < limit; offset++) {
    const character = value[offset];
    if (quote !== "") {
      if (character === "\\") offset += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'" || character === "`")
      quote = character;
    else if (isJSDocMargin(value, offset)) {
      parts.push(value.slice(segment, offset), " ");
      segment = offset + 1;
    }
  }
  parts.push(value.slice(segment, limit));
  return parts.join("");
};

const recordJSDocTypeImports = (
  file: ParsedJavaScriptSource,
  sourcePath: string | undefined,
): void => {
  if (/\.(?:ts|tsx|mts|cts)$/iu.test(sourcePath ?? "")) return;
  const declarations: t.ImportDeclaration[] = [];
  let complete = true;
  for (const comment of file.comments ?? []) {
    if (
      comment.type !== "CommentBlock" ||
      !comment.value.startsWith("*") ||
      !comment.value.includes("@import") ||
      comment.start == null ||
      comment.loc == null
    )
      continue;
    const value = comment.value;
    const tags = jsDocTags(value);
    let line = comment.loc.start.line;
    let column = comment.loc.start.column + 2;
    let cursor = 0;
    for (const [index, tag] of tags.entries()) {
      while (cursor < tag.offset) {
        if (/\r|\n|\u2028|\u2029/u.test(value[cursor] ?? "")) {
          if (value[cursor] !== "\n" || value[cursor - 1] !== "\r") line += 1;
          column = 0;
        } else column += 1;
        cursor += 1;
      }
      if (tag.name !== "import") continue;
      const normalized = normalizeJSDocImport(
        value,
        tag.offset,
        tag.end ?? tags[index + 1]?.offset,
      );
      try {
        const parsed = preserveModuleAttributePresence(
          parse(normalized, {
            sourceType: "module",
            plugins: ["typescript"],
            attachComment: false,
            errorRecovery: true,
            startIndex: comment.start + 2 + tag.offset,
            startLine: line,
            startColumn: column,
          }),
          normalized,
          comment.start + 2 + tag.offset,
        );
        const declaration = parsed.program.body[0];
        if (
          !t.isImportDeclaration(declaration) ||
          (declaration.specifiers.length === 0 &&
            !/^\s*import\s*\{/u.test(normalized))
        ) {
          complete = false;
          continue;
        }
        declaration.importKind = "type";
        recordJSDocImportDefaultMode(declaration, sourcePath);
        // The imported names retain their own parser spans; the request starts at @.
        if (declaration.start != null) declaration.start -= 1;
        if (declaration.loc != null) {
          declaration.loc.start.column -= 1;
          declaration.loc.start.index -= 1;
        }
        declarations.push(declaration);
        if (parsed.errors.some((error) => error.pos < (declaration.end ?? 0)))
          complete = false;
      } catch {
        // A malformed owned tag leaves partial coverage, not proven absence.
        complete = false;
      }
    }
  }
  jsDocImports.set(file.program, { declarations, complete });
};

/** Babel 8 uses [] for both an omitted attribute clause and an explicit with {}. */
const preserveModuleAttributePresence = (
  file: ParsedJavaScriptSource,
  source: string,
  sourceOffset = 0,
): ParsedJavaScriptSource => {
  const commentEnds = new Map<number, number>();
  for (const comment of file.comments ?? [])
    if (typeof comment.start === "number" && typeof comment.end === "number")
      commentEnds.set(comment.start, comment.end);
  traverseJavaScriptAst(file.program, {
    enter: (node) => {
      if (
        (!t.isImportDeclaration(node) &&
          !t.isExportNamedDeclaration(node) &&
          !t.isExportAllDeclaration(node)) ||
        node.attributes?.length !== 0 ||
        node.source?.end === null ||
        node.source?.end === undefined ||
        node.end === null ||
        node.end === undefined
      )
        return;
      // The parser already owns the declaration/source spans. Only trivia and
      // the optional semicolon can follow the source when no clause is present.
      let cursor = node.source.end;
      while (cursor < node.end) {
        const commentEnd = commentEnds.get(cursor);
        if (commentEnd !== undefined && commentEnd <= node.end)
          cursor = commentEnd;
        else if (/\s|;/u.test(source[cursor - sourceOffset] ?? "")) cursor += 1;
        else return;
      }
      delete node.attributes;
    },
  });
  return file;
};

/**
 * Babel plugins for one source path. Single owner for TypeScript/JSX
 * mode selection (tsc + Babel `typescript` plugin semantics).
 *
 * - `dts:true` only for `.d.ts/.d.mts/.d.cts` ambient declarations;
 *   ordinary `.ts` keeps the missing-initializer diagnostic.
 * - JSX enabled for `.tsx`, `.jsx`, `.js`, and unknown paths; disabled for
 *   plain `.ts/.cts/.mts` (angle-bracket assertions, not JSX) and for all
 *   declaration files. `.mts` (including `.d.mts`) sets
 *   `disallowAmbiguousJSXLike`, matching tsc's `.mts` mode.
 * - `decorators-legacy` always present: without it decorated sources fail
 *   hard instead of reporting recovered syntax, losing every derived fact.
 * - Unknown paths retain the existing JSX-capable contract (best-effort
 *   parse; failures surface via `errorRecovery`, never silent misparse).
 */
export const parserPluginsForPath = (sourcePath?: string): ParserPlugin[] => {
  const path = sourcePath ?? "";
  const dts = isTypeScriptDeclarationSourcePath(path);
  const isTsLike = /\.(?:ts|cts|mts)$/iu.test(path);
  const isTsx = /\.tsx$/iu.test(path);
  const isMts = /\.mts$/iu.test(path);
  const typescript: ParserPlugin = [
    "typescript",
    {
      dts,
      ...(isMts ? { disallowAmbiguousJSXLike: true } : {}),
    },
  ];
  const jsxCapable = !dts && (isTsx || !isTsLike);
  return jsxCapable
    ? ["decorators-legacy", "jsx", typescript]
    : ["decorators-legacy", typescript];
};

/** Source suffix that selects TypeScript's declaration-file parser context. */
const isTypeScriptDeclarationSourcePath = (path?: string): boolean =>
  /\.d\.(?:ts|mts|cts)$/iu.test(path ?? "");

/** `.mjs` and `.mts` explicitly select module mode. */
export const isExplicitModuleSourcePath = (path?: string): boolean =>
  /\.m[jt]s$/iu.test(path ?? "");

const runtimeSourceTypeForPath = (
  path?: string,
): "commonjs" | "module" | "unambiguous" =>
  /\.cjs$/iu.test(path ?? "")
    ? "commonjs"
    : isExplicitModuleSourcePath(path)
      ? "module"
      : "unambiguous";

export interface RecoveredJavaScriptParse {
  readonly file: ParsedJavaScriptSource;
  /** Errors that apply only if a source of unknown mode is an ES module. */
  readonly moduleOnlyErrors: readonly string[];
}

/**
 * Parse a module or script with recovery. Babel tries module mode first and
 * keeps its strict-mode errors after falling back to a script, so a script
 * with errors is parsed again as a script. Strict errors that only the module
 * parse reports stay visible because the source may still be a module.
 */
export const parseRecoveredJavaScript = (
  source: string,
  sourcePath: string | undefined,
  options: Omit<ParserOptions, "sourceType" | "errorRecovery">,
): RecoveredJavaScriptParse => {
  const sourceType = runtimeSourceTypeForPath(sourcePath);
  if (sourceType !== "unambiguous") {
    const normalizedOptions = { ...options };
    if (sourceType === "commonjs") {
      // Babel owns these wrapper semantics in CommonJS mode and rejects
      // explicit script overrides, including the reference-import options.
      delete normalizedOptions.allowAwaitOutsideFunction;
      delete normalizedOptions.allowReturnOutsideFunction;
      delete normalizedOptions.allowNewTargetOutsideFunction;
    }
    return {
      file: parse(source, {
        ...normalizedOptions,
        sourceType,
        errorRecovery: true,
      }),
      moduleOnlyErrors: [],
    };
  }
  const file = parse(source, {
    ...options,
    sourceType: "unambiguous",
    errorRecovery: true,
  });
  if (file.program.sourceType !== "script" || file.errors.length === 0)
    return { file, moduleOnlyErrors: [] };
  const script = parse(source, {
    ...options,
    sourceType: "script",
    errorRecovery: true,
  });
  const scriptErrors = new Set(script.errors.map((error) => error.message));
  return {
    file: script,
    moduleOnlyErrors: file.errors
      .map((error) => error.message)
      .filter((message) => !scriptErrors.has(message)),
  };
};

/** Parse inert JavaScript or TypeScript facts without attaching comments to AST nodes. */
export const parseJavaScriptSource = (
  source: string,
  sourcePath?: string,
): ParsedJavaScriptSource | null => {
  try {
    const runtimeSourceType = runtimeSourceTypeForPath(sourcePath);
    const commonjs = runtimeSourceType === "commonjs";
    const options = {
      errorRecovery: true,
      attachComment: false,
      plugins: parserPluginsForPath(sourcePath),
    };
    const file = parse(source, {
      ...options,
      // Inert artifact analysis retains module declarations even in .cjs assets.
      // Infer their syntax here; reference imports keep filename-mode diagnostics.
      sourceType: commonjs ? "unambiguous" : runtimeSourceType,
      allowReturnOutsideFunction: commonjs,
      allowNewTargetOutsideFunction: commonjs,
    });
    // Unambiguous mode retains module-only diagnostics after choosing a script.
    // The .cjs extension establishes wrapper mode, so obtain its own diagnostics.
    const recovered = preserveModuleAttributePresence(
      commonjs && file.program.sourceType === "script" && file.errors.length > 0
        ? parse(source, { ...options, sourceType: "commonjs" })
        : file,
      source,
    );
    recordTypeScriptModuleErasure(
      recovered.program,
      isTypeScriptDeclarationSourcePath(sourcePath),
    );
    recordJSDocTypeImports(recovered, sourcePath);
    return recovered;
  } catch (cause: unknown) {
    // Unparseable source is represented by the null return.
    void cause;
    return null;
  }
};
