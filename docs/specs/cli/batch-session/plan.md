# Implementation plan

1. Validate JSON call records, IDs and conflicting options at the CLI boundary.
2. Lazily compose one production session and MCP server. Connect an SDK client
   through InMemoryTransport, so canonical registration, parsing, execution,
   Evidence delivery and cancellation remain identical to MCP.
3. Await each call and output write before advancing. Keep only the current
   result. Use canonical JSON serialization with backpressure; file outputs use
   exclusive creation and safe filenames. Do not return a second CLI document.
4. In finally, settle SDK server work and close server, client, optional
   observation resources and BinarySession; project typed cleanup failures.
5. Cover compiled CLI file/stdin calls, shared native sessions with real Ghidra,
   errors, duplicate/path IDs, stop/continue, output collisions and cancellation.
   Measure equivalent multi-query sessions; distinguish synthetic timing from
   real-provider costs. Run static, discovery and documentation checks.

## Executed validation

On upstream `3620074b3`, Node 24.18.0 and darwin/arm64:

- 18 CLI/session and tool-coverage tests passed; static checks and discovery
  passed (1,168 test files, each discovered once).
- Real Ghidra 12.1.4 verified equivalent results, one open followed by three
  calls, saved snapshot, immutable target bytes and empty owned runtime.
- Three standalone imports took 44.645 seconds; the batch took 16.775 seconds.
  Host-cache warming makes this an illustrative run, not a controlled speed
  benchmark. CPU totals were 77.41 user / 5.26 system seconds versus
  29.76 / 2.00 seconds. Peak individual RSS was 1.42 GB versus 1.18 GB;
  process-family peak memory was not measured.
- Output-only token estimates were 9,489 versus 9,787, including the batch
  open record and metadata. Live model/input-schema tokens were not measured.
- `docs:check` is blocked by unchanged Greek README link drift tracked in
  https://github.com/morluto/rea/issues/3022.
- Full package verification passed, including archive/install, CLI, MCP,
  setup/uninstall and verified empty process lineage.
