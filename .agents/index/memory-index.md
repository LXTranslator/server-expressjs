---
name: memory-index
description: Index of server-expressjs agent memory — current repository state and the task records to load before resuming work.
---

# Memory Index — server-expressjs

Dynamic state, always local, never shared. Parent: [`root-index.md`](root-index.md).

This index is read at the start of **every** session — that is the standing exception to
the routing protocol. Load only the rows whose scope matches the current request, so you
continue prior work instead of restarting it.

Any file added to or removed from `.agents/memory/` is reflected in this index in the
same commit. Writing memory needs no approval.

## state/

| File | Scope — load when |
|---|---|
| [`../memory/state/repository-state.md`](../memory/state/repository-state.md) | You need the repository's current known state: what exists, the stack, what is not yet built, and the next obvious step. |

## tasks/

| File | Scope — load when |
|---|---|
| [`../memory/tasks/agents-setup.md`](../memory/tasks/agents-setup.md) | You are working on the instruction system itself, or need to know how this repository adopted the shared set. |
