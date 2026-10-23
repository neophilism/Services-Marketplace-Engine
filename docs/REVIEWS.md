# Reviews, responses, and disputes

`review-dispute.ts` defines the tenant-neutral trust contract for completed engagements.

## Review boundary

- A review requires `reviews:create`, an active tenant membership, and a completed engagement whose recorded customer is the authenticated subject.
- Exactly one immutable review may be recorded per engagement. Ratings are integers from 1 through 5 and comments are trimmed, non-empty, and bounded to 2,000 characters.
- Request keys provide exact idempotent replay. Reusing a key with changed content or attempting a second review fails closed.

## Provider response

- A response requires `reviews:respond` plus an active provider-operator binding for the provider named by the canonical review.
- Exactly one immutable, bounded response may be recorded for a review. Tenant, provider, subject, and review contamination is rejected.

## Dispute intake

- A dispute requires `reviews:dispute`. A customer must be the engagement's recorded customer; a provider actor must hold an active operator binding with the same permission.
- One open dispute may be created per review with a normalized reason, a bounded statement, and at most ten unique opaque evidence references. Evidence contents remain in the separately authorized attachment system.
- This unit records immutable intake only. Adjudication, reversals, moderation, and human oversight remain reserved for later planned units.

All attempts use the tenant authorization audit boundary. Invalid contract versions, malformed or cross-tenant records, audit outages, duplicate writes, and storage errors return `review_dispute_rejected` without accepting partial work.
