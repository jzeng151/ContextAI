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

## Development Workflow

1. Create a branch from the current `main` branch:

   ```sh
   git switch -c your-branch-name
   ```

2. Run the app locally:

   ```sh
   npm run dev
   ```

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

Recommended order:

- Kickoff: one developer owns #11 while the other owns #12.
- Decision layer: #8, then #3, then #6.
- Platform/workflow layer: #13, then #5, then #4; take #7 after its shared contracts/events are stable.
- Define #9 events before either layer ships, add events within each owning PR, and complete #19 reporting after #3-#7 emit them.

Use one issue and branch per PR, created from current `main`. Do not keep long-lived aggregate branches. Put new behavior in focused modules such as `config.ts`, `scoring.ts`, `adapters/`, `writeback-policy.ts`, `grounding.ts`, and `instrumentation.ts`. Treat `LeadPacket`, `Evidence`, and `Claim` as shared contract types: one person owns a contract change at a time, and dependent work updates only after that contract PR merges.

## Shared Contract Changes

Resolve shared contract decisions through issue #11 before parallel implementation.

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
