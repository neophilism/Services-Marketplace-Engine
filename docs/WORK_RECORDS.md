# Timesheets, materials, and inventory

SME-032 records a technician's completed work interval and material consumption as one tenant-bound operation. The caller must remain the active provider member assigned to the referenced technician task in an active Job Room. Intervals are bounded to twenty-four hours, cannot end in the future, and must not overlap another stored interval for that membership. Duration is derived from timestamps rather than trusted from the client.

Material lines are optional, ordered, unique by inventory item, and use positive integral quantities. Every inventory item must be active, belong to the assigned provider membership, have sufficient stock, and match the caller's expected revision. The store must atomically recheck interval overlap and every inventory revision, decrement all items, advance their revisions, and append the immutable work record. A conflict or partial persistence failure rejects the entire operation.

Request keys are tenant-scoped. Exact retries return the stored record; changed intervals, tasks, or material lines fail closed. Membership rebinding, closed rooms, reassigned tasks, contaminated stored values, stale inventory, insufficient stock, and audit failures are rejected. Payroll, pricing, invoicing, change orders, subcontractor delegation, offline drafts, and inventory replenishment workflows belong to later plan units.
