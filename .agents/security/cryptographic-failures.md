---
name: Cryptographic Failures
description: Correct use of encryption and hashing for stored credentials, passwords and change tracking fingerprints.
---

# Cryptographic Failures

## What is protected and how

| Data | Mechanism | Location |
|---|---|---|
| Account passwords | bcrypt, cost 12 in production | `src/modules/auth/auth.service.js` |
| Provider API keys | AES 256 GCM, key derived with scrypt | `src/infrastructure/crypto/secretBox.js` |
| Action tokens at rest | SHA-256 digest of the token | `src/modules/auth/token.service.js` |
| Source change tracking | SHA-256 truncated to a UUID shape | `src/core/textHash.js` |

## Rules

1. **Passwords are hashed, never encrypted.** bcrypt with a per hash salt.
   Comparison goes through `bcrypt.compare`, never a string equality test.
2. **Stored credentials are encrypted with an authenticated cipher.** AES 256
   GCM, a fresh 96 bit initialisation vector per message, and a 128 bit tag.
   Tampering fails closed on decrypt rather than returning corrupted plaintext.
3. **Never reuse an initialisation vector.** `crypto.randomBytes` generates one
   per call. Identical secrets must never produce identical ciphertext.
4. **The wire format is versioned.** `v1:iv:tag:ciphertext`. A future algorithm
   change must add `v2` rather than reinterpret existing rows.
5. **The text hash is not a security primitive.** It exists to detect source
   changes. Never use it for authentication, signatures, integrity of anything
   security relevant, or password storage.
6. **Compare secrets in constant time.** Use `safeEquals`, which wraps
   `crypto.timingSafeEqual`, not `===`.
7. **Transport encryption is the deployment's responsibility.** Terminate TLS
   1.2 or newer in front of the server, and set `TRUST_PROXY=true` so the real
   client address is recorded.

## Known trade off

`secretBox` derives its key with a fixed application salt rather than a per
record salt. A per record salt would be stronger, but the salt would have to be
stored beside the ciphertext, which adds little against a database compromise.
The real secret is `ENCRYPTION_PASSPHRASE`, which lives outside the database.
This is documented at the top of the module; do not change it silently.

## Rotation

Changing `ENCRYPTION_PASSPHRASE` makes every stored key undecryptable. Rotation
requires decrypting with the old passphrase and re-encrypting with the new one
in the same operation. `loadDecryptedKeys` logs and skips a key it cannot
decrypt rather than failing the whole project, so a botched rotation degrades
instead of taking the service down.
