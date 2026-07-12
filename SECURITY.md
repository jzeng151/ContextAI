# Pilot Security and Operations

## Threat model

Protected assets are CRM records, normalized evaluations, scoring configuration, writeback and access audits, OAuth credentials, and model prompts/responses. Trust boundaries exist at signed HTTP identity, HubSpot/source OAuth or bearer authentication, provider responses, SQLite persistence, model-provider requests, and operator access to the deployment.

The pilot recognizes `revops_admin` and `rep` human roles. RevOps Admin actions remain tenant-scoped and may manage configuration, integrations, writeback, retention, and audits. Reps may only read evaluations assigned to their actor ID. `system` and `integration` identities are non-human workers and do not gain RevOps administration. Sales Manager, Viewer, enterprise SSO, Salesforce, and prospect-facing automation remain outside v0.

Primary threats and controls:

- Cross-tenant or unassigned-record access: every store read binds the authenticated tenant; rep reads also bind `assigned_rep_id`. Allowed and denied attempts are append-only request audits.
- Credential theft: HubSpot access and refresh tokens use AES-256-GCM with `INTEGRATION_SECRET_KEY`; source credentials stay in authorization headers. Tokens and source payloads are never logged.
- Excess CRM privilege: HubSpot OAuth requests only the contact read/write, company read, and owner read scopes required for CRM context and user-assignment enforcement; existing field allowlists still constrain writes.
- Forged CRM-card context: the server validates HubSpot v3 signatures and five-minute timestamps, derives the tenant from the signed portal ID, maps the owner to HubSpot user ID, and applies assigned-record reads before returning cached data.
- Revoked integration reuse: disconnect disables local access before remote refresh-token revocation, clears credentials after success, and leaves the integration non-active if remote revocation fails.
- Provider abuse or injection: untrusted lookup keys and provider strings reject ASCII controls; provider payloads are normalized before persistence. Raw provider responses are not stored.
- Customer-data training or retention: OpenRouter requests require `data_collection: deny` and zero-data-retention routing. Grounded claims, rather than the complete CRM packet, are sent.
- Excess retention: evaluations default to 365 days unless configured. The purge job removes normalized non-audit records and redacts the evaluation shell while preserving writeback, grounding, and access audits.

Residual risks: SQLite is a single-process pilot store; deployment administrators and holders of encryption keys remain privileged. Enterprise SSO, per-customer keys, regional routing, and manager/viewer roles require a later production phase.

## Deployment encryption responsibilities

- The application encrypts integration tokens before SQLite persistence. Generate `INTEGRATION_SECRET_KEY` with `openssl rand -base64 32`; store it in the deployment secret manager, never `.env` in production.
- The deployment platform must terminate TLS 1.2+ and redirect HTTP to HTTPS. ContextAI must not be exposed directly without the TLS proxy/load balancer.
- The deployment owner must enable encryption at rest for the `DATABASE_PATH` volume and all backups. SQLite does not provide volume encryption.
- `SESSION_SECRET` must be at least 32 random bytes and stored in the secret manager. Rotate session and integration keys after suspected exposure; token-key rotation requires decrypting and re-encrypting stored credentials in a controlled maintenance window.
- Restrict database, backup, and secret-manager access to the service identity and named operators. Never copy production data into development or test fixtures.

## Runbook

### Connect HubSpot

1. Configure the HubSpot app callback and the exact scopes in `hubSpotRequiredScopes`.
2. Set `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI`, `INTEGRATION_SECRET_KEY`, and `SESSION_SECRET` in the secret manager.
3. Generate the authorization URL with `hubSpotAuthorizationUrl`, validate the signed OAuth `state` on callback, and exchange the single-use code with `exchangeHubSpotAuthorizationCode`.
4. Create the disabled tenant integration, then call `activateHubSpotIntegration` with the returned portal ID, scopes, expiry, and tokens. Do not log callback parameters or token responses.

### Health and rate limits

- Run `TENANT_ID=<tenant> ADMIN_ACTOR_ID=<operator> npm run integration:admin -- status <integration-id>`.
- Record successful probes as `healthy`, provider failures as `error`, and HTTP 429 responses as `rate_limited` with the provider retry time. Token reads fail closed until that time.
- Alert on `error`, repeated rate limiting, expired tokens, revocation failures, or missing health timestamps.

### Disconnect or revoke

Run `TENANT_ID=<tenant> ADMIN_ACTOR_ID=<operator> npm run integration:admin -- disconnect <integration-id>`. The command disables local source access first, posts the refresh token to HubSpot's 2026-03 revoke endpoint, clears encrypted credentials, and records the administrator request.

### Retention

Run at least daily:

```sh
ADMIN_ACTOR_ID=<operator> npm run db:purge -- <tenant-id> <ISO-cutoff>
```

Use the current time as the cutoff for normal enforcement. Confirm the purge count and append-only access audit. Required writeback, grounding, and access audits remain available.

### Incident response

1. Disable the affected integration and revoke its refresh token.
2. Rotate HubSpot/source credentials, `SESSION_SECRET`, and the integration encryption key as applicable.
3. Preserve access/writeback/grounding audits and deployment logs; do not copy raw CRM payloads into tickets.
4. Identify affected tenant IDs, request IDs, actors, and time range. Notify the pilot owner and customer contact under the deployment incident policy.
5. Restore service only after token access, tenant boundaries, and health checks pass.
