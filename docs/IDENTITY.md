# Identity sessions, MFA and passkeys

`IdentitySessions` is the engine's fail-closed passkey session boundary. The caller supplies durable credential storage, a cryptographic WebAuthn assertion verifier, a secure opaque-ID generator and a clock; the engine never implements cryptography or accepts passwords.

Authentication begins with a short-lived one-time challenge bound to an HTTPS origin and relying-party ID. Completion requires a non-revoked credential, verified user presence, exact challenge/origin/RP/credential binding and a strictly increasing authenticator signature counter. Successful completion advances the stored counter and issues a bounded session at the `mfa` authentication level.

Challenges are consumed before verification so failed assertions cannot be replayed. Unknown, expired, mismatched and revoked inputs all return `identity_denied`; no subject or credential existence is disclosed. Sessions support explicit revocation, subject-wide revocation and expiry. Production adapters must use a standards-compliant WebAuthn verifier, cryptographically secure random identifiers, durable transactional storage and rate limiting.
