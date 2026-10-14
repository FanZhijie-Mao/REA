import { chmod, lstat, readFile } from "node:fs/promises";
import { expect, it, onTestFinished } from "vitest";

import {
  expectConfigurationRefusal,
  serveCli as serve,
} from "./cliServeHarness.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analysisErrorProjectionSchema } from "../../../src/contracts/errorSchemas.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

it.each([
  [
    ["inspect-adb-client", "--json"],
    "/nonexistent/adb",
    "The selected adb binary was not found: /nonexistent/adb. Set REA_ADB_PATH",
  ],
  [
    ["list-adb-devices", "--json"],
    "/nonexistent/adb",
    "The selected adb binary was not found: /nonexistent/adb. Set REA_ADB_PATH",
  ],
  [
    ["list-adb-devices", "--json"],
    "relative/adb",
    "REA_ADB_PATH must be an absolute path to the adb binary.",
  ],
])(
  "%j with REA_ADB_PATH=%s names the host requirement",
  async (argv, binary, reason) => {
    const result = await serve(argv, { REA_ADB_PATH: binary });
    expectConfigurationRefusal(result, reason);
  },
);

it("validates device serials before contacting any device", async () => {
  const result = await serve(["inspect-adb-device", "bad serial", "--json"]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
  });
});

cliTest(
  "classifies a malformed --extra before any device operation",
  async ({ cli }) => {
    const workspace = await createTestWorkspace("rea-adb-cli-extra-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const environment = {
      HOME: workspace.root,
      XDG_CONFIG_HOME: workspace.path("config"),
      XDG_CACHE_HOME: workspace.path("cache"),
      XDG_DATA_HOME: workspace.path("data"),
    };
    for (const extra of ["string:key", ":", "string"]) {
      const result = await cli.run({
        arguments: [
          "start-adb-activity",
          "emulator-5554",
          "android.intent.action.VIEW",
          "--extra",
          extra,
          "--json",
        ],
        environment,
      });
      expect(result.exitCode, result.stdout).toBe(1);
      const projection = analysisErrorProjectionSchema.parse(result.json);
      expect(projection).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        message: expect.stringContaining("type:key:value"),
        details: {
          issues: [
            expect.objectContaining({
              path: ["extra", 0],
              reason: "invalid_format",
            }),
          ],
        },
      });
    }
    // A well-formed extra still reaches provider admission instead of being
    // rejected by the delimiter check.
    const admitted = await cli.run({
      arguments: [
        "start-adb-activity",
        "emulator-5554",
        "android.intent.action.VIEW",
        "--extra",
        "string:key:value",
        "--json",
      ],
      environment: { ...environment, REA_ADB_PATH: "/nonexistent/adb" },
    });
    expect(admitted.exitCode, admitted.stdout).toBe(1);
    expect(admitted.json).toMatchObject({ code: "capability_unavailable" });
  },
);

it("requires the output directory option on pull", async () => {
  const result = await serve([
    "pull-adb-package",
    "emulator-5554",
    "com.example",
    "--json",
  ]);
  expect(result.exitCode).not.toBe(0);
});

it.skipIf(process.platform === "win32")(
  "refuses a trailing device separator through the CLI before adb or output effects",
  async () => {
    const workspace = await createTestWorkspace("rea-adb-cli-pull-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const adb = await workspace.write(
      "adb",
      `#!/bin/sh
if [ "$1" = "version" ]; then
  printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-cli\\nInstalled as %s\\n' "$0"
  exit 0
fi
: > '${workspace.path("invoked")}'
exit 0
`,
    );
    await chmod(adb, 0o755);
    const output = workspace.path("pulls");
    const result = await serve(
      [
        "pull-adb-file",
        "emulator-5554",
        "/data/local/tmp/",
        "--output-directory",
        output,
        "--json",
      ],
      { REA_ADB_PATH: adb },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "invalid_request",
    });
    await expect(readFile(workspace.path("invoked"))).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
