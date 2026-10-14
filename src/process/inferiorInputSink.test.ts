import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { verifyInferiorInputSink } from "./inferiorInputSink.js";

const terminal = { path: "/dev/pts/none", dev: 0, ino: 0 };

const withChild = async <T>(
  stdin: "ignore" | "pipe",
  use: (pid: string) => Promise<T>,
): Promise<T> => {
  const child = spawn("sleep", ["30"], { stdio: [stdin, "ignore", "ignore"] });
  try {
    return await use(String(child.pid));
  } finally {
    child.kill("SIGKILL");
  }
};

describe.skipIf(process.platform !== "linux")(
  "inferior standard input verification",
  () => {
    it("treats the null device as independent of the debugger", async () => {
      await expect(
        withChild("ignore", (pid) => verifyInferiorInputSink(pid, terminal)),
      ).resolves.toBe("not-inherited");
    });

    it("rejects a pipe whose independence from the debugger is unproven", async () => {
      await expect(
        withChild("pipe", (pid) => verifyInferiorInputSink(pid, terminal)),
      ).rejects.toThrow(/unverified/u);
    });
  },
);
