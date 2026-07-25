---
name: Unrestricted Resource Consumption
description: Bound every expensive operation in the LXTranslator server so one caller cannot exhaust it.
---

# Unrestricted Resource Consumption

Translation is expensive in three currencies at once: CPU, memory, and paid
vendor quota. Every one of them needs a ceiling.

## Ceilings in place

| Resource | Control | Default |
|---|---|---|
| Requests per address | `globalLimiter` | 300 per minute |
| Credential attempts | `authLimiter` | 10 per minute |
| Availability probes | `availabilityLimiter` | 20 per minute |
| Uploads | `uploadLimiter` | 20 per minute |
| Request body | `express.json` limit | 1 MB |
| Upload size | multer `fileSize` | 2 MB |
| Files per request | multer `files` | 1 |
| JSON nesting depth | `maxJsonDepth` | 20 |
| Translatable keys | `maxTranslationKeys` | 5000 |
| Strings per provider call | `AI_BATCH_SIZE` | 25 |
| Concurrent worker jobs | `WORKER_POOL_SIZE` | 2 |
| Worker job duration | `WORKER_TASK_TIMEOUT_MS` | 5 minutes |
| Provider request duration | `AI_REQUEST_TIMEOUT_MS` | 30 seconds |
| Retries per credential | `AI_MAX_ATTEMPTS_PER_KEY` | 2 |

## Rules

1. **The worker pool is bounded and queued.** An unbounded pool would let a
   burst of uploads exhaust memory and vendor quota simultaneously.
2. **Every outbound request carries an abort signal.** A vendor that stops
   responding must not hold a worker thread indefinitely.
3. **Uploads respond immediately.** Holding the HTTP connection open for the
   duration of a large translation would tie up a connection for minutes.
4. **Retries are bounded and backed off.** Two attempts per credential with
   exponential backoff, then the chain advances. There is no unbounded retry
   loop anywhere.
5. **The fallback chain stops on a malformed request.** A `REQUEST` category
   failure ends the walk rather than burning every remaining credential on a
   defect that would fail identically.

## When adding an expensive operation

Give it a limit before you merge it. Ask: what happens if one caller invokes
this a thousand times in a minute, and what happens if the thing it calls never
responds? Both answers must be bounded.

## Not yet implemented

Pagination on list endpoints. Projects, files and keys are naturally bounded per
namespace at the intended scale, but a growing deployment should add cursor
pagination to `GET /projects/:projectId/files` and
`GET /files/:fileId/translations` before those lists become large.
