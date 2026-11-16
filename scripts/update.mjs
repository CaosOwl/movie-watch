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
    const netflix = added.some((k) => /^(flatrate|free|ads):.*netflix/i.test(k));
    alerts.push({ kind: netflix ? 'netflix' : 'home', text: `${netflix ? '🔴 On Netflix! ' : '🇨🇭 '}"${next.title}" new in ${HOME}: ${nice.join(', ')}`, link: next.availability[HOME]?.link });
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


// ---------- Coming soon: upcoming releases ranked by your taste ----------
function tasteProfile(movies) {
  const p = { genres: new Map(), keywords: new Map(), people: new Map(), total: 0 };
  const inc = (map, key, w, title) => {
    const cur = map.get(key) || { w: 0, titles: new Set() };
    cur.w += w; if (title) cur.titles.add(title); map.set(key, cur);
  };
  for (const m of movies) {
    if (!m.tmdb_id) continue;
    p.total++;
    for (const g of m.genre_ids || []) inc(p.genres, g, 1);
    for (const k of m.keywords || []) inc(p.keywords, k, 1, m.title);
    for (const d of m.directors || []) inc(p.people, d, 2, m.title);
    for (const c of (m.cast || []).slice(0, 6)) inc(p.people, c.name, 1, m.title);
  }
  return p;
}

const GENRE_NAMES = { 28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western' };

function genreScore(profile, genreIds = []) {
  if (!profile.total || !genreIds.length) return 0;
  const shares = genreIds.map((g) => (profile.genres.get(g)?.w || 0) / profile.total);
  return Math.min(1, shares.reduce((a, b) => a + b, 0) / Math.sqrt(genreIds.length));
}

function scoreUpcoming(profile, d) {
  const genreIds = d.genres?.map((g) => g.id) || d.genre_ids || [];
  const g = genreScore(profile, genreIds);
  const reasons = [];
  const topGenres = genreIds.filter((id) => profile.genres.has(id))
    .sort((a, b) => profile.genres.get(b).w - profile.genres.get(a).w).slice(0, 2).map((id) => GENRE_NAMES[id]).filter(Boolean);
  if (topGenres.length) reasons.push(`You like ${topGenres.join(' & ')}`);

  let people = 0;
  const directors = d.credits?.crew?.filter((c) => c.job === 'Director').map((c) => c.name) || [];
  const cast = d.credits?.cast?.slice(0, 10).map((c) => c.name) || [];
  for (const name of [...directors, ...cast]) {
    const hit = profile.people.get(name);
    if (!hit) continue;
    people += hit.w;
    if (reasons.length < 4) reasons.push(`${directors.includes(name) ? 'Directed by' : 'Starring'} ${name} (${[...hit.titles][0]})`);
  }
  const kws = (d.keywords?.keywords || []).map((k) => k.name).filter((k) => profile.keywords.has(k));
  if (kws.length) reasons.push(`Themes: ${kws.slice(0, 3).join(', ')}`);

  const pop = Math.min(1, Math.log10((d.popularity || 0) + 1) / 3);
  const score = profile.total
    ? 0.5 * g + 0.2 * Math.min(1, people / 2) + 0.15 * Math.min(1, kws.length / 3) + 0.15 * pop
    : pop;
  return { score, reasons };
}

function nextRelease(d, today) {
  const label = { 1: 'Premiere', 2: 'Cinema (limited)', 3: 'Cinema', 4: 'Digital', 5: 'Physical', 6: 'TV' };
  const home = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === HOME)?.release_dates || [];
  const homeNext = home.map((r) => ({ date: r.release_date.slice(0, 10), type: label[r.type] || 'Release' }))
    .filter((r) => r.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (homeNext) return { ...homeNext, where: HOME };
  if (d.release_date && d.release_date >= today) return { date: d.release_date, type: 'Release', where: 'World' };
  return null;
}

async function buildUpcoming(movies) {
  const profile = tasteProfile(movies);
  const owned = new Set(movies.map((m) => m.tmdb_id));
  const today = new Date().toISOString().slice(0, 10);
  const until = new Date(Date.now() + 270 * 864e5).toISOString().slice(0, 10);
  const pool = new Map();
  for (let page = 1; page <= 4; page++) {
    const queries = [
      { region: HOME, with_release_type: '2|3', 'release_date.gte': today, 'release_date.lte': until },
      { 'primary_release_date.gte': today, 'primary_release_date.lte': until },
    ];
    for (const q of queries) {
      const r = await tmdb('/discover/movie', { ...q, sort_by: 'popularity.desc', include_adult: 'false', page });
      for (const m of r.results || []) if (!owned.has(m.id) && !pool.has(m.id)) pool.set(m.id, m);
    }
  }
  // Cheap pre-ranking on genres + popularity, then fetch full details for the best candidates.
  const shortlist = [...pool.values()]
    .map((m) => ({ m, pre: 0.7 * genreScore(profile, m.genre_ids) + 0.3 * Math.min(1, Math.log10((m.popularity || 0) + 1) / 3) }))
    .sort((a, b) => b.pre - a.pre).slice(0, 60);

  const out = [];
  for (const { m } of shortlist) {
    try {
      const d = await tmdb(`/movie/${m.id}`, { append_to_response: 'credits,keywords,release_dates,videos,external_ids' });
      const release = nextRelease(d, today);
      if (!release) continue;
      const { score, reasons } = scoreUpcoming(profile, d);
      const trailer = (d.videos?.results || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer');
      const genreIds = d.genres?.map((g) => g.id) || [];
      out.push({
        tmdb_id: d.id, imdb_id: d.imdb_id || d.external_ids?.imdb_id || null,
        title: d.title, original_title: d.original_title, tagline: d.tagline, overview: d.overview,
        poster: d.poster_path, backdrop: d.backdrop_path, runtime: d.runtime || null,
        genres: d.genres?.map((g) => g.name) || [],
        category: genreIds.includes(16) ? 'animation' : genreIds.includes(27) ? 'horror' : 'general',
        directors: d.credits?.crew?.filter((c) => c.job === 'Director').map((c) => c.name) || [],
        writers: [...new Set(d.credits?.crew?.filter((c) => c.department === 'Writing').map((c) => c.name) || [])].slice(0, 3),
        cast: d.credits?.cast?.slice(0, 8).map((c) => ({ name: c.name, character: c.character, photo: c.profile_path })) || [],
        countries: d.production_countries?.map((c) => c.iso_3166_1) || [],
        release, trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
        match: Math.round(score * 100), reasons,
      });
    } catch (e) { console.warn(`upcoming ${m.id}: ${e.message}`); }
    await sleep(150);
  }
  out.sort((a, b) => b.match - a.match);
  return out.slice(0, 40);
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
try {
  const upcoming = await buildUpcoming(movies);
  await writeJson('data/upcoming.json', { home_country: HOME, generated: new Date().toISOString(), movies: upcoming });
  console.log(`Coming soon: ${upcoming.length} movies`);
} catch (e) { console.warn('Coming soon failed:', e.message); }

if (newAlerts.length) {
  alertsFile.alerts = [...newAlerts, ...alertsFile.alerts].slice(0, 200);
  await writeJson('data/alerts.json', alertsFile);
  for (const a of newAlerts) await notify(a);
}
console.log(`Done: ${movies.length} movies, ${newAlerts.length} new alerts`);
