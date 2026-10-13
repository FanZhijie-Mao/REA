import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";

type CacheTable = readonly (string | undefined)[];
type CacheKey = string | null | undefined;
type CachePath = readonly (string | null)[];
type AliasInitializer =
  JavaScriptSemanticBindingState["referenceInitializers"][number];
type AliasVertex = string | t.Node;

interface CacheOwnership {
  /** null joins different helper owners without allocating their cross-product. */
  readonly owner: string | null;
  readonly first: CacheKey;
  readonly direct: boolean;
  readonly shared: boolean;
}

interface CacheAlias {
  readonly target: AliasVertex;
  /** Selection in the source before an object-rest copy. */
  readonly sourceFirst?: CacheKey;
  /** Selection in the produced value, after any copy. */
  readonly first: CacheKey;
  /** undefined is an alias; a boolean retains the object-rest copied selection. */
  readonly copyKeepsCache?: boolean;
}

const ARRAY_MUTATORS = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

/** invalidate admitted Vite caches through possible lexical aliases and shared writes. */
export function* invalidateJavaScriptViteCachesSteps(
  program: t.Program,
  tables: Map<string, CacheTable | null>,
  initializations: ReadonlySet<t.Node | undefined>,
  state: JavaScriptSemanticAnalysisState,
): Generator<void> {
  const origins = yield* createViteCacheOriginsSteps(tables, state);
  const interop = createSemanticModuleInterop(state);
  let allOwners = false;
  const retain = (node: t.Node, path: CachePath): void => {
    const owner = path[0];
    if (initializations.has(node) || owner === undefined || allOwners) return;
    if (path.length !== 1 && path[1] !== null && path[1] !== "f") return;
    if (owner === null) allOwners = true;
    else if (tables.has(owner)) tables.set(owner, null);
  };
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (node, kind) => (kind === "member" ? origins(node) : []),
    (node) => {
      const callee = unwrapJavaScriptExpression(node.callee).node;
      if (
        t.isMemberExpression(callee) ||
        t.isOptionalMemberExpression(callee)
      ) {
        const method = semanticStaticPropertyKey(
          callee.property,
          callee.computed,
        );
        if (method === null || ARRAY_MUTATORS.has(method))
          for (const path of origins(callee.object))
            if (path[1] === null || path[1] === "f") retain(node, path);
      }
      const invocation = interop.intrinsicInvocation(node);
      if (
        invocation?.path.slice(0, -1).join(".") ===
          "intrinsic.Array.prototype" &&
        ARRAY_MUTATORS.has(invocation.path.at(-1) ?? "") &&
        invocation.receiver !== undefined
      )
        for (const path of origins(invocation.receiver))
          if (path[1] === null || path[1] === "f") retain(node, path);
      return invocation;
    },
    interop.staticString,
    interop.isFreshObject,
    retain,
  );
  if (allOwners) {
    let examined = 0;
    for (const owner of tables.keys()) {
      if (examined++ % 1024 === 0) yield;
      tables.set(owner, null);
    }
  }
}

function* createViteCacheOriginsSteps(
  tables: ReadonlyMap<string, CacheTable | null>,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, (node: t.Node) => readonly CachePath[]> {
  const aliases = yield* indexViteAliasesSteps(state);
  const facts = new Map<AliasVertex, CacheOwnership>();
  const pending: { binding: AliasVertex; ownership: CacheOwnership }[] = [];
  // each binding has one owner or an ambiguous marker. each field can widen
  // only once, so retained facts and queued updates stay proportional to source.
  const retain = (binding: AliasVertex, incoming: CacheOwnership): void => {
    const previous = facts.get(binding);
    const ownership = joinOwnership(previous, incoming);
    if (ownership === previous) return;
    facts.set(binding, ownership);
    pending.push({ binding, ownership });
  };
  for (const owner of tables.keys())
    retain(owner, { owner, first: undefined, direct: true, shared: true });
  for (let cursor = 0; cursor < pending.length; cursor++) {
    if (cursor % 1024 === 0) yield;
    const fact = pending[cursor];
    if (fact === undefined) break;
    for (const alias of aliases.get(fact.binding) ?? []) {
      const source = selectOwnership(fact.ownership, alias.sourceFirst);
      if (source === undefined) continue;
      const copied =
        alias.copyKeepsCache === undefined
          ? source
          : {
              ...source,
              direct: false,
              shared:
                source.shared && source.first !== "f" && alias.copyKeepsCache,
            };
      const selected = selectOwnership(copied, alias.first);
      if (selected !== undefined) retain(alias.target, selected);
    }
  }
  const cached = new WeakMap<t.Node, readonly CachePath[]>();
  return (node) => {
    const previous = cached.get(node);
    if (previous !== undefined) return previous;
    let ownership: CacheOwnership | undefined;
    for (const [source, suffix] of viteAliasSources(node, state, facts))
      if (facts.has(source)) {
        const selected = selectOwnership(facts.get(source), suffix);
        if (selected !== undefined)
          ownership = joinOwnership(ownership, selected);
      }
    const paths: readonly CachePath[] = ownership?.direct
      ? [
          ownership.first === undefined
            ? [ownership.owner]
            : [ownership.owner, ownership.first],
        ]
      : [];
    cached.set(node, paths);
    return paths;
  };
}

function* indexViteAliasesSteps(
  state: JavaScriptSemanticAnalysisState,
): Generator<void, ReadonlyMap<AliasVertex, readonly CacheAlias[]>> {
  const aliases = new Map<AliasVertex, CacheAlias[]>();
  const producers: t.Node[] = [];
  const spreadFacts = new WeakMap<t.Node, SpreadCacheFact>();
  const freshFacts = new WeakMap<t.Node, boolean>();
  const enqueued = new WeakSet<t.Node>();
  const normalize = (node: t.Node): void => {
    if (enqueued.has(node)) return;
    enqueued.add(node);
    producers.push(node);
  };
  const connect = (source: AliasVertex, alias: CacheAlias): void => {
    const targets = aliases.get(source) ?? [];
    targets.push(alias);
    aliases.set(source, targets);
  };
  let examined = 0;
  for (const binding of state.bindingsById.values()) {
    if (examined++ % 1024 === 0) yield;
    const initializers: readonly AliasInitializer[] = [
      ...binding.initializers,
      ...binding.referenceInitializers,
    ];
    for (const initializer of initializers) {
      if (initializer.copyKind === "array-rest") continue;
      const copied = initializer.copyKind === "object-rest";
      const projection =
        copied && initializer.copyProjectionOffset !== undefined
          ? initializer.projection.slice(0, initializer.copyProjectionOffset)
          : initializer.projection;
      const key = projection[0];
      normalize(initializer.node);
      connect(initializer.node, {
        target: binding.bindingId,
        first: copied
          ? undefined
          : key === undefined
            ? undefined
            : key === null
              ? null
              : String(key),
        ...(copied
          ? {
              sourceFirst:
                key === undefined
                  ? undefined
                  : key === null
                    ? null
                    : String(key),
              copyKeepsCache: semanticPropertyPathKeyMatches(
                {
                  excludedKeys: initializer.copyExcludedKeys ?? [],
                },
                "f",
              ),
            }
          : {}),
      });
      const expression = unwrapJavaScriptExpression(initializer.node).node;
      if (
        initializer.projection.length === 0 &&
        t.isObjectExpression(expression) &&
        expression.properties.every(
          (property) =>
            t.isObjectProperty(property) &&
            semanticStaticPropertyKey(property.key, property.computed) !== null,
        )
      ) {
        const properties = new Map<string, t.Node>();
        for (const property of expression.properties.toReversed())
          if (t.isObjectProperty(property)) {
            const key = semanticStaticPropertyKey(
              property.key,
              property.computed,
            );
            if (key !== null && !properties.has(key))
              properties.set(key, property.value);
          }
        for (const [key, value] of properties)
          connect(value, {
            target: viteCacheMemberVertex(binding.bindingId, key),
            first: undefined,
          });
      }
    }
  }
  // shared initializer expressions are vertices, rather than duplicating all
  // branch sources for every destructured binding that reads that expression.
  for (let cursor = 0; cursor < producers.length; cursor++) {
    if (cursor % 1024 === 0) yield;
    const node = producers[cursor];
    if (node === undefined) break;
    for (const input of yield* aliasProducerInputsSteps(
      node,
      state,
      spreadFacts,
      freshFacts,
    )) {
      if (typeof input.source !== "string") normalize(input.source);
      connect(input.source, {
        target: node,
        first: input.first,
        ...(input.copyKeepsCache === undefined
          ? {}
          : { copyKeepsCache: input.copyKeepsCache }),
      });
    }
  }
  return aliases;
}

function* aliasProducerInputsSteps(
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  spreadFacts: WeakMap<t.Node, SpreadCacheFact>,
  freshFacts: WeakMap<t.Node, boolean>,
): Generator<
  void,
  readonly {
    source: AliasVertex;
    first: CacheKey;
    copyKeepsCache?: boolean;
  }[]
> {
  const { root, members } = electronMemberPath(node);
  const first = members[0];
  if (t.isIdentifier(root)) {
    const binding = resolveSemanticBindingState(state, root, root.name);
    return binding === undefined ? [] : [{ source: binding.bindingId, first }];
  }
  if (t.isObjectExpression(root)) {
    const inputs: {
      source: AliasVertex;
      first: CacheKey;
      copyKeepsCache: boolean;
    }[] = [];
    let overwritten = false;
    let examined = 0;
    for (let index = root.properties.length - 1; index >= 0; index--) {
      if (examined++ % 1024 === 0) yield;
      const property = root.properties[index];
      if (property === undefined) continue;
      if (t.isSpreadElement(property)) {
        inputs.push({
          source: property.argument,
          first,
          copyKeepsCache: !overwritten,
        });
        if (
          (yield* spreadCacheFactSteps(
            property.argument,
            spreadFacts,
            freshFacts,
            state,
          )) === "fresh"
        )
          overwritten = true;
      } else {
        const key = semanticStaticPropertyKey(property.key, property.computed);
        if (
          key !== null &&
          (first === undefined || first === null
            ? key === "f"
            : key === first) &&
          t.isObjectProperty(property)
        ) {
          if (
            yield* freshCacheReplacementSteps(property.value, freshFacts, state)
          ) {
            overwritten = true;
          } else {
            inputs.push({ source: property.value, first });
          }
        }
      }
    }
    return inputs;
  }
  if (
    t.isCallExpression(root) &&
    t.isMemberExpression(root.callee) &&
    isUnshadowedGlobal(root.callee.object, state, "Object") &&
    semanticStaticPropertyKey(root.callee.property, root.callee.computed) ===
      "assign"
  ) {
    const inputs: {
      source: AliasVertex;
      first: CacheKey;
      copyKeepsCache: boolean;
    }[] = [];
    let overwritten = false;
    let examined = 0;
    for (let index = root.arguments.length - 1; index >= 1; index--) {
      if (examined++ % 1024 === 0) yield;
      const source = root.arguments[index];
      if (source === undefined || t.isSpreadElement(source)) continue;
      inputs.push({ source, first, copyKeepsCache: !overwritten });
      if (
        (yield* spreadCacheFactSteps(
          source,
          spreadFacts,
          freshFacts,
          state,
        )) === "fresh"
      )
        overwritten = true;
    }
    return inputs;
  }
  if (t.isConditionalExpression(root))
    return [
      { source: root.consequent, first },
      { source: root.alternate, first },
    ];
  if (t.isLogicalExpression(root))
    return [
      { source: root.left, first },
      { source: root.right, first },
    ];
  const source = t.isSequenceExpression(root)
    ? root.expressions.at(-1)
    : t.isAssignmentExpression(root, { operator: "=" })
      ? root.right
      : undefined;
  return source === undefined ? [] : [{ source, first }];
}

type SpreadCacheFact = "fresh" | "possible" | "absent";

function* freshCacheReplacementSteps(
  node: t.Node,
  facts: WeakMap<t.Node, boolean>,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, boolean> {
  const pending: {
    readonly node: t.Node;
    phase: "visit" | "alias" | "binding" | "container";
    resultNode?: t.Node;
    bindingId?: string;
    children?: Generator<t.Node>;
    expression?: t.ArrayExpression | t.ObjectExpression;
    fresh?: boolean;
  }[] = [{ node, phase: "visit" }];
  const activeBindings = new Set<string>();
  let examined = 0;
  while (pending.length > 0) {
    if (examined++ % 1024 === 0) yield;
    const current = pending.at(-1);
    if (current === undefined) break;
    if (current.phase === "alias" || current.phase === "binding") {
      if (current.phase === "binding" && current.bindingId !== undefined)
        activeBindings.delete(current.bindingId);
      const fresh =
        current.resultNode !== undefined &&
        facts.get(current.resultNode) === true;
      facts.set(current.node, fresh);
      facts.set(unwrapJavaScriptExpression(current.node).node, fresh);
      pending.pop();
      continue;
    }
    if (current.phase === "container") {
      const child = current.children?.next();
      if (child === undefined || child.done) {
        const fresh = current.fresh === true;
        if (current.expression !== undefined)
          facts.set(current.expression, fresh);
        facts.set(current.node, fresh);
        pending.pop();
      } else if (facts.get(child.value) === false) {
        current.fresh = false;
      } else if (!facts.has(child.value)) {
        pending.push({ node: child.value, phase: "visit" });
      }
      continue;
    }
    if (facts.has(current.node)) {
      pending.pop();
      continue;
    }
    const expression = unwrapJavaScriptExpression(current.node).node;
    if (expression !== current.node && facts.has(expression)) {
      facts.set(current.node, facts.get(expression) ?? false);
      pending.pop();
      continue;
    }
    if (expression !== current.node) {
      current.phase = "alias";
      current.resultNode = expression;
      pending.push({ node: expression, phase: "visit" });
      continue;
    }
    if (t.isIdentifier(expression)) {
      const binding = resolveSemanticBindingState(
        state,
        expression,
        expression.name,
      );
      const initializer = semanticStableInitializer(binding, state);
      if (
        binding === undefined ||
        initializer === undefined ||
        binding.mutatedPaths.length > 0 ||
        binding.escapedPaths.length > 0 ||
        activeBindings.has(binding.bindingId)
      ) {
        facts.set(current.node, false);
        facts.set(expression, false);
        pending.pop();
        continue;
      }
      activeBindings.add(binding.bindingId);
      current.phase = "binding";
      current.bindingId = binding.bindingId;
      current.resultNode = initializer.node;
      pending.push({ node: initializer.node, phase: "visit" });
      continue;
    }
    if (
      t.isFunction(expression) ||
      t.isStringLiteral(expression) ||
      t.isNumericLiteral(expression) ||
      t.isBooleanLiteral(expression) ||
      t.isNullLiteral(expression) ||
      t.isRegExpLiteral(expression)
    ) {
      facts.set(current.node, true);
      facts.set(expression, true);
      pending.pop();
      continue;
    }
    if (!t.isArrayExpression(expression) && !t.isObjectExpression(expression)) {
      facts.set(current.node, false);
      facts.set(expression, false);
      pending.pop();
      continue;
    }
    if (t.isObjectExpression(expression)) {
      let unsupportedProperty = false;
      for (const property of expression.properties) {
        if (!t.isSpreadElement(property) && !t.isObjectProperty(property))
          unsupportedProperty = true;
        if (examined++ % 1024 === 0) yield;
      }
      if (unsupportedProperty) {
        facts.set(current.node, false);
        facts.set(expression, false);
        pending.pop();
        continue;
      }
    }
    current.phase = "container";
    current.expression = expression;
    current.children = freshContainerValues(expression);
    current.fresh = true;
  }
  return facts.get(node) === true;
}

function* freshContainerValues(
  node: t.ArrayExpression | t.ObjectExpression,
): Generator<t.Node> {
  if (t.isArrayExpression(node)) {
    for (const element of node.elements)
      if (element !== null)
        yield t.isSpreadElement(element) ? element.argument : element;
    return;
  }
  for (const property of node.properties)
    if (t.isSpreadElement(property)) yield property.argument;
    else if (t.isObjectProperty(property)) yield property.value;
}

/** Read later literal spread keys once; unknown keys never prove lost ownership. */
function* spreadCacheFactSteps(
  node: t.Node,
  facts: WeakMap<t.Node, SpreadCacheFact>,
  freshFacts: WeakMap<t.Node, boolean>,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, SpreadCacheFact> {
  const pending = [{ node, finish: false }];
  let examined = 0;
  while (pending.length > 0) {
    if (examined++ % 1024 === 0) yield;
    const current = pending.pop();
    if (current === undefined || facts.has(current.node)) continue;
    if (!t.isObjectExpression(current.node)) {
      if (t.isIdentifier(current.node)) {
        facts.set(current.node, "possible");
        continue;
      }
      facts.set(
        current.node,
        (yield* freshCacheReplacementSteps(current.node, freshFacts, state))
          ? "absent"
          : "possible",
      );
      continue;
    }
    if (!current.finish) {
      pending.push({ ...current, finish: true });
      for (const property of current.node.properties) {
        if (t.isSpreadElement(property))
          pending.push({ node: property.argument, finish: false });
        if (examined++ % 1024 === 0) yield;
      }
      continue;
    }
    let result: SpreadCacheFact = "absent";
    for (let index = current.node.properties.length - 1; index >= 0; index--) {
      const property = current.node.properties[index];
      if (property === undefined) continue;
      if (t.isSpreadElement(property)) {
        result = facts.get(property.argument) ?? "possible";
        if (result !== "absent") break;
      } else {
        const key = semanticStaticPropertyKey(property.key, property.computed);
        if (key === null) {
          result = "possible";
          break;
        }
        if (key === "f") {
          result =
            t.isObjectProperty(property) &&
            (yield* freshCacheReplacementSteps(
              property.value,
              freshFacts,
              state,
            ))
              ? "fresh"
              : "possible";
          break;
        }
      }
    }
    facts.set(current.node, result);
  }
  return facts.get(node) ?? "possible";
}

const joinOwnership = (
  previous: CacheOwnership | undefined,
  incoming: CacheOwnership,
): CacheOwnership => {
  if (previous === undefined) return incoming;
  const joined = {
    owner: previous.owner === incoming.owner ? previous.owner : null,
    first: previous.first === incoming.first ? previous.first : null,
    direct: previous.direct || incoming.direct,
    shared: previous.shared || incoming.shared,
  };
  return joined.owner === previous.owner &&
    joined.first === previous.first &&
    joined.direct === previous.direct &&
    joined.shared === previous.shared
    ? previous
    : joined;
};

const selectOwnership = (
  source: CacheOwnership | undefined,
  first: CacheKey,
): CacheOwnership | undefined => {
  if (source === undefined || first === undefined) return source;
  if (!source.shared) return undefined;
  return {
    owner: source.owner,
    first: source.first === undefined ? first : source.first,
    direct: true,
    shared: true,
  };
};

/** only the first owned key distinguishes the admitted cache from other members. */
const viteAliasSources = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  facts: ReadonlyMap<AliasVertex, CacheOwnership>,
  first: CacheKey = undefined,
): ReadonlyMap<string, CacheKey> => {
  const sources = new Map<string, CacheKey>();
  const pending = [{ node, first }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const { root, members } = electronMemberPath(current.node);
    const key = members.length === 0 ? current.first : members[0];
    if (t.isIdentifier(root)) {
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === undefined) continue;
      const member =
        key === undefined || key === null
          ? undefined
          : viteCacheMemberVertex(binding.bindingId, key);
      const source =
        member !== undefined && facts.has(member) ? member : binding.bindingId;
      const previous = sources.get(source);
      sources.set(source, sources.has(source) && previous !== key ? null : key);
    } else if (t.isConditionalExpression(root))
      pending.push(
        { node: root.consequent, first: key },
        { node: root.alternate, first: key },
      );
    else if (t.isLogicalExpression(root))
      pending.push(
        { node: root.left, first: key },
        { node: root.right, first: key },
      );
    else if (t.isSequenceExpression(root)) {
      const last = root.expressions.at(-1);
      if (last !== undefined) pending.push({ node: last, first: key });
    } else if (t.isAssignmentExpression(root, { operator: "=" }))
      pending.push({ node: root.right, first: key });
  }
  return sources;
};

const viteCacheMemberVertex = (binding: string, key: string): string =>
  `${binding}:vite-member:${encodeURIComponent(key)}`;
