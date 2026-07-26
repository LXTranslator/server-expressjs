---
name: Server Side Request Forgery
description: Restrict outbound requests to a fixed provider registry in the LXTranslator server.
---

# Server Side Request Forgery

This server makes outbound HTTP requests to AI providers. That is the only
egress it performs, and it is the whole attack surface for this class.

## The defence

**Endpoints are compile time constants.** They are not read from the database,
not read from a request, and not read from the environment.

```js
// src/infrastructure/ai/providers/openai.js
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// src/infrastructure/ai/providers/anthropic.js
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

// src/infrastructure/ai/providers/openrouter.js
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
```

A project stores a provider **name**, which is resolved through a fixed registry
in `src/infrastructure/ai/providers/index.js`. A tampered database row can
select a different adapter but cannot introduce a new destination.

OpenRouter is a broker, so the vendor actually answering the call varies with
the model name. That does not widen the destination: the model is checked
against the adapter's fixed list before the call, and every request still leaves
for the one constant above. **A model name is never appended to a URL**, which
is what would turn the allowlist back into a path a caller controls.

## Rules

1. **Never add a configurable base URL.** Not through an environment variable
   and certainly not through the API. A settable base URL turns this server into
   a proxy for the internal network.
2. **The registry lookup uses `hasOwnProperty`.** A prototype key such as
   `constructor` cannot resolve to a function.
3. **Unknown provider names are rejected**, not defaulted, so a typo or a
   tampered row fails loudly.
4. **Every outbound request has a timeout.** An abort signal fires after
   `AI_REQUEST_TIMEOUT_MS`.
5. **No user supplied URL is ever fetched.** The application has no feature that
   accepts a URL and retrieves it. Do not add one without an allowlist and
   explicit blocking of loopback, link local and private ranges.

## If a new provider is added

- Hard code its endpoint as a constant.
- Register it in the registry object.
- Confirm it appears in `GET /providers` and that `translateWithKeyFallback`
  rejects any name outside the registry, as `tests/security.test.js` asserts.

## Deployment

Restrict egress at the network layer as well. The server needs outbound HTTPS to
the configured provider hosts and to SMTP; nothing else.
