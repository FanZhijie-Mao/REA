# CLI calls sharing one session

Issue: https://github.com/morluto/rea/issues/2927

## Requirements and acceptance

`rea batch calls.json` or `rea batch -` accepts an ordered JSON array of unique
`{id, tool, arguments}` records using the existing MCP names and schemas. Open
the target through an explicit `open_binary` call or `--target PATH` and optional
`--provider`. Reuse one production BinarySession and the existing server registry
for every call. Preserve canonical structured success values once with MCP
metadata, original tool error documents, Evidence, provenance and request
cancellation. Emit each completed call immediately as a
JSONL record with its ID, tool, status and duration. `--out DIR` instead writes
one file per portable ID without overwriting existing files. Default to stopping
on the first failed call; `--continue` processes later calls but still exits 1.
`--stop-on-error` explicitly selects the default; conflicting policies fail.

Parse and validate the entire list, IDs and options before creating resources.
SIGINT/SIGTERM cancel the current request, settle provider work, and close every
owned resource. Report cleanup failure rather than converting it into success.
Optional `--snapshot PATH` saves the canonical analysis snapshot before close.

## Authority and non-goals

Reuse the current MCP dispatcher and canonical tool contracts, including their
target/authority checks. There are no new providers or raw execution paths, no
parallel calls, implicit retries, target launching, LLM calls or network listener.
Each explicitly selected tool retains its existing documented effects. Batch
calls do not persist a session between separate CLI processes. Output uses a
fixed JSONL/file contract rather than per-call human presentation controls.
