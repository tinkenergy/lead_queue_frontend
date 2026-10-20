# lead-queue-web

The calling page for sales reps: one lead at a time from the shared lead queue of
[reonic-sync-api](https://github.com/tinkenergy/reonic_sync_api) (`/v1/lead-queue`).

- **`public/`**: the page (plain HTML, CSS and JavaScript, no build step).
- **`src/worker.js`**: a Cloudflare Worker that serves the page and proxies `/api/*` to the
  API. It adds `X-API-Key` (Worker secret `LEAD_QUEUE_API_KEY`) and `X-User-Email` (the rep,
  from the Cloudflare Access login) to every request. The browser never sees the key.
- **`src/access.js`**: checks the Access login token (`Cf-Access-Jwt-Assertion`) against the
  team's signing keys, the application's audience tag and the issuer.

Only these routes are forwarded: `POST /api/next`, `GET /api/me`, `GET /api/stats`,
`POST /api/leads/{id}/extend`, `POST /api/leads/{id}/release`. `GET /api/session` returns the
signed-in email. Everything else under `/api` answers 404.

## How the page behaves

- **Get a lead / Next lead**: reserves the next lead (`previous_outcome: done`, so the previous
  lead is held back for the cooldown). **Skip (not called)** returns the current lead at once.
- **Timer**: the lead is reserved until `lease.return_at`. From `lease.warn_at` the page asks
  "Still on it?" with **Keep** (extends the reservation). At `return_at` it returns the lead
  itself. All times come from the API (`LEAD_QUEUE_*` settings there), none are set here.
- **Reload / second tab**: `GET /api/me` shows the same lead. Closing the tab sends
  `release: unload`; the API keeps the lead for a short grace period so a reload gets it back.
- Clicking the card opens the contact in HubSpot.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in DEV_USER_EMAIL and LEAD_QUEUE_API_KEY
npm run dev                      # http://localhost:8787
npm test
```

There is no Cloudflare Access in front of localhost, so `.dev.vars` sets a fixed user
(`ALLOW_DEV_USER`, `DEV_USER_EMAIL`). The Worker only honours that on `localhost`/`127.0.0.1`
(hence `--local-upstream localhost:8787` in `npm run dev`). To run against a local API, set
`API_BASE_URL=http://localhost:8000` in `.dev.vars` and start the API with
`LEAD_QUEUE_ENABLED=true LEAD_QUEUE_API_KEY=<same key>`.

## Deployment (first time)

1. **Cloudflare Zero Trust → Settings → Authentication**: make sure Google is a login method.
   If it isn't, create an OAuth client in the Google Cloud Console (consent screen
   "Internal", redirect URI `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`)
   and add it to Cloudflare.
2. **Zero Trust → Access → Applications → Add → Self-hosted**:
   - Domain `leads.tinkenergy.dev`, login method Google only.
   - Policy "Sales reps": action Allow, include **Emails**: the reps' `@tink.io` addresses.
   - Session duration, e.g. 24 hours.
   - From the app's overview, copy the **Application Audience (AUD) tag**, and note the team
     domain (`<team>.cloudflareaccess.com`).
3. In `wrangler.jsonc`, set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (not secret), and check
   `API_BASE_URL`.
4. Log in and set the API key (the same value as `LEAD_QUEUE_API_KEY` on Render):
   ```bash
   npx wrangler login
   npx wrangler secret put LEAD_QUEUE_API_KEY
   ```
5. Deploy: `npm run deploy`. This creates the custom domain `leads.tinkenergy.dev` (the zone
   must be in the same Cloudflare account). `workers_dev` and `preview_urls` are off, so the
   Worker is only reachable through the domain Access protects.
6. Open `https://leads.tinkenergy.dev`, log in with Google, and request a lead.

Adding or removing a rep is an edit to the Access policy; nothing here changes.
