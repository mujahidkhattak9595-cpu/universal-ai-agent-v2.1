# Universal AI Employee v2.1 - ONE-FILE edition

`backend_server.js` contains the whole app (server + all helper code + the web app). Files in this package, all in ONE flat folder (no sub-folders, so iPhone upload works):
`backend_server.js`, `package.json`, `Dockerfile`, `render.yaml`, `schema.sql`, `README.md`.

## Upload to GitHub from iPhone
1. Unzip in the Files app. 2. github.com > your repo > Add file > Upload files > choose all 6 files together > Commit.
3. Render > New > Blueprint > pick the repo (it uses the Dockerfile and installs Chromium).

## Settings (enter in Render, never in GitHub)
Required: `APP_PASSWORD`, `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY` (service_role key), `SHOPIFY_STORE_URL` (your-store.myshopify.com), `SHOPIFY_API_KEY` (Admin API access token, starts with shpat_), `SHOPIFY_API_SECRET`, `FB_PAGE_TOKEN`, `FB_PAGE_ID`.
Optional: `FB_USER_TOKEN`, `FB_CATALOG_ID`, `FB_GRAPH_VERSION` (default v18.0), `SHOPIFY_API_VERSION` (default 2024-01), `GROQ_MODEL`, `PORT`.
TikTok Shop (optional): `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`, `TIKTOK_ACCESS_TOKEN`, `TIKTOK_SHOP_CIPHER`, `TIKTOK_WAREHOUSE_ID`, `TIKTOK_CURRENCY` (default PKR).
Database: run `schema.sql` once in Supabase (SQL Editor).

## Honest status
This package was checked only by a syntax check and a load test with stand-in modules (all routes registered; the page, health, approval checks, "not configured" errors and webhook signature check behave as expected). The separate multi-file v2.1 ZIP had 28 passing logic tests; this one-file build has no test files. NOT verified anywhere: `npm install`, a real server start, and any real call to Groq, Facebook, Shopify, Supabase, TikTok, Daraz or AliExpress, and deployment.
Nothing is pushed, posted or scheduled without your approval dialog (the server also refuses without `approved:true`). The autonomous run researches by itself, then stops for your approval.

## Things to know
- Profit = Daraz price - (AliExpress USD x 280) - 15% of Daraz price; BUY above 30% of cost. Shipping, customs, refunds, ads not included. Cheapest items on each site may be different products.
- Shopify and TikTok price = AliExpress USD x 280 x 1.35. Orders are tracked for Shopify only; commission is an estimate.
- Facebook "Create Page" will probably fail (Facebook does not allow it through this API, as far as I know). Create the Page in the Facebook app.
- TikTok Shop needs Partner Center approval first; the request format follows the 202309 API as I understand it and has never been accepted by TikTok. Tokens expire (not auto-refreshed).
- Free Render sleeps after 15 min (no scheduler, running jobs lost), 512 MB may be too little for Chromium. Free Supabase pauses after 7 days of low activity. Daraz/AliExpress may show verification pages; the app stops and never bypasses them.
- API versions (Facebook v18.0, Shopify 2024-01) are old; change the version settings if you see version errors.
- Dropshipping risks (counterfeit/trademark items, platform rules, taxes, customs, refunds) are yours to check before approving.
