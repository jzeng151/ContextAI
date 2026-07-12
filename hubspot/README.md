# HubSpot CRM Card

This HubSpot Developer Platform 2026.03 project installs the ContextAI card in contact and company sidebars. The card uses HubSpot's signed `hubspot.fetch()` boundary and renders only persisted, assigned evaluations; it never sends email, enrolls sequences, routes, nurtures, or disqualifies records.

Create a HubSpot config profile with `CONTEXTAI_API_URL` set to the public HTTPS origin of the ContextAI Node server, then run:

```sh
hs project install-deps
hs project validate --profile <profile>
hs project upload --profile <profile>
```

Set the same origin in the server's `CONTEXTAI_API_URL`, and set `HUBSPOT_CLIENT_SECRET` to the installed app's client secret. The portal ID stored on the active integration must match HubSpot's signed `portalId`; evaluation `assigned_rep_id` stores the HubSpot owner's `userId`, which must match the signed `userId`.

Pilot load target: the card serves the latest persisted evaluation in under 2.5 seconds. Assignment and morning-run orchestration refresh evaluations outside the card request; a card with no persisted evaluation returns a usable “not available” state instead of blocking HubSpot. This replaces the provisional “under 10 seconds fresh” in-card target for v0, avoiding a long CRM request and duplicate provider work.
