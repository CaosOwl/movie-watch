# 🎬 Cinema Watchlist

A personal app for the movies you want to see. It installs on your phone like a normal app, but it's really a web page on **GitHub Pages**. A daily **GitHub Action** fills in the data. You don't need a server and you don't pay anything.

## What it does

- **Three lists:** Horror, Animation, General. When you add a movie, it goes into the right list automatically based on its genres, or you can pick the list yourself.
- **Lots of info per movie:** poster, backdrop, plot, cast, director, writers, runtime, age rating, awards, trailer, a link to IMDb, and ratings from **IMDb, TMDB, Metascore and Rotten Tomatoes**.
- **Where to watch it legally:** stream, free, rent or buy, with provider logos. **Switzerland (CH)** comes first, and you can open every other country where the movie is available.
- **When it becomes watchable:** shows official release dates (cinema, digital, physical), so you can see when a legal digital option is expected in CH or anywhere else.
- **Alerts:** every day the Action compares today's availability with yesterday's. You get an alert when
  - a movie on your list becomes legally available **anywhere in the world** for the first time, or
  - a movie gets a **new legal option in Switzerland**.

  Alerts show up in the app's *Alerts* tab, and as a push notification on your phone if you set up the free [ntfy](https://ntfy.sh) app.
- **Recommendations:** the *For you* tab ranks similar movies, using every movie on your list. Each list (horror, animation, general) gets its own suggestions. Add one with a single tap.
- Mark movies as watched, move them to another list, remove them, or filter to only "watchable in Switzerland".

## How it works

```
Phone app (GitHub Pages) ──edits──▶ data/watchlist.json   (via GitHub API + your token)
                                         │ push triggers
                                         ▼
               GitHub Action (also daily 06:17 CH time)
               scripts/update.mjs  ── TMDB API (details, cast, release dates,
                                   │            JustWatch availability, recommendations)
                                   └─ OMDb API (IMDb rating, votes, awards)
                                         │
                       data/movies.json · data/recommendations.json · data/alerts.json
                                         │
                                   ntfy push ─▶ your phone
```

**About "from IMDb":** IMDb has no free public API, and scraping it is against its terms. The app stores each movie by its **IMDb ID** (`tt…`) and gets IMDb's own rating, votes and awards through **OMDb**, which is free. Everything else comes from **TMDB**. That includes the where-to-watch data, which TMDB gets from JustWatch.

## Setup (≈15 minutes, from a desktop)

1. **Create the repo:** make a new GitHub repository (it can be private if your plan allows Pages on private repos; otherwise make it public). Push these files to the `main` branch.
2. **Get API keys:**
   - **TMDB** (required): make a free account → Settings → API → copy the **API Read Access Token** (the long one).
   - **OMDb** (optional, for the IMDb rating): get a free key at omdbapi.com/apikey.aspx.
   - **ntfy** (optional, for push): install the ntfy app on Android and subscribe to a long, random topic name, e.g. `emilio-cinema-8f3k2q`.
3. **Add repo secrets:** Settings → Secrets and variables → Actions → *New repository secret*:
   - `TMDB_TOKEN`, `OMDB_KEY`, `NTFY_TOPIC`
4. **Turn on Pages:** Settings → Pages → *Source: GitHub Actions*.
5. **First run:** Actions tab → *Update movies & deploy* → *Run workflow*. When it finishes, the app is at https://caosowl.github.io/movie-watch/.
6. **Create a phone token:** GitHub → Settings → Developer settings → *Fine-grained tokens* → only this repository → **Contents: Read and write**.
7. **On your phone:** open the site in Chrome → ⋮ → *Add to Home screen*. Then open ⚙︎ Settings in the app and enter:
   - repo (`owner/name`)
   - the GitHub token from step 6
   - your TMDB token (used to search by title)
   - home country `CH`

Your tokens are stored only on your phone (in the browser's local storage). They're never put in the repo.

## Using it

- **＋ Add** → type a title, or paste an IMDb link or `tt` ID → **Add**. The movie shows *Fetching…* for about 1–2 minutes while the Action runs, then fills in.
- Tap a movie for full details, where to watch it, release dates, cast, similar movies and actions.
- The three example movies in `data/watchlist.json` are only there to try the app. Remove them whenever you like.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `app.js`, `styles.css` | The app (no build step) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Lets you install it on your phone and use it offline |
| `scripts/update.mjs` | Daily data fetch, availability check, recommendations, alerts (Node 20, no dependencies) |
| `.github/workflows/update.yml` | Runs the script daily and after each change, saves the data, deploys Pages |
| `data/watchlist.json` | **Your list.** The only file the app edits |
| `data/movies.json`, `recommendations.json`, `alerts.json` | Created by the Action. Don't edit them |

## Ideas for later

- Turn the PWA into an Android APK (e.g. with Bubblewrap / TWA)
- More lists, or custom tags
- A watchlist for TV series (TMDB `/tv` endpoints work the same way)
- Price tracking for rent and buy

---
Data: TMDB, with availability from JustWatch, and OMDb. This product uses the TMDB API but is not endorsed or certified by TMDB.
