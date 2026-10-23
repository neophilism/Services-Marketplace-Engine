# Realtime Job Room chat, receipts, and notifications

SME-026 adds tenant-audited communication to active Job Rooms. A caller must be a current room member and hold `job-rooms:chat` to create an immutable, request-key-idempotent message. Message bodies are trimmed, non-empty, and limited to 4,000 characters. The transactional store must persist the message and one notification intent for every other current room member atomically.

Notification intents contain only room, message, recipient, event, and time identifiers. They never copy message bodies. Email, push, SMS, websocket delivery, presence, typing state, edits, deletion, reactions, and channel-specific retry behavior remain outside this unit; durable delivery adapters remain assigned to SME-054.

A current recipient member holding `job-rooms:receipts` may record delivery and then advance it to read. Receipts are immutable request-key records, exact replays return the existing record, and the store must compare the prior receipt identifier atomically. Senders cannot acknowledge their own messages; read receipts cannot be downgraded or duplicated under a new request key.

Closed rooms, non-members, cross-tenant or cross-room records, contaminated or oversized membership rosters, conflicting request keys, duplicate opaque identifiers, audit failures, and failed atomic writes are rejected without disclosing which prerequisite failed. Attachments and private media remain SME-027.
