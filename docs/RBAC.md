# Organization memberships and RBAC

`authorizeOrganizationAction` is the reusable, fail-closed authorization boundary for organization-scoped actions. It requires one active organization, exactly one active membership for the authenticated subject, and one or more uniquely assigned roles defined by that same organization. Effective permissions are the union of the assigned roles.

Missing context, cross-organization access, inactive records, duplicate memberships, duplicate or unknown role assignments, cross-organization role definitions, and absent permissions all return the same `authorization_denied` result. Adapters must load the authorization state transactionally and must not perform resource lookup or mutation until this evaluator authorizes the request.
