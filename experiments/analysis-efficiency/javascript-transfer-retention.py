"""Opt-in macOS CLI process-family comparison; see javascript-transfer-retention.md."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def cpu_seconds(value):
    parts = value.split(':')
    return sum(float(part) * 60 ** index for index, part in enumerate(reversed(parts)))


def sample(root_pid):
    rows = subprocess.check_output(
        ['ps', '-axo', 'pid=,ppid=,rss=,time='], text=True,
    )
    processes = {}
    for row in rows.splitlines():
        pid, parent, rss, cpu = row.split()
        processes[int(pid)] = (int(parent), int(rss) * 1024, cpu_seconds(cpu))
    family = {root_pid}
    while True:
        expanded = family | {pid for pid, row in processes.items() if row[0] in family}
        if expanded == family:
            break
        family = expanded
    return {pid: processes[pid] for pid in family if pid in processes}


def measure(command, output, environment):
    peak = 0
    cpu = {}
    actors = 0
    parent_at_peak = 0
    started = time.monotonic()
    with output.open('xb') as stdout, output.with_suffix('.stderr').open('xb') as stderr:
        with subprocess.Popen(command, stdout=stdout, stderr=stderr, env=environment) as process:
            while process.poll() is None:
                family = sample(process.pid)
                rss = sum(row[1] for row in family.values())
                if rss > peak:
                    peak = rss
                    parent_at_peak = family.get(process.pid, (0, 0, 0))[1]
                actors = max(actors, len(family))
                for pid, row in family.items():
                    cpu[pid] = max(cpu.get(pid, 0), row[2])
                time.sleep(0.05)
            code = process.wait()
    return {
        'exit_code': code,
        'elapsed_seconds': round(time.monotonic() - started, 3),
        'sampled_family_cpu_seconds': round(sum(cpu.values()), 3),
        'sampled_peak_family_rss_bytes': peak,
        'parent_rss_at_family_peak_bytes': parent_at_peak,
        'max_sampled_actors': actors,
        'output_bytes': output.stat().st_size,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control', type=Path, required=True, help='Built 8x checkout root')
    parser.add_argument('--candidate', type=Path, required=True, help='Built 5x checkout root')
    parser.add_argument('--output', type=Path, required=True, help='New retained lab directory')
    parser.add_argument('--node', required=True, help='Absolute pinned Node executable')
    parser.add_argument('--case', action='append', help='Run only these named cases')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This sampler uses macOS ps RSS/time units; use a Linux cgroup meter there')
    args.output.mkdir(parents=True, exist_ok=False)
    cases = {
        'default-calls': (1, False, 'calls'),
        'raised-calls': (1, True, 'calls'),
        'raised-bindings': (1, True, 'bindings'),
        'raised-multi': (3, True, 'calls'),
        'raised-multi-small': (3, True, 'small-calls'),
    }
    if args.case and set(args.case) - cases.keys():
        parser.error('Unknown case')
    receipts = []
    for name, (files, raised, shape) in cases.items():
        if args.case and name not in args.case:
            continue
        fixture = args.output / name
        fixture.mkdir()
        hashes = {}
        for index in range(files):
            if shape in ('calls', 'small-calls'):
                source = ''.join(
                    f'export function f{i}(v){{const x = v.map(n => n + {i}); '
                    f'fetch("https://example.test/{i}", {{method:"POST",body:JSON.stringify(x)}}); '
                    'return x.filter(n => n > 3);}\n'
                    for i in range(1000 if shape == 'small-calls' else 12000)
                )
            else:
                source = ''.join(
                    f'export const v{i} = {{name:"item-{i}", nested:{{id:{i}, '
                    f'tags:["alpha","beta"]}}}};\n'
                    for i in range(24000)
                )
            path = fixture / f'file{index}.mjs'
            path.write_text(source)
            hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        # ABBA order. Every invocation has a cold process/JIT; repeat means
        # potentially warmed OS caches, not a persistent warm MCP session.
        for variant, repeat in [('control', 1), ('candidate', 1), ('candidate', 2), ('control', 2)]:
            root = getattr(args, variant).resolve()
            command = [args.node, str(root / 'scripts/rea.mjs'),
                       'analyze-javascript-application', str(fixture), '--format', 'json']
            if raised:
                command += ['--max-semantic-nodes', '1000000',
                            '--max-semantic-nodes-per-file', '100000']
            output = args.output / f'{name}-{variant}-{repeat}.json'
            environment = {**os.environ, 'NODE_OPTIONS': '--max-old-space-size=3072'}
            receipt = {'case': name, 'variant': variant, 'repeat': repeat,
                       'source_sha256': hashes, 'command': command,
                       'parent_node_options': environment['NODE_OPTIONS'],
                       **measure(command, output, environment)}
            assert receipt['exit_code'] == 0, output.with_suffix('.stderr').read_text()
            evidence = json.loads(output.read_bytes())
            result = evidence['normalized_result']
            graph = result['semantic_graph']
            receipt['statistics'] = result['statistics']
            assert result['statistics']['parse_failures'] == 0
            receipt['retained'] = {key: len(graph[key]) for key in
                                   ['nodes', 'relations', 'unknowns', 'fingerprints']}
            receipt['coverage_status'] = graph['coverage']['status']
            receipt['coverage_limits'] = graph['coverage']['limits']
            del evidence, result, graph
            receipts.append(receipt)
            (args.output / 'receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
            print(json.dumps(receipt), flush=True)


if __name__ == '__main__':
    main()
