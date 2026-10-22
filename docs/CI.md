# Continuous integration contract

Every push and pull request must pass two independent jobs after a frozen `npm ci` install:

- `static` validates the canonical 67-unit registry and its accepted architecture decisions, then checks first-party text hygiene and workspace dependency boundaries.
- `test` compiles every strict TypeScript project reference and runs the complete Node test suite, including API and worker authorization-negative cases.

Registry validation requires dependencies to point backward in plan order, real PR numbers to map to exactly one unit, observed PR records to match those mappings, and merged units to record a 40-character merge commit plus exact-head, merged-main, and PR-link evidence. Static policy keeps the shared contract package independent from application adapters and rejects industry-specific core terminology, cross-adapter imports, committed build output, malformed JSON, CRLF, tabs, and missing final newlines.

Run the same gates locally with `npm ci && npm run check`. CI must not replace the frozen install, suppress a failing test, or weaken a policy to obtain a passing result.
