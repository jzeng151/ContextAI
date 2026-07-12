# ContextAI

ContextAI is a CRM-native lead prioritization and data-quality layer for B2B go-to-market teams. It combines CRM, enrichment, intent, engagement, and public-signal data into an auditable deterministic score, a concise reason, and one evidence-grounded outreach hook.

> **Status:** Early v0 development. This repository currently contains a fixture-backed Astro dashboard, integration client foundations, deterministic scoring, and a local durable runtime store. Orchestration, writeback governance, CRM embedding, and pilot hardening are tracked in the [roadmap](ROADMAP.md).

## Product Direction

ContextAI is intended to help:

- RevOps teams inspect and tune transparent, versioned lead-scoring rules.
- SDRs and AEs see prioritized leads and the evidence behind each recommendation.
- Teams safely enrich CRM records through allowlisted, confidence-gated, audited writeback.
- Pilot teams measure research time, recommendation acceptance, CRM completeness, false positives, and weak-signal overfitting.

The LLM explains a score and drafts one grounded hook. It does not calculate scores, change bands, decide CRM writeback, send outreach, create sequences, route leads, or disqualify prospects.

## Current Repository

The current implementation includes:

- An Astro and TypeScript dashboard with rep and RevOps views.
- Evidence-backed lead-packet fixtures and runtime contract validation.
- Locked v0 packet semantics for CRM associations, separate intent/engagement, terminal tool status, manual review, and writeback plan versus outcome.
- Helper logic for freshness, weak email-open signals, grounded hooks, and writeback eligibility.
- OpenRouter configuration, key validation, and grounded explanation client foundations.
- HubSpot contact list/read and guarded PATCH client foundations.
- A native Node server boundary with SQLite migrations, fixture seeding, and durable evaluation/audit/event records.
- A RevOps governance workspace with validated config publishing, immutable history, manual-review decisions, audit tracing, rollback access, and integration health.
- Ordered HubSpot lead evaluation with bounded morning runs, authenticated assignment triggers, replay protection, manual-review routing, and dry-run writeback.
- A HubSpot Developer Platform 2026.03 contact/company sidebar card backed by signed, tenant- and assignment-scoped APIs.
- A typed, PII-rejecting pilot telemetry contract with idempotent append-only recording.
- Secret-optional integration smoke checks and native Node tests.

See [ROADMAP.md](ROADMAP.md) for implementation status, dependencies, and the two-developer delivery sequence.

## Design and Safety Principles

- Scoring is deterministic, inspectable, and versioned.
- Confidence is separate from score.
- Every factual explanation or hook must trace to approved evidence.
- Email opens alone are weak engagement and cannot make a lead Hot.
- Missing, stale, conflicting, duplicate, or malformed data can trigger manual review.
- CRM writeback must be schema-valid, allowlisted, source-backed, audited, idempotent, and reversible.
- Live CRM writes remain disabled until the complete safety and rollback gates pass.
- Retrieved CRM and public-source text is untrusted data, not model instructions.

## Tech Stack

- [Astro](https://astro.build/) 7
- TypeScript
- Node.js native test runner
- Node.js built-in SQLite persistence
- HubSpot CRM API foundations
- OpenRouter chat-completion foundations

## Getting Started

### Prerequisites

- Node.js 22.12.0 or newer
- npm
- Git

### Install and Run

```sh
git clone https://github.com/jzeng151/ContextAI.git
cd ContextAI
npm install
cp .env.example .env
npm run db:seed
npm run dev
```

Astro normally serves the app at `http://localhost:4321`; use the URL printed by the development server if the port changes.

Live integration credentials are optional for local UI development and automated tests.

## Environment Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | No | Enables OpenRouter key checks and optional live explanation calls. |
| `OPENROUTER_MODEL` | No | Overrides the default model, `openai/gpt-4.1-mini`. |
| `OPENAI_API_KEY` | No | Uses the OpenAI API directly instead of OpenRouter when set. |
| `OPENAI_MODEL` | No | Overrides the direct OpenAI model, `gpt-4.1-mini`. |
| `CONTEXTAI_APP_URL` | No | Sets the application URL sent with OpenRouter requests. |
| `CONTEXTAI_API_URL` | Required for CRM card | Public HTTPS origin used to validate signed HubSpot card requests. |
| `PUBLIC_CONTEXTAI_API_URL` | Local dashboard | Browser-facing ContextAI API origin; defaults to `http://127.0.0.1:4000`. |
| `CONTEXTAI_ALLOW_MODEL_DATA` | No | Set to `1` only after approving HubSpot-derived claims for OpenRouter analysis; local grounded fallback is the default. |
| `PUBLIC_CONTEXTAI_API_URL` | No | Sets the runtime API origin used by the Astro governance page. |
| `CONTEXTAI_ADMIN_ORIGIN` | No | Allows the Astro governance origin to call the runtime API; defaults to `http://127.0.0.1:4321`. |
| `HUBSPOT_ACCESS_TOKEN` | No | Enables live HubSpot contact checks. |
| `HUBSPOT_WEBHOOK_SECRET` | No | Authenticates `POST /webhooks/hubspot/assignments`. |
| `HUBSPOT_INTEGRATION_ID` | No | Selects the encrypted HubSpot OAuth integration used by server-triggered evaluations. |
| `SESSION_SECRET` | No | Verifies signed bearer sessions for `POST /internal/morning-run`. |
| `CONTEXTAI_TENANT_ID` | No | Selects the configured tenant for server-triggered evaluations; defaults to `local`. |
| `DATABASE_PATH` | No | SQLite file used by the server; defaults to `.contextai/contextai.sqlite`. |
| `HOST` / `PORT` | No | Server bind address and port; defaults to `127.0.0.1:4000`. |

Never commit `.env` or credentials.

## Available Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the local Astro development server. |
| `npm start` | Start the Node server; `GET /health` reports runtime readiness. |
| `npm test` | Run the native Node test suite. |
| `npm run build` | Create a production Astro build. |
| `npm run db:migrate` | Create or upgrade the SQLite store. |
| `npm run db:seed` | Migrate and idempotently seed local fixture evaluations. |
| `npm run check:integrations` | Check configured HubSpot and OpenRouter connections; missing secrets are reported as skipped. |

Before opening a pull request, run:

```sh
npm test
npm run build
```

## Project Structure

```text
src/
  data/leads.ts           Evidence-backed development fixtures
  lib/contextai.ts        Shared contracts and deterministic safety helpers
  lib/grounding.ts        Allowed-claim compiler and grounded-output validator
  lib/migrations.ts       Ordered transactional SQLite migrations
  lib/persistence.ts      Durable runtime storage boundary
  lib/instrumentation.ts  Pilot event contract and failure-isolated recorder
  lib/integrations.ts     HubSpot and OpenRouter client foundations
  lib/governance.ts       Governance review reason codes
  lib/orchestration.ts    Ordered evaluation and HubSpot trigger handling
  pages/index.astro       Current rep and RevOps dashboard
  pages/admin.astro       RevOps governance and manual-review workspace
  server.ts               Minimal Node runtime and health endpoint
scripts/
  database.ts             Local migration and fixture-seed command
  check-integrations.ts   Optional live integration smoke checks
tests/
  contextai.test.ts       Contract, fixture, grounding, and helper tests
  grounding.test.ts       Grounded-output validation and safety evals
  security.test.ts        Authentication, encryption, tenant, and role controls
hubspot/                   HubSpot 2026.03 CRM sidebar card project
PRD.md                     Product and safety requirements
SECURITY.md                Threat model and pilot operations runbook
CONTRIBUTING.md            Local setup and collaboration workflow
ROADMAP.md                 Product delivery plan and implementation status
```

## Runtime and Persistence

v0 uses the existing Node 22 runtime and Node's built-in SQLite module, so persistence adds no ORM or database package. `RuntimeStore` is the only storage side-effect boundary; deterministic contracts, configuration, scoring, and policy remain plain TypeScript. Transactional migrations create tenant/integration, versioned configuration, evaluation/step, normalized evidence/claim, writeback/audit/rollback, review, append-only event, request-audit, encrypted credential, and retention records.

SQLite is the smallest deployable single-process store for the pilot. `DATABASE_PATH` is the deployment-owned durable volume. Audit records reject updates and deletes. Evaluations default to 365-day retention through `EVALUATION_RETENTION_DAYS`; `npm run db:purge -- <tenant-id> [ISO-cutoff]` deletes expired non-audit data while retaining required audits.

Production security responsibilities, OAuth operations, disconnect/status commands, encryption requirements, and incident procedures are documented in [SECURITY.md](SECURITY.md).

Telemetry producers use the recorder in `instrumentation.ts`; they do not import metric aggregation or reporting. Event names, required linkage, PII exclusions, retention classes, and metric inputs are documented in [TELEMETRY.md](TELEMETRY.md).

The HubSpot card project and deployment steps live in [hubspot/README.md](hubspot/README.md). It renders the latest cached evaluation and records views, score display, recommendation disposition, and observed rep actions without executing prospect-facing automation.

Pilot reports are read-only: `GET /reports/pilot` returns JSON and `GET /reports/pilot.csv` returns an export. Both require a RevOps Admin bearer token and accept `from`, `to`, `cohort`, `teamId`, `repId`, `scoreVersion`, `configVersion`, `promptVersion`, `source`, and `band` query filters. Reports include metric/window metadata and explicit data-quality caveats; missing telemetry is never presented as a valid zero.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before starting work. Use one focused issue and branch per pull request, treat the issue #11 contract as the v0 baseline, give any later shared-contract change one explicit owner, and keep roadmap status changes aligned with merged implementation.

## Scope

The v0 build is HubSpot-first. Salesforce support, autonomous outbound, full email drafting, prospect-facing automation, enterprise account planning, and advanced manager/viewer experiences are outside the pilot-critical scope.

## License

No license file is currently included in this repository.
