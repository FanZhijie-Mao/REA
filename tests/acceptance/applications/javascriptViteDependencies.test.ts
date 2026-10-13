import { createHash } from "node:crypto";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const mapDependencies = (table: string, indexes: string): string =>
  "const __vite__mapDeps = (i, m = __vite__mapDeps, d = " +
  "(m.f || (m.f = " +
  table +
  "))) => i.map(i => d[i]);\n" +
  "__vite__mapDeps(" +
  indexes +
  ");";

// captured with Babel core 8.0.7 and transform-arrow-functions 8.0.1.
const babelArrows = String.raw`const __vite__mapDeps = function (i, m = __vite__mapDeps, d = m.f || (m.f = ["./caf\u00e9.js", './nested\/dep.js', "./bracket].js"])) {
  return i.map(function (i) {
    return d[i];
  });
};
__vite__mapDeps([0, 1, 2]);`;

// transform-parameters 8.0.5 and transform-block-scoping 8.0.7 added to the same producer.
const babelEs5 = String.raw`var __vite__mapDeps = function (i) {
  var m = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : __vite__mapDeps;
  var d = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : m.f || (m.f = ["./caf\u00e9.js", './nested\/dep.js', "./bracket].js"]);
  return i.map(function (i) {
    return d[i];
  });
};
__vite__mapDeps([0, 1, 2]);`;

const typescriptEs5 = String.raw`var __vite__mapDeps = function (i, m, d) {
  if (m === void 0) m = __vite__mapDeps;
  if (d === void 0) d = m.f || (m.f = ["./caf\u00e9.js", './nested\/dep.js', "./bracket].js"]);
  return i.map(function (i) {
    return d[i];
  });
};
__vite__mapDeps([0, 1, 2]);`;

const typescriptEs5Minified = typescriptEs5
  .replace(
    "if (m === void 0) m = __vite__mapDeps;",
    "m === void 0 && (m = __vite__mapDeps);",
  )
  .replace(
    'if (d === void 0) d = m.f || (m.f = ["./caf\\u00e9.js", \'./nested\\/dep.js\', "./bracket].js"]);',
    'd === void 0 && (d = m.f || (m.f = ["./caf\\u00e9.js", \'./nested\\/dep.js\', "./bracket].js"]));',
  );

const typescriptEs5ReversedGuard = typescriptEs5Minified
  .replace(
    "m === void 0 && (m = __vite__mapDeps);",
    "void 0 === m && (m = __vite__mapDeps);",
  )
  .replace(
    "d === void 0 && (d = m.f || (m.f =",
    "void 0 === d && (d = m.f || (m.f =",
  );

const scenarios = [
  {
    file: "escaped.js",
    source: mapDependencies(
      String.raw`["./caf\u00e9.js", './nested\/dep.js', "./bracket].js"]`,
      "[0, 1, 2]",
    ),
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "typescript-es5.js",
    source: typescriptEs5,
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "typescript-es5-minified.js",
    source: typescriptEs5Minified,
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "typescript-es5-reversed-guards.js",
    source: typescriptEs5ReversedGuard,
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "dynamic.js",
    source: mapDependencies(
      '["./first.js", runtimeUrl("./decoy.js"), "./last.js"]',
      "[1, 2]",
    ),
    resolved: ["last.js"],
    unknown: true,
  },
  {
    file: "sparse.js",
    source: mapDependencies('["./first.js", , "./last.js"]', "[1, 2]"),
    resolved: ["last.js"],
    unknown: true,
  },
  {
    file: "spread.js",
    source: mapDependencies(
      '["./first.js", ...runtimeUrls, "./last.js"]',
      "[0, 2]",
    ),
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "scoped.js",
    source:
      "{\n" +
      mapDependencies('["./left.js"]', "[0]") +
      "\n}\n{\n" +
      mapDependencies('["./right.js"]', "[0]") +
      "\n}",
    resolved: ["left.js", "right.js"],
    unknown: false,
  },
  {
    file: "comment.js",
    source:
      '// decoy.f || (decoy.f = ["./decoy.js"])\n' +
      mapDependencies('["./last.js"]', "[0]"),
    resolved: ["last.js"],
    unknown: false,
  },
  {
    file: "shadowed.js",
    source:
      mapDependencies('["./left.js"]', "[0]") +
      "\nfunction unrelated(__vite__mapDeps) { __vite__mapDeps([0]); }",
    resolved: ["left.js"],
    unknown: false,
  },
  {
    file: "cache.js",
    source: mapDependencies('["./left.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps.f = runtimeUrls;\n__vite__mapDeps([0]);",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "overridden.js",
    source: mapDependencies('["./left.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0], runtimeMapper);",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "indices.js",
    source: mapDependencies('["./first.js", "./last.js"]', "[0, runtimeIndex]"),
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "unrelated.js",
    source: mapDependencies('["./decoy.js"]', "[0]").replace(
      "i.map(i => d[i])",
      '["./first.js"]',
    ),
    resolved: [],
    unknown: false,
  },
  {
    file: "reassigned.js",
    source: mapDependencies('["./left.js"]', "[0]")
      .replace("const __vite__mapDeps", "let __vite__mapDeps")
      .replace(
        "__vite__mapDeps([0]);",
        "__vite__mapDeps = runtimeMapper;\n__vite__mapDeps([0]);",
      ),
    resolved: [],
    unknown: true,
  },
  {
    file: "self-shadowed.js",
    source: mapDependencies('["./decoy.js"]', "[0]")
      .replace("d = (m.f", "__vite__mapDeps = (m.f")
      .replace("d[i]", "__vite__mapDeps[i]"),
    resolved: [],
    unknown: false,
  },
  {
    file: "chained-filter.js",
    source: mapDependencies('["./first.js", "./last.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0]).filter(Boolean);",
    ),
    resolved: ["first.js"],
    unknown: false,
    callSource: "__vite__mapDeps([0])",
  },
  {
    file: "chained-concat.js",
    source: mapDependencies('["./first.js", "./last.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0]).concat([1]);",
    ),
    resolved: ["first.js"],
    unknown: false,
    callSource: "__vite__mapDeps([0])",
  },
  {
    file: "void-default.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0], void 0);",
    ),
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "undefined-defaults.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0], undefined, void 0);",
    ),
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "shadowed-undefined.js",
    source:
      "{\nconst undefined = runtimeMapper;\n" +
      mapDependencies('["./first.js"]', "[0]").replace(
        "__vite__mapDeps([0]);",
        "__vite__mapDeps([0], undefined);",
      ) +
      "\n}",
    resolved: [],
    unknown: true,
  },
  {
    file: "effectful-void.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      'function mutateCache(target) { target.f = ["./last.js"]; }\n' +
        "__vite__mapDeps([0], void mutateCache(__vite__mapDeps));",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "table-override.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0], void 0, runtimeUrls);",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "effectful-extra.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      'function mutateCache(target) { target.f = ["./last.js"]; }\n' +
        "__vite__mapDeps([0], void 0, void 0, mutateCache(__vite__mapDeps));",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "babel-arrows.js",
    source: babelArrows,
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "babel-es5.js",
    source: babelEs5,
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "babel-shadowed-guard.js",
    source: "{\nconst undefined = runtimeSentinel;\n" + babelEs5 + "\n}",
    resolved: [],
    unknown: true,
  },
  {
    file: "babel-shadowed-arguments.js",
    source: babelEs5
      .replace("function (i)", "function (arguments)")
      .replace("return i.map", "return arguments.map"),
    resolved: [],
    unknown: true,
  },
  {
    file: "effectful-index.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      'function mutateCache(target) { target.f = ["./last.js"]; return 0; }\n' +
        "__vite__mapDeps([0, mutateCache(__vite__mapDeps)]);",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "index-getter.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0, runtimeIndices.next]);",
    ),
    resolved: [],
    unknown: true,
  },
  ...[
    {
      file: "helper-alias.js",
      mutation: 'const alias = __vite__mapDeps; alias.f = ["./last.js"];',
    },
    {
      file: "cache-alias.js",
      mutation: 'const cache = __vite__mapDeps.f; cache[0] = "./last.js";',
    },
    {
      file: "cache-splice.js",
      mutation: '__vite__mapDeps.f.splice(0, 1, "./last.js");',
    },
    {
      file: "alias-splice.js",
      mutation:
        'const cache = __vite__mapDeps.f; cache.splice(0, 1, "./last.js");',
    },
    {
      file: "computed-splice.js",
      mutation: '__vite__mapDeps["f"]["splice"](0, 1, "./last.js");',
    },
    {
      file: "borrowed-splice.js",
      mutation:
        'Array.prototype.splice.call(__vite__mapDeps.f, 0, 1, "./last.js");',
    },
    {
      file: "borrowed-apply.js",
      mutation: 'Array.prototype.fill.apply(__vite__mapDeps.f, ["./last.js"]);',
    },
    {
      file: "spread-child-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; copy.f[0] = "./last.js";',
    },
    {
      file: "spread-projected-child.js",
      mutation:
        '__vite__mapDeps([0]); const cache = ({...__vite__mapDeps}).f; cache[0] = "./last.js";',
    },
    {
      file: "spread-projected-splice.js",
      mutation:
        '__vite__mapDeps([0]); const cache = ({...__vite__mapDeps}).f; cache.splice(0, 1, "./last.js");',
    },
    {
      file: "spread-uncertain-override.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, [runtimeKey]: []}; copy.f[0] = "./last.js";',
    },
    {
      file: "spread-literal-override.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, ...{f: []}}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "spread-stable-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const replacement = []; const copy = {...__vite__mapDeps, f: replacement}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "rest-copied-array.js",
      mutation:
        '__vite__mapDeps([0]); const {f: {...copy}} = __vite__mapDeps; copy[0] = "./last.js";',
      kept: true,
    },
    {
      file: "spread-nested-literal-override.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, ...{...{f: []}}}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "spread-property-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; copy.f = ["./last.js"];',
      kept: true,
    },
    {
      file: "mutated-replacement-alias.js",
      mutation:
        '__vite__mapDeps([0]); const replacement = []; replacement[0] = __vite__mapDeps.f; const copy = {f: replacement}; copy.f[0] = "./last.js";',
    },
    {
      file: "spread-overridden-child.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, f: []}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "nested-cache-array-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, ...{f: [__vite__mapDeps.f]}}; copy.f[0][0] = "./last.js";',
    },
    {
      file: "getter-cache-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, get f() { return __vite__mapDeps.f; }}; copy.f[0] = "./last.js";',
    },
    {
      file: "nested-getter-cache-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, f: {get cache() { return __vite__mapDeps.f; }}}; copy.f.cache[0] = "./last.js";',
    },
    {
      file: "regexp-override.js",
      mutation:
        "__vite__mapDeps([0]); const copy = {...__vite__mapDeps, f: /x/g}; copy.f.lastIndex = 1;",
      kept: true,
    },
    {
      file: "nested-fresh-array-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, ...{f: [["./other.js"]]}}; copy.f[0][0] = "./last.js";',
      kept: true,
    },
    {
      file: "reassigned-alias.js",
      mutation:
        'let alias = __vite__mapDeps; alias = runtimeMapper; alias.f = ["./last.js"];',
    },
    {
      file: "unrelated-property.js",
      mutation: 'const alias = __vite__mapDeps; alias.other = ["./last.js"];',
      kept: true,
    },
    {
      file: "cache-read.js",
      mutation: "const cache = __vite__mapDeps.f; cache.slice(0, 1);",
      kept: true,
    },
  ].map(({ file, mutation, kept }) => ({
    file,
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      mutation + "\n__vite__mapDeps([0]);",
    ),
    resolved: kept ? ["first.js"] : [],
    unknown: !kept,
  })),
  {
    file: "copied-cache-splice.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      '__vite__mapDeps([0]);\nconst {...copy} = __vite__mapDeps; copy.f.splice(0, 1, "./last.js");\n__vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "explicit-cache-property.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; box.f[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "cache-non-f-property.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f}; box.cache[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "mutated-array-map.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "const __vite__mapDeps",
      'Array.prototype.map = function () { return ["./last.js"]; };\nconst __vite__mapDeps',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "object-assign-cache.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      '__vite__mapDeps([0]); const copy = Object.assign({}, __vite__mapDeps); copy.f[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "copied-cache-replacement.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      '__vite__mapDeps([0]);\nconst {...copy} = __vite__mapDeps; copy.f = ["./last.js"];\n__vite__mapDeps([0]);',
    ),
    resolved: ["first.js", "first.js"],
    unknown: false,
  },
  {
    file: "ambiguous-helper-alias.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "let alias = __vite__mapDeps;\n{\n" +
        mapDependencies('["./last.js"]', "[0]").replace(
          "__vite__mapDeps([0]);",
          "alias = __vite__mapDeps;\n__vite__mapDeps([0]);",
        ) +
        '\n}\nalias.f.splice(0, 1, "./last.js");\n__vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
] as const;

cliTest.for(["CLI", "stdio MCP"] as const)(
  "resolves Vite dependency values without inventing paths through %s",
  { timeout: 120_000 },
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-vite-dependencies-");
    const sources = Object.fromEntries(
      scenarios.map(({ file, source }) => [
        file,
        source + '\nthrow new Error("fixture source must never execute");\n',
      ]),
    );
    await writeFixtureFiles(root, {
      ...sources,
      ...Object.fromEntries(
        [
          "café.js",
          "nested/dep.js",
          "bracket].js",
          "first.js",
          "last.js",
          "left.js",
          "right.js",
          "decoy.js",
        ].map((path) => [path, "export const dependency = true;\n"]),
      ),
    });
    let document: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: ["analyze-javascript-application", root, "--json"],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      document = response.json;
    } else {
      const { call } = await connectLocalToolsMcp();
      const response = await call("analyze_javascript_application", {
        input_path: root,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      document = response.structuredContent;
    }
    const { graph } = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(document).normalized_result,
    );
    for (const scenario of scenarios) {
      const imports = graph.edges.filter(
        ({ relation, properties, evidence }) =>
          relation === "imports" &&
          properties.kind === "dynamic-import" &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === scenario.file,
      );
      expect
        .soft(
          imports
            .flatMap(({ properties }) =>
              properties.resolved_path === null
                ? []
                : [properties.resolved_path],
            )
            .sort(),
          scenario.file,
        )
        .toEqual([...scenario.resolved].sort());
      expect
        .soft(
          imports.some(({ properties }) => properties.specifier === null),
          scenario.file,
        )
        .toBe(scenario.unknown);
      for (const edge of imports) {
        const resolved = edge.properties.resolved_path;
        if (typeof resolved === "string")
          expect.soft(edge.properties, scenario.file).toMatchObject({
            specifier: "./" + resolved,
            resolved_path: resolved,
          });
        else {
          expect.soft(edge.properties, scenario.file).toMatchObject({
            specifier: null,
            expression: expect.stringContaining("__vite__mapDeps("),
          });
          expect
            .soft(edge.evidence.coverage.status, scenario.file)
            .toBe("partial");
        }
        const location = edge.evidence.location;
        expect.soft(edge.evidence.artifact, scenario.file).toMatchObject({
          available: true,
          sha256: createHash("sha256")
            .update(sources[scenario.file] ?? "")
            .digest("hex"),
        });
        if (location.available && location.value.kind === "source-range") {
          const source = sources[scenario.file] ?? "";
          const lines = source.split("\n");
          const line = lines[location.value.start.line - 1] ?? "";
          const callSource =
            "callSource" in scenario && typeof scenario.callSource === "string"
              ? scenario.callSource
              : line.slice(0, -1);
          expect.soft(location.value, scenario.file).toMatchObject({
            start: { column: 0 },
            end: {
              line: location.value.start.line,
              column: callSource.length,
            },
          });
          expect
            .soft(
              line.slice(
                location.value.start.column,
                location.value.end.column,
              ),
              scenario.file,
            )
            .toBe(callSource);
          expect.soft(line, scenario.file).toMatch(/^__vite__mapDeps\(/u);
          if (!scenario.unknown)
            expect
              .soft(edge.evidence.coverage.status, scenario.file)
              .toBe("complete");
        }
      }
    }
  },
);
