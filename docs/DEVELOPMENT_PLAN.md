# Complete development PR plan

One planned stable work unit corresponds to one future implementation PR; `prs: []` means no PR exists yet. Record actual GitHub PR numbers only when GitHub creates them. A unit cannot be marked completed until full behavior and tests are accepted. Later work must not proceed ahead of prerequisites.

## Foundation

- **SME-001 — Architecture ADRs**. Depends on: none. Acceptance: Complete architecture adrs functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-002 — TypeScript workspaces API worker bootstrap**. Depends on: SME-001. Acceptance: Complete typescript workspaces api worker bootstrap functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-003 — CI static checks registry validation**. Depends on: SME-002. Acceptance: Complete ci static checks registry validation functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-004 — Postgres migrations and rollback**. Depends on: SME-003. Acceptance: Complete postgres migrations and rollback functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-005 — OpenAPI contracts SDK generation**. Depends on: SME-004. Acceptance: Complete openapi contracts sdk generation functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-006 — Identity sessions MFA passkeys**. Depends on: SME-005. Acceptance: Complete identity sessions mfa passkeys functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-007 — Organizations memberships RBAC**. Depends on: SME-006. Acceptance: Complete organizations memberships rbac functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-008 — Tenancy boundary audit logs**. Depends on: SME-007. Acceptance: Complete tenancy boundary audit logs functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-009 — Outbox queues idempotency**. Depends on: SME-008. Acceptance: Complete outbox queues idempotency functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-010 — Object storage attachment scanning**. Depends on: SME-009. Acceptance: Complete object storage attachment scanning functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
## Marketplace

- **SME-011 — Customer profiles and saved assets**. Depends on: SME-010. Acceptance: Complete customer profiles and saved assets functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-012 — Provider organizations and locations**. Depends on: SME-011. Acceptance: Complete provider organizations and locations functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-013 — Provider employees and permissions**. Depends on: SME-012. Acceptance: Complete provider employees and permissions functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-014 — Service taxonomy dynamic intake schemas**. Depends on: SME-013. Acceptance: Complete service taxonomy dynamic intake schemas functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-015 — Provider onboarding and attestation**. Depends on: SME-014. Acceptance: Complete provider onboarding and attestation functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-016 — Insurance uploads review expiration**. Depends on: SME-015. Acceptance: Complete insurance uploads review expiration functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-017 — Credential evidence background check adapter**. Depends on: SME-016. Acceptance: Complete credential evidence background check adapter functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-018 — Geospatial territories and travel rules**. Depends on: SME-017. Acceptance: Complete geospatial territories and travel rules functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-019 — Search indexes ranking**. Depends on: SME-018. Acceptance: Complete search indexes ranking functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-020 — Availability and appointment slots**. Depends on: SME-019. Acceptance: Complete availability and appointment slots functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-021 — Lead creation matching notifications**. Depends on: SME-020. Acceptance: Complete lead creation matching notifications functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-022 — Lead triage and quotes**. Depends on: SME-021. Acceptance: Complete lead triage and quotes functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-023 — Reviews dispute responses**. Depends on: SME-022. Acceptance: Complete reviews dispute responses functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-024 — Saved providers and repeat requests**. Depends on: SME-023. Acceptance: Complete saved providers and repeat requests functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
## Job Room

- **SME-025 — Job Room membership and invitations**. Depends on: SME-024. Acceptance: Complete job room membership and invitations functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-026 — Realtime chat receipts notifications**. Depends on: SME-025. Acceptance: Complete realtime chat receipts notifications functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-027 — Attachment sharing private media**. Depends on: SME-026. Acceptance: Complete attachment sharing private media functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-028 — Immutable estimate versions approval**. Depends on: SME-027. Acceptance: Complete immutable estimate versions approval functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-029 — Contracts e-sign adapter**. Depends on: SME-028. Acceptance: Complete contracts e-sign adapter functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-030 — Scheduling holds conflicts ICS**. Depends on: SME-029. Acceptance: Complete scheduling holds conflicts ics functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-031 — Technician tasks and checklists**. Depends on: SME-030. Acceptance: Complete technician tasks and checklists functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-032 — Timesheets materials inventory**. Depends on: SME-031. Acceptance: Complete timesheets materials inventory functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-033 — Change orders milestone acceptance**. Depends on: SME-032. Acceptance: Complete change orders milestone acceptance functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-034 — Subcontractor permissions**. Depends on: SME-033. Acceptance: Complete subcontractor permissions functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-035 — Completion warranties follow-up**. Depends on: SME-034. Acceptance: Complete completion warranties follow-up functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-036 — Disputes reversals human oversight**. Depends on: SME-035. Acceptance: Complete disputes reversals human oversight functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-037 — Accessibility offline drafts**. Depends on: SME-036. Acceptance: Complete accessibility offline drafts functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
## Commerce

- **SME-038 — Payment abstraction Stripe Connect**. Depends on: SME-037. Acceptance: Complete payment abstraction stripe connect functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-039 — Pricing fee caps**. Depends on: SME-038. Acceptance: Complete pricing fee caps functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-040 — Deposits milestone charges**. Depends on: SME-039. Acceptance: Complete deposits milestone charges functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-041 — External payment records**. Depends on: SME-040. Acceptance: Complete external payment records functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-042 — Refund disputes payout reconciliation**. Depends on: SME-041. Acceptance: Complete refund disputes payout reconciliation functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-043 — Plans entitlements**. Depends on: SME-042. Acceptance: Complete plans entitlements functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-044 — Ad inventory and sponsors**. Depends on: SME-043. Acceptance: Complete ad inventory and sponsors functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-045 — Coupons redemption control**. Depends on: SME-044. Acceptance: Complete coupons redemption control functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-046 — Referrals affiliate fraud controls**. Depends on: SME-045. Acceptance: Complete referrals affiliate fraud controls functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-047 — Gift cards loyalty credits**. Depends on: SME-046. Acceptance: Complete gift cards loyalty credits functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-048 — Subscriptions dunning**. Depends on: SME-047. Acceptance: Complete subscriptions dunning functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-049 — Invoices tax accounting exports**. Depends on: SME-048. Acceptance: Complete invoices tax accounting exports functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
## Operations

- **SME-050 — Provider CRM**. Depends on: SME-049. Acceptance: Complete provider crm functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-051 — Funnel analytics attribution**. Depends on: SME-050. Acceptance: Complete funnel analytics attribution functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-052 — Admin RBAC moderation support**. Depends on: SME-051. Acceptance: Complete admin rbac moderation support functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-053 — Feature flags configuration**. Depends on: SME-052. Acceptance: Complete feature flags configuration functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-054 — Email push SMS adapters**. Depends on: SME-053. Acceptance: Complete email push sms adapters functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-055 — Knowledge base content CMS**. Depends on: SME-054. Acceptance: Complete knowledge base content cms functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-056 — AI gateway quotas tools**. Depends on: SME-055. Acceptance: Complete ai gateway quotas tools functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-057 — Assistant registry configurations**. Depends on: SME-056. Acceptance: Complete assistant registry configurations functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-058 — Public professional research sourcing**. Depends on: SME-057. Acceptance: Complete public professional research sourcing functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-059 — Retrieval grounding corrections**. Depends on: SME-058. Acceptance: Complete retrieval grounding corrections functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-060 — Conversational request drafts approvals**. Depends on: SME-059. Acceptance: Complete conversational request drafts approvals functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-061 — Multi-agent turn director disabled**. Depends on: SME-060. Acceptance: Complete multi-agent turn director disabled functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-062 — Rights consent ledger**. Depends on: SME-061. Acceptance: Complete rights consent ledger functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-063 — Data privacy exports retention deletion**. Depends on: SME-062. Acceptance: Complete data privacy exports retention deletion functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-064 — Monitoring alerts incidents**. Depends on: SME-063. Acceptance: Complete monitoring alerts incidents functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-065 — Threat modeling security tests**. Depends on: SME-064. Acceptance: Complete threat modeling security tests functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-066 — Load accessibility contract tests**. Depends on: SME-065. Acceptance: Complete load accessibility contract tests functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
- **SME-067 — Production rollout DR release certification**. Depends on: SME-066. Acceptance: Complete production rollout dr release certification functionality, contract and authorization-negative tests, documentation, and recorded acceptance evidence.
