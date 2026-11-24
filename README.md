# lead-queue-web

The calling page for sales reps: one lead at a time from the shared lead queue of
[reonic-sync-api](https://github.com/tinkenergy/reonic_sync_api) (`/v1/lead-queue`).

- **`public/`**: the page (plain HTML, CSS and JavaScript, no build step).
  - `tokens.css` is generated from the design system's `tokens.json` and `tl.css` is its
    component stylesheet, both from the **tink Lead-Queue** design system (Artifact
    https://claude.ai/artifact/UgUT3KkMuqg3xoMZpeWuuc). `app.css` only lays them out.
  - `app.js` is the page: a thin client of the lead queue v2 API.
- **`src/worker.js`**: a Cloudflare Worker that serves the page and proxies `/api/*` to the
  API. It adds `X-API-Key` (Worker secret `LEAD_QUEUE_API_KEY`) and `X-User-Email` (the rep,
  from the Cloudflare Access login) to every request. The browser never sees the key.
- **`src/access.js`**: checks the Access login token (`Cf-Access-Jwt-Assertion`) against the
  team's signing keys, the application's audience tag and the issuer.
- **`dev/mock-server.mjs`**: a local stand-in for the API with made-up data, to look at every
  screen without HubSpot (`npm run mock`).

Forwarded routes (the API's lead queue v2, spec "Lead queue v2" in reonic-sync-api):
`GET /api/state`, `GET /api/pulse`, `GET /api/meetings`, `POST /api/lead`,
`POST /api/lead/{done,skip,extend,expire,leave,reclaim,undo}`, `POST /api/{pause,resume,logout}`,
`POST /api/filters/preview`, `PUT /api/filters`, `DELETE /api/filters`,
`PATCH /api/tasks/{id}`, `POST /api/skips/reset`. `GET /api/session` returns the signed-in
email. Everything else under `/api` answers 404. The API needs the v2 routes (branch
`development` of reonic-sync-api or later).

## How the page behaves

The page is in German and follows the design system's Fokus layout (version A).

- **Every action answers with the whole state**, so the page redraws from any answer. A light
  refresh (`/pulse`, every 60 s) keeps the queue counts, daily stats, callbacks and status
  current; meetings refresh every 15 minutes. Both intervals come from the API's
  `settings.refresh`, and both pause while the tab is hidden.
- **Lead holen / Erledigt, nächster Lead / Überspringen (nicht angerufen)**: `POST /lead`,
  `/lead/done`, `/lead/skip`. After Erledigt a toast offers "Rückgängig" for 5 seconds
  (`/lead/undo`). When a mail reminder is due, the popup comes first and "Verstanden" gets
  the next lead. **N** confirms "Verstanden" too (a held key does not), so N, N moves on
  from one lead to the next.
- **Timer**: counts down to `reservation.return_at`; from `warn_at` "Noch dran?" with
  **Behalten**; at `return_at` the page sends `/lead/expire` and offers **Zurückholen**.
  Clicking the name opens HubSpot and extends the reservation (`reason: hubspot_opened`).
- **Meeting soon**: when a meeting starts within the reservation length, the action bar
  turns amber, names the meeting on its own line and offers "Überspringen", "Erledigt, weiter"
  and "Erledigt, Pause bis Termin" (pause until "Weitermachen").
- **Filters**: quick filters, Gruppe, Quelle, Anrufe, Lead-Alter; the panels show counts from
  `/filters/preview` before applying, and filters are saved per rep on the server.
- **Aufgaben in HubSpot**: ticking completes the task in HubSpot, unticking reopens it.
- **Heute**: today's meetings and today's callbacks (Discovery Calls), by time.
- **Pause**, **Übersprungene zurückholen**, **Tastenkürzel** and **Abmelden** (returns the
  lead, then `/cdn-cgi/access/logout`) are in the header and the user menu.
- **Reload / second tab**: `GET /state` shows the same lead. Closing the tab sends
  `/lead/leave`; the API keeps the lead for a short grace period so a reload gets it back.
- **Keyboard**: `N` Erledigt (or Lead holen), `S` Überspringen, `B` Behalten, `F` Filter,
  `1` to `9` tick a task, `Esc` closes panels.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in DEV_USER_EMAIL and LEAD_QUEUE_API_KEY
npm run dev                      # http://localhost:8787
npm run mock                     # http://localhost:8790, no Worker, no API, made-up data
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
