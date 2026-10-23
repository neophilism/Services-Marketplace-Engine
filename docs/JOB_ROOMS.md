# Job Room membership and invitations

SME-025 defines invitation-based access to an existing active Job Room. An inviter must be an active room member with `canInvite` and must also pass the tenant-audited `job-rooms:invite` authorization check. Invitations are immutable, request-key idempotent, limited to one pending invitation per room and subject, and expire within fourteen days.

Only the named subject may accept an unexpired invitation. Acceptance requires `job-rooms:join` and atomically creates one non-inviting membership plus an immutable acceptance record. A provider-role invitee must also be an active operator for the room's provider with current `job-rooms:join` standing. Customer collaborators are bound by the invitation and tenant membership.

Exact invitation and acceptance replays return the existing record. Conflicting keys, cross-tenant records, closed rooms, existing members, duplicate pending invitations, expired invitations, inactive provider operators, audit failures, and non-atomic persistence failures are rejected.

Room creation, chat, receipts, notifications, attachments, estimates, scheduling, payments, and application-specific behavior remain outside SME-025.
