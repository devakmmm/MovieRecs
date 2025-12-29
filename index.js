const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Load credentials from file if it exists (for local dev), otherwise use env vars
let credentials = { github: {}, omdb: {} };
const credPath = path.join(__dirname, "auth", "credentials.json");
if (fs.existsSync(credPath)) {
  credentials = require(credPath);
}

// ---------------- Config ----------------
const PORT = process.env.PORT || 3000;
const HOST = process.env.RENDER_EXTERNAL_HOSTNAME || process.env.HOST || "localhost";
const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.RENDER === "true";

// GitHub OAuth
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || credentials.github.client_id;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || credentials.github.client_secret;
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

// OMDb
const OMDB_API_KEY = process.env.OMDB_API_KEY || credentials.omdb.api_key;
const OMDB_BASE = "https://www.omdbapi.com/";

// In-memory stores
const oauth_state_store = new Map();
const session_store = new Map();

// Templates
const TPL = {
  index: load_template("html/index.html"),
  recommend: load_template("html/recommend.html"),
};

console.log(`🚀 Starting server...`);
console.log(`📍 Host: ${HOST}`);
console.log(`🔧 Environment: ${IS_PRODUCTION ? "Production" : "Development"}`);

// ---------------- Server ----------------
const server = http.createServer(request_handler);
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🌐 ${IS_PRODUCTION ? `https://${HOST}` : `http://localhost:${PORT}`}`);
});

// ---------------- Routing ----------------
function request_handler(req, res) {
  console.log(`${req.method} ${req.url}`);

  if (req.method === "GET" && req.url === "/") {
    return send_html(res, 200, TPL.index);
  }

  if (req.method === "GET" && req.url.startsWith("/auth/github")) {
    return start_github_oauth_or_run(req, res);
  }

  if (req.method === "GET" && req.url.startsWith("/oauth/github/callback")) {
    return handle_github_callback(req, res);
  }

  if (req.method === "GET" && req.url === "/me") {
    const session = get_session(req);
    return send_json(res, 200, session
      ? { logged_in: true, login: session.user.login, bio: session.user.bio, location: session.user.location }
      : { logged_in: false });
  }

  if (req.method === "GET" && req.url === "/logout") {
    return logout(req, res);
  }

  if (req.method === "GET" && req.url === "/health") {
    return send_json(res, 200, { status: "healthy", timestamp: new Date().toISOString() });
  }

  return send_text(res, 404, "404 Not Found");
}

// ---------------- Phase Driver ----------------
function start_github_oauth_or_run(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const full_name = (url.searchParams.get("full_name") || "").trim();
  const min_rating = clamp_float(url.searchParams.get("min_rating"), 0, 10, 7.0);
  const limit = clamp_int(url.searchParams.get("limit"), 1, 10, 10);

  if (!full_name) return send_text(res, 400, "Full name is required.");

  const session = get_session(req);
  if (session) {
    return run_pipeline_and_render(res, session.access_token, full_name, limit, min_rating);
  }

  const state = random_id();
  oauth_state_store.set(state, { created_at: Date.now(), full_name, min_rating, limit });

  // Build redirect URI based on environment
  const redirect_uri = IS_PRODUCTION
    ? `https://${HOST}/oauth/github/callback`
    : `http://localhost:${PORT}/oauth/github/callback`;

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri,
    scope: "read:user",
    state
  });

  res.writeHead(302, { Location: `${GITHUB_AUTHORIZE_URL}?${params.toString()}` });
  res.end();
}

// ---------------- OAuth Callback ----------------
function handle_github_callback(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state || !oauth_state_store.has(state)) {
    return send_text(res, 400, "OAuth Error: missing/invalid code or state.");
  }

  const { full_name, min_rating, limit } = oauth_state_store.get(state);
  oauth_state_store.delete(state);

  exchange_code_for_token(code, (err, access_token) => {
    if (err) return send_text(res, 500, `Token Exchange Failed: ${err}`);

    fetch_github_user(access_token, (err2, user) => {
      if (err2) return send_text(res, 500, `GitHub User Fetch Failed: ${err2}`);

      const sid = random_id();
      session_store.set(sid, { user, access_token, created_at: Date.now() });

      res.writeHead(200, {
        "Set-Cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; ${IS_PRODUCTION ? "Secure; SameSite=Lax" : ""}`,
        "Content-Type": "text/html; charset=utf-8"
      });

      run_pipeline(access_token, full_name, limit, min_rating, (err3, page_html) => {
        if (err3) return res.end(`<pre>${escape_html(err3)}</pre>`);
        res.end(page_html);
      });
    });
  });
}

function run_pipeline_and_render(res, access_token, full_name, limit, min_rating) {
  run_pipeline(access_token, full_name, limit, min_rating, (err, page_html) => {
    if (err) return send_text(res, 500, err);
    send_html(res, 200, page_html);
  });
}

// ---------------- Pipeline ----------------
function run_pipeline(access_token, full_name, limit, min_rating, cb) {
  fetch_github_user(access_token, (err, user) => {
    if (err) return cb(`GitHub API error: ${err}`);

    const bio = (user.bio || "").trim();
    const location = (user.location || "").trim();

    const decision = choose_genre_from_bio_location(bio, location);
    const search_term = genre_to_search_term(decision.genre);

    omdb_search_then_fill(search_term, limit, min_rating, (err2, movies, debug) => {
      if (err2) return cb(`OMDb error: ${err2}`);

      const cards_html = movies.map(movie_card_html).join("\n");

      const html = render(TPL.recommend, {
        FULL_NAME: escape_html(full_name),
        GITHUB_LOGIN: escape_html(user.login || ""),
        BIO: bio ? escape_html(bio) : "(no bio)",
        LOCATION: location ? escape_html(location) : "(no location)",
        GENRE: escape_html(decision.genre),
        REASON: escape_html(decision.reason),
        MIN_RATING: String(min_rating),
        LIMIT: String(limit),
        CARDS: cards_html || `<div class="empty-state"><div class="empty-icon">🎬</div><div class="empty-title">No Movies Found</div><div class="empty-text">Try adjusting your filters</div></div>`,
        DEBUG_JSON: escape_html(JSON.stringify(debug, null, 2))
      });

      cb(null, html);
    });
  });
}

// ---------------- GitHub HTTP helpers ----------------
function exchange_code_for_token(code, cb) {
  const post_data = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    client_secret: GITHUB_CLIENT_SECRET,
    code
  }).toString();

  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "Content-Length": Buffer.byteLength(post_data)
    }
  };

  const r = https.request(GITHUB_TOKEN_URL, options, (stream) => {
    collect_stream(stream, (body) => {
      try {
        const obj = JSON.parse(body);
        if (!obj.access_token) return cb("No access_token in response.", null);
        return cb(null, obj.access_token);
      } catch {
        return cb("Token response was not valid JSON.", null);
      }
    });
  });

  r.on("error", (e) => cb(`HTTPS error: ${e.message}`, null));
  r.end(post_data);
}

function fetch_github_user(access_token, cb) {
  const options = {
    method: "GET",
    headers: {
      "User-Agent": "cs355-movie-recommender",
      "Authorization": `Bearer ${access_token}`,
      "Accept": "application/vnd.github+json"
    }
  };

  const r = https.request(GITHUB_USER_URL, options, (stream) => {
    collect_stream(stream, (body) => {
      try {
        const user = JSON.parse(body);
        if (!user || !user.login) return cb("User response missing login.", null);
        return cb(null, user);
      } catch {
        return cb("User response was not valid JSON.", null);
      }
    });
  });

  r.on("error", (e) => cb(`HTTPS error: ${e.message}`, null));
  r.end();
}

// ---------------- Recommendation Logic ----------------
function choose_genre_from_bio_location(bio, location) {
  const b = normalize_text(bio);

  const coding_words = [
    "computer science","software","developer","dev","programmer","coding","code",
    "javascript","node","python","java","c++","cs","engineering","engineer",
    "full stack","fullstack","backend","frontend","ai","ml","machine learning"
  ];
  
  if (contains_any_phrase(b, coding_words)) {
    return { genre: "Sci-Fi", reason: "Bio contains coding-related keywords → Sci-Fi preference." };
  }

  if (!b) {
    const loc = normalize_text(location);
    if (loc.includes("new york") || loc.includes("nyc") || loc.includes("ny")) {
      return { genre: "Action", reason: "No bio; location indicates New York → Action preference." };
    }
    return { genre: "Drama", reason: "No bio; location not mapped → Drama preference." };
  }

  if (is_name_only_bio(bio)) {
    return { genre: "Thriller", reason: "Bio appears to be name-only → Thriller preference." };
  }

  return { genre: "Drama", reason: "No matched keywords → Drama preference." };
}

function genre_to_search_term(genre) {
  const g = normalize_text(genre);
  if (g.includes("sci")) return "science fiction";
  return genre;
}

function is_name_only_bio(original_bio) {
  const raw = (original_bio || "").trim();
  if (!raw) return false;
  const cleaned = raw.replace(/[^A-Za-z\s]/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return (parts.length >= 1 && parts.length <= 3);
}

// ---------------- OMDb ----------------
function omdb_search_then_fill(search_term, limit, min_rating, cb) {
  const debug = { search_term, limit, min_rating, steps: [] };
  const MAX_PAGES = 5;
  const seen = new Set();
  const candidates = [];

  function fetch_page(page) {
    const params = new URLSearchParams({
      apikey: OMDB_API_KEY,
      s: search_term,
      type: "movie",
      page: String(page)
    });

    const endpoint = `${OMDB_BASE}?${params.toString()}`;
    debug.steps.push({ step: "search", page, endpoint });

    https_get_json(endpoint, (err, data) => {
      if (err) return cb(err, [], debug);

      if (!data || data.Response === "False") {
        debug.steps.push({ step: "search_page_empty", page, error: data && data.Error ? data.Error : "Unknown" });
        return finish();
      }

      const pageResults = Array.isArray(data.Search) ? data.Search : [];
      for (const r of pageResults) {
        if (r && r.imdbID && !seen.has(r.imdbID)) {
          seen.add(r.imdbID);
          candidates.push(r);
        }
      }

      if (page >= MAX_PAGES || candidates.length >= 45) return finish();
      fetch_page(page + 1);
    });
  }

  function finish() {
    debug.steps.push({ step: "final_candidates", count: candidates.length });
    if (candidates.length === 0) return cb(null, [], debug);
    fetch_details_sequential(candidates, 0, [], limit, min_rating, debug, cb);
  }

  fetch_page(1);
}

function fetch_details_sequential(candidates, i, acc, limit, min_rating, debug, cb) {
  if (acc.length >= limit) return cb(null, acc, debug);
  if (i >= candidates.length) return cb(null, acc, debug);

  const imdbID = candidates[i] && candidates[i].imdbID;
  if (!imdbID) return fetch_details_sequential(candidates, i + 1, acc, limit, min_rating, debug, cb);

  const endpoint = `${OMDB_BASE}?${new URLSearchParams({
    apikey: OMDB_API_KEY,
    i: imdbID,
    plot: "short"
  }).toString()}`;

  https_get_json(endpoint, (err, movie) => {
    if (!err && movie && movie.Response !== "False") {
      const rating = parseFloat(movie.imdbRating);
      const passes = Number.isFinite(rating) && rating >= min_rating;

      if (passes) {
        acc.push(movie);
      } else {
        debug.steps.push({ step: "filtered_out", imdbID, imdbRating: movie.imdbRating });
      }
    }
    fetch_details_sequential(candidates, i + 1, acc, limit, min_rating, debug, cb);
  });
}

// ---------------- Card rendering ----------------
function movie_card_html(m) {
  const title = escape_html(m.Title || "Untitled");
  const year = escape_html(m.Year || "N/A");
  const runtime = escape_html(m.Runtime || "N/A");
  const rating = escape_html((m.imdbRating && m.imdbRating !== "N/A") ? m.imdbRating : "N/A");
  const plot = escape_html((m.Plot && m.Plot !== "N/A") ? m.Plot : "No plot available.");
  const poster = (m.Poster && m.Poster !== "N/A") ? escape_attr(m.Poster) : "";

  const genre = (m.Genre && m.Genre !== "N/A") ? m.Genre : "";
  const chips = genre
    ? genre.split(",").slice(0, 3).map(g => `<span class="genre-tag">${escape_html(g.trim())}</span>`).join("")
    : `<span class="genre-tag">Genre N/A</span>`;

  return `
    <div class="movie-card">
      <div class="poster-container">
        ${poster ? `<img class="poster" src="${poster}" alt="${title} Poster">` : `<div class="poster-placeholder">🎬</div>`}
        <div class="rating-overlay">
          <span class="star">⭐</span>
          ${rating}
        </div>
      </div>
      <div class="card-content">
        <div class="movie-title">${title}</div>
        <div class="movie-meta">
          <span>📅 ${year}</span>
          <span>⏱️ ${runtime}</span>
        </div>
        <div class="genre-tags">${chips}</div>
        <div class="plot">${plot}</div>
      </div>
    </div>
  `;
}

// ---------------- Utilities ----------------
function load_template(relPath) {
  return fs.readFileSync(path.join(__dirname, relPath), "utf8");
}

function render(tpl, vars) {
  return tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ""));
}

function https_get_json(url, cb) {
  const r = https.request(url, { method: "GET" }, (stream) => {
    collect_stream(stream, (body) => {
      try { cb(null, JSON.parse(body)); }
      catch { cb("Response was not valid JSON.", null); }
    });
  });
  r.on("error", (e) => cb(`HTTPS error: ${e.message}`, null));
  r.end();
}

function collect_stream(stream, cb) {
  let body = "";
  stream.on("data", (chunk) => (body += chunk));
  stream.on("end", () => cb(body));
}

function send_html(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function send_text(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function send_json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj, null, 2));
}

function logout(req, res) {
  const sid = get_cookie(req, "sid");
  if (sid) session_store.delete(sid);

  res.writeHead(302, {
    "Set-Cookie": `sid=; HttpOnly; Path=/; Max-Age=0${IS_PRODUCTION ? "; Secure; SameSite=Lax" : ""}`,
    Location: "/"
  });
  res.end();
}

function random_id() {
  return crypto.randomBytes(20).toString("hex");
}

function get_cookie(req, name) {
  const cookie = req.headers.cookie || "";
  const parts = cookie.split(";").map(s => s.trim());
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function get_session(req) {
  const sid = get_cookie(req, "sid");
  if (!sid) return null;
  return session_store.get(sid) || null;
}

function normalize_text(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function contains_any_phrase(text, phrases) {
  for (const p of phrases) {
    if (text.includes(String(p).toLowerCase())) return true;
  }
  return false;
}

function escape_html(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escape_attr(s) {
  return escape_html(s).replaceAll("`", "&#096;");
}

function clamp_int(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clamp_float(v, min, max, fallback) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}