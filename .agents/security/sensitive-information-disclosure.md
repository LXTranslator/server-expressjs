---
name: Sensitive Information Disclosure
description: Control what leaves the system in AI provider requests and in API responses.
---

# Sensitive Information Disclosure

## What is sent to a provider

Only the strings that need translating, plus the source and target locale codes.
Nothing else. Specifically **not** sent:

- Account identifiers, email addresses or display names.
- Project names, file names or namespace names.
- Any other project's content.
- Any credential other than the one authenticating that request.

The prompt builder receives an array of strings and nothing more, which makes
this structural rather than a matter of discipline.

## Rules

1. **Never add context to a translation prompt.** It is tempting to send a
   project name or a filename as "context for better translation". Doing so
   sends customer metadata to a third party. Do not.
2. **The credential goes in a header, never in a body or a URL.** A URL reaches
   proxy logs and browser history.
3. **A vendor error body is logged, never returned.** It can echo request
   content back.
4. **Uploaded content is customer data.** It may contain anything the customer
   put in it. Treat locale files as confidential: never log their contents,
   never include them in an error message.
5. **Choosing a provider is a data processing decision.** The offline `mock`
   provider sends nothing anywhere and is the default. Selecting a network
   provider means locale strings leave the system; that belongs in the
   deployment's data processing record.

## What is returned to clients

- Serialisation is an allowlist per model, so a new column cannot leak by
  existing.
- `password_hash` appears in no serializer.
- `api_key` is excluded from every default query; responses carry only a mask.
- Errors return generic text unless the application raised them deliberately.
- The stack trace appears in a response only outside production.

## Verification

`tests/security.test.js` asserts that a stored credential never appears in any
response body and that the stored column is ciphertext.
