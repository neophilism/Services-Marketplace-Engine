# Disputes, reversals, and human oversight

SME-036 lets either exact active party to a completed Job Room open an immutable, tenant-bound dispute with a bounded reason, statement, and ordered evidence references. Request keys replay only when every material field and current party binding match.

Resolution requires a separately authorized, active, human-verified reviewer who is not the dispute opener. A resolution is revision-fenced and atomically closes the dispute while recording the reviewer, outcome, rationale, and any exact completion or milestone-acceptance reversal directive. An upheld outcome cannot request a reversal.

The contract records an oversight decision; it does not move money, mutate prior completion or milestone evidence, or grant payment-adapter authority. Downstream adapters must apply a recorded directive under their own authorization, ledger, and reconciliation controls. Cross-tenant data, inactive or rebound identities, self-review, automated reviewers, stale revisions, conflicting replays, malformed evidence, audit failure, and partial persistence all fail closed.
