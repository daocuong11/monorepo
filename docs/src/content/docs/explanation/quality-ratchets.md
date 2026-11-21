---
title: Quality ratchets
description: Why canker and deadwood exist, what they measure, and why their baselines can only shrink.
sidebar:
  order: 8
---

Agents write a lot of code, quickly. Review catches some problems; gates in the verify command catch others before review starts. canker and deadwood are two such gates, aimed at problems agent-written code is prone to, and both are built to be adopted in a codebase that already has the problem.

## canker: complex and untested

canker scores every function with CRAP (Change Risk Anti-Patterns):

```
CRAP = complexity² × (1 − coverage)³ + complexity
```

The formula is forgiving in two directions. A complex function is fine when the tests run it; coverage drives the first term towards zero. An untested function is fine when it is simple; the score is then roughly its complexity. canker fails only when a function is both.

That matches how risk actually works. A ten-branch function with full coverage is unlikely to hide a surprise; a two-line getter without tests is unlikely to need one. The function to worry about is the branchy one nobody runs, and that is the one canker names.

Scoring per function, rather than per file or per project, keeps the signal sharp. A project-wide coverage percentage can rise while the riskiest function stays untested.

## deadwood: prose where it does not belong

deadwood checks two things over the files git tracks.

- **Stray Markdown.** A Markdown file outside an allowlist fails. Agents readily write notes, plans and summaries as files; left alone, they accumulate into documentation nobody maintains and which drifts from the code.
- **Comment density.** A source file fails when comments exceed a share of its lines (15% by default). Heavy commenting often restates what the code says, and goes stale when the code changes. Directives, type-only JSDoc and the shebang are not counted, so the measure targets prose.

Both checks look only at tracked files, so generated and ignored files never count.

## Ratchets, not cliffs

A new gate on an old codebase usually fails on day one, and a gate that fails on day one tends to be switched off. Both tools avoid that with a **baseline**: a file recording today's offenders, which then pass.

The baseline is a ratchet. It can only move one way:

- A new offender fails.
- A baselined offender that gets worse fails.
- A baselined offender that improves passes, and the update command lowers its entry.
- Neither tool's update command ever adds an entry or raises one.

So the codebase can only get better. Nobody has to fix the backlog before adopting the gate; every change simply has to leave things no worse than they were.

canker keys baseline entries by file and function name rather than line number, so an edit above a function does not orphan its entry.

## Owned by a person

Growing a baseline is the one way around a ratchet. Owning the baseline file in CODEOWNERS puts that decision with a person: an agent that wants to add an offender must ask, and the reason is on record. This is the same pattern as the rest of the stack — local tools catch problems early, and the deliberate exceptions go through a human. See [The boundary and the tripwires](/explanation/boundary-and-tripwires/).

## Cheap to run

Both gates are designed to sit in the verify command without slowing it. canker reads the coverage the tests already write, so in Nx a cached test run restores the coverage and canker replays from cache too. deadwood has no dependencies and runs over the git file list.

Setup is in [Add the CRAP gate](/how-to/add-the-crap-gate/) and [Add the prose gate](/how-to/add-the-prose-gate/).
