# CS355 Final Project — GitHub OAuth × OMDb Mashup

## Overview
This project is a server-side mashup built with **Node.js (http/https modules only)** that combines **GitHub OAuth** with the **OMDb API**.

The user submits their name and filtering preferences. The server authenticates the user using **3-Legged GitHub OAuth**, retrieves the authenticated GitHub user profile, and then uses that GitHub data to decide what movie genre to search for in OMDb. OMDb is never called independently — it is strictly driven by the GitHub API response.

All external API requests are performed **server-to-server**. The browser is only involved in navigation and OAuth redirects.

---

## APIs Used

### GitHub
- **Authorize Endpoint**  
  `GET https://github.com/login/oauth/authorize`  
  Used to initiate OAuth (client_id, redirect_uri, scope, state).

- **Token Endpoint**  
  `POST https://github.com/login/oauth/access_token`  
  Exchanges authorization code for an access token.

- **User Endpoint**  
  `GET https://api.github.com/user`  
  Retrieves the authenticated user’s profile using the access token.

### OMDb
- **Search Endpoint**  
  `GET https://www.omdbapi.com/?apikey=...&s=...&page=...`  
  Retrieves movie search results based on a genre-derived search term.

- **Details Endpoint**  
  `GET https://www.omdbapi.com/?apikey=...&i=IMDB_ID`  
  Retrieves detailed movie information used for filtering by rating.

---

## Request Flow (High Level)

1. Browser requests `/` → server returns landing page form.
2. Browser submits form to `/auth/github`.
3. Server redirects browser to GitHub OAuth authorize endpoint.
4. GitHub redirects back to `/oauth/github/callback` with `code` and `state`.
5. Server exchanges code for access token (GitHub API).
6. Server fetches GitHub user profile (GitHub API).
7. Server determines a movie genre from GitHub profile data.
8. Server searches OMDb and fetches movie details sequentially.
9. Server renders and returns a final HTML page.

This flow is documented visually in the **sequence diagram** included in the submission.

---

## Synchronous Behavior Guarantee

The project is designed to operate **synchronously** across multiple API domains:

- GitHub OAuth token exchange **must complete** before GitHub `/user` is requested.
- GitHub `/user` **must complete** before any OMDb request begins.
- OMDb detail requests are executed **sequentially**, not in parallel.

This is enforced structurally in the code using **nested callbacks**, not timing assumptions.

---

## Synchronous Testing (Lecture-Required Test)

To verify synchronous behavior, the project was tested using the method described in lecture:

1. Print statements were added to log when each API is called:
   - GitHub token exchange
   - GitHub `/user`
   - OMDb search
   - OMDb details

2. A temporary delay was introduced by wrapping the `.end()` call of the **first API request** in a `setTimeout` (e.g., 5 seconds).

3. When running the project with this delay:
   - The application took ~5 seconds longer to display results.
   - Subsequent API calls did **not** execute until the delayed request completed.
   - API log messages appeared strictly in order.

This confirmed that later API requests correctly wait for earlier responses.

After testing, the delay was removed and the code reverted to its original form before submission.

---

## Caching Strategy

The project uses **in-memory caching only**:
- OAuth state data is temporarily stored during the OAuth redirect flow and deleted immediately after use.
- Session data (GitHub user + access token) is stored in memory and cleared on logout or server restart.

No cache files are written to disk. Restarting the server clears all cached data.

---

## Resilience

- Invalid routes return `404 Not Found`.
- Invalid or missing OAuth parameters return `400 Bad Request`.
- Invalid user input is validated and rejected early.
- The server remains stable under repeated requests without requiring restarts.

---

## Notes

- The server can handle multiple sequential requests continuously.
- No client-side JavaScript API calls are used.
- All sensitive credentials remain server-side.

---

## Author
CS355 Final Project  
GitHub OAuth × OMDb Mashup
