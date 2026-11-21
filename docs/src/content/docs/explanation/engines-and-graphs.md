---
title: Engines and graphs
description: cambium's two engines, what a graph is, and why the workflows are moving onto graphs.
sidebar:
  order: 5
---

cambium can run its workflows two ways, chosen by `engine` in its config. The legacy engine is the original stage-by-stage tick. The graph engine expresses each workflow as a typed graph of nodes and edges. Both make the same moves for a task up to its PR; beyond that, only the graph engine does triage, merging, releases and rescue.

## Why graphs

The legacy engine encodes the task lifecycle as code paths in the tick: if the worker exited and a PR exists, mark it submitted; if CI is red, requeue; and so on. That works, but the shape of the workflow is only visible by reading the code.

A graph makes the shape data:

- **It can be drawn.** cambium publishes every graph in its heartbeat; canopy draws them and replays the last day's traffic over them. Nobody keeps a diagram up to date by hand.
- **It can be traced.** Each node visit becomes a span. An issue's trace reads intake → triage → each attempt → CI → close-out, across ticks and restarts.
- **It can be checked.** A graph with an unreachable node, or a node whose last edge has a condition and no fallback, is rejected when defined.
- **It can be extended.** Triage, the PR lifecycle, releases and rescue were each added as a new graph rather than more branches in the tick.

## Steps and waits

A graph has two kinds of node.

- A **step** runs and produces an output: start a worker, submit, requeue, close an issue.
- A **wait** polls something outside cambium's control: is the worker still running, is the PR still open. It answers "not ready" or "ready, with this output".

Edges are tried in order; the first whose condition holds is taken. A turn advances an issue through steps and ready waits until it reaches a wait that is not ready, or the end. Then it stops, and the next tick polls again. No turn ever blocks on an agent, and no span is held open across ticks.

## Labels are a projection

Each node declares which queue label an issue resting there carries, and whether it holds `running`. When an issue lands on a node, cambium writes the marker first and then sets labels to match the declaration. The labels on GitHub are therefore a projection of the graph position, not a separate state to keep in sync. A person reading labels sees the same thing as a person reading the graph drawing.

## Several small graphs, not one big one

The task graph ends when a worker has published a PR. From there the PR graph takes over: each tick it assesses every settled agent PR and takes at most one action — merge, rework, close, or hand to a person. Rework sends the issue back into the task graph with a fresh attempt budget.

Splitting the lifecycle this way keeps each graph easy to reason about and lets the PR graph treat any agent PR the same way, including ones adopted from a worker that was killed after publishing.

Triage (`dispatch`), the two release graphs and `rescue` are separate graphs for the same reason: each has one subject and one clear end.

## Versioned

Each graph has a version. When a graph changes shape, an issue whose marker rests on a node that no longer exists restarts at the entry with a `graph-changed` note, rather than being stuck on a phantom node. Moving nodes from one graph to another is handled explicitly: a marker at a node the PR graph now owns is the PR graph's, not a restart.

## Why the legacy engine remains

The graph engine has to make exactly the moves the legacy engine makes before it can replace it. A differential test runs every task scenario up to a PR's submission on both engines and compares their GitHub calls in order. Switching back to legacy while triage runs is safe; the graph engine picks up where it left off when switched again. Deleting the legacy path is planned once the graph engine is the default.

## Beyond cambium

The graph module is published as `@oakgreencc/cambium/graph`, so the same nodes-with-schemas, edges-as-data model can be used elsewhere. It converts to and from LangGraph: a cambium wait becomes a LangGraph interrupt, resumed with the poll's output. cambium's own runtime concerns — queue labels, leases, recovery — stay outside the conversion.

The node tables for each graph are in [Graphs](/reference/cambium/graphs/); the API is in [Graph module](/reference/cambium/graph-module/).
