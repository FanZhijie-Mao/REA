import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "../../domain/javascript/javascriptStaticAnalysis.js";
import { javaScriptWorkerStaticAnalysisSchema } from "./JavaScriptAnalysisWorkerSchemas.js";

it("preserves endpoint candidate interpretation without accepting unknown claims", () => {
  const wire: unknown = JSON.parse(
    JSON.stringify(analyzeJavaScriptStaticSource("app.get(''); fetch('');")),
  );
  const parsed = javaScriptWorkerStaticAnalysisSchema.parse(wire);
  expect(parsed.endpoints).toContainEqual(
    expect.objectContaining({
      kind: "network",
      value: "",
      mechanism: "call:app.get",
      interpretation: "candidate",
    }),
  );
  const known = parsed.endpoints.find(
    ({ mechanism }) => mechanism === "call:fetch",
  );
  expect(known).toBeDefined();
  expect(known).not.toHaveProperty("interpretation");
  expect(
    javaScriptWorkerStaticAnalysisSchema.safeParse({
      ...parsed,
      endpoints: parsed.endpoints.map((endpoint) => ({
        ...endpoint,
        interpretation: "verified",
      })),
    }).success,
  ).toBe(false);
});

it("versions fingerprints through the worker schema and rejects v1", () => {
  const facts =
    analyzeJavaScriptStaticSource(`globalThis.webpackChunkApp.push([[1], {
    17(module, exports) { const key = selectKey(); exports.read = value[key]; }
  }]);`);
  expect(facts.bundler_registrations[0]?.modules[0]).toMatchObject({
    structural_fingerprint_algorithm: "babel-ast-v2",
    structural_fingerprint_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(
    javaScriptWorkerStaticAnalysisSchema.safeParse(
      JSON.parse(JSON.stringify(facts)) as unknown,
    ).success,
  ).toBe(true);
  const old = {
    ...facts,
    bundler_registrations: facts.bundler_registrations.map((registration) => ({
      ...registration,
      modules: registration.modules.map((module) => ({
        ...module,
        structural_fingerprint_algorithm: "babel-ast-v1",
      })),
    })),
  };
  expect(javaScriptWorkerStaticAnalysisSchema.safeParse(old).success).toBe(
    false,
  );
});
