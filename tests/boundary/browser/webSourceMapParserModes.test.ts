import { createServer } from "node:http";

import { expect, it } from "vitest";

import { fetchWebSourceMaps } from "../../../src/browser/WebSourceMapFetcher.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";

it.each(["regular", "indexed"])(
  "uses original URL path parser modes for %s HTTP source maps",
  async (format) => {
    const originals = [
      ["main.ts", 'import "./dep.js"; const value = <number>1;', "included"],
      [
        "main.cts?revision=2#view.tsx",
        'import "./dep.js"; const value = <number>1;',
        "included",
      ],
      [
        "main.cjs?revision=2#view.mjs",
        'const value = require("./dep.js"); return value;',
        "included",
      ],
      [
        "webpack:///src/main.ts?revision=2#view.tsx",
        'import "./dep.js"; const value = <number>1;',
        "included",
      ],
      [
        "main.tsx?view=main.ts",
        'import "./dep.js"; const value = <div />;',
        "included",
      ],
      ["main.mts?view=main.ts", "const value = <number>1;", "partial"],
      ["main.mjs?view=main.cjs", "return 1;", "partial"],
    ] as const;
    const texts = originals.map(([source, content]) => {
      const map = {
        version: 3,
        names: [],
        sources: [source],
        sourcesContent: [content],
        mappings: "AAAA",
      };
      return JSON.stringify(
        format === "indexed"
          ? {
              version: 3,
              sections: [{ offset: { line: 1, column: 2 }, map }],
            }
          : map,
      );
    });
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/source-map+json");
      response.end(texts[Number(request.url?.slice(1))]);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new TypeError("Expected a TCP listener address");
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const result = await fetchWebSourceMaps(
        texts.map((_, index) => ({
          scriptKey: `scr_${String(index + 1).padStart(64, "0")}`,
          declaredUrl: `${origin}/${String(index)}`,
          fetchUrl: `${origin}/${String(index)}`,
        })),
        analyzeWebBundleInputSchema.parse({
          cdp_endpoint: origin,
          target_id: "fixture",
          allowed_origins: [origin],
          fetch_source_maps: true,
        }),
      );
      for (const [index, [source, content, status]] of originals.entries()) {
        const sourceUrl = new URL(source, `${origin}/`).href;
        const item = result.items[index];
        expect(item, source).toMatchObject({
          status,
          artifact: { text: texts[index] },
          original_sources: [
            { source: sourceUrl, artifact: { text: content } },
          ],
          mappings: [{ source: sourceUrl }],
        });
        if (status === "included") {
          expect(item?.limitation, source).toBeNull();
          expect(item?.original_module_edges, source).toEqual([
            {
              from_source: sourceUrl,
              kind: source.startsWith("main.cjs") ? "require" : "static_import",
              specifier: "./dep.js",
              resolved_source: new URL("./dep.js", sourceUrl).href,
            },
          ]);
        } else {
          expect(item?.limitation, source).toContain(
            "could not be parsed in full",
          );
        }
      }
    } finally {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        });
    }
  },
);
