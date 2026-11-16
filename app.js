// Cinema Watchlist — static PWA. Reads data/*.json (built by GitHub Actions),
// and edits data/watchlist.json through the GitHub API using a token stored on this device.

const IMG = 'https://image.tmdb.org/t/p/';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cfg = JSON.parse(localStorage.getItem('cinema-cfg') || '{}');
cfg.home = (cfg.home || 'CH').toUpperCase();
// On GitHub Pages (<owner>.github.io/<repo>/) the repository can be derived from the URL.
if (!cfg.repo && location.hostname.endsWith('.github.io')) {
  const repoName = location.pathname.split('/').filter(Boolean)[0];
  if (repoName) cfg.repo = `${location.hostname.split('.')[0]}/${repoName}`;
}
const regionName = (cc) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc); } catch { return cc; } };
const OFFER_LABEL = { flatrate: 'Stream', free: 'Free', ads: 'Free (ads)', rent: 'Rent', buy: 'Buy' };

const state = { tab: 'horror', watchlist: { movies: [] }, watchlistSha: null, movies: [], recs: {}, alerts: [], upcoming: [], soonCat: 'all' };

// ---------- data loading ----------
async function getJson(path) {
  const r = await fetch(`${path}?t=${Date.now()}`);
  return r.ok ? r.json() : null;
}

const b64decode = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));
const b64encode = (s) => btoa(unescape(encodeURIComponent(s)));

async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${cfg.repo}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${cfg.ghToken}`, Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

async function loadWatchlist() {
  if (cfg.repo && cfg.ghToken) {
    try {
      const f = await gh('/contents/data/watchlist.json?ref=main');
      state.watchlistSha = f.sha;
      state.watchlist = JSON.parse(b64decode(f.content));
      return;
    } catch (e) { setStatus(`Could not reach GitHub (${e.message}); showing published copy.`); }
  }
  state.watchlist = (await getJson('data/watchlist.json')) || { movies: [] };
}

async function saveWatchlist(message) {
  if (!cfg.repo || !cfg.ghToken) { alert(`Missing in Settings (⚙︎): ${[!cfg.repo && 'GitHub repository', !cfg.ghToken && 'GitHub token'].filter(Boolean).join(' and ')}. Fill it in and tap Save.`); throw new Error('no token'); }
  const body = { message, content: b64encode(JSON.stringify(state.watchlist, null, 2) + '\n'), sha: state.watchlistSha, branch: 'main' };
  const res = await gh('/contents/data/watchlist.json', { method: 'PUT', body: JSON.stringify(body) });
  state.watchlistSha = res.content.sha;
  setStatus('Saved. Details & availability refresh in ~1–2 min (GitHub Action).');
}

async function loadAll() {
  setStatus('Loading…');
  const [movies, recs, alerts, upcoming] = await Promise.all([getJson('data/movies.json'), getJson('data/recommendations.json'), getJson('data/alerts.json'), getJson('data/upcoming.json'), loadWatchlist()]);
  state.movies = movies?.movies || [];
  state.recs = recs || {};
  state.alerts = alerts?.alerts || [];
  state.upcoming = upcoming?.movies || [];
  setStatus(movies?.generated ? `Data updated ${new Date(movies.generated).toLocaleString()}` : 'No data yet — run the GitHub Action once.');
  render();
}

// Merge: watchlist (source of truth) + enriched data (may lag behind).
function mergedList() {
  const byId = new Map(state.movies.map((m) => [m.imdb_id, m]));
  return state.watchlist.movies.map((w) => ({ ...(byId.get(w.imdb_id) || {}), ...w, pending: !byId.has(w.imdb_id) }));
}

// ---------- availability helpers ----------
function homeOffers(m) {
  const e = m.availability?.[cfg.home];
  if (!e) return [];
  return Object.keys(OFFER_LABEL).filter((t) => e[t]).map((t) => ({ type: t, providers: e[t] }));
}

const NETFLIX_TYPES = ['flatrate', 'free', 'ads'];
function onNetflix(m) {
  const e = m.availability?.[cfg.home];
  return !!e && NETFLIX_TYPES.some((t) => (e[t] || []).some((p) => /netflix/i.test(p.name)));
}
const NETFLIX_BADGE = '<span class="badge netflix">N&nbsp;Netflix</span>';

function availabilityBadges(m) {
  if (m.pending) return `<span class="badge pending">${esc(m.pending_title ? 'Fetching details…' : 'Fetching…')}</span>`;
  const offers = homeOffers(m);
  if (offers.length) {
    return (onNetflix(m) ? NETFLIX_BADGE : '') + offers.map((o) => `<span class="badge ${o.type === 'flatrate' || o.type === 'free' || o.type === 'ads' ? 'stream' : o.type}">${OFFER_LABEL[o.type]}: ${esc(o.providers.slice(0, 3).map((p) => p.name).join(', '))}</span>`).join('');
  }
  const n = Object.keys(m.availability || {}).length;
  if (n) return `<span class="badge world">Not in ${cfg.home} yet · legal in ${n} countr${n === 1 ? 'y' : 'ies'}</span>`;
  const next = upcomingLegal(m);
  return `<span class="badge none">No legal option yet${next ? ` · expected ${esc(next)}` : ''}</span>`;
}

function upcomingLegal(m) {
  const home = (m.releases?.byCountry?.[cfg.home] || []).find((r) => r.typeId === 4 || r.typeId === 5);
  if (home) return `${home.date} (${home.type}, ${cfg.home})`;
  const w = m.releases?.earliestDigital;
  return w ? `${w.date} (${w.type}, ${w.country})` : null;
}

// ---------- rendering ----------
function setStatus(t) { $('#status').textContent = t; }

function card(m) {
  const poster = m.poster ? `<img loading="lazy" src="${IMG}w185${m.poster}" alt="">` : `<div class="poster-ph"></div>`;
  const rating = m.ratings?.imdb ? `IMDb ${m.ratings.imdb.value}` : m.ratings?.tmdb ? `TMDB ${m.ratings.tmdb.value.toFixed(1)}` : '';
  return `<article class="card cat-${m.category}" data-id="${m.imdb_id}">
    ${poster}
    <div>
      <h3>${esc(m.title || m.pending_title || m.imdb_id)} ${m.watched ? '✓' : ''}</h3>
      <div class="meta">${[m.year, m.runtime ? `${m.runtime} min` : '', rating, (m.genres || []).slice(0, 3).join(', ')].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="badges">${availabilityBadges(m)}</div>
    </div>
  </article>`;
}

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  $('#filters').style.display = ['recs', 'alerts', 'soon'].includes(state.tab) ? 'none' : 'flex';
  const list = $('#list');

  if (state.tab === 'alerts') {
    list.innerHTML = state.alerts.length
      ? state.alerts.map((a) => `<div class="alert"><div>${esc(a.text)}</div><div class="meta">${new Date(a.date).toLocaleDateString()} ${a.link ? `· <a href="${esc(a.link)}" target="_blank" rel="noopener">Where to watch</a>` : ''}</div></div>`).join('')
      : `<p class="muted">No alerts yet. You'll get one here (and on your phone via ntfy, if set up) when a movie on your list first becomes legally available anywhere, or gets a new option in ${cfg.home}.</p>`;
    return;
  }

  if (state.tab === 'soon') {
    const onList = new Set(state.watchlist.movies.map((m) => m.imdb_id));
    const cats = ['all', 'horror', 'animation', 'general'];
    const chips = `<div class="chips">${cats.map((c) => `<button data-soonc="${c}" class="${state.soonCat === c ? 'active' : ''}">${c === 'all' ? 'All' : c[0].toUpperCase() + c.slice(1)}</button>`).join('')}</div>`;
    const items = state.upcoming.filter((m) => state.soonCat === 'all' || m.category === state.soonCat);
    list.innerHTML = chips + (items.length ? items.map((m) => `
      <article class="card cat-${m.category}" data-soon="${m.tmdb_id}">
        ${m.poster ? `<img loading="lazy" src="${IMG}w185${m.poster}" alt="">` : '<div class="poster-ph"></div>'}
        <div>
          <h3>${esc(m.title)}</h3>
          <div class="meta">${[m.genres.slice(0, 3).join(', '), m.directors.length && `Dir. ${m.directors.join(', ')}`].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="badges">
            <span class="badge match">${m.match}% match</span>
            <span class="badge date">${esc(fmtDate(m.release.date))} · ${esc(m.release.type)}${m.release.where === cfg.home ? ` in ${esc(cfg.home)}` : ''}</span>
            ${onList.has(m.imdb_id) ? '<span class="badge stream">On your list</span>' : ''}
          </div>
          ${m.reasons?.length ? `<div class="reasons">${esc(m.reasons.slice(0, 2).join(' · '))}</div>` : ''}
          <div class="synopsis muted">${esc(m.overview || '')}</div>
        </div>
      </article>`).join('') : '<p class="muted">Upcoming movies appear after the next data update (Actions → Run workflow).</p>');
    return;
  }

  if (state.tab === 'recs') {
    const groups = ['horror', 'animation', 'general'].map((c) => {
      const items = state.recs[c] || [];
      if (!items.length) return '';
      return `<div class="section"><h4>${c}</h4><div class="row-scroll">${items.map((r) => `
        <div class="mini">
          ${r.poster ? `<img loading="lazy" src="${IMG}w185${r.poster}" alt="">` : '<div class="poster-ph"></div>'}
          <div>${esc(r.title)} ${r.year ? `(${esc(r.year)})` : ''}</div>
          <div class="muted">because of ${esc(r.because?.[0] || '')}</div>
          <button data-addtmdb="${r.tmdb_id}" data-cat="${c}" data-title="${esc(r.title)}">＋ Add</button>
        </div>`).join('')}</div></div>`;
    }).join('');
    list.innerHTML = groups || '<p class="muted">Recommendations appear after the first data update.</p>';
    return;
  }

  const onlyCH = $('#f-ch').checked, showWatched = $('#f-watched').checked, onlyNetflix = $('#f-netflix').checked;
  const items = mergedList()
    .filter((m) => m.category === state.tab)
    .filter((m) => showWatched || !m.watched)
    .filter((m) => !onlyCH || homeOffers(m).length)
    .filter((m) => !onlyNetflix || onNetflix(m))
    .sort((a, b) => onNetflix(b) - onNetflix(a) || (homeOffers(b).length > 0) - (homeOffers(a).length > 0) || (b.added || '').localeCompare(a.added || ''));
  list.innerHTML = items.length ? items.map(card).join('') : '<p class="muted">Nothing here yet — tap ＋ Add.</p>';
}

function providerList(entry) {
  return Object.keys(OFFER_LABEL).filter((t) => entry[t]).map((t) => `
    <div><span class="muted">${OFFER_LABEL[t]}:</span>
    <div class="providers">${entry[t].map((p) => `<span class="provider">${p.logo ? `<img src="${IMG}w45${p.logo}" alt="">` : ''}${esc(p.name)}</span>`).join('')}</div></div>`).join('');
}

function openDetail(id) {
  const m = mergedList().find((x) => x.imdb_id === id);
  if (!m) return;
  const home = m.availability?.[cfg.home];
  const others = Object.entries(m.availability || {}).filter(([cc]) => cc !== cfg.home)
    .sort(([a], [b]) => regionName(a).localeCompare(regionName(b)));
  const homeRel = m.releases?.byCountry?.[cfg.home] || [];
  const ratings = [
    m.ratings?.imdb && `IMDb <b>${m.ratings.imdb.value}</b>/10 (${esc(m.ratings.imdb.votes)})`,
    m.ratings?.tmdb && `TMDB <b>${m.ratings.tmdb.value.toFixed(1)}</b>`,
    m.ratings?.metascore && `Metascore <b>${m.ratings.metascore}</b>`,
    ...(m.ratings?.others || []).filter((r) => r.Source === 'Rotten Tomatoes').map((r) => `RT <b>${esc(r.Value)}</b>`),
  ].filter(Boolean).join(' · ');

  $('#detail-body').innerHTML = `
    <div class="hero" style="background-image:url('${m.backdrop ? IMG + 'w780' + m.backdrop : ''}')">
      <button class="close" data-close>✕</button>
    </div>
    <div class="detail-inner">
      <h2>${esc(m.title || m.imdb_id)} ${m.year ? `<span class="muted">(${esc(m.year)})</span>` : ''}</h2>
      ${m.tagline ? `<div class="muted"><i>${esc(m.tagline)}</i></div>` : ''}
      <div class="meta">${[m.rated, m.runtime && `${m.runtime} min`, (m.genres || []).join(', '), m.countries?.join(', ')].filter(Boolean).map(esc).join(' · ')}</div>
      ${ratings ? `<div>${ratings}</div>` : ''}
      ${m.awards ? `<div class="meta">🏆 ${esc(m.awards)}</div>` : ''}

      ${onNetflix(m) ? `<div class="badges">${NETFLIX_BADGE}<span class="meta">Included in your Netflix subscription</span></div>` : ''}
      <div class="section"><h4>Watch legally in ${esc(regionName(cfg.home))}</h4>
        ${home ? providerList(home) + `<p><a href="${esc(home.link)}" target="_blank" rel="noopener">Open offers (JustWatch/TMDB) →</a></p>`
               : `<p class="muted">Not available in ${esc(cfg.home)} yet.${upcomingLegal(m) ? ` Expected: ${esc(upcomingLegal(m))}.` : ''} You'll get an alert when it appears.</p>`}
      </div>

      ${homeRel.length ? `<div class="section"><h4>Release dates in ${esc(cfg.home)}</h4><table class="rel">${homeRel.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.type)}</td><td class="muted">${esc(r.note || '')}</td></tr>`).join('')}</table></div>` : ''}

      ${others.length ? `<div class="section"><details><summary>Available legally in ${others.length} other countries</summary>
        ${others.map(([cc, e]) => `<div style="margin-top:8px"><b>${esc(regionName(cc))}</b> <a href="${esc(e.link)}" target="_blank" rel="noopener">→</a>${providerList(e)}</div>`).join('')}
      </details></div>` : ''}

      <div class="section"><h4>Story</h4><p>${esc(m.plot_imdb || m.overview || '')}</p></div>
      ${m.directors?.length ? `<div class="meta">Director: ${esc(m.directors.join(', '))}${m.writers?.length ? ` · Writers: ${esc(m.writers.join(', '))}` : ''}</div>` : ''}
      ${m.cast?.length ? `<div class="section"><h4>Cast</h4><div class="row-scroll">${m.cast.map((c) => `<div class="mini">${c.photo ? `<img loading="lazy" src="${IMG}w185${c.photo}" alt="">` : '<div class="poster-ph" style="width:92px;height:138px"></div>'}<div>${esc(c.name)}</div><div class="muted">${esc(c.character)}</div></div>`).join('')}</div></div>` : ''}
      ${m.recommendations?.length ? `<div class="section"><h4>If you like this</h4><div class="row-scroll">${m.recommendations.map((r) => `<div class="mini">${r.poster ? `<img loading="lazy" src="${IMG}w185${r.poster}" alt="">` : ''}<div>${esc(r.title)}</div><button data-addtmdb="${r.tmdb_id}" data-title="${esc(r.title)}">＋</button></div>`).join('')}</div></div>` : ''}

      <div class="actions">
        <a href="${esc(m.imdb_url || `https://www.imdb.com/title/${m.imdb_id}/`)}" target="_blank" rel="noopener"><button>IMDb</button></a>
        ${m.trailer ? `<a href="${esc(m.trailer)}" target="_blank" rel="noopener"><button>▶ Trailer</button></a>` : ''}
        <button data-act="watched">${m.watched ? 'Mark unwatched' : '✓ Watched'}</button>
        ${['horror', 'animation', 'general'].filter((c) => c !== m.category).map((c) => `<button data-act="move" data-cat="${c}">→ ${c}</button>`).join('')}
        <button class="danger" data-act="remove">Remove</button>
      </div>
    </div>`;
  $('#detail').dataset.id = id;
  $('#detail').showModal();
}


const fmtDate = (iso) => { try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return iso; } };

function openSoon(tmdbId) {
  const m = state.upcoming.find((x) => String(x.tmdb_id) === String(tmdbId));
  if (!m) return;
  const onList = state.watchlist.movies.some((w) => w.imdb_id === m.imdb_id);
  $('#detail-body').innerHTML = `
    <div class="hero" style="background-image:url('${m.backdrop ? IMG + 'w780' + m.backdrop : ''}')">
      <button class="close" data-close>✕</button>
    </div>
    <div class="detail-inner">
      <h2>${esc(m.title)}</h2>
      ${m.tagline ? `<div class="muted"><i>${esc(m.tagline)}</i></div>` : ''}
      <div class="meta">${[m.runtime && `${m.runtime} min`, m.genres.join(', '), m.countries.join(', ')].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="badges"><span class="badge match">${m.match}% match</span>
        <span class="badge date">${esc(fmtDate(m.release.date))} · ${esc(m.release.type)} ${m.release.where === cfg.home ? `in ${esc(regionName(cfg.home))}` : '(worldwide)'}</span></div>
      ${m.reasons?.length ? `<div class="reasons">Why: ${esc(m.reasons.join(' · '))}</div>` : ''}
      <div class="section"><h4>Synopsis</h4><p>${esc(m.overview || 'No synopsis yet.')}</p></div>
      <div class="meta">${m.directors.length ? `Director: ${esc(m.directors.join(', '))}` : ''}${m.writers.length ? ` · Writers: ${esc(m.writers.join(', '))}` : ''}</div>
      ${m.cast?.length ? `<div class="section"><h4>Cast</h4><div class="row-scroll">${m.cast.map((c) => `<div class="mini">${c.photo ? `<img loading="lazy" src="${IMG}w185${c.photo}" alt="">` : '<div class="poster-ph" style="width:92px;height:138px"></div>'}<div>${esc(c.name)}</div><div class="muted">${esc(c.character)}</div></div>`).join('')}</div></div>` : ''}
      <div class="actions">
        ${onList ? '<button disabled>✓ On your list</button>' : `<button class="primary" data-addsoon="${m.tmdb_id}">＋ Add to ${esc(m.category)}</button>`}
        ${m.trailer ? `<a href="${esc(m.trailer)}" target="_blank" rel="noopener"><button>▶ Trailer</button></a>` : ''}
        ${m.imdb_id ? `<a href="https://www.imdb.com/title/${esc(m.imdb_id)}/" target="_blank" rel="noopener"><button>IMDb</button></a>` : ''}
      </div>
      <p class="meta">Once added, you'll get an alert when it becomes legally watchable in ${esc(regionName(cfg.home))}.</p>
    </div>`;
  $('#detail').dataset.id = '';
  $('#detail').showModal();
}

async function addSoon(tmdbId) {
  const m = state.upcoming.find((x) => String(x.tmdb_id) === String(tmdbId));
  if (!m) return;
  if (m.imdb_id) await addMovie({ imdb_id: m.imdb_id, category: m.category, title: m.title });
  else await addByTmdbId(m.tmdb_id, m.category, m.title);
}

// ---------- adding movies ----------
function guessCategory(genreIds = []) {
  if (genreIds.includes(16)) return 'animation';
  if (genreIds.includes(27)) return 'horror';
  return 'general';
}

async function tmdbFetch(path, params = {}) {
  if (!cfg.tmdbToken) throw new Error('Add a TMDB token in Settings to search by title (or paste an IMDb ID).');
  const u = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${cfg.tmdbToken}` } });
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

async function addMovie({ imdb_id, category, title }) {
  if (state.watchlist.movies.some((m) => m.imdb_id === imdb_id)) { setStatus('Already on your list.'); return; }
  state.watchlist.movies.push({ imdb_id, category, added: new Date().toISOString().slice(0, 10), watched: false, pending_title: title });
  render();
  await saveWatchlist(`Add ${title || imdb_id} (${category})`);
}

async function addByTmdbId(tmdbId, catHint, title) {
  const d = await tmdbFetch(`/movie/${tmdbId}`, { append_to_response: 'external_ids' });
  const imdb = d.imdb_id || d.external_ids?.imdb_id;
  if (!imdb) throw new Error('No IMDb ID for this title yet.');
  const pick = document.querySelector('input[name=cat]:checked')?.value;
  const category = catHint || (pick && pick !== 'auto' ? pick : guessCategory(d.genres?.map((g) => g.id)));
  await addMovie({ imdb_id: imdb, category, title: d.title || title });
}

let searchTimer;
async function search(q) {
  const box = $('#results');
  const imdb = q.match(/tt\d{6,10}/)?.[0];
  if (imdb) {
    box.innerHTML = `<div class="result"><div></div><div>IMDb ID <b>${imdb}</b></div><button class="primary" data-addimdb="${imdb}">Add</button></div>`;
    return;
  }
  if (q.trim().length < 2) { box.innerHTML = ''; return; }
  try {
    const r = await tmdbFetch('/search/movie', { query: q, include_adult: 'false' });
    box.innerHTML = r.results.slice(0, 12).map((m) => `
      <div class="result">
        ${m.poster_path ? `<img src="${IMG}w92${m.poster_path}" alt="">` : '<img alt="">'}
        <div><b>${esc(m.title)}</b> <span class="muted">${esc(m.release_date?.slice(0, 4) || '')}</span><div class="meta">${esc((m.overview || '').slice(0, 90))}…</div></div>
        <button class="primary" data-addtmdb="${m.id}" data-title="${esc(m.title)}">Add</button>
      </div>`).join('') || '<p class="muted">No results.</p>';
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// ---------- events ----------
$('#tabs').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.tab; if (t) { state.tab = t; render(); } });
$('#f-ch').addEventListener('change', render);
$('#f-watched').addEventListener('change', render);
$('#f-netflix').addEventListener('change', render);
$('#list').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-soonc]');
  if (chip) { state.soonCat = chip.dataset.soonc; render(); return; }
  const soon = e.target.closest('[data-soon]');
  if (soon) { openSoon(soon.dataset.soon); return; }
  const add = e.target.closest('[data-addtmdb]');
  if (add) { e.stopPropagation(); addByTmdbId(add.dataset.addtmdb, add.dataset.cat, add.dataset.title).catch((x) => alert(x.message)); return; }
  const c = e.target.closest('.card'); if (c) openDetail(c.dataset.id);
});
$('#btn-add').addEventListener('click', () => { $('#q').value = ''; $('#results').innerHTML = ''; $('#add').showModal(); $('#q').focus(); });
$('#q').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(e.target.value), 350); });
$('#results').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  e.preventDefault();
  b.disabled = true; b.textContent = '…';
  try {
    if (b.dataset.addimdb) {
      const pick = document.querySelector('input[name=cat]:checked').value;
      await addMovie({ imdb_id: b.dataset.addimdb, category: pick === 'auto' ? 'general' : pick });
    } else {
      await addByTmdbId(b.dataset.addtmdb, null, b.dataset.title);
    }
    b.textContent = '✓ Added';
  } catch (x) { b.textContent = 'Error'; alert(x.message); }
});
$('#detail').addEventListener('click', async (e) => {
  const dlg = $('#detail');
  if (e.target === dlg || e.target.closest('[data-close]')) { dlg.close(); return; }
  const addS = e.target.closest('[data-addsoon]');
  if (addS) { addS.disabled = true; addSoon(addS.dataset.addsoon).then(() => { addS.textContent = '✓ Added'; render(); }).catch((x) => { addS.disabled = false; alert(x.message); }); return; }
  const add = e.target.closest('[data-addtmdb]');
  if (add) { addByTmdbId(add.dataset.addtmdb, null, add.dataset.title).then(() => { add.textContent = '✓'; }).catch((x) => alert(x.message)); return; }
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  const w = state.watchlist.movies.find((m) => m.imdb_id === dlg.dataset.id); if (!w) return;
  if (act === 'remove' && !confirm('Remove from your list?')) return;
  if (act === 'watched') w.watched = !w.watched;
  if (act === 'move') w.category = e.target.dataset.cat;
  if (act === 'remove') state.watchlist.movies = state.watchlist.movies.filter((m) => m !== w);
  dlg.close(); render();
  try { await saveWatchlist(`${act} ${w.imdb_id}`); } catch (x) { alert(x.message); }
});
$('#btn-settings').addEventListener('click', () => {
  const f = $('#settings-form');
  for (const k of ['repo', 'ghToken', 'tmdbToken', 'home']) f.elements[k].value = cfg[k] || (k === 'home' ? 'CH' : '');
  $('#settings').showModal();
});
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  const f = $('#settings-form');
  for (const k of ['repo', 'ghToken', 'tmdbToken', 'home']) cfg[k] = f.elements[k].value.trim();
  cfg.home = (cfg.home || 'CH').toUpperCase();
  localStorage.setItem('cinema-cfg', JSON.stringify(cfg));
  loadAll();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
loadAll();
