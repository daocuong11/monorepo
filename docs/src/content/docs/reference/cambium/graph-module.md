---
title: Graph module
description: The @oakgreencc/cambium/graph API for typed workflows, and its LangGraph interop.
sidebar:
  order: 7
---

`@oakgreencc/cambium/graph` defines typed workflows: nodes with schemas, edges as data, and a loop that advances a position through them. cambium's own graphs are built on it. Status: preview.

## Example

```js
import { z } from 'zod'
import { advance, defineGraph, defineNode, defineWait, END, toMermaid } from '@oakgreencc/cambium/graph'

const Pr = z.object({ pr: z.number() })
const open = defineNode({
  name: 'open-pr',
  input: z.object({ issue: z.number() }),
  output: Pr,
  run: async (i, ctx) => ({ pr: 1 }),
})
const ci = defineWait({
  name: 'ci',
  input: Pr,
  output: z.object({ pr: z.number(), green: z.boolean() }),
  poll: async ({ pr }, ctx) => (done ? { ready: true, output: { pr, green } } : { ready: false }),
})
const g = defineGraph({
  name: 'demo',
  version: 1,
  entry: { queue: 'q:task', node: 'open-pr' },
  nodes: [open, ci],
  edges: [
    ['open-pr', 'ci'],
    ['ci', END, (out) => out.green],
    ['ci', 'open-pr', null, (out) => ({ issue: out.pr })],
  ],
})
const { transitions, reason, node, input } = await advance(g, { node: 'open-pr', input: { issue: 7 } }, ctx)
```

## Exports

| Export                                   | Description                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `defineNode({ name, input, output, run })` | A step node. `run(input, ctx)` returns the output.                                                                               |
| `defineWait({ name, input, output, poll })` | A wait node. `poll(input, ctx)` returns `{ ready: false }` or `{ ready: true, output }`.                                       |
| `defineGraph({ name, version, about?, entry, nodes, edges })` | A graph. Throws on any `validateGraph` problem.                                                   |
| `END`                                    | Edge target that ends the graph.                                                                                                    |
| `validateGraph(graph)`                   | Returns every problem as a string.                                                                                                  |
| `advance(graph, { node, input }, ctx, opts?)` | Runs step nodes and ready waits.                                                                                               |
| `toMermaid(graph)`                       | A Mermaid flowchart: boxes for steps, hexagons for waits, conditional edges labelled with `when`'s function name.                   |
| `describeGraph(graph)`                   | The graph as plain JSON (shape in [Heartbeat](/reference/cambium/heartbeat/#graphs)).                                               |
| `GraphNodeError`                         | Thrown on a schema failure; names the node, the phase and the schema issues.                                                        |

## Schemas

`input` and `output` accept any [Standard Schema](https://standardschema.dev) (zod v4 in cambium). Input is validated before `run`/`poll`, output after.

## Edges

`[from, to, when?, map?]`, tried in order.

- The first edge whose `when(output, subject)` is true, or that has no `when`, wins.
- `map(output, subject)` builds `to`'s input; default identity.
- `to` may be `END`. A node with no outgoing edges also ends the graph.

## `validateGraph` problems

- Unknown edge endpoints.
- Nodes unreachable from `entry.node`.
- A node with outgoing edges whose last edge is conditional (no fallback).
- Duplicate names.
- A non-integer `version`.

## `advance`

Options: `{ maxTransitions = 8, signal, instrument }`.

Returns `{ transitions, reason, node, input, error? }`:

| `reason`  | Meaning                                                   |
| --------- | --------------------------------------------------------- |
| `waiting` | Stopped at a wait that is not ready.                      |
| `end`     | Graph ended.                                              |
| `limit`   | `maxTransitions` reached.                                 |
| `aborted` | `signal` or `ctx.signal`, checked before each node.       |
| `error`   | A node failed; see `error`.                               |

`node` and `input` are where it stopped. Each transition is `{ from, to, edge, input, output, next }`. `ctx` is passed to `run`/`poll` untouched apart from `ctx.signal`; edges see `ctx.subject`.

`instrument(visit, step)` wraps each node visit. `visit` is `{ node, kind: 'node' | 'wait', input }`. `step(extraCtx?)` runs the node and picks the edge, returning the transition, or `null` for a wait that is not ready; it throws on a node error. `extraCtx` is merged into the node's `ctx`. The wrapper returns what `step` returned.

## LangGraph interop

`@oakgreencc/cambium/graph/langgraph`. LangGraph is an optional peer dependency: install `@langchain/langgraph` and `@langchain/core` separately.

```js
import { Command, MemorySaver } from '@langchain/langgraph'
import { fromLangGraph, pollWait, toLangGraph } from '@oakgreencc/cambium/graph/langgraph'

const app = (await toLangGraph(g)).compile({ checkpointer: new MemorySaver() })
const config = { configurable: { thread_id: 'owner/repo#42' }, context: ctx }
let out = await app.invoke({ subject, last: { issue: 7 } }, config)
const waiting = out.__interrupt__?.[0]?.value // { waiting: 'ci', input: { pr: 1 } }
const polled = await pollWait(g, waiting, ctx)
if (polled.ready) out = await app.invoke(new Command({ resume: polled.output }), config)
```

| Export                                          | Description                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `toLangGraph(graph, { langgraph }?)`            | Resolves to an uncompiled `StateGraph` over `{ subject, last, outputs }`. Imports LangGraph when called, or takes the module.       |
| `pollWait(graph, waiting, ctx)`                 | Runs a wait's poll for an interrupt value.                                                                                          |
| `fromLangGraph(compiled, { name, input, output })` | A `defineNode` whose `run` invokes the compiled graph and validates the final state against `output`.                            |

- State: `last` is the next node's input; `outputs` each node's latest output by name; `subject` what edges see (checkpointed, so serialisable).
- A wait calls `interrupt({ waiting, input })`. Resume with the ready poll's `output`.
- Edges become `addConditionalEdges`; `END` is LangGraph's `END`. Errors are `GraphNodeError`s.
- An imported graph cannot wait: `interrupt()` inside `fromLangGraph` fails the node.
- Not carried over: `entry.queue`, `version`, and cambium's per-node declarations (`queue`, `running`, `enter`, `pollOnEntry`, `recover`).
