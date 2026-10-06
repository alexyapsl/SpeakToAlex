# SpeakToAlex

Personal request router. A static GitHub Pages page accepts a message, a Cloudflare Worker routes it through TypeSafe/Jev, and only high-urgency requests reveal the direct WhatsApp button.

## Architecture

- Public repo: static frontend only (`index.html`, `styles.css`, `app.js`).
- Cloudflare Worker (`worker/`): owns secrets, calls TypeSafe, applies routing rules, stores every message.
- Private storage repo: one JSON file per message under `inbox/YYYY/MM/<id>.json`.

Routing rules:

- Q1: `work` only if related to Alex's Samsung job; otherwise `personal`.
- Work label: `AX` for AI-related projects, `eStore` for Samsung online store / samsung.com / shop.samsung.com features, bugs, testing, orders, payments; otherwise `other`.
- Personal label: `fun` / `not_fun` only.
- Urgency: TypeSafe Score levels 0-9 are mapped to 1-10 and rounded. Rounded score 8-10 reveals WhatsApp.
- Low-confidence personal/work classification defaults to inbox + `needs_review`.
- TypeSafe failure defaults to inbox storage with `routing_status: "unrouted_api_error"`.

## Setup

1. Create a private GitHub repo for storage, suggested name: `SpeakToAlex-inbox`. Initialize it with a README so the default branch exists.
2. Create a GitHub PAT with `contents: write` on that private repo only.
3. Deploy the Worker:

   ```sh
   cd worker
   npx wrangler login
   npx wrangler secret put TYPESAFE_API_KEY
   npx wrangler secret put GITHUB_TOKEN
   # optional but recommended
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler deploy
   ```

4. Set Worker vars in `wrangler.toml` or dashboard:
   - `GITHUB_OWNER`
   - `GITHUB_REPO` = private storage repo
   - `GITHUB_BRANCH` = `main`
   - `ALLOWED_ORIGIN` = your GitHub Pages origin
5. Update `index.html` meta `speaktoalex-api` with the deployed Worker `/route` URL.
6. Enable GitHub Pages for this repo from `main` / root.

Local env files are for local development only. Do not commit `.env` or `.dev.vars`.

## Local test

```sh
cd worker
npm test
```

The tests mock TypeSafe answers and do not need an API key.
