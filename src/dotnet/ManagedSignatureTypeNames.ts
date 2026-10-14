import { createHash } from "node:crypto";

import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import type { SignatureTypeName } from "./ManagedMemberInspectorCore.js";
import {
  metadataRowCursor,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { readManagedValue } from "./ManagedReaderFailure.js";

const TYPE_REF = 1;
const TYPE_DEF = 2;
const NESTED_CLASS = 41;
/** ResolutionScope tag of a TypeRef that names a nested type's enclosing TypeRef. */
const ENCLOSING_TYPE_REF = 3;

/** One type's own namespace and name, and its enclosing type's row if nested. */
interface TypeLink {
  readonly namespace: string;
  readonly name: string;
  readonly enclosingRow: number | null;
}

/** Each nested TypeDef row's enclosing row, from the NestedClass table. */
const enclosingTypeDefs = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
): ReadonlyMap<number, number> => {
  const enclosing = new Map<number, number>();
  const rows = layout.table(NESTED_CLASS)?.rowCount ?? 0;
  for (let row = 1; row <= rows; row += 1) {
    const cursor = metadataRowCursor(bytes, layout, NESTED_CLASS, row);
    const nested = cursor.readIndex(layout.tableIndexSize(TYPE_DEF));
    enclosing.set(nested, cursor.readIndex(layout.tableIndexSize(TYPE_DEF)));
  }
  return enclosing;
};

/**
 * Read a TypeDef or TypeRef row's namespace and name; a failure to read a row
 * in its table is retained in `issues`.
 */
const readTypeLink = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
  {
    table,
    row,
    enclosing,
  }: {
    readonly table: typeof TYPE_REF | typeof TYPE_DEF;
    readonly row: number;
    /** The enclosing type's row, from the row and its ResolutionScope. */
    readonly enclosing: (row: number, scope: number) => number | null;
  },
): TypeLink | null => {
  // Member signature operands are not validated against their tables, so an
  // operand past its table only goes unnamed; a row that is there but cannot
  // be read is malformed metadata.
  if (row < 1 || row > (layout.table(table)?.rowCount ?? 0)) return null;
  return (
    readManagedValue(() => {
      const cursor = metadataRowCursor(bytes, layout, table, row);
      const scope =
        table === TYPE_REF
          ? cursor.readIndex(layout.codedIndexSize("ResolutionScope"))
          : cursor.readUInt32();
      const name = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
        layout.strings.size,
      );
      const namespace = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
        layout.strings.size,
      );
      return { namespace, name, enclosingRow: enclosing(row, scope) };
    }, issues) ?? null
  );
};

/**
 * Deepest type nesting REA names, counting the outermost type as 1. Real
 * assemblies nest a few levels; the cap bounds the walk a hostile chain of
 * NestedClass rows or TypeRef ResolutionScopes can force per operand.
 */
export const MAX_TYPE_NESTING_DEPTH = 64;

/** Digest prefixes that keep a top-level type apart from a nested one. */
const TOP_LEVEL = Buffer.from([0]);
const NESTED = Buffer.from([1]);
/**
 * Separates a namespace from a name. #Strings entries end at NUL, so neither
 * holds one, and `A` + `B.C` stays apart from `A.B` + `C`.
 */
const NAME_SEPARATOR = Buffer.from([0]);

interface NamedRow {
  readonly digest: Buffer;
  readonly depth: number;
}

/**
 * Digest each row's type name after its enclosing types' names: a top-level
 * type hashes its namespace and name, each framed, and a nested type hashes
 * its enclosing type's digest and its own namespace and name, as
 * `Outer/Inner` would read. Each
 * row is read and digested once, so naming a chain is linear in its length.
 * A gap, a cycle, or nesting deeper than `MAX_TYPE_NESTING_DEPTH` has no
 * digest. `retain` is charged once per row read and once per remembered row.
 */
export const nestedTypeDigests = (
  link: (row: number) => TypeLink | null,
  retain: () => void,
): ((row: number) => Buffer | null) => {
  const named = new Map<number, NamedRow | null>();
  const remember = (row: number, value: NamedRow | null): void => {
    retain();
    named.set(row, value);
  };
  // Rows a walk read but could not name, such as the parents of a type nested
  // past the cap, are still read only once.
  const links = new Map<number, TypeLink | null>();
  const readLink = (row: number): TypeLink | null => {
    const known = links.get(row);
    if (known !== undefined) return known;
    const read = link(row);
    retain();
    links.set(row, read);
    return read;
  };
  return (row) => {
    // Walk out to a named row or the outermost type, at most past the cap.
    const path: { readonly row: number; readonly link: TypeLink }[] = [];
    const seen = new Set<number>();
    let outer: NamedRow | null = null;
    for (let current: number | null = row; current !== null;) {
      const known = named.get(current);
      if (known !== undefined) {
        if (known === null) {
          for (const step of path) remember(step.row, null);
          return null;
        }
        outer = known;
        break;
      }
      if (seen.has(current)) {
        // Every row on a cycle, and every row nested in one, has no name.
        for (const step of path) remember(step.row, null);
        return null;
      }
      if (path.length === MAX_TYPE_NESTING_DEPTH) {
        // The row the walk started from is nested past the cap.
        remember(row, null);
        return null;
      }
      const step = readLink(current);
      if (step === null) {
        remember(current, null);
        for (const visited of path) remember(visited.row, null);
        return null;
      }
      seen.add(current);
      path.push({ row: current, link: step });
      current = step.enclosingRow;
    }
    // Name inward from the outermost row; a row past the cap, and every row
    // nested in it, has no name.
    let inner: NamedRow | null = outer;
    let exceeded = false;
    for (const step of path.reverse()) {
      const depth = (inner?.depth ?? 0) + 1;
      exceeded ||= depth > MAX_TYPE_NESTING_DEPTH;
      if (exceeded) {
        remember(step.row, null);
        continue;
      }
      const hash = createHash("sha256");
      if (inner === null) hash.update(TOP_LEVEL);
      else hash.update(NESTED).update(inner.digest);
      hash
        .update(step.link.namespace)
        .update(NAME_SEPARATOR)
        .update(step.link.name);
      inner = { digest: hash.digest(), depth };
      remember(step.row, inner);
    }
    return exceeded ? null : (inner?.digest ?? null);
  };
};

/**
 * Name signature type operands independently of their metadata rows: a TypeDef
 * or TypeRef by namespace and name, after its enclosing types for a nested
 * type, as in `Outer/Inner`. A TypeDef and a TypeRef with the same name are
 * the same type, and a TypeRef's resolution scope assembly is not part of its
 * name, so a type forwarded between assemblies keeps its name. A TypeSpec, an
 * unreadable row, cyclic nesting, or nesting deeper than the cap has no name,
 * so its signature has no resolved digest; an unreadable row's failure is
 * retained in `issues`, once per row. Each coded index and each row is
 * named and digested once, so repeated operands cost a lookup.
 */
export const signatureTypeNames = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): SignatureTypeName => {
  let enclosingDefs: ReadonlyMap<number, number> | undefined;
  const retain = () => managedDecodeBudget(layout).reserve(128, null);
  const definitions = nestedTypeDigests(
    (row) =>
      readTypeLink(bytes, layout, issues, {
        table: TYPE_DEF,
        row,
        enclosing: (nested) => {
          enclosingDefs ??= enclosingTypeDefs(bytes, layout);
          return enclosingDefs.get(nested) ?? null;
        },
      }),
    retain,
  );
  const references = nestedTypeDigests(
    (row) =>
      readTypeLink(bytes, layout, issues, {
        table: TYPE_REF,
        row,
        enclosing: (_row, scope) =>
          (scope & 3) === ENCLOSING_TYPE_REF ? scope >>> 2 : null,
      }),
    retain,
  );
  const digests = new Map<number, Buffer | null>();
  return (codedIndex) => {
    let digest = digests.get(codedIndex);
    if (digest === undefined) {
      managedDecodeBudget(layout).reserve(256, null);
      const row = codedIndex >>> 2;
      const table = codedIndex & 3;
      digest =
        table === 0 ? definitions(row) : table === 1 ? references(row) : null;
      digests.set(codedIndex, digest);
    }
    return digest;
  };
};
