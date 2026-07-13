# Local Live Demo

This runs the Node/SQLite API and Astro UI locally while a free Cloudflare Quick Tunnel exposes only the API for HubSpot OAuth callbacks and CRM card requests. Quick Tunnels are for supervised demos, not production.

## 1. Install prerequisites

Install Node.js 22.12.0 or newer, npm, `cloudflared`, and the HubSpot CLI. Then authenticate the CLI and create the ignored local project profile once:

```sh
npm ci
cloudflared --version
hs --version
hs account auth
cd hubspot
hs project install-deps
hs project profile add dev
cd ..
```

Choose the HubSpot developer/test account that owns the demo project when `profile add` prompts. The resulting `hubspot/src/hsprofile.dev.json` is ignored; never commit it.

## 2. Create local secrets

```sh
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 32
```

Copy the two different hex values into `CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN` and `SESSION_SECRET`, and the base64 value into `INTEGRATION_SECRET_KEY`. Add the HubSpot app's `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`. Keep `CONTEXTAI_TENANT_ID=local` and `HUBSPOT_INTEGRATION_ID=hubspot-demo`.

Do not share the generated values or commit `.env`. Leave `CONTEXTAI_API_URL`, `PUBLIC_CONTEXTAI_API_URL`, and `HUBSPOT_REDIRECT_URI` empty; `npm run demo` derives them from the current tunnel. The tunneled API always runs with `CONTEXTAI_LOCAL_DEMO=0`, and CRM writeback remains dry-run.

## 3. Start the demo

```sh
npm run demo
```

The command checks prerequisites and ports, starts the Quick Tunnel before the API, seeds the configured tenant, starts the API on `127.0.0.1:4000`, and starts Astro on `127.0.0.1:4321`. It fails if a child exits or an endpoint is unhealthy. In another terminal, verify the running environment with:

```sh
npm run demo:check
```

To check only the local configuration and required executables without opening ports or making network requests, run `npm run demo -- --preflight`.

## 4. Validate and upload HubSpot

Run the exact commands printed by `npm run demo` in another terminal:

```sh
cd hubspot
hs project validate --profile dev
hs project upload --profile dev
```

Every Quick Tunnel session has a different hostname. Validate and upload the regenerated `dev` profile before starting OAuth in every session, or HubSpot will retain the previous callback/card origin. Upload is never automatic unless you explicitly start with `npm run demo -- --upload`.

## 5. Run the demo flow

1. Visit `http://127.0.0.1:4321/login`.
2. Sign in and connect HubSpot through Lane 3's OAuth flow.
3. Refresh the dashboard and analyze the HubSpot records.
4. Open a matching contact or company in HubSpot and open the **ContextAI Priority** card.

Lane 3 supplies these interfaces consumed by the merged demo:

```text
POST /auth/session
POST /oauth/hubspot/start
GET /oauth/hubspot/callback
```

## 6. Stop or reset

Press Ctrl-C in the demo terminal. The supervisor forwards the signal and terminates Cloudflare, the API, and Astro.

To reset the seeded database after the demo is stopped:

```sh
rm -rf .contextai
```

For a full local reset, also remove the ignored profile; the next session must recreate it with `hs project profile add dev`:

```sh
rm -f hubspot/src/hsprofile.dev.json
```
