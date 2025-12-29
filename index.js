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
/**
 * session_store entry shape:
 * sid => {
 *   user, access_token, created_at,
 *   preferenceBias: { [genre]: number },  // per-user adaptive bias
 *   last: { genre, moviesById: { [imdbID]: movie }, ts }
 * }
 */
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

  // Start keep-alive ping in production
  if (IS_PRODUCTION) {
    startKeepAlivePing();
  }
});

// ---------------- Keep-Alive Ping ----------------
function startKeepAlivePing() {
  const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
  const url = `https://${HOST}/health`;
  console.log(`⏰ Keep-alive ping enabled: ${url} every 14 minutes`);

  setInterval(() => {
    https
      .get(url, (res) => {
        console.log(`💓 Keep-alive ping: ${res.statusCode} at ${new Date().toISOString()}`);
      })
      .on("error", (err) => {
        console.log(`❌ Keep-alive ping failed: ${err.message}`);
      });
  }, PING_INTERVAL);
}

/* ========================================================================
   ML-ish Genre Model (Multinomial Naive Bayes + priors + online updates)
   ======================================================================== */

const GENRE_LABELS = ["Sci-Fi", "Action", "Thriller", "Drama", "Mystery", "Romance"];

/**
 * Seed dataset: small but credible; expand over time.
 * You can tune this without changing any architecture.
 */
const SEED_TRAINING = [
  // Sci-Fi / Tech
  { text: "software engineer backend node javascript python ai machine learning", label: "Sci-Fi" },
  { text: "computer science developer full stack api oauth systems", label: "Sci-Fi" },
  { text: "data engineer ml ai analytics sql database", label: "Sci-Fi" },
  { text: "robotics engineer distributed systems cloud", label: "Sci-Fi" },

  // Action / sports / high energy
  { text: "athlete captain soccer competitive fast paced", label: "Action" },
  { text: "founder startup builder ship product hustle", label: "Action" },
  { text: "fitness gym training performance discipline", label: "Action" },

  // Thriller / security / intensity
  { text: "security reverse engineering c c++ low level cryptography", label: "Thriller" },
  { text: "debugging deep dive intense problem solver", label: "Thriller" },
  { text: "firmware embedded systems hardware", label: "Thriller" },

  // Drama / creative / people
  { text: "designer ui ux art music film cinema writer storytelling", label: "Drama" },
  { text: "education teaching community culture sociology", label: "Drama" },
  { text: "dance theatre performance", label: "Drama" },

  // Mystery / research / analysis
  { text: "research investigation evidence analysis patterns", label: "Mystery" },
  { text: "law policy reasoning", label: "Mystery" },

  // Romance / empathy / relationships
  { text: "community empathy people relationships communication", label: "Romance" },
  { text: "social work counseling care psychology", label: "Romance" },
];

const GENRE_MODEL = createNaiveBayesModel(GENRE_LABELS);
GENRE_MODEL.trainBatch(SEED_TRAINING);

/**
 * Deep genre choice:
 * - ML classification on (bio + location)
 * - heuristic priors (empty bio/name-only/location)
 * - per-user adaptive bias (from feedback)
 * Returns: { genre, reason, confidence, debug }
 */
function choose_genre_deep(bio, location, userBias) {
  const bioRaw = (bio || "").trim();
  const locRaw = (location || "").trim();
  const bioNorm = normalize_text(bioRaw);
  const locNorm = normalize_text(locRaw);

  // --- Heuristic priors (light, additive) ---
  const priors = new Map();
  for (const g of GENRE_LABELS) priors.set(g, 0);

  const heuristicNotes = [];

  if (!bioNorm) {
    priors.set("Drama", priors.get("Drama") + 0.7);
    heuristicNotes.push("No bio → slight prior toward Drama (broad default).");
  }

  if (bioRaw && is_name_only_bio(bioRaw)) {
    priors.set("Thriller", priors.get("Thriller") + 0.9);
    heuristicNotes.push("Name-only bio → prior toward Thriller (engagement baseline).");
  }

  if (locNorm.includes("new york") || locNorm.includes("nyc") || locNorm === "ny") {
    priors.set("Action", priors.get("Action") + 0.35);
    heuristicNotes.push("NYC location → small Action prior (urban pace).");
  }

  if (locNorm.includes("san francisco") || locNorm.includes("bay area") || locNorm.includes("seattle")) {
    priors.set("Sci-Fi", priors.get("Sci-Fi") + 0.35);
    heuristicNotes.push("Tech hub location → small Sci-Fi prior.");
  }

  // --- Per-user adaptive bias (from feedback) ---
  const biasNotes = [];
  if (userBias && typeof userBias === "object") {
    for (const g of GENRE_LABELS) {
      const v = Number(userBias[g] || 0);
      if (Number.isFinite(v) && v !== 0) {
        priors.set(g, priors.get(g) + v);
      }
    }
    const topBias = Object.entries(userBias)
      .filter(([, v]) => Number(v) !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 2);
    if (topBias.length) {
      biasNotes.push(
        `User feedback bias applied: ${topBias.map(([g, v]) => `${g} ${v > 0 ? "+" : ""}${v.toFixed(2)}`).join(", ")}.`
      );
    }
  }

  // --- ML classification ---
  const joined = `${bioRaw} ${locRaw}`.trim();
  const ml = GENRE_MODEL.predict(joined);
  const probs = softmaxFromLogScores(ml.scores);

  // --- Combine ML probabilities + priors ---
  const combined = new Map();
  for (const g of GENRE_LABELS) {
    combined.set(g, (probs.get(g) || 0) + (priors.get(g) || 0));
  }

  // Choose winner
  const priority = ["Sci-Fi", "Action", "Thriller", "Mystery", "Drama", "Romance"];
  let bestGenre = priority[0];
  let bestScore = -Infinity;
  for (const g of priority) {
    const s = combined.get(g);
    if (s > bestScore) {
      bestScore = s;
      bestGenre = g;
    }
  }

  // Confidence estimate
  const total = [...combined.values()].reduce((a, b) => a + b, 0) || 1;
  const confidence = (combined.get(bestGenre) || 0) / total;

  // Explanation (interpretable)
  const topTokens = ml.topTokensByLabel(bestGenre, 6);
  const tokenExpl = topTokens.length
    ? `Top tokens driving ${bestGenre}: ${topTokens.map((t) => `"${t.token}"`).join(", ")}.`
    : `No dominant tokens; selection relied on combined priors.`;

  const reason = [
    `Selected ${bestGenre} (confidence ${(confidence * 100).toFixed(0)}%).`,
    tokenExpl,
    heuristicNotes.length ? `Heuristics: ${heuristicNotes.join(" ")}` : "",
    biasNotes.length ? biasNotes.join(" ") : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    genre: bestGenre,
    reason,
    confidence,
    debug: {
      ml_probs: Object.fromEntries([...probs.entries()].map(([k, v]) => [k, +v.toFixed(4)])),
      priors: Object.fromEntries([...priors.entries()].map(([k, v]) => [k, +v.toFixed(3)])),
      combined: Object.fromEntries([...combined.entries()].map(([k, v]) => [k, +v.toFixed(4)])),
      top_tokens: topTokens,
    },
  };
}

function createNaiveBayesModel(labels) {
  const wordCounts = new Map(); // label -> Map(token -> count)
  const docCounts = new Map(); // label -> docs count
  const totalWords = new Map(); // label -> total token count
  const vocab = new Set();

  for (const l of labels) {
    wordCounts.set(l, new Map());
    docCounts.set(l, 0);
    totalWords.set(l, 0);
  }

  function trainOne(label, text) {
    if (!wordCounts.has(label)) return;

    docCounts.set(label, (docCounts.get(label) || 0) + 1);
    const tokens = tokenize(text);

    const m = wordCounts.get(label);
    for (const tok of tokens) {
      vocab.add(tok);
      m.set(tok, (m.get(tok) || 0) + 1);
      totalWords.set(label, (totalWords.get(label) || 0) + 1);
    }
  }

  function trainBatch(samples) {
    for (const s of samples) trainOne(s.label, s.text);
  }

  function predict(text) {
    const tokens = tokenize(text);
    const vocabSize = vocab.size || 1;
    const totalDocs = labels.reduce((sum, l) => sum + (docCounts.get(l) || 0), 0) || 1;

    const scores = new Map(); // label -> log score

    for (const label of labels) {
      // smoothed prior
      const prior = Math.log(((docCounts.get(label) || 0) + 1) / (totalDocs + labels.length));

      const m = wordCounts.get(label);
      const denom = (totalWords.get(label) || 0) + vocabSize;

      let score = prior;
      for (const tok of tokens) {
        const count = (m.get(tok) || 0) + 1; // Laplace
        score += Math.log(count / denom);
      }
      scores.set(label, score);
    }

    function topTokensByLabel(label, k) {
      const m = wordCounts.get(label) || new Map();
      const denom = (totalWords.get(label) || 0) + (vocab.size || 1);
      const tokenSet = new Set(tokens);

      const contributions = [];
      for (const tok of tokenSet) {
        const count = (m.get(tok) || 0) + 1;
        const p = count / denom;
        contributions.push({ token: tok, approxWeight: p });
      }
      contributions.sort((a, b) => b.approxWeight - a.approxWeight);
      return contributions.slice(0, k);
    }

    return { scores, topTokensByLabel };
  }

  function stats() {
    const out = {};
    for (const l of labels) out[l] = { docs: docCounts.get(l) || 0, words: totalWords.get(l) || 0 };
    return { labels: [...labels], vocabSize: vocab.size || 0, perLabel: out };
  }

  return { trainOne, trainBatch, predict, stats };
}

function tokenize(text) {
  return normalize_text(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 120);
}

function softmaxFromLogScores(scoreMap) {
  let max = -Infinity;
  for (const v of scoreMap.values()) if (v > max) max = v;

  let sum = 0;
  const exps = new Map();
  for (const [k, v] of scoreMap.entries()) {
    const e = Math.exp(v - max);
    exps.set(k, e);
    sum += e;
  }

  const probs = new Map();
  for (const [k, e] of exps.entries()) probs.set(k, e / (sum || 1));
  return probs;
}

/* ========================================================================
   Routing
   ======================================================================== */

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
    return send_json(
      res,
      200,
      session
        ? {
            logged_in: true,
            login: session.user.login,
            bio: session.user.bio,
            location: session.user.location,
            preferenceBias: session.preferenceBias || {},
            modelStats: GENRE_MODEL.stats(),
          }
        : { logged_in: false }
    );
  }

  if (req.method === "POST" && req.url === "/feedback") {
    return handle_feedback(req, res);
  }

  if (req.method === "GET" && req.url === "/logout") {
    return logout(req, res);
  }

  if (req.method === "GET" && req.url === "/health") {
    return send_json(res, 200, {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: IS_PRODUCTION ? "production" : "development",
    });
  }

  return send_text(res, 404, "404 Not Found");
}

/* ========================================================================
   Phase Driver
   ======================================================================== */

function start_github_oauth_or_run(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const full_name = (url.searchParams.get("full_name") || "").trim();
  const min_rating = clamp_float(url.searchParams.get("min_rating"), 0, 10, 7.0);
  const limit = clamp_int(url.searchParams.get("limit"), 1, 10, 10);

  if (!full_name) return send_text(res, 400, "Full name is required.");

  const session = get_session(req);
  if (session) {
    return run_pipeline_and_render(req, res, session.access_token, full_name, limit, min_rating);
  }

  const state = random_id();
  oauth_state_store.set(state, { created_at: Date.now(), full_name, min_rating, limit });

  const redirect_uri = IS_PRODUCTION
    ? `https://${HOST}/oauth/github/callback`
    : `http://localhost:${PORT}/oauth/github/callback`;

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri,
    scope: "read:user",
    state,
  });

  res.writeHead(302, { Location: `${GITHUB_AUTHORIZE_URL}?${params.toString()}` });
  res.end();
}

/* ========================================================================
   OAuth Callback
   ======================================================================== */

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
      session_store.set(sid, {
        user,
        access_token,
        created_at: Date.now(),
        preferenceBias: init_bias(),
        last: null,
      });

      res.writeHead(200, {
        "Set-Cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; ${
          IS_PRODUCTION ? "Secure; SameSite=Lax" : ""
        }`,
        "Content-Type": "text/html; charset=utf-8",
      });

      run_pipeline(access_token, sid, full_name, limit, min_rating, (err3, page_html) => {
        if (err3) return res.end(`<pre>${escape_html(err3)}</pre>`);
        res.end(page_html);
      });
    });
  });
}

function run_pipeline_and_render(req, res, access_token, full_name, limit, min_rating) {
  const sid = get_cookie(req, "sid");
  run_pipeline(access_token, sid, full_name, limit, min_rating, (err, page_html) => {
    if (err) return send_text(res, 500, err);
    send_html(res, 200, page_html);
  });
}

/* ========================================================================
   Pipeline
   ======================================================================== */

function run_pipeline(access_token, sid, full_name, limit, min_rating, cb) {
  fetch_github_user(access_token, (err, user) => {
    if (err) return cb(`GitHub API error: ${err}`);

    const bio = (user.bio || "").trim();
    const location = (user.location || "").trim();

    // pull user bias from session if available
    const session = sid ? session_store.get(sid) : null;
    const userBias = session && session.preferenceBias ? session.preferenceBias : init_bias();

    const decision = choose_genre_deep(bio, location, userBias);

    const search_term = genre_to_search_term(decision.genre);

    omdb_search_then_fill(search_term, limit, min_rating, (err2, movies, debug) => {
      if (err2) return cb(`OMDb error: ${err2}`);

      const moviesById = {};
      for (const m of movies) {
        if (m && m.imdbID) moviesById[m.imdbID] = m;
      }

      // store last run for feedback endpoint
      if (session && sid) {
        session.user = user; // refresh user data
        session.last = { genre: decision.genre, moviesById, ts: Date.now() };
      }

      const cards_html = movies.map(movie_card_html).join("\n");
      const feedback_script = make_feedback_script();

      const html = render(TPL.recommend, {
        FULL_NAME: escape_html(full_name),
        GITHUB_LOGIN: escape_html(user.login || ""),
        BIO: bio ? escape_html(bio) : "(no bio)",
        LOCATION: location ? escape_html(location) : "(no location)",
        GENRE: escape_html(decision.genre),
        REASON: escape_html(decision.reason),
        MIN_RATING: String(min_rating),
        LIMIT: String(limit),
        CARDS:
          (cards_html ||
            `<div class="empty-state"><div class="empty-icon">🎬</div><div class="empty-title">No Movies Found</div><div class="empty-text">Try adjusting your filters</div></div>`) +
          feedback_script,
        DEBUG_JSON: escape_html(
          JSON.stringify(
            {
              ...debug,
              genreDecision: decision.debug,
              modelStats: GENRE_MODEL.stats(),
              userBias,
            },
            null,
            2
          )
        ),
      });

      cb(null, html);
    });
  });
}

/* ========================================================================
   Feedback Loop
   - POST /feedback { imdbID, action: "like"|"dislike" }
   - like: updates per-user bias AND incrementally trains global model on movie text for the chosen genre
   - dislike: updates per-user bias away from the current genre (no global "negative" update)
   ======================================================================== */

function handle_feedback(req, res) {
  const session = get_session(req);
  if (!session) return send_json(res, 401, { ok: false, error: "Not logged in." });

  parse_json_body(req, (err, body) => {
    if (err) return send_json(res, 400, { ok: false, error: err });

    const imdbID = String(body.imdbID || "").trim();
    const action = String(body.action || "").trim().toLowerCase();

    if (!imdbID || (action !== "like" && action !== "dislike")) {
      return send_json(res, 400, { ok: false, error: "Expected { imdbID, action: like|dislike }" });
    }

    if (!session.last || !session.last.moviesById || !session.last.genre) {
      return send_json(res, 400, { ok: false, error: "No active recommendation session to provide feedback on." });
    }

    const movie = session.last.moviesById[imdbID];
    if (!movie) {
      return send_json(res, 404, { ok: false, error: "Movie not found in last recommendation results." });
    }

    const chosenGenre = session.last.genre;

    // Ensure bias map exists
    if (!session.preferenceBias) session.preferenceBias = init_bias();

    // Adjust per-user bias
    const STEP = 0.25; // tune this
    if (action === "like") {
      session.preferenceBias[chosenGenre] = clamp_num((session.preferenceBias[chosenGenre] || 0) + STEP, -2, 2);
    } else {
      // dislike: move away from this genre slightly
      session.preferenceBias[chosenGenre] = clamp_num((session.preferenceBias[chosenGenre] || 0) - STEP, -2, 2);
    }

    // Online learning (global model) only for "like"
    // We train on movie metadata text to strengthen association between user-chosen genre and movie content.
    if (action === "like") {
      const trainingText = build_movie_training_text(movie);
      GENRE_MODEL.trainOne(chosenGenre, trainingText);
    }

    return send_json(res, 200, {
      ok: true,
      action,
      imdbID,
      appliedGenre: chosenGenre,
      updatedBias: session.preferenceBias,
      modelStats: GENRE_MODEL.stats(),
    });
  });
}

function build_movie_training_text(movie) {
  const parts = [
    movie.Title,
    movie.Genre,
    movie.Plot,
    movie.Actors,
    movie.Director,
    movie.Writer,
    movie.Year,
  ]
    .filter(Boolean)
    .join(" ");
  return parts;
}

function init_bias() {
  const out = {};
  for (const g of GENRE_LABELS) out[g] = 0;
  return out;
}

function clamp_num(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(min, Math.min(max, x));
}

/* ========================================================================
   GitHub HTTP helpers
   ======================================================================== */

function exchange_code_for_token(code, cb) {
  const post_data = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    client_secret: GITHUB_CLIENT_SECRET,
    code,
  }).toString();

  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "Content-Length": Buffer.byteLength(post_data),
    },
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
      Authorization: `Bearer ${access_token}`,
      Accept: "application/vnd.github+json",
    },
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

/* ========================================================================
   Recommendation Logic Helpers
   ======================================================================== */

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
  return parts.length >= 1 && parts.length <= 3;
}

/* ========================================================================
   OMDb
   ======================================================================== */

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
      page: String(page),
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
    plot: "short",
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

/* ========================================================================
   Card rendering + Feedback UI
   ======================================================================== */

function movie_card_html(m) {
  const title = escape_html(m.Title || "Untitled");
  const year = escape_html(m.Year || "N/A");
  const runtime = escape_html(m.Runtime || "N/A");
  const rating = escape_html(m.imdbRating && m.imdbRating !== "N/A" ? m.imdbRating : "N/A");
  const plot = escape_html(m.Plot && m.Plot !== "N/A" ? m.Plot : "No plot available.");
  const poster = m.Poster && m.Poster !== "N/A" ? escape_attr(m.Poster) : "";
  const imdbID = escape_attr(m.imdbID || "");

  const genre = m.Genre && m.Genre !== "N/A" ? m.Genre : "";
  const chips = genre
    ? genre
        .split(",")
        .slice(0, 3)
        .map((g) => `<span class="genre-tag">${escape_html(g.trim())}</span>`)
        .join("")
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

        <div class="fb-row">
          <button class="fb-btn fb-like" data-imdbid="${imdbID}" data-action="like" type="button">👍 Like</button>
          <button class="fb-btn fb-dislike" data-imdbid="${imdbID}" data-action="dislike" type="button">👎 Not for me</button>
          <span class="fb-status" aria-live="polite"></span>
        </div>
      </div>
    </div>
  `;
}

// Injects one script + minimal CSS additions (no template edits required)
function make_feedback_script() {
  return `
  <style>
    .fb-row{ display:flex; gap:10px; align-items:center; margin-top:12px; flex-wrap:wrap; }
    .fb-btn{
      padding:8px 10px;
      border-radius:10px;
      border:1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.06);
      color: rgba(255,255,255,.92);
      cursor:pointer;
      font-size:13px;
      transition: transform .15s ease, background .2s ease, border-color .2s ease;
    }
    .fb-btn:hover{ transform: translateY(-1px); border-color: rgba(229,9,20,.45); background: rgba(229,9,20,.12); }
    .fb-status{ font-size:12px; color: rgba(255,255,255,.65); }
  </style>
  <script>
    (function(){
      function closestCard(el){ while(el && !el.classList.contains('movie-card')) el = el.parentElement; return el; }
      async function sendFeedback(imdbID, action, statusEl){
        try{
          statusEl.textContent = "Saving...";
          const r = await fetch("/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imdbID, action })
          });
          const data = await r.json();
          if(!data.ok){ statusEl.textContent = data.error || "Failed"; return; }
          statusEl.textContent = action === "like" ? "Saved ✅ (will adapt)" : "Saved ✅";
        }catch(e){
          statusEl.textContent = "Network error";
        }
      }
      document.addEventListener("click", function(e){
        const btn = e.target && e.target.closest && e.target.closest(".fb-btn");
        if(!btn) return;
        const imdbID = btn.getAttribute("data-imdbid");
        const action = btn.getAttribute("data-action");
        const card = closestCard(btn);
        const statusEl = card ? card.querySelector(".fb-status") : null;
        if(!statusEl) return;
        sendFeedback(imdbID, action, statusEl);
      });
    })();
  </script>
  `;
}

/* ========================================================================
   Utilities
   ======================================================================== */

function load_template(relPath) {
  return fs.readFileSync(path.join(__dirname, relPath), "utf8");
}

function render(tpl, vars) {
  return tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ""));
}

function https_get_json(url, cb) {
  const r = https.request(url, { method: "GET" }, (stream) => {
    collect_stream(stream, (body) => {
      try {
        cb(null, JSON.parse(body));
      } catch {
        cb("Response was not valid JSON.", null);
      }
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
    Location: "/",
  });
  res.end();
}

function random_id() {
  return crypto.randomBytes(20).toString("hex");
}

function get_cookie(req, name) {
  const cookie = req.headers.cookie || "";
  const parts = cookie.split(";").map((s) => s.trim());
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

// JSON body parser for POST /feedback
function parse_json_body(req, cb) {
  const MAX = 64 * 1024; // 64 KB
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX) {
      cb("Payload too large.", null);
      req.destroy();
    }
  });
  req.on("end", () => {
    try {
      const obj = JSON.parse(body || "{}");
      cb(null, obj);
    } catch {
      cb("Invalid JSON body.", null);
    }
  });
  req.on("error", (e) => cb(`Request error: ${e.message}`, null));
}
