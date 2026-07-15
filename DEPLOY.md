# Deploying MoonSun.Earth to Cloudflare Pages

Static site → Cloudflare Pages via Wrangler direct upload.
Run these from this folder. `wrangler login` opens your browser to authorize.

> **Node note:** Wrangler 4 requires Node 22+. On Node 20, pin `wrangler@3`
> (used below) — it deploys to Pages identically. Or upgrade Node: `nvm install 22`.

## First time
```bash
# 1. Authorize wrangler with your Cloudflare account (opens a browser)
npx wrangler@3 login

# 2. Create the Pages project (once)
npx wrangler@3 pages project create moonsun-earth --production-branch production

# 3. Deploy the site
npx wrangler@3 pages deploy . --project-name moonsun-earth
```

Wrangler prints a `*.pages.dev` preview URL — open it to confirm it works.

## Attach the custom domain (moonsun.earth)
Since the domain is already in your Cloudflare account, easiest via dashboard:
**Workers & Pages → moonsun-earth → Custom domains → Set up a custom domain**
→ enter `moonsun.earth` (and `www.moonsun.earth` if you want). Cloudflare adds the
DNS + TLS automatically.

## Redeploying after changes
```bash
npx wrangler@3 pages deploy . --project-name moonsun-earth
```

## Security note
`app.js` contains your Cesium ion token (public-by-design, client-side). Once live,
restrict it in ion so it only works on your domain:
**ion.cesium.com → Access Tokens → (your token) → allowed URLs → add
`https://moonsun.earth`**. Then it can't be reused elsewhere.
