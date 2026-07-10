# ContextAI

ContextAI is a CRM-native lead prioritization and data-quality layer for B2B go-to-market teams. It combines CRM, enrichment, intent, engagement, and public-signal data into an auditable deterministic score, a concise reason, and one evidence-grounded outreach hook.

> **Status:** Early v0 development. This repository currently contains a fixture-backed Astro dashboard and integration client foundations. Production scoring, source adapters, orchestration, persistence, writeback governance, CRM embedding, and pilot hardening are tracked in the [roadmap](ROADMAP.md).

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
- Helper logic for freshness, weak email-open signals, grounded hooks, and writeback eligibility.
- OpenRouter configuration, key validation, and grounded explanation client foundations.
- HubSpot contact list/read and guarded PATCH client foundations.
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

Never commit `.env` or credentials.

## Available Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the local Astro development server. |
| `npm test` | Run the native Node test suite. |
| `npm run build` | Create a production Astro build. |
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
  lib/integrations.ts     HubSpot and OpenRouter client foundations
  pages/index.astro       Current rep and RevOps dashboard
scripts/
  check-integrations.ts   Optional live integration smoke checks
tests/
  contextai.test.ts       Contract, fixture, grounding, and helper tests
CONTRIBUTING.md            Local setup and collaboration workflow
ROADMAP.md                 Product delivery plan and implementation status
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before starting work. Use one focused issue and branch per pull request, coordinate shared contract changes through issue #11, and keep roadmap status changes aligned with merged implementation.

## Scope

The v0 build is HubSpot-first. Salesforce support, autonomous outbound, full email drafting, prospect-facing automation, enterprise account planning, and advanced manager/viewer experiences are outside the pilot-critical scope.

## License

No license file is currently included in this repository.
