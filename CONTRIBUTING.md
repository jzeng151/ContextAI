# Contributing

## Local Setup

1. Install Node.js 22.12.0 or newer and npm.
2. Install dependencies:

   ```sh
   npm install
   ```

3. Create local environment config:

   ```sh
   cp .env.example .env
   ```

4. Add optional live integration secrets in `.env` only when needed:

   ```sh
   OPENROUTER_API_KEY=
   HUBSPOT_ACCESS_TOKEN=
   ```

5. Create and seed the local SQLite store without live credentials:

   ```sh
   npm run db:seed
   ```

## Development Workflow

1. Create a branch from the current `main` branch:

   ```sh
   git switch -c your-branch-name
   ```

2. Run the app locally:

   ```sh
   npm run dev
   ```

   Run `npm start` separately only when working on the server runtime. It uses `DATABASE_PATH` and exposes `GET /health` on `HOST:PORT`.

3. Before committing, run:

   ```sh
   npm test
   npm run build
   ```

4. For optional live service checks, set secrets in `.env` and run:

   ```sh
   npm run check:integrations
   ```

   The integration check is safe to run without secrets; it reports skipped services.

## Parallel Development

Split work by subsystem so each person can own files and behavior end to end:

| Decision layer | Workflow layer |
| --- | --- |
| #8 configuration primitives | #5 source and ingestion adapters |
| #3 deterministic scoring | #4 CRM writeback policy |
| #6 LLM grounding and evals | #7 dashboard and interaction UX |
| Support #9 event definitions | Own #9 instrumentation; #19 reporting |

Recommended implementation waves (with two developers, take at most one issue per developer from the current wave):

1. **Contract and CI:** merge #11 as the shared v0 contract baseline. Land #12 as early as possible; it has no product dependency and is safe in parallel with every wave. Closed issue #2 is superseded and requires no work.
2. **Parallel foundations after #11:** build #8 versioned configuration, #13 runtime/persistence, and #5 source adapters in parallel. Start #18 pilot definitions at the same time. Land the contract/schema portion of #9 early and reconcile its metric terms with #18 before either contract is treated as final.
3. **Core implementation:** after #8 and the #9 event contract, build #3 deterministic scoring. After #9's contract, #7 may build fixture-first interaction UX, but its score-driven integration waits for #3. After #8 and #13, build #4's dry-run writeback policy/audit/rollback path; live adapter completion also waits for #5. After #13, finish #9's append-only recorder. Start #14 security and tenant controls after #13.
4. **Grounding and integration completion:** build #6 after #3, finish it against real normalized evidence after #5, and persist its audits through #13. Finish #4 after #5, finish #7 after #3, and add #9-compatible producers as #3-#7 land.
5. **End-to-end alpha and governance:** build #15 only after #3, #4, #5, #6, and #13; keep production activation gated by #14. In parallel, build #16 after #8, #4, #7, #9, and #13, consuming #14's integration-security controls when stable.
6. **CRM-native pilot surface and reporting:** build #17 after #7, #13, #14, and #15. #19 report scaffolding may start once #9, #13, and #18 are stable, but it completes only after the relevant producers in #3-#7, #15, and #17 emit reconciled events.
7. **Pilot:** run #20 last, after #14, #15, #16, #17, #18, and #19 pass their launch gates.

Treat #9 as contract-first and persistence/integration-later rather than waiting to design telemetry after features ship. Treat #4 similarly: fixture-backed planning can proceed before live adapters, but execution remains dry-run until persistence, provider, audit, idempotency, and rollback gates pass.

Use one issue and branch per PR, created from current `main`. Do not keep long-lived aggregate branches. Put new behavior in focused modules such as `config.ts`, `scoring.ts`, `adapters/`, `writeback-policy.ts`, `grounding.ts`, and `instrumentation.ts`. Treat `LeadPacket`, `Evidence`, and `Claim` as shared contract types: one person owns a contract change at a time, and dependent work updates only after that contract PR merges.

## Shared Contract Changes

Issue #11 is the locked v0 contract baseline. For any later shared-contract change:

- Give each shared contract one owner.
- Merge contract/schema changes in a focused PR before dependent work.
- Rebase dependent branches after the contract merges.
- Record decisions in runtime schemas and the owning issue, not in this guide.

## Coding Standards

- Ship the smallest change that solves the real problem. Delete or reuse before adding new code.
- Reuse existing helpers, types, and patterns before writing another version. Use standard library or platform features before dependencies.
- Use semantic variable names that describe the domain value or intent.
- Do not add abstractions, config, scaffolding, or flexibility for hypothetical future needs.
- Fix bugs at the shared root cause, not at each caller. Check sibling callers before patching behavior.
- Treat `PRD.md` as the product/safety source, shared TypeScript schemas and active configuration as runtime contracts, `ROADMAP.md` as phase/status, and GitHub issues as executable scope.
- Keep scoring deterministic. The LLM may explain a score, but it must not calculate scores, change bands, decide writeback, route leads, disqualify leads, or draft full emails.
- Ground hooks and explanations in `allowed_claims`. Treat `disallowed_claims` as unavailable.
- Keep CRM writeback allowlisted, audited, and blocked from ownership, lifecycle, routing, deal, forecast, sequence, and other prospect-visible automation fields.
- Add the smallest useful test for non-trivial logic. Skip test scaffolding for trivial text-only or one-line changes.
- Mark deliberate shortcuts with a `ponytail:` comment that names the ceiling and the upgrade path.
- Update `ROADMAP.md` in the same change when implementation status changes.
