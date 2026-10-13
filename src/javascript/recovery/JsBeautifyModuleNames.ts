import { basename, dirname, join } from "node:path";
import { normalizeArtifactPath } from "../../artifacts/ArtifactPaths.js";
import type { RecoveryInputSnapshot } from "./RecoveryFiles.js";

const FILE_NAME_MAX_BYTES = 255;

type Alias = "collision" | "length";

/** Keep the selected layout where safe, and give every published script a JS extension. */
const moduleName = (
  source: RecoveryInputSnapshot,
  single: boolean,
): { readonly name: string; readonly shortened: boolean } => {
  let name = source.relative_path;
  if (single) {
    const selectedName = basename(source.path);
    try {
      if (normalizeArtifactPath(selectedName) === selectedName)
        name = selectedName;
    } catch {
      // The snapshot already owns a safe fallback for a native-only basename.
    }
  }
  const withExtension = /\.(?:[cm]?js|jsx)$/i.test(name) ? name : `${name}.js`;
  if (Buffer.byteLength(basename(withExtension)) <= FILE_NAME_MAX_BYTES)
    return { name: withExtension, shortened: false };
  const replacement = `__rea_${source.sha256.slice(0, 16)}.js`;
  return {
    name:
      dirname(withExtension) === "."
        ? replacement
        : join(dirname(withExtension), replacement),
    shortened: true,
  };
};

/**
 * Allocate the complete output layout before any producer can overwrite a selected input's output.
 * Inputs published under their own relative path keep it; renamed inputs take aliases on collision,
 * so an import of a selected file still resolves to that file's recovered output. An aliased module
 * (moved on collision, or shortened to a digest name past the basename limit) no longer sits where
 * imports of it or from it resolve.
 */
export const moduleNames = (
  sources: readonly RecoveryInputSnapshot[],
): readonly { readonly name: string; readonly alias: Alias | null }[] => {
  const planned = sources.map((source) =>
    moduleName(source, sources.length === 1),
  );
  const desired = planned.map(({ name }) => name);
  const renamed = (index: number): number =>
    Number(desired[index] !== sources[index]?.relative_path);
  const order = desired
    .map((_, index) => index)
    .sort((left, right) => renamed(left) - renamed(right));
  const allocated = new Set<string>();
  const names: { name: string; alias: Alias | null }[] = [];
  const overlaps = (left: string, right: string): boolean =>
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`);
  for (const index of order) {
    const name = desired[index] ?? "";
    let candidate = name;
    let suffix = 0;
    while (
      [...allocated].some((used) => overlaps(used, candidate)) ||
      desired.some(
        (reserved, other) =>
          other !== index &&
          reserved !== candidate &&
          overlaps(reserved, candidate),
      )
    ) {
      suffix += 1;
      candidate = `__rea_recovered_${String(index + 1)}_${String(suffix)}/${basename(name)}`;
    }
    allocated.add(candidate);
    names[index] = {
      name: candidate,
      alias:
        candidate !== name
          ? "collision"
          : planned[index]?.shortened === true && sources.length > 1
            ? "length"
            : null,
    };
  }
  return names;
};

/** Aliased modules are published, but the combined tree is not offered as analysis input. */
export const aliasWarnings = (
  sources: readonly RecoveryInputSnapshot[],
  names: ReturnType<typeof moduleNames>,
) =>
  sources.flatMap((source, index) => {
    const allocated = names[index];
    if (allocated?.alias === undefined || allocated.alias === null) return [];
    const reason =
      allocated.alias === "collision"
        ? "its JavaScript name collides with another selected input"
        : `its JavaScript name exceeds ${String(FILE_NAME_MAX_BYTES)} bytes`;
    return [
      {
        filename: allocated.name,
        kind: "module-alias",
        is_error: false,
        message: `${JSON.stringify(source.relative_path)} was published as ${JSON.stringify(allocated.name)} because ${reason}; relative imports of and from it no longer resolve as in the original layout, so analysis_input is null`,
      },
    ];
  });
