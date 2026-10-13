#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Route production MCP before importing Incur. Incur owns registration helpers
// such as `mcp add`, while the MCP runtime serves the stdio tool catalog.
const args = process.argv.slice(2);
const { default: packageJson } = await import("../package.json", {
  with: { type: "json" },
});
process.env.REA_PACKAGE_VERSION = packageJson.version;
const isMcpMode =
  args.length === 1 && (args[0] === "--mcp" || args[0] === "mcp");
const isMcpDoctorMode = args[0] === "mcp" && args[1] === "doctor";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Windows home lookup throws for an empty USERPROFILE. Dependencies resolve
// home during import, before REA's own resolver can apply its account fallback.
if (process.platform === "win32" && process.env.USERPROFILE === "") {
  delete process.env.USERPROFILE;
}

// Playwright's registry assumes one of its three desktop host platforms when
// it chooses the browser cache directory. Termux reports `android`, although
// its Node runtime and filesystem are POSIX-compatible. Keep the cache path
// explicit so REA can start on Termux. Browser launch still requires a
// caller-supplied Android-compatible Chromium executable.
if (
  process.platform === "android" &&
  process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
) {
  const cacheRoot =
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? ".", ".cache");
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(cacheRoot, "ms-playwright");
}

// Prefer bundles, but fall back to plain TypeScript output if an
// Android/ARM64 bundler leaves an empty entry point.
const runtimeLayouts = {
  bundled: {
    mcp: "dist/mcp/main.js",
    mcpDoctor: "dist/cli-runtime/mcpDoctor.js",
    cli: "dist/cli-runtime/cli.js",
    cliOutput: "dist/cli-runtime/cliOutput.js",
    cliResultOutput: "dist/cli-runtime/cliResultOutput.js",
  },
  compiled: {
    mcp: "dist/main.js",
    mcpDoctor: "dist/mcpDoctor.js",
    cli: "dist/cli.js",
    cliOutput: "dist/cliOutput.js",
    cliResultOutput: "dist/cli/cliResultOutput.js",
  },
};

const filesForLayout = (layout) =>
  isMcpMode
    ? [layout.mcp]
    : isMcpDoctorMode
      ? [layout.mcp, layout.mcpDoctor]
      : [layout.cli, layout.cliOutput, layout.cliResultOutput];

const runtimeLayout = (await compiledRuntimeExists(
  filesForLayout(runtimeLayouts.bundled),
))
  ? runtimeLayouts.bundled
  : runtimeLayouts.compiled;
const runtimeFiles = filesForLayout(runtimeLayout);

if (!(await compiledRuntimeExists(runtimeFiles))) {
  process.stderr.write(
    `REA's compiled runtime is missing. Run \`npm ci && npm run build:cached\` in ${packageRoot} to install dependencies and build REA, then restart it. If this is an installed package, reinstall rea-agents.\n`,
  );
  process.exitCode = 1;
} else if (isMcpMode) {
  const { runEntrypoint } = await import(
    pathToFileURL(resolve(packageRoot, runtimeLayout.mcp)).href
  );
  await runEntrypoint();
} else if (isMcpDoctorMode) {
  const { runProductionMcpDoctorCli } = await import(
    pathToFileURL(resolve(packageRoot, runtimeLayout.mcpDoctor)).href
  );
  const result = await runProductionMcpDoctorCli(args.slice(2), {
    dispatcherPath: fileURLToPath(import.meta.url),
    packageRoot,
  });
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
} else {
  const { cliConfigurationError, createCli } = await import(
    pathToFileURL(resolve(packageRoot, runtimeLayout.cli)).href
  );
  const { createCliResultOutput } = await import(
    pathToFileURL(resolve(packageRoot, runtimeLayout.cliResultOutput)).href
  );
  const {
    renderCliOutputArgumentError,
    renderEmptyFilteredCliOutput,
    validateCliOutputArguments,
  } = await import(
    pathToFileURL(resolve(packageRoot, runtimeLayout.cliOutput)).href
  );
  const outputArguments = validateCliOutputArguments(args);
  const configurationError = cliConfigurationError(process.env);
  if (configurationError !== undefined) {
    process.stderr.write(`${configurationError}\n`);
    process.exitCode = 1;
  } else if (!outputArguments.ok) {
    process.stdout.write(renderCliOutputArgumentError(outputArguments));
    process.exitCode = 1;
  } else {
    let wroteOutput = false;
    const resultOutput = createCliResultOutput(args, process.stdout);
    await createCli(process.env, resultOutput).serve(args, {
      stdout: (output) => {
        if (resultOutput?.handled) {
          if (resultOutput.failed) process.stderr.write(output);
          return;
        }
        if (output.length > 0) wroteOutput = true;
        process.stdout.write(output);
      },
    });
    if (!wroteOutput && !resultOutput?.handled)
      process.stdout.write(renderEmptyFilteredCliOutput(args) ?? "");
  }
}

async function compiledRuntimeExists(paths) {
  for (const path of paths) {
    try {
      const info = await stat(resolve(packageRoot, path));
      if (!info.isFile() || info.size === 0) return false;
    } catch (cause) {
      if (isMissing(cause)) return false;
      throw cause;
    }
  }
  return true;
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
