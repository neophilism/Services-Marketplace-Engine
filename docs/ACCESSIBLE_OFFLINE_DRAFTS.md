# Accessible offline drafts

SME-037 synchronizes offline Job Room drafts as ordered, labeled plain-text fields with an explicit language tag. A draft belongs to the exact active room membership that first syncs it; closed rooms, rebound identities, unlabeled fields, duplicate field identifiers, control characters, and unbounded content are rejected.

Each offline edit carries an immutable client edit identifier and an expected server revision. The store must atomically compare-and-set the prior draft with its sync receipt. Request-key replay succeeds only for the same edit and owner after that revision is durable; stale or conflicting edits fail closed so clients can present a merge workflow without silently losing work.

This contract supplies storage and accessibility-safe data semantics, not a claim that a particular user interface is accessible. Rendering clients remain responsible for semantic controls, focus, contrast, keyboard and assistive-technology testing.
