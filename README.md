# MultiModalNav

A park-and-ride and multimodal trip planner, built as an installable web app (PWA). Pick a mode for each leg of the trip (drive and park, drop-off, rideshare, bike or walk to transit; light rail, subway, train, bus or ferry; then walk, bike, a share bike/scooter or rideshare to the destination). For drive-first trips it compares several stations using traffic-aware drive times and shows which one gets you there first.

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

**Free tier use per drive-first search** (default 6 stations): about 7 TomTom routes (11 with a rideshare last leg) and 7 Transitous queries, plus station lists, which are cached for a week. TomTom's free 20,000 routes a month works out to about 1,800 to 2,800 searches. Transitous asks to be contacted above about 720 plan queries a day, which is roughly 100 searches.

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

### 3. Deploy to Cloudflare Pages

**Git integration:** in the Cloudflare dashboard, go to Workers & Pages → Create → Pages → Connect to Git and pick this repo.

- Build command: `npm run build`
- Build output directory: `dist`
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
