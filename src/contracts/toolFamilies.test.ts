import { describe, expect, it } from "vitest";

import {
  TOOL_FAMILY_DEFINITIONS,
  TOOL_FAMILY_IDS,
  toolFamilyId,
} from "./toolFamilies.js";
import { TOOL_CONTRACTS } from "./toolContracts.js";

describe("tool families", () => {
  it("covers every contract exactly once", () => {
    const owners = new Map<string, string[]>();
    for (const { id, contracts } of TOOL_FAMILY_DEFINITIONS)
      for (const { name } of contracts)
        owners.set(name, [...(owners.get(name) ?? []), id]);
    expect([...owners].filter(([, ids]) => ids.length > 1)).toEqual([]);
    expect([...owners.keys()].sort()).toEqual(
      TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );
  });

  it("resolves each advertised tool to its owning family", () => {
    for (const { name } of TOOL_CONTRACTS)
      expect(TOOL_FAMILY_IDS).toContain(toolFamilyId(name));
    expect(toolFamilyId("not_a_tool")).toBeUndefined();
  });
});
