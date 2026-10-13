# JavaScript transfer retention measurements

Addresses the process-family measurement finding in
[PR #2097](https://github.com/morluto/rea/pull/2097#discussion_r4258728157).
The 5x admission charge is a heuristic retention estimate. Arithmetic assertions
and parent-only RSS cannot establish a process-family memory bound.

## Frozen comparison

Measured on 2026-10-14, macOS 26.3 (25D125), Apple M5, 10 logical CPUs,
24 GiB RAM, Node 24.18.0, with the PR's locked dependencies installed by
`npm ci`. Both variants start from `264e48443ec15f80bacb0d79f0001e1a9d7bad61`.
The control changes only `TRANSFER_RETENTION_MULTIPLIER` from 5 to 8 before
building, restoring both retention charging and the paired stream divisor.
The candidate uses the pinned PR unchanged. Later edits clarify documentation
and test comments; they do not alter runtime behavior.

Compiled file-table SHA-256 values (sorted relative `dist/` path, NUL, file
SHA-256, newline, then SHA-256 of that table):

- Control: `553cbc044c00679cb0493d7f0dd5a5fb507be8c1bf13f8919a5c8d59feb275a7`.
- Candidate: `dd34cbd678126468d5afff88f13e9aac5518002e126abc280da30bd80f073bf7`.

Every CLI process uses `NODE_OPTIONS=--max-old-space-size=3072`. The analysis
worker uses the unchanged default 1024 MiB heap and 300000 ms per-file deadline.
Default semantic capacities are 100000 application / 20000 per file; raised
cases request 1000000 / 100000. The complete unfiltered JSON is redirected to a
file, exercising adoption, sealing, Evidence validation/digest and CLI output.
No target code executes.

The [driver](javascript-transfer-retention.py) generates self-owned sources:

- Calls: 12000 exported functions with map/filter callbacks, a fetch and JSON
  serialization; 1958670 source bytes, 504002 visited AST nodes per file.
  File SHA-256: `b794517208ab6b46a6a4ee4a230141f781b51e2c7865c7d6d9f827cf93166f11`.
- Bindings: 24000 exported nested objects with strings, numbers and arrays;
  2006670 source bytes, 456002 visited AST nodes.
  File SHA-256: `f89894ae94db3a3e79e75accba23687069fcca13a32d3cccc69cd14089bf3f0f`.
- Multi: three separately named copies of the calls source. This exercises
  accumulated parent facts and sequential reuse of the producer.
- Multi-small: three files with 1000 of the same exported functions each,
  exercising sealing of several admitted projections. Each file is 159670
  bytes with 42002 visited AST nodes and SHA-256
  `b99d1ca9bbfe9cefd9c46277f3812827c7ecf9295d49e9ac9e5daabdc7f234f2`.

Each case runs control 1, candidate 1, candidate 2, control 2, serially. All
processes/JITs start cold. Repeat 2 is a warm-filesystem repeat, with OS caches
uncontrolled; it is not a warm MCP session. Later files in the multi case use
the already running worker. Builds and fixture generation are outside timing.

## Measurement method and limits

The macOS sampler reads `ps` for the direct CLI PID and recursive descendants
until CLI exit, sleeping 50 ms between snapshots. Peak memory is the maximum
sum of simultaneous RSS values, including worker/helper processes. CPU is the
sum of each observed PID's maximum cumulative user+system time. Both are
**sampled estimates**: short-lived actors and terminal CPU increments may be
missed. RSS can double-count shared pages and excludes nonresident/swap memory;
there is no kernel process-family high-water mark here. The sampler and
post-run JSON inspection are outside the measured family. Host load is not
isolated. These measurements do not establish a speed improvement or a hard
memory ceiling.

Measured workflows invoke no model: model calls and model tokens are zero.
CLI output token counts, model-driven selection/retries, persistent warm MCP
retention, Linux/Windows/Bun behavior, near-8-MiB individual records and the
2-GiB transport ceiling are unmeasured. Output bytes below describe coverage
and serialization volume; they are not token counts. Authoring-session tokens
are unavailable and excluded from these deterministic workflow measurements.

## Completed workflow results

Every run exits 0 with no syntax parse failures. Pairs below are first fresh
process / warm-filesystem repeat; CPU and peak RSS retain the sampling caveats
above. RSS is in GiB (2^30 bytes).

| Case               | Policy | Elapsed seconds, 1 / 2 | Family CPU seconds, 1 / 2 | Peak family RSS GiB, 1 / 2 |
| ------------------ | ------ | ---------------------: | ------------------------: | -------------------------: |
| default-calls      | 8x     |        16.315 / 19.788 |             18.59 / 24.61 |              1.499 / 1.475 |
| default-calls      | 5x     |        16.213 / 19.761 |             18.82 / 24.34 |              1.501 / 1.462 |
| raised-calls       | 8x     |        19.997 / 19.190 |             24.64 / 22.01 |              1.497 / 1.442 |
| raised-calls       | 5x     |        26.883 / 28.633 |             30.80 / 34.80 |              1.770 / 1.612 |
| raised-bindings    | 8x     |        22.580 / 24.148 |             26.04 / 27.58 |              1.476 / 1.655 |
| raised-bindings    | 5x     |        24.777 / 22.001 |             26.15 / 25.06 |              1.362 / 1.387 |
| raised-multi       | 8x     |        24.301 / 28.603 |             29.91 / 30.35 |              1.415 / 1.401 |
| raised-multi       | 5x     |        36.347 / 33.001 |             39.62 / 37.57 |              1.687 / 1.651 |
| raised-multi-small | 8x     |        16.209 / 15.657 |             19.18 / 18.65 |              1.056 / 1.311 |
| raised-multi-small | 5x     |        18.640 / 19.127 |             21.98 / 22.00 |              1.335 / 1.320 |

Counts and output sizes are stable across the two repeats:

| Case               | Policy |   Nodes | Relations | Unknowns | Fingerprints | Output bytes |
| ------------------ | ------ | ------: | --------: | -------: | -----------: | -----------: |
| default-calls      | both   |  20,000 |         0 |   84,000 |       19,999 |  112,215,255 |
| raised-calls       | 8x     |       1 |         0 |       12 |            0 |   17,878,988 |
| raised-calls       | 5x     | 100,000 |         0 |  144,000 |       36,000 |  237,928,606 |
| raised-bindings    | both   | 100,000 |    75,999 |        0 |            0 |  218,150,832 |
| raised-multi       | 8x     |       3 |         0 |       36 |            0 |   22,209,585 |
| raised-multi       | 5x     | 100,002 |         0 |  144,024 |       36,000 |  242,259,544 |
| raised-multi-small | 8x     |  76,003 |    50,000 |   24,012 |        6,000 |  139,882,799 |
| raised-multi-small | 5x     | 114,003 |    75,000 |   36,000 |        9,000 |  197,009,163 |

The raised calls case reproduces admission refusal at 8x and useful retained
coverage at 5x. The 5x process-family peak includes roughly 0.93–0.97 GiB of
concurrent descendant RSS beyond the parent's 0.68–0.80 GiB at that peak; relying
on parent RSS alone would omit much of this workflow's resident memory. In the
binding-heavy case the sampled peak contains only parent RSS during
result handling; the shape has substantial retained relations rather
than unknowns/fingerprints. Both parts of the lifecycle must be measured.

Large multi-file coverage remains partial: after admitting the first projection,
5x reports exhausted semantic result capacity for subsequent sources. The 8x
control refuses the first graph as well. Earlier facts survive and all files
retain explicit coverage limits. The increased elapsed time and output volume
buy additional coverage; these are equivalent requests with different retained
results, not evidence of a speed or memory reduction. All large cases also
retain their explicit semantic node ceiling limitations.

In multi-small, 5x admits all three projections and seals their combined
114003 nodes and 75000 relations; 8x admits two and refuses the third. The 5x
coverage status remains `unknown` because static relationships include
unresolved facts, with no resource limits reported. This covers multi-file
sealing as well as the large case's capacity exhaustion.

These observations support keeping 5x for the measured record mixes, with
independent worker limits and the parent's existing headroom. They do not prove
that all possible records expand by at most 5x. No new universal memory-bound
claim or limit increase follows from this experiment.

## Reproduction

Build two isolated checkouts of the pinned revision with `npm ci` and
`npm run build:cached`, using the pinned Node. Set the control's shared
multiplier to 8 before building; leave the candidate at 5. Keep each checkout's
`bridge/` directory alongside its runtime: macOS process ownership helpers
depend on those shipped sources. Then run:

```bash
python3 experiments/analysis-efficiency/javascript-transfer-retention.py \
  --control /absolute/control-checkout \
  --candidate /absolute/candidate-checkout \
  --node /absolute/node-24.18.0 \
  --output /absolute/new-lab-directory
```

The driver requires a new output directory and retains source fixtures, complete
stdout/stderr and `receipts.json`. It records only the explicitly selected
Node heap setting, not the inherited environment. Raw output files are large;
keep the lab outside Git. The local measured lab is
`/private/tmp/rea-pr-2097-measured-complete`; the additional multi-small pairs
are in `/private/tmp/rea-pr-2097-measured-small` (selected with
`--case raised-multi-small`).

## Validation

All 20 CLI workflows complete with exit 0 and zero syntax parse failures.
Within each case/policy pair, retained counts, statistics and output sizes
match across repeats. The four focused transfer-budget tests,
`npm run check:fast` and `npm run docs:check` pass. Provider verification here
is the real local static JavaScript CLI; no external analysis engine or
model-driven workflow is covered.
