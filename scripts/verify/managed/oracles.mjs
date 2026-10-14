import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { inspectManagedArtifactBytes } from "../../../dist/dotnet/ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "../../../dist/dotnet/ManagedMemberInspector.js";
import { importManagedReconstructionEvidence } from "../../../dist/application/managed/ManagedReconstructionService.js";
import { createEvidence } from "../../../dist/domain/evidence.js";
import { MANAGED_STATIC_PROVIDER } from "../../../dist/application/InvestigationProviders.js";
import {
  createManagedManifestVerifier,
  selectManifestMethod,
} from "./manifest.mjs";

const execFileAsync = promisify(execFile);

export const createManagedConformanceOracleSupport = (context) => {
  const verifier = createManagedManifestVerifier(context);
  const support = { ...context, ...verifier };
  return {
    runManagedAppManifestSelfTest: () => runManagedAppManifestSelfTest(support),
    runOptionalManagedAppManifest: () => runOptionalManagedAppManifest(support),
    runOptionalIlspyOracle: () => runOptionalIlspyOracle(support),
  };
};

async function runManagedAppManifestSelfTest(context) {
  const sample = await context.fixture("manifest-self-test.exe", {
    methods: [
      { name: "FirstSemanticSlice", body: manifestMethodBody(1, 0x06000003) },
      { name: "PinnedSemanticSlice", body: manifestMethodBody(5, 0x06000001) },
      {
        name: "UnselectedSemanticSlice",
        body: manifestMethodBody(9, 0x0a000001),
      },
    ],
    // One-character UTF-16 #US entries have a three-byte payload and a
    // one-byte compressed length; their offsets are 1, 5 and 9.
    userStringHeap: Buffer.from([
      0, 3, 0x41, 0, 0, 3, 0x42, 0, 0, 3, 0x43, 0, 0,
    ]),
  });
  const artifact = inspectManagedArtifactBytes(
    sample.bytes,
    sample.target,
    context.inspectionLimits,
  );
  const members = inspectManagedMembersBytes(
    sample.bytes,
    sample.target,
    context.memberLimits,
  );
  const method = members.methods[1];
  assert.ok(method);
  const memberFactChecks = verifyManifestSelectedFacts(members);
  const manifest = {
    label: "source-owned manifest verifier self-test",
    target: {
      path: sample.path,
      sha256: sample.target.sha256,
      mvid: artifact.module?.mvid,
      assembly_name: artifact.assembly?.name,
      runtime_family: artifact.classification.runtime_family,
      managed_architecture: artifact.classification.managed_architecture,
    },
    methods: [
      {
        label: "pinned-semantic-slice",
        token: method.token,
        signature_sha256: method.signature.raw_sha256,
        il_size: method.body.il_size,
        il_sha256: method.body.il_sha256,
        normalized_il_sha256: method.body.normalized_il_sha256,
      },
    ],
    application_graph: {
      expected_node_kinds: [
        "artifact",
        "managed-assembly",
        "managed-module",
        "managed-type",
        "managed-method",
      ],
      feature_traces: [
        {
          label: "trace pinned method by name",
          method_token: method.token,
          seed: "PinnedSemanticSlice",
          match: "exact",
          min_matched_seeds: 1,
        },
      ],
    },
  };
  const manifestPath = join(
    context.workspace,
    "source-owned-managed-app-manifest.json",
  );
  const summary = await context.verifyManagedAppManifest(
    manifest,
    manifestPath,
  );
  assert.equal(summary.application_graph.projections.length, 1);
  const projection = summary.application_graph.projections[0];
  assert.equal(projection.summary.methods, 1);
  assert.equal(projection.method_token, "0x06000002");
  assert.deepEqual(projection.member_selection, {
    method_tokens: ["0x06000002"],
    selection_stage: "post-inspection",
  });
  assert.equal(projection.coverage.status, "partial");
  const first = members.methods[0];
  assert.ok(first);
  const firstRow = await context.verifyManagedAppManifest(
    {
      ...manifest,
      methods: [
        {
          token: first.token,
          signature_sha256: first.signature.raw_sha256,
          il_size: first.body.il_size,
          il_sha256: first.body.il_sha256,
          normalized_il_sha256: first.body.normalized_il_sha256,
        },
      ],
      application_graph: { expected_node_kinds: ["managed-method"] },
    },
    manifestPath,
  );
  assert.equal(
    firstRow.application_graph.projections[0].method_token,
    "0x06000001",
  );
  assert.equal(firstRow.application_graph.projections[0].summary.methods, 1);
  const rejections = await verifyManifestRejections(
    context,
    manifest,
    manifestPath,
  );
  return {
    verified: true,
    assertions: summary.assertions,
    methods: summary.methods.length,
    applicationGraph: summary.application_graph ?? null,
    target: summary.target,
    selection_checks: 2,
    rejection_checks: rejections,
    member_fact_checks: memberFactChecks,
  };
}

function manifestMethodBody(literalOffset, callToken) {
  const callee = Buffer.alloc(4);
  callee.writeUInt32LE(callToken);
  const il = Buffer.concat([
    // ldarg.0; ldfld 0x04000001; pop
    Buffer.from([0x02, 0x7b, 1, 0, 0, 4, 0x26]),
    // ldstr from this method's #US entry; pop
    Buffer.from([0x72, literalOffset, 0, 0, 0x70, 0x26]),
    Buffer.from([0x28]),
    callee,
    Buffer.from([0x2a]), // call; ret
  ]);
  return Buffer.concat([Buffer.from([(il.length << 2) | 2]), il]);
}

function verifyManifestSelectedFacts(members) {
  assert.equal(members.call_edges.length, 3);
  assert.equal(members.field_accesses.length, 3);
  assert.equal(members.user_strings.literals.length, 3);
  const cases = [
    ["0x06000001", "0x06000003", "0x70000001", "A"],
    ["0x06000002", "0x06000001", "0x70000005", "B"],
    ["0x06000003", "0x0a000001", "0x70000009", "C"],
  ];
  for (const [token, callee, literal, value] of cases) {
    const selected = selectManifestMethod(members, token);
    assert.deepEqual(
      selected.methods.map((method) => method.token),
      [token],
    );
    assert.deepEqual(
      selected.call_edges.map((edge) => [edge.caller_token, edge.target_token]),
      [[token, callee]],
    );
    assert.deepEqual(
      selected.field_accesses.map((access) => [
        access.method_token,
        access.field_token,
        access.opcode,
      ]),
      [[token, "0x04000001", "ldfld"]],
    );
    assert.deepEqual(
      selected.user_strings.literals.map((item) => [item.token, item.value]),
      [[literal, value]],
    );
    assert.deepEqual(selected.artifact, members.artifact);
    assert.deepEqual(selected.identity_scope, members.identity_scope);
  }
  assert.equal(
    selectManifestMethod({ ...members, user_strings: null }, "0x06000002")
      .user_strings,
    null,
  );
  return cases.length;
}

async function verifyManifestRejections(context, manifest, manifestPath) {
  const cases = [
    ...[
      ["sha256", "0".repeat(64), /target sha256 mismatch/u],
      ["mvid", "00000000-0000-0000-0000-000000000000", /target MVID mismatch/u],
      ["assembly_name", "Other.Assembly", /assembly name mismatch/u],
      ["runtime_family", "dotnet-framework", /runtime family mismatch/u],
      ["managed_architecture", "x64", /managed architecture mismatch/u],
    ].map(([field, value, error]) => ({
      manifest: { ...manifest, target: { ...manifest.target, [field]: value } },
      error,
    })),
    ...[
      ["signature_sha256", "0".repeat(64), /signature sha256 mismatch/u],
      ["il_size", manifest.methods[0].il_size + 1, /IL size mismatch/u],
      ["il_sha256", "0".repeat(64), /IL sha256 mismatch/u],
      [
        "normalized_il_sha256",
        "0".repeat(64),
        /normalized IL sha256 mismatch/u,
      ],
      ["token", "0x06000004", /was not returned by the member inspector/u],
      ["token", "0x06000000", /invalid row id/u],
    ].map(([field, value, error]) => ({
      manifest: {
        ...manifest,
        methods: [{ ...manifest.methods[0], [field]: value }],
      },
      error,
    })),
    {
      manifest: {
        ...manifest,
        application_graph: {
          feature_traces: [
            { method_token: "0x06000002", seed: "UnselectedSemanticSlice" },
          ],
        },
      },
      error: /matched 0 seeds/u,
    },
    {
      manifest: {
        ...manifest,
        application_graph: {
          feature_traces: [
            { method_token: "0x06000003", seed: "UnselectedSemanticSlice" },
          ],
        },
      },
      error: /must also be declared in manifest.methods/u,
    },
  ];
  for (const { manifest: invalid, error } of cases)
    await assert.rejects(
      context.verifyManagedAppManifest(invalid, manifestPath),
      error,
    );
  return cases.length;
}

async function runOptionalManagedAppManifest(context) {
  const manifestPath = process.env.REA_MANAGED_APP_MANIFEST_PATH;
  if (manifestPath === undefined) return null;
  if (manifestPath.trim().length === 0)
    throw new Error("REA_MANAGED_APP_MANIFEST_PATH is set but empty");
  const resolvedManifestPath = resolve(process.cwd(), manifestPath);
  const text = await readFile(resolvedManifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `managed app manifest ${resolvedManifestPath} is not valid JSON: ${message}`,
    );
  }
  return {
    configured: true,
    ...(await context.verifyManagedAppManifest(manifest, resolvedManifestPath)),
  };
}

async function runOptionalIlspyOracle(context) {
  const ilspyPath = process.env.REA_ILSPY_CMD_PATH;
  if (ilspyPath === undefined) return null;
  ensureIlspy(
    ilspyPath.trim().length > 0,
    "REA_ILSPY_CMD_PATH is set but empty",
  );
  ensureIlspy(
    isAbsolute(ilspyPath),
    "REA_ILSPY_CMD_PATH must be an absolute path",
  );
  await ensureExecutable(ilspyPath);
  const versionOutput = await runIlspy(ilspyPath, ["--version"], 64 * 1024);
  const version = ilspyVersion(versionOutput);
  const executableSha256 = context.sha256(await readFile(ilspyPath));
  const sample = await context.fixture("ilspy-oracle.exe", {
    methodName: "PinnedSemanticSlice",
  });
  const artifact = inspectManagedArtifactBytes(
    sample.bytes,
    sample.target,
    context.inspectionLimits,
  );
  const members = inspectManagedMembersBytes(
    sample.bytes,
    sample.target,
    context.memberLimits,
  );
  const method = members.methods[0];
  ensureIlspy(method !== undefined, "source-owned fixture has no method");
  const listOutput = await runIlspy(
    ilspyPath,
    ["--disable-updatecheck", "-l", "c", sample.path],
    256 * 1024,
  );
  ensureIlspy(
    listOutput.includes("Class Fixture.Program"),
    "ilspycmd class listing did not include Fixture.Program",
  );
  const csharp = await runIlspy(
    ilspyPath,
    ["--disable-updatecheck", "--type", "Fixture.Program", sample.path],
    256 * 1024,
  );
  ensureIlspy(
    csharp.includes("PinnedSemanticSlice"),
    "ilspycmd C# output did not include the pinned method name",
  );
  ensureIlspy(
    csharp.length <= 65_536,
    "ilspycmd C# output exceeded the managed reconstruction import bound",
  );
  const reconstructionImport = importIlspyReconstruction({
    context,
    sample,
    method,
    members,
    version,
    executableSha256,
    csharp,
  });
  const imported = reconstructionImport.value.normalized_result;
  return {
    env: "REA_ILSPY_CMD_PATH",
    configured: true,
    version,
    executable_sha256: executableSha256,
    fixture: {
      file_name: basename(sample.path),
      sha256: sample.target.sha256,
      mvid: artifact.module?.mvid ?? null,
      assembly_name: artifact.assembly?.name ?? null,
      method: {
        token: method.token,
        declaring_type: method.declaring_type,
        name: method.name,
        signature_sha256: method.signature.raw_sha256,
        il_size: method.body.il_size,
        normalized_il_sha256: method.body.normalized_il_sha256,
      },
    },
    output: {
      class_listing_sha256: context.sha256(Buffer.from(listOutput)),
      decompiled_csharp_sha256: context.sha256(Buffer.from(csharp)),
      decompiled_csharp_bytes: Buffer.byteLength(csharp),
      imported_evidence_id: reconstructionImport.value.evidence_id,
      reconstruction_id: imported.reconstruction_id,
      canonical_observation:
        imported.methods[0]?.validation.canonical_observation ?? null,
      confidence_floor:
        imported.methods[0]?.validation.confidence_floor ?? null,
    },
  };
}

function importIlspyReconstruction({
  context,
  sample,
  method,
  members,
  version,
  executableSha256,
  csharp,
}) {
  const memberEvidence = createEvidence(
    sample.target,
    MANAGED_STATIC_PROVIDER,
    {
      operation: "inspect_managed_members",
      parameters: context.memberLimits,
      result: members,
      rawResult: null,
      limitations: members.limitations,
      locations: [{ kind: "artifact-path", path: sample.target.path }],
    },
  );
  const reconstructionImport = importManagedReconstructionEvidence({
    static_members: memberEvidence,
    decompiler: {
      name: "ilspycmd",
      version,
      family: "ilspy",
      executable_sha256: executableSha256,
      options: ["--disable-updatecheck", "--type", "Fixture.Program"],
    },
    methods: [
      {
        token: method.token,
        signature_sha256: method.signature.raw_sha256,
        normalized_il_sha256: method.body.normalized_il_sha256,
        reconstruction: {
          kind: "decompiled-csharp",
          language: "csharp",
          text: csharp,
        },
      },
    ],
    notes: [
      "source-owned real ilspycmd oracle; output is imported as reconstruction inference",
    ],
  });
  ensureIlspy(reconstructionImport.ok, "managed reconstruction import failed");
  const imported = reconstructionImport.value.normalized_result;
  ensureIlspy(
    imported.summary.decompiled_csharp_methods === 1,
    "managed reconstruction import did not record one decompiled C# method",
  );
  return reconstructionImport;
}

async function ensureExecutable(path) {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`managed ILSpy oracle failed: ${path} is not executable`);
  }
}

async function runIlspy(path, args, maxBuffer) {
  try {
    const { stdout } = await execFileAsync(path, args, {
      timeout: 30_000,
      maxBuffer,
      env: {
        ...process.env,
        DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      },
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`managed ILSpy oracle failed: ${message}`);
  }
}

function ilspyVersion(output) {
  const version = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("ilspycmd:"));
  ensureIlspy(
    version !== undefined,
    "ilspycmd --version did not identify ilspycmd",
  );
  return version;
}

function ensureIlspy(condition, message) {
  if (!condition) throw new Error(`managed ILSpy oracle failed: ${message}`);
}
