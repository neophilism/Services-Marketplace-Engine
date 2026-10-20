# ADR-001: Standalone domain-neutral engine boundaries

Status: Accepted

## Context

The engine must serve multiple service marketplaces and is an upstream prerequisite for Get Docked. Allowing a dependent application or one industry's terminology into core contracts would reverse the dependency and prevent reuse.

## Decision

The repository owns domain contracts, application services, API adapters, workers, persistence adapters, and operational tooling. HTTP, queue, storage, payment, and notification providers sit behind adapters that depend inward on versioned domain contracts. Dependent applications consume published contracts and may not be imported by the engine. Core schemas and examples remain industry-neutral.

## Enforced consequences

The architecture registry records forbidden dependent-application imports and domain-specific core terms as negative cases. Later workspace and boundary checks must fail when either appears. Deployment, credentials, storage, and release evidence remain owned by this repository.
