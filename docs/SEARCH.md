# Search indexes and ranking

SME-019 defines a bounded, tenant-authorized search contract. Index writes derive public names, service titles, descriptions, revisions, and lifecycle state from canonical provider and service stores. A caller can add only normalized keywords and an integer quality score; it cannot forge canonical source fields.

Queries accept at most ten normalized terms, return at most 100 results, and inspect at most 5,000 tenant-bound documents. Ranking is deterministic and inspectable: matched-term coverage dominates, followed by exact title, provider-name, keyword, description, and bounded quality contributions. Public name and opaque document ID provide stable tie-breaking.

The result projection omits descriptions and internal persistence state. Duplicate IDs, cross-tenant records, malformed source snapshots, stale optimistic versions, inactive providers, unpublished services, audit failures, and store failures are rejected closed.

This unit does not implement availability, appointment slots, lead matching, notifications, public anonymous search, personalization, paid placement, geospatial ranking, or a user interface. Those remain later plan units.
