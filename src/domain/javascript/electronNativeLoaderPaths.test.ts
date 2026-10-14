import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("native addon type-only TypeScript imports", () => {
  it("retains erased declarations as source evidence without runtime requests", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      import type { NativeThing } from "./addon.node";
      export type { Extra } from "./addon.node";
    `);
    expect(analysis.parse_status).toBe("complete");
    expect(analysis.electron.native_addon_bindings).toMatchObject([
      { members: ["NativeThing"], type_only: true },
      { members: ["Extra"], type_only: true },
    ]);
    expect(
      analysis.electron.native_addon_bindings.filter(
        ({ type_only }) => type_only === false,
      ),
    ).toEqual([]);
  });

  it("keeps only value members from mixed type/value native imports", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      import { type OtherThing, load } from "./addon.node";
      load();
    `);
    expect(analysis.electron.native_addon_bindings).toMatchObject([
      {
        specifier: "./addon.node",
        binding_kind: "import",
        members: ["load"],
        type_only: false,
      },
      {
        specifier: "./addon.node",
        binding_kind: "import",
        members: ["OtherThing"],
        type_only: true,
      },
    ]);
  });

  it("retains ordinary value imports of native addons", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      import { load } from "./addon.node";
      load();
    `);
    expect(analysis.electron.native_addon_bindings).toEqual([
      expect.objectContaining({
        specifier: "./addon.node",
        binding_kind: "import",
        members: ["load"],
      }),
    ]);
  });
});

describe("native addon type-only re-exports", () => {
  it.each([
    ['export { type Extra, load } from "./addon.node";', ["load"]],
    ['export { type Extra } from "./addon.node";', []],
    ['export type * from "./addon.node";', []],
  ] as const)("retains only runtime members from %s", (source, members) => {
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.parse_status).toBe("complete");
    expect(analysis.electron.native_addon_bindings).toContainEqual(
      expect.objectContaining({ type_only: true }),
    );
    expect(
      analysis.electron.native_addon_bindings.filter(
        ({ type_only }) => type_only === false,
      ),
    ).toEqual(
      members.length === 0
        ? []
        : [
            expect.objectContaining({
              specifier: "./addon.node",
              binding_kind: "re-export",
              members: [...members],
            }),
          ],
    );
  });
});

describe("native addon loader provenance", () => {
  it("distinguishes CommonJS and ESM re-exports", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const required = require("./addon.node#literal.node");
      module.exports = require("./addon.node#literal.node");
      import imported from "./addon.node#literal.node";
      export { default } from "./addon.node#literal.node";
    `);
    expect(analysis.electron.native_addon_bindings).toHaveLength(4);
    expect(analysis.electron.native_addon_bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding_kind: "require",
          module_kind: "require",
        }),
        expect.objectContaining({
          binding_kind: "import",
          module_kind: "import",
        }),
        expect.objectContaining({
          binding_kind: "re-export",
          module_kind: "require",
        }),
        expect.objectContaining({
          binding_kind: "re-export",
          module_kind: "import",
        }),
      ]),
    );
  });

  it.each(["#", "?"])(
    "classifies require filenames literally for %s",
    (punctuation) => {
      const analysis = analyzeJavaScriptStaticSource(`
      const script = require("./addon.node${punctuation}helper.js");
      import native from "./addon.node${punctuation}helper.js";
    `);
      expect(analysis.electron.native_addon_bindings).toEqual([
        expect.objectContaining({
          binding_kind: "import",
          module_kind: "import",
        }),
      ]);
    },
  );
});
