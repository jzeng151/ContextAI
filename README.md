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
| `CONTEXTAI_APP_URL` | No | Sets the application URL sent with OpenRouter requests. |
| `HUBSPOT_ACCESS_TOKEN` | No | Enables live HubSpot contact checks. |
| `DATABASE_PATH` | No | SQLite file used by the server; defaults to `.contextai/contextai.sqlite`. |
| `HOST` / `PORT` | No | Server bind address and port; defaults to `127.0.0.1:4000`. |

Never commit `.env` or credentials.

## Available Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the local Astro development server. |
| `npm start` | Start the minimal Node server; `GET /health` reports runtime readiness. |
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
  lib/migrations.ts       Ordered transactional SQLite migrations
  lib/persistence.ts      Durable runtime storage boundary
  lib/integrations.ts     HubSpot and OpenRouter client foundations
  pages/index.astro       Current rep and RevOps dashboard
  server.ts               Minimal Node runtime and health endpoint
scripts/
  database.ts             Local migration and fixture-seed command
  check-integrations.ts   Optional live integration smoke checks
tests/
  contextai.test.ts       Contract, fixture, grounding, and helper tests
PRD.md                     Product and safety requirements
CONTRIBUTING.md            Local setup and collaboration workflow
ROADMAP.md                 Product delivery plan and implementation status
```

## Runtime and Persistence

v0 uses the existing Node 22 runtime and Node's built-in SQLite module, so persistence adds no ORM or database package. `RuntimeStore` is the only storage side-effect boundary; deterministic contracts, configuration, scoring, and policy remain plain TypeScript. Two transactional migrations create tenant/integration, versioned configuration, evaluation/step, normalized evidence/claim, writeback/audit/rollback, review, and append-only event records.

SQLite is the smallest deployable single-process store for the pilot. `DATABASE_PATH` is the deployment-owned durable volume. Audit and event tables reject updates and deletes. Evaluation rows expose a retention date and query hook, while production retention policy and deletion enforcement remain owned by the security workstream (#14).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before starting work. Use one focused issue and branch per pull request, treat the issue #11 contract as the v0 baseline, give any later shared-contract change one explicit owner, and keep roadmap status changes aligned with merged implementation.

## Scope

The v0 build is HubSpot-first. Salesforce support, autonomous outbound, full email drafting, prospect-facing automation, enterprise account planning, and advanced manager/viewer experiences are outside the pilot-critical scope.

## License

No license file is currently included in this repository.
