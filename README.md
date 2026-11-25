# MultiModalNav

A park-and-ride and multimodal trip planner, built as an installable web app (PWA). Pick one or more modes for each leg of the trip (drive and park, drop-off, rideshare, bike or walk to transit; light rail, subway, train, bus or ferry; then walk, bike, a share bike/scooter or rideshare to the destination), and every combination is compared side by side. For drive-first trips it compares several stations using traffic-aware drive times and shows which one gets you there first.

## How it works

| Piece | Service | Notes |
| --- | --- | --- |
| Map | [OpenFreeMap](https://openfreemap.org) + MapLibre GL | No key needed |
| Transit, walk and bike routing, stations, place search | [Transitous](https://transitous.org) (MOTIS 2 API) | No key; worldwide community GTFS/GTFS-RT feeds |
| Driving with traffic | [TomTom Routing API](https://developer.tomtom.com) | Free tier, key kept server-side |
| Hosting, API proxy, password | Cloudflare Pages + Functions | |

A drive-first search:

1. Asks Transitous for its own park-and-ride trip (that gives a real parking lot and the walk to the platform), and loads stations near the start that serve the selected transit modes.
2. Picks up to *N* candidate stations spread along the corridor to the destination (near home, midway, near the destination).
3. Gets a traffic-aware drive time to each station from TomTom.
4. Plans the transit part from each station with Transitous, passing the drive time plus a parking buffer as the first leg (`fromOffsets`). Transitous's own drive times ignore traffic, so this step is what makes the ranking reflect rush hour.
5. Ranks the stations by arrival time (or by latest departure for "arrive by"), next to a drive-the-whole-way option for comparison.

Drives and rides longer than the "max" limits are dropped. If none fit, the shortest ones are kept and a note says so.

A **rideshare last leg** works the same way from the other end. The app finds up to 4 stations near the destination and gets a traffic-aware ride time from each. It adds the pickup wait and passes the totals to Transitous as the last leg (`toOffsets`), so Transitous picks the best station to get off at. Transitous can't route a car last leg itself.

Walk-first and bike-first searches are a single Transitous query (plus the rideshare lookups if the last leg is a rideshare).

With several modes selected, each first/last pairing is planned separately, because one combined query would only return the fastest mode. TomTom lookups, Transitous's park-and-ride pick and the rideshare stations are shared between pairings. Queries are kept to 3 at a time for Transitous and 2 for TomTom, and the server retries their "too many requests" responses.

**No-transit comparisons** appear under "For comparison": driving or rideshare the whole way, walking or biking the whole way, and, when both "Drive & park" and "Rideshare" are selected, **park near the destination and rideshare the rest**. That last one parks at a station lot near the destination (from the rideshare search) and doesn't count against the max-drive limit.

**Free tier use per drive-first search** (default 6 stations): about 7 TomTom routes (11 with a rideshare last leg) and 7 Transitous queries, plus station lists, which are cached for a week. Each extra first/last pairing adds up to 6 Transitous queries for a car first leg, or 1 for walk or bike. The app shows an estimate under **Find routes** before you search. TomTom's free 20,000 routes a month works out to roughly 1,800 to 2,800 single-mode searches. Transitous asks to be contacted above about 720 plan queries a day, which is roughly 100 searches.

### Usage tracking and rate limits

After you sign in, the footer shows TomTom routes used this month and Transitous plan queries used today, next to their free-tier limits. The numbers turn amber at 80% and red at the limit. Each set of results also says how many calls that search made, and an estimate appears under **Find routes** before you search.

The server also rate-limits upstream calls across **all** connected clients, so several people searching at once don't trip TomTom's or Transitous's "too many requests" limits:

| Limit | Default | When exceeded |
| --- | --- | --- |
| TomTom routes per month (`TOMTOM_MONTHLY_LIMIT`) | 20,000 | TomTom isn't called; drive times fall back to estimates until next month |
| Transitous plan queries per day (`TRANSITOUS_DAILY_LIMIT`) | 720 | Shown only; it's a guideline for when to contact Transitous, not a hard limit |
| TomTom requests per second, all clients (`TOMTOM_MAX_PER_SECOND`) | 4 | The request waits for the next free second (up to 8 s), then gets HTTP 503 |
| Transitous requests per second, all clients (`TRANSITOUS_MAX_PER_SECOND`) | 4 | Same as above. Station-list tiles are exempt: they're mostly served from Cloudflare's cache |
| Requests per minute from one device (`CLIENT_MAX_PER_MINUTE`) | 120 | HTTP 429 with a `Retry-After`, so one runaway client can't starve the others |

- Counters live in the optional `USAGE_DB` database (see setup below). D1 is strongly consistent, so every request on every Cloudflare server sees the same counts. Without the database, nothing is counted or limited server-side, the footer says tracking is off, and only each browser tab's own limit applies (3 Transitous and 2 TomTom requests at a time).
- Counts only include this app's calls, and periods are UTC months and days. TomTom's own dashboard is the authoritative figure.
- If the database itself fails, requests go ahead rather than failing.
- Devices are told apart by IP address (`CF-Connecting-IP`), so people on the same network share a per-device budget. A heavy multi-mode search makes about 60 upstream calls.

## Setup

### 1. TomTom key (optional but recommended)

Create a free account at [developer.tomtom.com](https://developer.tomtom.com) (no credit card) and copy the API key. Without it the app still works, but drive times are straight-line estimates.

### 2. Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # set APP_PASSWORD, TRANSITOUS_CONTACT, and TOMTOM_API_KEY if you have it
npm run dev                      # Vite on :5173, Pages Functions on :8788
```

Open http://localhost:5173. `npm run preview` serves the production build on :8788 instead.

```sh
npm test         # unit tests
npm run check    # type-check the app and the Functions
```

### 3. Usage database (`USAGE_DB`, optional but recommended)

This is a free [D1](https://developers.cloudflare.com/d1/) database that turns on usage tracking, the TomTom monthly stop, and the shared rate limits. The free tier (100,000 writes a day) is plenty: each upstream call costs about 3 writes. Because `wrangler.toml` is the source of truth for this project, the binding has to go in that file; the dashboard's Bindings page will be read-only. The database id is just an identifier, not a secret, so it's fine to commit.

**Option A: from the command line** (on your own machine)

```sh
npx wrangler login     # opens a browser to authorize Wrangler with your Cloudflare account
npx wrangler d1 create multimodalnav-usage --location wnam --binding USAGE_DB --update-config
```

That creates the database (`wnam` = Western North America, close to Southern California) and appends a block like this to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "USAGE_DB"
database_name = "multimodalnav-usage"
database_id = "…"
```

**Option B: from the dashboard**

1. Go to **Storage & Databases → D1 SQL database → Create database**.
2. Name it `multimodalnav-usage`, pick a location near you, and create it.
3. Copy the **Database ID** from the database's page.
4. In `wrangler.toml`, uncomment the `[[d1_databases]]` block at the bottom and replace `<DATABASE_ID>` with that id.

**Then, either way:**

1. Commit and push `wrangler.toml`. The Pages build picks up the binding. The tables are created automatically on the first request, so there's nothing else to set up.
2. Check it: sign in, and the footer should read "Usage: TomTom 0 / 20,000 routes this month · …" instead of "Usage tracking is off". To look at the raw counters:
   ```sh
   npx wrangler d1 execute multimodalnav-usage --remote --command "SELECT * FROM usage"
   ```
3. To change any limit, edit its value under `[vars]` in `wrangler.toml` and push.

**Locally**, once the block is in `wrangler.toml`, `npm run dev` uses a local SQLite copy automatically; your production counts aren't touched. Before then, `npx wrangler pages dev --d1 USAGE_DB=usage-local` gives you a throwaway local database.

If a deploy fails with an error about the D1 binding, the `database_id` in `wrangler.toml` doesn't match a database in your account. Re-copy it from the dashboard.

### 4. Deploy to Cloudflare Pages

**Git integration:** in the Cloudflare dashboard, go to **Workers & Pages → Create application → Pages → Connect to Git** and pick this repo. Make sure it's a **Pages** project: the default "Create" flow makes a Worker, which asks for a deploy command and won't work with this repo.

- Project name: `multimodalnav` (must match `name` in `wrangler.toml`)
- Framework preset: None
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: leave blank
- Under Settings → Variables and Secrets, add `APP_PASSWORD`, `TOMTOM_API_KEY` and `TRANSITOUS_CONTACT` as **secrets**. Because the repo has a `wrangler.toml`, Cloudflare treats that file as the source of truth for plain-text variables and won't let you edit them in the dashboard. Secrets are still set in the dashboard, and they also keep your contact details out of the public repo.

**Or from the CLI:**

```sh
npx wrangler pages project create multimodalnav
npx wrangler pages secret put APP_PASSWORD --project-name multimodalnav
npx wrangler pages secret put TOMTOM_API_KEY --project-name multimodalnav
npx wrangler pages secret put TRANSITOUS_CONTACT --project-name multimodalnav
npm run deploy
```

### Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `APP_PASSWORD` | yes | Password for the app; also signs the session cookie |
| `TOMTOM_API_KEY` | no | Traffic-aware drive and rideshare times; without it they're estimates |
| `TRANSITOUS_CONTACT` | recommended | Your email or a URL, sent to Transitous in the User-Agent (`MultiModalNav/<version> (+<repo>; <contact>)`) as its usage policy asks |
| `TOMTOM_MONTHLY_LIMIT` | no (in `wrangler.toml`) | TomTom routes per month before calls stop; default 20000 |
| `TRANSITOUS_DAILY_LIMIT` | no (in `wrangler.toml`) | Transitous plan queries per day shown in the footer; default 720 |
| `TOMTOM_MAX_PER_SECOND` | no (in `wrangler.toml`) | TomTom requests per second across all clients; default 4 |
| `TRANSITOUS_MAX_PER_SECOND` | no (in `wrangler.toml`) | Transitous requests per second across all clients; default 4 |
| `CLIENT_MAX_PER_MINUTE` | no (in `wrangler.toml`) | Upstream requests per minute from one device; default 120 |
| `USAGE_DB` | recommended (D1 binding) | Turns on usage tracking, the TomTom monthly stop and the shared rate limits |

The first three are **secrets**: set them in the dashboard or with `wrangler pages secret put`, and never put them in `wrangler.toml`, which is public.

## Password protection

Every `/api/*` route except login and logout requires a session cookie. The cookie is HMAC-signed with a key derived from `APP_PASSWORD`, so changing the password signs everyone out. The app shell is public, but it can't do anything without signing in, and the TomTom key never reaches the browser.

## Usage terms and attribution

- **Transitous** is a volunteer service for open-source, non-commercial apps. Its [usage policy](https://transitous.org/api/) asks for a visible link to [its data sources](https://transitous.org/sources/) (shown in the app footer), a User-Agent with contact details (set by the proxy from `TRANSITOUS_CONTACT`), and a heads-up for heavy use.
- **OpenStreetMap / OpenFreeMap** attribution is shown on the map.
- Check TomTom's terms for your use when you sign up.

## Known limitations

- **Coverage depends on Transitous.** For example, NCTD in San Diego County (Coaster, Sprinter, Breeze) isn't in Transitous yet, so those lines can't be routed. LA Metro, Metrolink, San Diego MTS, OCTA and Amtrak are covered, most with live data.
- **"Own bike" doesn't restrict to bike-friendly trains**, because many feeds don't publish that data and enabling the filter returns no results. Check the agency's bike rules.
- **Bike/scooter share** needs share-system data in Transitous, which many areas lack.
- **Parking** comes from OpenStreetMap park-and-ride lots when Transitous finds one; other stations assume you park at the station. Cost and availability aren't known.
- **Rideshare** is modeled as your pickup wait plus a car trip in traffic. The app has no price, surge or availability data.
- **Park-and-ride (`CAR_PARKING`) is marked experimental** in the MOTIS API, so it may change.
