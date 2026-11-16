// Daily updater: enriches data/watchlist.json with TMDB + IMDb (via OMDb) data,
// tracks legal availability worldwide (focus: HOME_COUNTRY, default CH),
// builds recommendations, and sends alerts when a legal option appears.
// Node 20+, no dependencies.

import fs from 'node:fs/promises';

const TMDB_TOKEN = process.env.TMDB_TOKEN;      // TMDB "API Read Access Token" (v4 bearer)
const OMDB_KEY = process.env.OMDB_KEY || '';    // optional, adds IMDb rating/votes/awards
const NTFY_TOPIC = process.env.NTFY_TOPIC || ''; // optional, push notifications via ntfy.sh
const HOME = (process.env.HOME_COUNTRY || 'CH').toUpperCase();
const LANG = process.env.TMDB_LANGUAGE || 'en-US';

if (!TMDB_TOKEN) { console.error('Missing TMDB_TOKEN secret'); process.exit(1); }

const readJson = async (p, fallback) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmdb(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('language', LANG);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TMDB_TOKEN}`, accept: 'application/json' } });
    if (res.status === 429) { await sleep(2000); continue; }
    if (!res.ok) throw new Error(`TMDB ${path} -> ${res.status}`);
    return res.json();
  }
  throw new Error(`TMDB ${path} rate-limited`);
}

async function omdb(imdbId) {
  if (!OMDB_KEY) return null;
  try {
    const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&plot=full&apikey=${OMDB_KEY}`);
    const j = await res.json();
    return j.Response === 'True' ? j : null;
  } catch { return null; }
}

const RELEASE_TYPES = { 1: 'Premiere', 2: 'Theatrical (limited)', 3: 'Theatrical', 4: 'Digital', 5: 'Physical', 6: 'TV' };
const OFFER_TYPES = ['flatrate', 'free', 'ads', 'rent', 'buy'];

function summarizeProviders(wp) {
  // -> { CH: { link, flatrate:[names], rent:[...], ... }, ... }
  const out = {};
  for (const [cc, data] of Object.entries(wp?.results || {})) {
    const entry = { link: data.link };
    for (const t of OFFER_TYPES) {
      if (data[t]?.length) entry[t] = data[t].map((p) => ({ name: p.provider_name, logo: p.logo_path }));
    }
    if (OFFER_TYPES.some((t) => entry[t])) out[cc] = entry;
  }
  return out;
}

function summarizeReleases(rd) {
  const byCountry = {};
  let earliestDigital = null;
  for (const r of rd?.results || []) {
    for (const d of r.release_dates) {
      const item = { type: RELEASE_TYPES[d.type] || String(d.type), typeId: d.type, date: d.release_date?.slice(0, 10), note: d.note || undefined };
      (byCountry[r.iso_3166_1] ||= []).push(item);
      if ((d.type === 4 || d.type === 5) && (!earliestDigital || item.date < earliestDigital.date)) {
        earliestDigital = { country: r.iso_3166_1, ...item };
      }
    }
  }
  for (const list of Object.values(byCountry)) list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return { byCountry, earliestDigital };
}

const providerKeys = (entry) =>
  new Set(OFFER_TYPES.flatMap((t) => (entry?.[t] || []).map((p) => `${t}:${p.name}`)));

async function enrich(item) {
  const found = await tmdb(`/find/${item.imdb_id}`, { external_source: 'imdb_id' });
  const hit = found.movie_results?.[0];
  if (!hit) return { ...item, error: 'Not found on TMDB' };
  const d = await tmdb(`/movie/${hit.id}`, {
    append_to_response: 'credits,videos,release_dates,watch/providers,recommendations,keywords',
  });
  const o = await omdb(item.imdb_id);
  const trailer = (d.videos?.results || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer');
  const releases = summarizeReleases(d.release_dates);
  return {
    ...item,
    tmdb_id: d.id,
    title: d.title,
    original_title: d.original_title,
    year: d.release_date?.slice(0, 4) || null,
    release_date: d.release_date || null,
    status: d.status,
    runtime: d.runtime,
    tagline: d.tagline,
    overview: d.overview,
    plot_imdb: o?.Plot && o.Plot !== 'N/A' ? o.Plot : undefined,
    genres: d.genres?.map((g) => g.name) || [],
    genre_ids: d.genres?.map((g) => g.id) || [],
    keywords: d.keywords?.keywords?.slice(0, 15).map((k) => k.name) || [],
    poster: d.poster_path, backdrop: d.backdrop_path,
    directors: d.credits?.crew?.filter((c) => c.job === 'Director').map((c) => c.name) || [],
    writers: [...new Set(d.credits?.crew?.filter((c) => c.department === 'Writing').map((c) => c.name) || [])].slice(0, 4),
    cast: d.credits?.cast?.slice(0, 10).map((c) => ({ name: c.name, character: c.character, photo: c.profile_path })) || [],
    countries: d.production_countries?.map((c) => c.iso_3166_1) || [],
    languages: d.spoken_languages?.map((l) => l.english_name) || [],
    trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
    ratings: {
      tmdb: d.vote_average ? { value: d.vote_average, votes: d.vote_count } : null,
      imdb: o?.imdbRating && o.imdbRating !== 'N/A' ? { value: Number(o.imdbRating), votes: o.imdbVotes } : null,
      metascore: o?.Metascore && o.Metascore !== 'N/A' ? Number(o.Metascore) : null,
      others: o?.Ratings || [],
    },
    rated: o?.Rated, awards: o?.Awards && o.Awards !== 'N/A' ? o.Awards : undefined,
    box_office: o?.BoxOffice && o.BoxOffice !== 'N/A' ? o.BoxOffice : undefined,
    imdb_url: `https://www.imdb.com/title/${item.imdb_id}/`,
    releases,
    availability: summarizeProviders(d['watch/providers']),
    recommendations: (d.recommendations?.results || []).slice(0, 12).map((r) => ({
      tmdb_id: r.id, title: r.title, year: r.release_date?.slice(0, 4), poster: r.poster_path,
      genre_ids: r.genre_ids, vote: r.vote_average,
    })),
    updated: new Date().toISOString(),
  };
}

function diffAvailability(prev, next) {
  const alerts = [];
  if (!next.availability) return alerts;
  const prevCountries = Object.keys(prev?.availability || {});
  const nextCountries = Object.keys(next.availability);
  const first = prev && prevCountries.length === 0 && nextCountries.length > 0;
  if (first) {
    alerts.push({ kind: 'first-anywhere', text: `🎬 "${next.title}" is now legally available in ${nextCountries.length} countr${nextCountries.length === 1 ? 'y' : 'ies'} (${nextCountries.slice(0, 8).join(', ')})` });
  }
  const before = providerKeys(prev?.availability?.[HOME]);
  const after = providerKeys(next.availability[HOME]);
  const added = [...after].filter((k) => !before.has(k));
  if (prev && added.length) {
    const nice = added.map((k) => { const [t, n] = k.split(':'); return `${n} (${t === 'flatrate' ? 'stream' : t})`; });
    alerts.push({ kind: 'home', text: `🇨🇭 "${next.title}" new in ${HOME}: ${nice.join(', ')}`, link: next.availability[HOME]?.link });
  }
  return alerts.map((a) => ({ ...a, imdb_id: next.imdb_id, date: new Date().toISOString() }));
}

function buildRecommendations(movies, watchlistIds) {
  const tmdbIds = new Set(movies.map((m) => m.tmdb_id));
  const score = new Map();
  for (const m of movies) {
    if (m.watched) continue;
    for (const r of m.recommendations || []) {
      if (tmdbIds.has(r.tmdb_id)) continue;
      const cur = score.get(r.tmdb_id) || { ...r, score: 0, because: [] };
      cur.score += 1 + (r.vote || 0) / 10;
      if (cur.because.length < 3) cur.because.push(m.title);
      score.set(r.tmdb_id, cur);
    }
  }
  const all = [...score.values()].sort((a, b) => b.score - a.score);
  const cat = (r) => (r.genre_ids?.includes(16) ? 'animation' : r.genre_ids?.includes(27) ? 'horror' : 'general');
  const out = { horror: [], animation: [], general: [] };
  for (const r of all) if (out[cat(r)].length < 20) out[cat(r)].push(r);
  return out;
}

async function notify(alert) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST', body: alert.text,
      headers: { Title: 'Cinema watchlist', Tags: 'movie_camera', ...(alert.link ? { Click: alert.link } : {}) },
    });
  } catch (e) { console.warn('ntfy failed', e.message); }
}

const watchlist = await readJson('data/watchlist.json', { movies: [] });
const prevMovies = await readJson('data/movies.json', { movies: [] });
const prevById = new Map(prevMovies.movies.map((m) => [m.imdb_id, m]));
const alertsFile = await readJson('data/alerts.json', { alerts: [] });

const movies = [];
const newAlerts = [];
for (const item of watchlist.movies) {
  try {
    const m = await enrich(item);
    const prev = prevById.get(item.imdb_id);
    if (!item.watched) newAlerts.push(...diffAvailability(prev, m));
    movies.push(m);
    console.log(`✓ ${m.title || item.imdb_id}`);
  } catch (e) {
    console.warn(`✗ ${item.imdb_id}: ${e.message}`);
    movies.push(prevById.get(item.imdb_id) || { ...item, error: e.message });
  }
  await sleep(250);
}

await writeJson('data/movies.json', { home_country: HOME, generated: new Date().toISOString(), movies });
await writeJson('data/recommendations.json', { generated: new Date().toISOString(), ...buildRecommendations(movies) });
if (newAlerts.length) {
  alertsFile.alerts = [...newAlerts, ...alertsFile.alerts].slice(0, 200);
  await writeJson('data/alerts.json', alertsFile);
  for (const a of newAlerts) await notify(a);
}
console.log(`Done: ${movies.length} movies, ${newAlerts.length} new alerts`);
