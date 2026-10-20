# ADR-002: Fail-closed tenant authorization

Status: Accepted

## Context

A marketplace stores customer, provider, job, payment, and communication data for multiple organizations. Filtering after a lookup risks disclosing whether another tenant's resource exists.

## Decision

Every tenant-owned resource carries an organization identifier. An application operation establishes an authenticated subject, active organization membership, and explicit permission before resource lookup. Missing tenant context, inactive or revoked membership, absent permission, and cross-tenant identifiers fail with the same non-disclosing denial. Background work carries signed tenant and actor context and rechecks authorization where user authority is material.

## Required negative evidence

Automated service tests must cover missing tenant context, inactive membership, revoked membership, absent permission, forged organization identifiers, and cross-tenant resource identifiers. Logs may record an internal denial reason but public responses cannot reveal foreign resource existence.
