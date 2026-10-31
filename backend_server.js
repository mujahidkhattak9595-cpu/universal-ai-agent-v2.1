
// Universal AI Employee v2.1 - ONE-FILE EDITION.
// This single file contains the server, all helper libraries and the web app (frontend).
// Sections: LIBRARIES (inlined) -> SERVER -> EMBEDDED FRONTEND. Needs only package.json next to it.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import axios from 'axios';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
// ===================== LIBRARIES (inlined) =====================
const P = (() => {
const RATE = 280;           // PKR per USD (fixed by spec; the real rate varies)
const parseRs = s => { const m = String(s || '').match(/Rs\.?\s*([\d,]+(?:\.\d+)?)/i); return m ? parseFloat(m[1].replace(/,/g, '')) : null; };
const parseUsd = s => { const m = String(s || '').match(/\$\s*(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : null; };
function cheapest(items, parse) {
  let best = null;
  for (const it of items || []) { const v = parse(it.price); if (v != null && v > 0 && (!best || v < best.value)) best = { ...it, value: v }; }
  return best;
}
const r1 = n => Math.round(n * 10) / 10;
// profit = Daraz price - AliExpress cost (USD x 280) - 15% of the Daraz price (fees/shipping allowance).
// profitPercent = profit / cost x 100. Real shipping, customs, refunds and ad costs are NOT included.
function evaluate({ darazPkr, aliUsd }) {
  if (!(darazPkr > 0) || !(aliUsd > 0)) return null;
  const costPkr = aliUsd * RATE, feesPkr = darazPkr * 0.15, profitPkr = darazPkr - costPkr - feesPkr, pct = profitPkr / costPkr * 100;
  return { darazPkr, aliUsd, costPkr: Math.round(costPkr), feesPkr: Math.round(feesPkr), profitPkr: Math.round(profitPkr), profitPercent: r1(pct), recommendation: pct > 30 ? 'BUY' : 'SKIP',
    formula: 'profit = daraz - (ali USD x 280) - 15% of daraz; percent = profit / cost' };
}
const sellingPrice = aliUsd => Math.round(aliUsd * RATE * 1.35);   // cost + 35%
return { RATE, parseRs, parseUsd, cheapest, evaluate, sellingPrice };
})();
const Shop = (() => {
const norm = u => String(u || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const E = (m, code) => Object.assign(new Error(m), { code });
const configured = env => !!(env.SHOPIFY_STORE_URL && env.SHOPIFY_API_KEY);
// SHOPIFY_API_KEY must be an Admin API access token (starts with shpat_), sent as X-Shopify-Access-Token.
async function call(env, f, method, path, body) {
  if (!configured(env)) throw E('SHOPIFY_STORE_URL / SHOPIFY_API_KEY not set', 'NOT_CONFIGURED');
  const r = await f(`https://${norm(env.SHOPIFY_STORE_URL)}/admin/api/${env.SHOPIFY_API_VERSION || '2024-01'}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-shopify-access-token': env.SHOPIFY_API_KEY }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw E(`Shopify error ${r.status}: ${JSON.stringify(d.errors || d).slice(0, 300)}`, 'SHOPIFY');
  return d;
}
const html = t => String(t || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
async function createProduct(env, f, { title, description, images, price }) {
  if (!title || String(title).length > 255) throw E('title required (max 255)', 'BAD_INPUT');
  if (!(price > 0) || !isFinite(price)) throw E('valid price required', 'BAD_INPUT');
  const imgs = (Array.isArray(images) ? images : []).filter(u => /^https?:\/\//i.test(u)).slice(0, 5).map(src => ({ src }));
  const d = await call(env, f, 'POST', '/products.json', { product: { title: String(title), body_html: html(description), images: imgs, variants: [{ price: Number(price).toFixed(2) }], status: 'active' } });
  const p = d.product; if (!p || !p.id) throw E('Shopify did not return a product', 'SHOPIFY');
  return { shopifyProductId: String(p.id), productUrl: `https://${norm(env.SHOPIFY_STORE_URL)}/products/${p.handle}` };
}
async function listProducts(env, f) { const d = await call(env, f, 'GET', '/products.json?limit=50&fields=id,title,handle,status,variants'); return (d.products || []).map(p => ({ id: String(p.id), title: p.title, status: p.status, price: p.variants && p.variants[0] ? p.variants[0].price : null, url: `https://${norm(env.SHOPIFY_STORE_URL)}/products/${p.handle}` })); }
async function deleteProduct(env, f, id) { if (!/^\d+$/.test(String(id))) throw E('bad product id', 'BAD_INPUT'); await call(env, f, 'DELETE', `/products/${id}.json`); return { ok: true }; }
async function getOrder(env, f, id) { if (!/^\d+$/.test(String(id))) throw E('bad order id', 'BAD_INPUT'); return (await call(env, f, 'GET', `/orders/${id}.json`)).order; }
return { configured, call, createProduct, listProducts, deleteProduct, getOrder };
})();
const Groq = (() => {
const E = (m, code) => Object.assign(new Error(m), { code });
async function chat(env, f, messages, json = false) {
  if (!env.GROQ_API_KEY) throw E('GROQ_API_KEY is not set', 'NOT_CONFIGURED');
  let r; try { r = await f('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.GROQ_API_KEY },
    body: JSON.stringify({ model: env.GROQ_MODEL || 'llama-3.3-70b-versatile', messages, ...(json ? { response_format: { type: 'json_object' } } : {}) }), signal: AbortSignal.timeout(45000) }); }
  catch (e) { throw E('Groq unreachable: ' + e.message, 'AI'); }
  if (r.status === 429) throw E('Groq usage limit reached (429). Wait and retry.', 'RATE_LIMIT');
  if (!r.ok) throw E('Groq error HTTP ' + r.status, 'AI');
  const d = await r.json(); const t = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!t) throw E('Groq returned an empty response', 'AI'); return t;
}
const SYS = 'You are Universal AI Employee. Golden rules: ask before doing, take approval, never fake completion. Never invent numbers or sales claims.';
const strategy = async (env, f, ctx) => (await chat(env, f, [{ role: 'system', content: SYS + ' Reply with exactly 2 short lines of sales strategy.' }, { role: 'user', content: String(ctx).slice(0, 2000) }])).trim().split('\n').filter(Boolean).slice(0, 2).join('\n');
async function content(env, f, title) {
  const out = await chat(env, f, [{ role: 'system', content: SYS + ' Reply JSON only: {"captions":["...","...","..."],"hashtags":["#..."]}. Each caption mixes Urdu (Urdu script) and English, max 220 chars, no false claims or fake discounts.' }, { role: 'user', content: 'Product: ' + String(title).slice(0, 200) }], true);
  let j; try { j = JSON.parse(out); } catch { const m = out.match(/\{[\s\S]*\}/); try { j = m && JSON.parse(m[0]); } catch { j = null; } }
  if (!j || !Array.isArray(j.captions) || !j.captions.length) throw E('Groq returned invalid content', 'AI');
  return { captions: j.captions.slice(0, 3).map(String), hashtags: (Array.isArray(j.hashtags) ? j.hashtags : []).slice(0, 15).map(String) };
}
return { chat, strategy, content };
})();
const W = (() => {
const { RATE } = P;
function verifyHmac(raw, header, secret) {
  if (!secret || !header) return false;
  const a = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('base64')), b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// byShopifyId: { '123': {ali_price_usd, selling_price_pkr} }. commission = selling price - aliPrice x 280, per unit x quantity.
// This is an estimated gross margin, before fees, shipping, refunds and ad spend.
function economics(order, byShopifyId) {
  let commission = 0; const unmatched = [], items = [];
  for (const li of order.line_items || []) {
    const m = byShopifyId[String(li.product_id)], qty = Number(li.quantity) || 1;
    if (!m) { unmatched.push(li.title); items.push({ title: li.title, qty, matched: false }); continue; }
    const sell = Number(m.selling_price_pkr) || Number(li.price), c = (sell - Number(m.ali_price_usd) * RATE) * qty;
    commission += c; items.push({ title: li.title, qty, matched: true, commission: Math.round(c) });
  }
  return { commission: Math.round(commission), unmatched, items };
}
function fulfillText(order, lines) {
  const a = order.shipping_address || {};
  const addr = [a.name, a.address1, a.address2, a.city, a.province, a.zip, a.country, a.phone ? 'Phone: ' + a.phone : ''].filter(Boolean).join(', ');
  const steps = lines.map(l => l.aliLink ? `Manually order "${l.title}" x${l.qty} from AliExpress link ${l.aliLink} to customer address ${addr}` : `"${l.title}" x${l.qty}: no AliExpress link saved for this product, find the supplier manually. Ship to ${addr}`);
  return { instructions: steps, trackingTemplate: 'Order ' + (order.name || order.id) + ' | AliExpress order no: ____ | Carrier: ____ | Tracking no: ____ | Shipped on: ____ | Then add tracking to the Shopify order and notify the customer.' };
}
return { verifyHmac, economics, fulfillText };
})();
const TT = (() => {
const E = (m, code) => Object.assign(new Error(m), { code });
const NEED = ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET', 'TIKTOK_ACCESS_TOKEN', 'TIKTOK_SHOP_CIPHER', 'TIKTOK_WAREHOUSE_ID'];
const missing = env => NEED.filter(k => !env[k]);
const configured = env => missing(env).length === 0;
// TikTok Shop signing: HMAC-SHA256 with the app secret over secret + path + sorted(key+value of query params except sign/access_token) + JSON body + secret.
// Multipart (image upload) bodies are not part of the signed string.
function sign(path, query, body, secret) {
  const s = path + Object.keys(query).filter(k => k !== 'sign' && k !== 'access_token').sort().map(k => k + query[k]).join('') + (body || '');
  return crypto.createHmac('sha256', secret).update(secret + s + secret).digest('hex');
}
async function call(env, f, method, p, { query = {}, body, form } = {}) {
  const m = missing(env); if (m.length) throw E('TikTok settings missing: ' + m.join(', '), 'NOT_CONFIGURED');
  const q = { app_key: env.TIKTOK_APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: env.TIKTOK_SHOP_CIPHER, version: '202309', ...query };
  const raw = body ? JSON.stringify(body) : '';
  q.sign = sign(p, q, raw, env.TIKTOK_APP_SECRET);
  const r = await f(`${env.TIKTOK_API_BASE || 'https://open-api.tiktokglobalshop.com'}${p}?${new URLSearchParams(q)}`, { method,
    headers: { 'x-tts-access-token': env.TIKTOK_ACCESS_TOKEN, ...(form ? {} : { 'content-type': 'application/json' }) }, body: form || raw || undefined, signal: AbortSignal.timeout(30000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.code !== 0) throw E(`TikTok error ${d.code != null ? d.code : r.status}: ${d.message || 'request failed'}`, 'TIKTOK');
  return d.data;
}
const priv = ip => net.isIPv6(ip) ? (ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:')) : (p => p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168))(ip.split('.').map(Number));
async function assertPublicHttps(u, lookup = dns.lookup) {
  let x; try { x = new URL(u); } catch { throw E('Invalid image URL', 'BAD_INPUT'); }
  if (x.protocol !== 'https:') throw E('Image URL must be https', 'BAD_INPUT');
  const ips = net.isIP(x.hostname) ? [{ address: x.hostname }] : await lookup(x.hostname, { all: true });
  if (ips.some(i => priv(i.address))) throw E('Image URL points to a private address', 'BAD_INPUT');
  return x;
}
async function uploadImage(env, f, url, lookup) {
  const x = await assertPublicHttps(url, lookup);
  const r = await f(x, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw E('Could not download image (HTTP ' + r.status + ')', 'BAD_INPUT');
  const type = String(r.headers.get('content-type') || '').split(';')[0];
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw E('Image must be JPEG, PNG or WEBP', 'BAD_INPUT');
  const buf = await r.arrayBuffer(); if (buf.byteLength > 5 * 1024 * 1024) throw E('Image larger than 5 MB', 'BAD_INPUT');
  const form = new FormData(); form.append('data', new Blob([buf], { type }), 'image'); form.append('use_case', 'MAIN_IMAGE');
  const d = await call(env, f, 'POST', '/product/202309/images/upload', { form });
  if (!d || !d.uri) throw E('TikTok did not return an image uri', 'TIKTOK'); return d.uri;
}
const html = t => String(t || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
async function pushProduct(env, f, p, lookup) {
  if (!p.title || String(p.title).length > 255) throw E('title required (max 255)', 'BAD_INPUT');
  if (!/^\d{3,25}$/.test(String(p.categoryId || ''))) throw E('categoryId (TikTok leaf category id) required', 'BAD_INPUT');
  const urls = Array.isArray(p.imageUrls) ? p.imageUrls.slice(0, 5) : []; if (!urls.length) throw E('at least one https image URL required', 'BAD_INPUT');
  if (!(p.price > 0) || !isFinite(p.price)) throw E('valid price required', 'BAD_INPUT');
  const qty = Number(p.quantity); if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw E('quantity must be 1-10000', 'BAD_INPUT');
  const w = Number(p.weightKg); if (!(w > 0) || w > 100) throw E('weightKg required (0-100)', 'BAD_INPUT');
  if (missing(env).length) throw E('TikTok settings missing: ' + missing(env).join(', '), 'NOT_CONFIGURED');
  const uris = []; for (const u of urls) uris.push(await uploadImage(env, f, u, lookup));
  const d = await call(env, f, 'POST', '/product/202309/products', { body: {
    title: String(p.title), description: html(p.description || p.title), category_id: String(p.categoryId), main_images: uris.map(uri => ({ uri })),
    skus: [{ seller_sku: p.sellerSku || 'uai-' + Date.now(), price: { amount: Number(p.price).toFixed(2), currency: env.TIKTOK_CURRENCY || 'PKR' }, inventory: [{ warehouse_id: String(env.TIKTOK_WAREHOUSE_ID), quantity: qty }] }],
    package_weight: { value: String(w), unit: 'KILOGRAM' } } });
  if (!d || !d.product_id) throw E('TikTok did not return a product id', 'TIKTOK');
  return { tiktokProductId: String(d.product_id) };
}
return { missing, configured, sign, call, assertPublicHttps, uploadImage, pushProduct };
})();
const fb = (() => {
const module = { exports: {} };
// Facebook Graph API v18.0 helpers. `http` is axios (or a test double). Tokens come from the environment only.
const G='https://graph.facebook.com/'+(process.env.FB_GRAPH_VERSION||'v18.0');
const E=(m,code)=>Object.assign(new Error(m),{code});
function fbErr(e){const d=e&&e.response&&e.response.data&&e.response.data.error;
  return E(d?`Facebook error ${d.code||''}: ${d.message}`:'Facebook request failed: '+(e&&e.message),'FB')}
async function createPage(http,{name,about},token){
  if(!token)throw E('FB_USER_TOKEN is not set','NOT_CONFIGURED');
  if(!name||String(name).length>75)throw E('Page name is required (max 75 chars)','BAD_INPUT');
  let r;try{r=await http.post(G+'/me/accounts',null,{params:{name:String(name),category_enum:2722,about:String(about||'').slice(0,255),access_token:token}})}catch(e){throw fbErr(e)}
  const id=r&&r.data&&r.data.id;if(!id)throw E('Facebook did not return a page id: '+JSON.stringify(r&&r.data).slice(0,200),'FB');
  return{pageId:String(id)}}
async function post(http,{pageId,message,imageUrl,link},token){
  if(!token)throw E('FB_PAGE_TOKEN is not set','NOT_CONFIGURED');
  if(!/^\d{5,25}$/.test(String(pageId||'')))throw E('A numeric pageId is required (set FB_PAGE_ID or send pageId)','BAD_INPUT');
  if(!message&&!imageUrl)throw E('message or imageUrl required','BAD_INPUT');
  if(message&&String(message).length>5000)throw E('message too long','BAD_INPUT');
  if(imageUrl&&!/^https?:\/\//i.test(imageUrl))throw E('imageUrl must be http(s)','BAD_INPUT');
  if(link&&!/^https?:\/\//i.test(link))throw E('link must be http(s)','BAD_INPUT');
  let r;try{r=imageUrl?await http.post(`${G}/${pageId}/photos`,null,{params:{url:imageUrl,caption:((message||'')+(link?'\n'+link:'')).trim(),access_token:token}})
    :await http.post(`${G}/${pageId}/feed`,null,{params:{message:String(message||''),...(link?{link}:{}),access_token:token}})}catch(e){throw fbErr(e)}
  const id=r&&r.data&&(r.data.post_id||r.data.id);if(!id)throw E('Facebook did not confirm the post: '+JSON.stringify(r&&r.data).slice(0,200),'FB');
  return{postId:String(id)}}
async function createCatalogProduct(http,{catalogId,name,description,price,currency,imageUrl,url},token){
  if(!token)throw E('FB_PAGE_TOKEN is not set','NOT_CONFIGURED');
  if(!/^\d{5,25}$/.test(String(catalogId||'')))throw E('FB_CATALOG_ID is not set or invalid','NOT_CONFIGURED');
  if(!name||!(Number(price)>0)||!/^https?:\/\//i.test(imageUrl||'')||!/^https?:\/\//i.test(url||''))throw E('name, price>0, http(s) imageUrl and http(s) url are required','BAD_INPUT');
  const cur=String(currency||'PKR').toUpperCase();let r;
  try{r=await http.post(`${G}/${catalogId}/products`,null,{params:{retailer_id:'uai-'+Date.now(),name:String(name).slice(0,150),description:String(description||name).slice(0,5000),availability:'in stock',condition:'new',price:Math.round(Number(price)*100),currency:cur,image_url:imageUrl,url,access_token:token}})}catch(e){throw fbErr(e)}
  const id=r&&r.data&&r.data.id;if(!id)throw E('Facebook did not confirm the catalog product: '+JSON.stringify(r&&r.data).slice(0,200),'FB');return{productId:String(id)}}
module.exports={createPage,post,createCatalogProduct};
return module.exports;
})();
const daraz = (() => {
const module = { exports: {} };
// Daraz.pk product search with Playwright. Low-volume personal use; never bypasses human verification.
const SEL="[data-qa-locator='product-item']";
function extract(els){return els.slice(0,5).map(function(el){
  var a=el.querySelector('a[title]')||el.querySelector('a[href]'),l=el.querySelector('a[href]');
  var t=((a&&(a.getAttribute('title')||a.textContent))||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,200);
  var m=(el.textContent||'').match(/Rs\.?\s*[\d,]+(\.\d+)?/);var h=l?l.getAttribute('href'):null;
  if(h&&h.indexOf('//')===0)h='https:'+h;return{title:t,price:m?m[0]:null,link:h}})}
async function search(chromium,product){
  const q=String(product||'').trim();
  if(!q||q.length>80||!/^[\p{L}\p{N} -]+$/u.test(q))throw Object.assign(new Error('Enter a product name (letters, numbers, spaces)'),{code:'BAD_INPUT'});
  const b=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{const page=await b.newPage();
    await page.goto('https://www.daraz.pk/tag/'+encodeURIComponent(q.toLowerCase().replace(/ +/g,'-'))+'/',{timeout:30000,waitUntil:'domcontentloaded'});
    const html=String(await page.content()).slice(0,300000).toLowerCase();
    if(/captcha|unusual traffic|_____tmd_____/.test(html))throw Object.assign(new Error('Daraz asked for human verification. This app does not bypass it. Try again later.'),{code:'HUMAN'});
    try{await page.waitForSelector(SEL,{timeout:15000})}catch{throw Object.assign(new Error('No product items found. The page layout may have changed, or the request was blocked.'),{code:'NO_ITEMS'})}
    const products=await page.$$eval(SEL,extract);
    if(!products.length)throw Object.assign(new Error('No products extracted'),{code:'NO_ITEMS'});return products
  }finally{await b.close()}}
module.exports={search,extract,SEL};
return module.exports;
})();
const ali = (() => {
const module = { exports: {} };
// AliExpress search with Playwright. Read-only: never logs in, never buys. Does not bypass human verification.
const SEL="a[href*='/item/']";
// Runs inside the browser, so it must be self-contained.
function extract(els){var seen=new Set(),out=[];
  for(var i=0;i<els.length;i++){var el=els[i];if(out.length>=5)break;var href=el.href;if(!href||seen.has(href))continue;seen.add(href);
    var box=el.closest('[class]'),txt=box?box.innerText||'':'',m=txt.match(/\$[\d\.]+/);
    out.push({title:(el.title||el.innerText||'').slice(0,100),price:m?m[0]:'Check link',link:href})}
  return out}
const okHost=l=>{try{const u=new URL(l);return u.protocol==='https:'&&/(^|\.)aliexpress\.(com|us)$/.test(u.hostname)}catch{return false}};
async function search(chromium,product){
  const q=String(product||'').trim();
  if(!q||q.length>80||!/^[\p{L}\p{N} -]+$/u.test(q))throw Object.assign(new Error('Enter a product name (letters, numbers, spaces)'),{code:'BAD_INPUT'});
  const b=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{const page=await b.newPage();
    await page.goto('https://www.aliexpress.com/w/wholesale-'+encodeURIComponent(q.replace(/ +/g,'-'))+'.html',{waitUntil:'domcontentloaded',timeout:20000});
    const html=String(await page.content()).slice(0,300000).toLowerCase();
    if(/captcha|unusual traffic|slide to verify|_____tmd_____/.test(html))throw Object.assign(new Error('AliExpress asked for human verification. This app does not bypass it. Try again later.'),{code:'HUMAN'});
    try{await page.waitForSelector(SEL,{timeout:15000})}catch{throw Object.assign(new Error('No product links found. The page layout may have changed, or the request was blocked.'),{code:'NO_ITEMS'})}
    const products=(await page.$$eval(SEL,extract)).filter(p=>okHost(p.link));
    if(!products.length)throw Object.assign(new Error('No products extracted'),{code:'NO_ITEMS'});return products
  }finally{await b.close()}}
module.exports={search,extract,SEL,okHost};
return module.exports;
})();

// ===================== SERVER =====================
const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env, started = Date.now();
const sb = env.SUPABASE_URL && env.SUPABASE_KEY ? createClient(env.SUPABASE_URL, env.SUPABASE_KEY, { auth: { persistSession: false } }) : null;
const fetchFn = (u, o) => fetch(u, o);
const HttpErr = (m, code) => Object.assign(new Error(m), { code });
const fail = (res, e) => {
  const c = e.code, st = c === 'BAD_INPUT' ? 400 : c === 'NOT_CONFIGURED' ? 503 : c === 'HUMAN' ? 409 : c === 'RATE_LIMIT' ? 429 : 502;
  console.error(`[error] ${c || 'ERR'}: ${e.message}`); res.status(st).json({ error: e.message });
};
const needApproval = (req, res) => req.body && req.body.approved === true ? false : (res.status(400).json({ error: 'Approval required: send approved:true after the user approves in the app.' }), true);
const needDb = res => sb ? false : (res.status(503).json({ error: 'SUPABASE_URL / SUPABASE_KEY not set' }), true);
const dbErr = (res, e) => res.status(502).json({ error: 'Database error: ' + (e.message || e) });

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN || false }));
app.use((req, res, next) => { const t = Date.now(); res.on('finish', () => console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`)); next(); }); // never logs bodies or headers

// Shopify webhook: authenticated by HMAC signature (not by app password), needs the raw body.
app.post('/api/orders/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!W.verifyHmac(req.body, req.get('x-shopify-hmac-sha256'), env.SHOPIFY_API_SECRET)) return res.status(401).json({ error: 'Bad signature' });
  if (!sb) return res.status(503).json({ error: 'Database not configured' }); // Shopify will retry
  try {
    const order = JSON.parse(req.body.toString('utf8'));
    const ids = [...new Set((order.line_items || []).map(l => String(l.product_id)))];
    const { data: prods, error: pe } = await sb.from('products').select('shopify_product_id,ali_price_usd,selling_price_pkr,ali_link').in('shopify_product_id', ids);
    if (pe) throw pe;
    const eco = W.economics(order, Object.fromEntries((prods || []).map(p => [String(p.shopify_product_id), p])));
    const { error } = await sb.from('orders').upsert({ shopify_order_id: String(order.id), order_number: order.name, total_price: Number(order.total_price), currency: order.currency, commission: eco.commission, items: eco.items, unmatched: eco.unmatched }, { onConflict: 'shopify_order_id' });
    if (error) throw error;
    console.log(`[order] ${order.name} commission=${eco.commission} unmatched=${eco.unmatched.length}`);
    res.json({ ok: true });
  } catch (e) { console.error('[order] webhook failed: ' + (e.message || e)); res.status(500).json({ error: 'Webhook processing failed' }); }
});

app.use(express.json({ limit: '200kb' }));
const eq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const authFails = new Map();
const auth = (req, res, next) => {
  if (!env.APP_PASSWORD) return res.status(503).json({ error: 'APP_PASSWORD is not set on the server' });
  const now = Date.now(), f = (authFails.get(req.ip) || []).filter(t => now - t < 900000);
  if (f.length >= 20) return res.status(429).json({ error: 'Too many failed logins. Wait 15 minutes.' });
  if (!eq(req.get('x-app-password') || '', env.APP_PASSWORD)) { f.push(now); authFails.set(req.ip, f); console.warn(`[auth] failed from ${req.ip}`); return res.status(401).json({ error: 'Wrong or missing password' }); }
  next();
};
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Rate limit: 100 requests per 15 minutes' } });

let browserOk = null;
async function browserReady() {
  if (browserOk !== null) return browserOk;
  try { const { chromium } = await import('playwright'); browserOk = fs.existsSync(chromium.executablePath()); } catch { browserOk = false; }
  return browserOk;
}
let dbCache = { t: 0, v: 'missing' };
async function dbStatus() {
  if (!sb) return 'missing';
  if (Date.now() - dbCache.t < 25000) return dbCache.v;
  const { error } = await sb.from('products').select('id').limit(1);
  dbCache = { t: Date.now(), v: error ? 'error' : 'ok' }; return dbCache.v;
}
// "configured" means the settings are present, not that Facebook/Shopify accepted them.
app.get('/api/health', auth, async (req, res) => {
  const br = (await browserReady()) ? 'ready' : 'missing';
  res.json({ status: 'ok', fb: env.FB_PAGE_TOKEN && env.FB_PAGE_ID ? 'configured' : 'missing', daraz: br, aliexpress: br, shopify: Shop.configured(env) ? 'configured' : 'missing',
    supabase: await dbStatus(), groq: env.GROQ_API_KEY ? 'configured' : 'missing', uptime: Math.round((Date.now() - started) / 1000) });
});
app.use('/api', auth, limiter);

// ---- AI
app.post('/api/chat', async (req, res) => {
  const m = String(req.body.message || '').trim().slice(0, 2000); if (!m) return res.status(400).json({ error: 'message required' });
  try { res.json({ reply: await Groq.strategy(env, fetchFn, m) }); } catch (e) { fail(res, e); }
});
app.post('/api/generate-content', async (req, res) => {
  const t = String(req.body.productTitle || '').trim(); if (!t) return res.status(400).json({ error: 'productTitle required' });
  try { res.json(await Groq.content(env, fetchFn, t)); } catch (e) { fail(res, e); }
});

// ---- Facebook (every call that changes the account needs approved:true)
app.post('/api/fb/create-page', async (req, res) => {
  if (needApproval(req, res)) return;
  try { res.json(await fb.createPage(axios, req.body, env.FB_USER_TOKEN)); } catch (e) { fail(res, e); }
});
app.post('/api/fb/post', async (req, res) => {
  if (needApproval(req, res)) return;
  try { const r = await fb.post(axios, { ...req.body, pageId: req.body.pageId || env.FB_PAGE_ID }, env.FB_PAGE_TOKEN); console.log('[fb] posted ' + r.postId); res.json(r); } catch (e) { fail(res, e); }
});
app.post('/api/fb/create-shop-product', async (req, res) => {
  if (needApproval(req, res)) return;
  const p = req.body.product || {};
  try { res.json(await fb.createCatalogProduct(axios, { catalogId: env.FB_CATALOG_ID, ...p }, env.FB_PAGE_TOKEN)); } catch (e) { fail(res, e); }
});

// ---- Scraping (one job at a time, 10 s apart: Chromium is memory-hungry)
let busy = false, lastScrape = 0;
async function gated(res, fn) {
  if (busy || Date.now() - lastScrape < 10000) return res.status(429).json({ error: 'Wait a few seconds between searches.' });
  busy = true;
  try { const { chromium } = await import('playwright'); return await fn(chromium); }
  catch (e) { return fail(res, e.code === 'ERR_MODULE_NOT_FOUND' ? HttpErr('Playwright is not installed on this server', 'NOT_CONFIGURED') : e); }
  finally { busy = false; lastScrape = Date.now(); }
}
app.post('/api/daraz/search', (req, res) => gated(res, async c => res.json({ products: await daraz.search(c, req.body.product) })));
app.post('/api/aliexpress/search', (req, res) => gated(res, async c => res.json({ success: true, products: await ali.search(c, req.body.product) })));

async function both(chromium, product) {
  const [a, d] = await Promise.allSettled([ali.search(chromium, product), daraz.search(chromium, product)]);
  return { ali: a.status === 'fulfilled' ? a.value : null, daraz: d.status === 'fulfilled' ? d.value : null, errors: { aliexpress: a.status === 'rejected' ? a.reason.message : null, daraz: d.status === 'rejected' ? d.reason.message : null } };
}
// ---- Profit engine
app.post('/api/compare-profit', (req, res) => gated(res, async c => {
  const name = String(req.body.productName || '').trim();
  const r = await both(c, name);
  if (!r.ali && !r.daraz) throw HttpErr(`Both searches failed. AliExpress: ${r.errors.aliexpress}. Daraz: ${r.errors.daraz}`, 'SCRAPE');
  const ca = r.ali && P.cheapest(r.ali, P.parseUsd), cd = r.daraz && P.cheapest(r.daraz, P.parseRs);
  const evaluation = ca && cd ? P.evaluate({ darazPkr: cd.value, aliUsd: ca.value }) : null;
  let strategyText = null;
  if (evaluation) { try { strategyText = await Groq.strategy(env, fetchFn, `Product: ${name}. AliExpress cost $${ca.value}, Daraz price Rs ${cd.value}, estimated profit ${evaluation.profitPercent}% (${evaluation.recommendation}).`); } catch (e) { r.errors.groq = e.message; } }
  res.json({ aliexpress: { items: r.ali, cheapest: ca }, daraz: { items: r.daraz, cheapest: cd }, evaluation, strategyText, errors: r.errors,
    warnings: ['The cheapest AliExpress and Daraz results may be different products; check they match.', 'Shipping, customs, refunds and ads are not included in profit.'] });
}));

// ---- Shopify
app.post('/api/shopify/push-product', async (req, res) => {
  if (needApproval(req, res)) return;
  try {
    const { title, description, images, aliPrice, darazPrice, aliLink } = req.body, usd = Number(aliPrice);
    if (!(usd > 0)) throw HttpErr('aliPrice (USD) must be > 0', 'BAD_INPUT');
    if (aliLink && !ali.okHost(aliLink)) throw HttpErr('aliLink must be an https AliExpress URL', 'BAD_INPUT');
    const sellingPrice = P.sellingPrice(usd), r = await Shop.createProduct(env, fetchFn, { title, description, images, price: sellingPrice });
    const ev = Number(darazPrice) > 0 ? P.evaluate({ darazPkr: Number(darazPrice), aliUsd: usd }) : null; let warning = null;
    if (sb) { const { error } = await sb.from('products').insert({ title, ali_link: aliLink || null, ali_price_usd: usd, daraz_price_pkr: Number(darazPrice) || null, selling_price_pkr: sellingPrice, profit_percent: ev ? ev.profitPercent : null, shopify_product_id: r.shopifyProductId, shopify_url: r.productUrl, status: 'pushed' }); if (error) warning = 'Pushed to Shopify but could not save to database: ' + error.message; }
    else warning = 'Pushed to Shopify, but Supabase is not configured so order commission tracking will not work for this product.';
    res.json({ ...r, sellingPrice, warning });
  } catch (e) { fail(res, e); }
});
app.post('/api/shopify/list-products', async (req, res) => { try { res.json({ products: await Shop.listProducts(env, fetchFn) }); } catch (e) { fail(res, e); } });
app.delete('/api/shopify/products/:id', async (req, res) => { if (needApproval(req, res)) return; try { res.json(await Shop.deleteProduct(env, fetchFn, req.params.id)); } catch (e) { fail(res, e); } });

// ---- TikTok Shop (v2.1). Needs TikTok Shop Partner Center access; see README. Requires approved:true.
app.post('/api/tiktok/push-product', async (req, res) => {
  if (needApproval(req, res)) return;
  try {
    const b = req.body, usd = Number(b.aliPrice);
    if (!(usd > 0)) throw HttpErr('aliPrice (USD) must be > 0', 'BAD_INPUT');
    if (b.aliLink && !ali.okHost(b.aliLink)) throw HttpErr('aliLink must be an https AliExpress URL', 'BAD_INPUT');
    const sellingPrice = P.sellingPrice(usd);
    const r = await TT.pushProduct(env, fetchFn, { title: b.title, description: b.description, categoryId: b.categoryId, imageUrls: b.imageUrls, price: sellingPrice, quantity: b.quantity, weightKg: b.weightKg });
    const currency = env.TIKTOK_CURRENCY || 'PKR'; const warnings = [];
    if (currency !== 'PKR') warnings.push(`Price was calculated in PKR (AliExpress USD x 280 x 1.35) but sent as ${currency}. Check the amount.`);
    if (sb) { const { error } = await sb.from('products').insert({ title: b.title, ali_link: b.aliLink || null, ali_price_usd: usd, selling_price_pkr: sellingPrice, tiktok_product_id: r.tiktokProductId, status: 'tiktok' });
      if (error) warnings.push('Created on TikTok but not saved to the database (did you run schema_v2.1.sql?): ' + error.message); }
    else warnings.push('Supabase is not configured, so this product was not saved.');
    console.log('[tiktok] created ' + r.tiktokProductId);
    res.json({ ...r, sellingPrice, currency, warnings, note: 'Submitted to TikTok. It may need TikTok review before it is visible. TikTok orders are not tracked by this app.' });
  } catch (e) { fail(res, e); }
});

// ---- Autonomous flow: phase 1 (research + Groq strategy) runs by itself; nothing is pushed or posted until the user approves.
const jobs = new Map();
setInterval(() => { for (const [k, j] of jobs) if (Date.now() - j.created > 3600e3) jobs.delete(k); }, 600e3).unref();
const log = (j, m) => { j.logs.push({ t: new Date().toISOString(), m }); };
async function research(job, chromium) {
  const kw = job.keyword; log(job, `Searching AliExpress and Daraz for "${kw}"...`);
  const r = await both(chromium, kw);
  if (!r.ali) { job.status = 'failed'; job.error = 'AliExpress search failed: ' + r.errors.aliexpress; return log(job, job.error); }
  log(job, `Found ${r.ali.length} AliExpress results`);
  if (!r.daraz) { job.status = 'needs_review'; job.error = 'Daraz search failed, so profit cannot be checked: ' + r.errors.daraz; return log(job, job.error + ' Nothing was pushed.'); }
  log(job, `Found ${r.daraz.length} Daraz results`);
  const cd = P.cheapest(r.daraz, P.parseRs); if (!cd) { job.status = 'needs_review'; job.error = 'No parsable Daraz price'; return log(job, job.error); }
  const cands = r.ali.map(a => ({ ...a, usd: P.parseUsd(a.price) })).filter(a => a.usd > 0).sort((a, b) => a.usd - b.usd);
  const pick = cands.map(a => ({ a, ev: P.evaluate({ darazPkr: cd.value, aliUsd: a.usd }) })).find(x => x.ev && x.ev.recommendation === 'BUY');
  if (!pick) { job.status = 'skipped'; job.error = 'No AliExpress result gives more than 30% profit against the cheapest Daraz price'; return log(job, job.error); }
  log(job, `Picked "${pick.a.title.slice(0, 60)}" at $${pick.a.usd}; estimated profit ${pick.ev.profitPercent}%`);
  log(job, 'Asking Groq for strategy...');
  let strategy, content;
  try { strategy = await Groq.strategy(env, fetchFn, `Product: ${pick.a.title}. Cost $${pick.a.usd}, Daraz Rs ${cd.value}, est. profit ${pick.ev.profitPercent}%.`); content = await Groq.content(env, fetchFn, pick.a.title); }
  catch (e) { job.status = 'failed'; job.error = 'Groq failed, so nothing will be pushed: ' + e.message; return log(job, job.error); }
  job.plan = { product: { title: pick.a.title, aliLink: pick.a.link, aliPriceUsd: pick.a.usd }, darazPricePkr: cd.value, profit: pick.ev, sellingPricePkr: P.sellingPrice(pick.a.usd), strategy, content,
    warnings: ['Cheapest Daraz item may be a different product than the AliExpress pick.', 'Selling price is cost + 35% and may be above Daraz.'] };
  job.status = 'awaiting_approval'; log(job, 'Waiting for your approval (strategy shown). Nothing has been pushed or posted.');
}
app.post('/api/autonomous/run', (req, res) => {
  const kw = String(req.body.productKeyword || '').trim(); if (!kw) return res.status(400).json({ error: 'productKeyword required' });
  if (busy || Date.now() - lastScrape < 10000) return res.status(429).json({ error: 'Wait a few seconds between searches.' });
  const job = { id: crypto.randomBytes(6).toString('hex'), keyword: kw.slice(0, 80), created: Date.now(), status: 'running', logs: [], plan: null, report: null, error: null };
  jobs.set(job.id, job); busy = true;
  (async () => { try { const { chromium } = await import('playwright'); await research(job, chromium); } catch (e) { job.status = 'failed'; job.error = e.message; log(job, 'Failed: ' + e.message); } finally { busy = false; lastScrape = Date.now(); } })();
  res.json({ jobId: job.id });
});
app.get('/api/autonomous/job/:id', (req, res) => { const j = jobs.get(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'No such job (jobs expire after 1 hour or a restart)' }); });
app.post('/api/autonomous/approve', (req, res) => {
  const j = jobs.get(String(req.body.jobId)); if (!j) return res.status(404).json({ error: 'No such job' });
  if (j.status !== 'awaiting_approval') return res.status(409).json({ error: 'Job is not waiting for approval' });
  if (req.body.approved !== true) { j.status = 'cancelled'; log(j, 'You declined. Nothing was pushed.'); return res.json({ ok: true }); }
  j.status = 'executing'; log(j, 'Approved. Executing...');
  (async () => {
    const p = j.plan, rep = { product: p.product, profit: p.profit, strategy: p.strategy, shopifyUrl: null, shopifyProductId: null, fbPostId: null, saved: false, status: 'done', problems: [] };
    try {
      log(j, 'Pushing to Shopify...');
      const s = await Shop.createProduct(env, fetchFn, { title: p.product.title, description: p.content.captions[0] || p.product.title, images: [], price: p.sellingPricePkr });
      rep.shopifyUrl = s.productUrl; rep.shopifyProductId = s.shopifyProductId; log(j, 'Shopify product created: ' + s.productUrl);
      try { log(j, 'Posting to Facebook Page...'); const f = await fb.post(axios, { pageId: env.FB_PAGE_ID, message: `${p.content.captions[0]}\n${p.content.hashtags.join(' ')}`.trim(), link: s.productUrl }, env.FB_PAGE_TOKEN); rep.fbPostId = f.postId; log(j, 'Facebook post: ' + f.postId); }
      catch (e) { rep.problems.push('Facebook: ' + e.message); log(j, 'Facebook failed: ' + e.message); }
      if (sb) { const { error } = await sb.from('products').insert({ title: p.product.title, ali_link: p.product.aliLink, ali_price_usd: p.product.aliPriceUsd, daraz_price_pkr: p.darazPricePkr, selling_price_pkr: p.sellingPricePkr, profit_percent: p.profit.profitPercent, shopify_product_id: s.shopifyProductId, shopify_url: s.productUrl, fb_post_id: rep.fbPostId, status: 'autonomous' });
        if (error) { rep.problems.push('Database: ' + error.message); log(j, 'Save failed: ' + error.message); } else { rep.saved = true; log(j, 'Saved to Supabase'); } }
      else { rep.problems.push('Supabase not configured: not saved, commission tracking will not work'); }
      rep.status = rep.problems.length ? 'partial' : 'done'; j.status = rep.status; log(j, rep.status === 'done' ? 'Done!' : 'Finished with problems: ' + rep.problems.join('; '));
    } catch (e) { rep.status = 'failed'; rep.problems.push(e.message); j.status = 'failed'; j.error = e.message; log(j, 'Failed at Shopify, nothing else was done: ' + e.message); }
    j.report = rep;
  })();
  res.json({ ok: true });
});

// ---- Orders and commission (estimated gross margin, before fees/shipping/refunds)
app.get('/api/orders', async (req, res) => {
  if (needDb(res)) return;
  const { data, error } = await sb.from('orders').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) return dbErr(res, error);
  res.json({ orders: data, totalCommission: data.reduce((s, o) => s + (Number(o.commission) || 0), 0), note: 'Commission = selling price - AliExpress price x 280, estimated before fees, shipping and refunds.' });
});
app.post('/api/orders/fulfill', async (req, res) => {
  if (needDb(res)) return;
  try {
    const order = await Shop.getOrder(env, fetchFn, req.body.orderId);
    const ids = (order.line_items || []).map(l => String(l.product_id));
    const { data, error } = await sb.from('products').select('shopify_product_id,ali_link').in('shopify_product_id', ids); if (error) throw error;
    const links = Object.fromEntries((data || []).map(p => [String(p.shopify_product_id), p.ali_link]));
    const t = W.fulfillText(order, (order.line_items || []).map(l => ({ title: l.title, qty: l.quantity, aliLink: links[String(l.product_id)] })));
    res.json({ ...t, note: 'Nothing was ordered automatically. Place the AliExpress order yourself.' });
  } catch (e) { fail(res, e); }
});

// ---- Scheduler (needs an always-awake server)
app.post('/api/schedule', async (req, res) => {
  if (needApproval(req, res) || needDb(res)) return;
  const { message, scheduledAt } = req.body, pageId = req.body.pageId || env.FB_PAGE_ID, at = new Date(scheduledAt);
  if (!message || String(message).length > 5000 || isNaN(at) || at.getTime() < Date.now() - 60000) return res.status(400).json({ error: 'message and a future scheduledAt (ISO date) are required' });
  if (!/^\d{5,25}$/.test(String(pageId || ''))) return res.status(400).json({ error: 'pageId required (or set FB_PAGE_ID)' });
  const { data, error } = await sb.from('schedules').insert({ page_id: String(pageId), message: String(message), scheduled_at: at.toISOString(), status: 'pending' }).select().single();
  error ? dbErr(res, error) : res.json(data);
});
app.get('/api/schedules', async (req, res) => {
  if (needDb(res)) return;
  const { data, error } = await sb.from('schedules').select('*').order('scheduled_at', { ascending: false }).limit(100);
  error ? dbErr(res, error) : res.json({ schedules: data });
});
app.get('/api/stats', async (req, res) => {
  if (needDb(res)) return;
  const [p, o] = await Promise.all([sb.from('products').select('profit_percent'), sb.from('orders').select('commission')]);
  if (p.error || o.error) return dbErr(res, p.error || o.error);
  const pp = p.data.map(x => Number(x.profit_percent)).filter(Number.isFinite);
  res.json({ productsPushed: p.data.length, orders: o.data.length, totalCommission: o.data.reduce((s, x) => s + (Number(x.commission) || 0), 0), avgProfitPercent: pp.length ? Math.round(pp.reduce((a, b) => a + b, 0) / pp.length * 10) / 10 : null });
});
async function tickSchedules() {
  if (!sb || !env.FB_PAGE_TOKEN) return;
  const { data } = await sb.from('schedules').select('*').eq('status', 'pending').lte('scheduled_at', new Date().toISOString()).limit(10);
  for (const s of data || []) {
    if (Date.now() - new Date(s.scheduled_at).getTime() > 24 * 3600e3) { await sb.from('schedules').update({ status: 'missed', error: 'More than 24h overdue (server was asleep?)' }).eq('id', s.id); continue; }
    const { data: claimed } = await sb.from('schedules').update({ status: 'posting' }).eq('id', s.id).eq('status', 'pending').select(); // claim to avoid double posts
    if (!claimed || !claimed.length) continue;
    try { const r = await fb.post(axios, { pageId: s.page_id, message: s.message }, env.FB_PAGE_TOKEN); await sb.from('schedules').update({ status: 'posted', post_id: r.postId }).eq('id', s.id); console.log('[cron] posted ' + r.postId); }
    catch (e) { await sb.from('schedules').update({ status: 'failed', error: e.message.slice(0, 300) }).eq('id', s.id); console.error('[cron] failed: ' + e.message); }
  }
}
cron.schedule('* * * * *', () => tickSchedules().catch(e => console.error('[cron] ' + e.message)));

// Frontend is embedded below (see EMBEDDED FRONTEND), so this one file is the whole app.
app.get('/', (req, res) => res.type('html').send(INDEX_HTML));
app.get('/app.js', (req, res) => res.type('js').send(APP_JS));
app.get('/style.css', (req, res) => res.type('css').send(STYLE_CSS));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error('[error] ' + err.message); res.status(err.status || 500).json({ error: err.status === 400 ? 'Bad request' : 'Server error' }); });

// ===================== EMBEDDED FRONTEND =====================
const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\"><meta name=\"apple-mobile-web-app-title\" content=\"Universal AI\">\n<title>Universal AI v2.0</title><link rel=\"stylesheet\" href=\"style.css\"></head>\n<body>\n<header><div class=\"top\"><b>Universal AI</b><div class=\"dots\" id=\"dots\"></div><button class=\"ghost sm\" id=\"theme\" type=\"button\">Dark</button></div><nav id=\"tabs\"></nav></header>\n<div class=\"note\" id=\"note\">Nothing is bought, pushed or posted without your approval.</div>\n<main id=\"view\"></main>\n<div id=\"modal\" class=\"modal\" hidden></div>\n<script src=\"app.js\"></script>\n</body></html>\n";
const APP_JS = "'use strict';\nconst $ = s => document.querySelector(s);\nconst esc = s => String(s == null ? '' : s).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\nconst safeUrl = u => /^https?:\\/\\//i.test(u || '') ? u : '#';\nconst clean = t => String(t || '').replace(/[^\\p{L}\\p{N} -]/gu, ' ').replace(/\\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');\nlet PW = sessionStorage.getItem('pw') || '';\nconst TABS = [['dash', 'Dashboard'], ['fb', 'Facebook'], ['dz', 'Daraz'], ['ae', 'AliExpress'], ['pf', 'Profit Finder'], ['sh', 'Shopify'], ['tt', 'TikTok'], ['auto', 'Autonomous'], ['ord', 'Orders'], ['sch', 'Scheduler'], ['hl', 'Health']];\nconst ST = { tab: 'dash', dz: null, ae: null, cmp: null, pfq: '', job: null, sh: null, ord: null, sch: null, stats: null, capt: null, fbOut: '', hl: null, err: '', busy: false };\n\nfunction say(t, bad) { const n = $('#note'); n.textContent = t; n.style.color = bad ? 'var(--er)' : 'var(--mut)'; }\nasync function api(p, method, body) {\n  const r = await fetch(p, { method: method || 'GET', headers: { 'content-type': 'application/json', 'x-app-password': PW }, body: body ? JSON.stringify(body) : undefined });\n  const j = await r.json().catch(() => ({}));\n  if (r.status === 401) { PW = ''; sessionStorage.removeItem('pw'); login(); throw new Error('Login required'); }\n  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);\n  return j;\n}\nfunction modal(html, buttons) {\n  return new Promise(res => {\n    const m = $('#modal'); m.innerHTML = '<div class=\"box\">' + html + '<div class=\"row\" style=\"margin-top:12px\">' + buttons.map((b, i) => '<button data-m=\"' + i + '\" class=\"' + (b.cls || '') + '\">' + esc(b.t) + '</button>').join('') + '</div></div>'; m.hidden = false;\n    m.onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; m.hidden = true; m.innerHTML = ''; m.onclick = null; res(buttons[+b.dataset.m].v); };\n  });\n}\nfunction login() {\n  const m = $('#modal'); m.hidden = false;\n  m.innerHTML = '<div class=\"box\"><h2>Login</h2><p class=\"mut\">Enter the APP_PASSWORD you set on the server.</p><input id=\"pw\" type=\"password\" autocomplete=\"current-password\" placeholder=\"Password\"><p class=\"er\" id=\"lerr\"></p><button id=\"lgo\">Login</button></div>';\n  const go = async () => { PW = $('#pw').value; try { await api('/api/health'); sessionStorage.setItem('pw', PW); m.hidden = true; m.innerHTML = ''; boot(); } catch (e) { if (e.message !== 'Login required') $('#lerr').textContent = e.message; else $('#lerr').textContent = 'Wrong password'; } };\n  $('#lgo').onclick = go; $('#pw').onkeydown = e => { if (e.key === 'Enter') go(); };\n}\n\n// ---- Approval flow: Groq strategy first, then explicit approval. Nothing is pushed otherwise.\nasync function pushFlow(p) {\n  const sell = Math.round(p.aliUsd * 280 * 1.35); let strat;\n  say('Asking Groq for strategy\u2026');\n  try { strat = (await api('/api/chat', 'POST', { message: `Product: ${p.title}. Cost $${p.aliUsd}, planned selling price Rs ${sell}${p.darazPkr ? ', Daraz price Rs ' + p.darazPkr : ''}.` })).reply; }\n  catch (e) { say('Could not get Groq strategy, so nothing was pushed: ' + e.message, true); return; }\n  say('Waiting for your approval.');\n  const ok = await modal('<h2>Approve push to Shopify?</h2><p><b>' + esc(p.title) + '</b></p><p>Cost $' + esc(p.aliUsd) + ' \u2192 selling Rs ' + sell + ' (cost + 35%)</p><p class=\"mut\">Groq strategy</p><p>' + esc(strat).replace(/\\n/g, '<br>') + '</p><p class=\"wn\">This creates a live product in your Shopify store.</p>', [{ t: 'Cancel', cls: 'ghost', v: false }, { t: 'Approve and push', v: true }]);\n  if (!ok) return say('Cancelled. Nothing was pushed.');\n  try { const r = await api('/api/shopify/push-product', 'POST', { title: p.title, description: p.description || p.title, images: p.images || [], aliPrice: p.aliUsd, darazPrice: p.darazPkr, aliLink: p.aliLink, approved: true });\n    say('Pushed: ' + r.productUrl + (r.warning ? ' | Warning: ' + r.warning : ''), !!r.warning); }\n  catch (e) { say('Push failed: ' + e.message, true); }\n}\nconst usd = s => { const m = String(s || '').match(/\\$\\s*(\\d+(?:\\.\\d+)?)/); return m ? parseFloat(m[1]) : null; };\n\n// ---- Renderers\nconst card = (p, i, tab) => '<div class=\"card\"><b>' + esc(p.title || '(no title)') + '</b><div class=\"row\"><span>' + esc(p.price || 'n/a') + '</span><a href=\"' + esc(safeUrl(p.link)) + '\" target=\"_blank\" rel=\"noopener\">Open</a></div><div class=\"row\" style=\"margin-top:8px\"><button class=\"ghost sm\" data-act=\"cmp\" data-i=\"' + i + '\" data-t=\"' + tab + '\">Compare</button>' + (tab === 'ae' ? '<button class=\"sm\" data-act=\"pushAe\" data-i=\"' + i + '\">Push to Shopify</button>' : '') + '</div></div>';\nconst searchView = (tab, name, ph) => '<h2>' + name + '</h2><p class=\"mut\">Reads public search results only. If a site asks for human verification the search stops.</p><div class=\"card\"><input id=\"q_' + tab + '\" placeholder=\"' + ph + '\"><button data-act=\"search\" data-t=\"' + tab + '\"' + (ST.busy ? ' disabled' : '') + '>Search</button></div>' + (ST.err ? '<div class=\"card er\">' + esc(ST.err) + '</div>' : '') + (ST.busy ? '<p class=\"mut\">Searching, can take up to a minute\u2026</p>' : '') + (ST[tab] || []).map((p, i) => card(p, i, tab)).join('');\nconst R = {\n  dash() { const s = ST.stats;\n    return '<h2>Dashboard</h2>' + (s ? '<div class=\"grid\"><div class=\"card\"><div class=\"big\">' + s.productsPushed + '</div>Products pushed</div><div class=\"card\"><div class=\"big\">' + s.orders + '</div>Orders</div><div class=\"card\"><div class=\"big\">Rs ' + s.totalCommission + '</div>Est. commission</div><div class=\"card\"><div class=\"big\">' + (s.avgProfitPercent == null ? 'n/a' : s.avgProfitPercent + '%') + '</div>Avg profit %</div></div>' : '<div class=\"card er\">Stats unavailable: ' + esc(ST.err) + '</div>')\n      + '<div class=\"card\"><b>Run Autonomous Now</b><input id=\"dk\" placeholder=\"Product keyword\"><button data-act=\"dashRun\">Start research</button><p class=\"mut\">Research only. You approve before anything is pushed or posted.</p></div>'; },\n  fb() { return '<h2>Facebook</h2><p class=\"mut\">Each action asks you to confirm first.</p>'\n    + '<div class=\"card\"><b>Create Page</b><p class=\"wn\">Facebook may refuse this. You will see its exact error. Creating a Page in the Facebook app always works.</p><input id=\"fn\" placeholder=\"Page name\"><input id=\"fa\" placeholder=\"About (optional)\"><button data-act=\"fbCreate\">Create Page</button></div>'\n    + '<div class=\"card\"><b>AI captions</b><input id=\"ft\" placeholder=\"Product title\"><button class=\"ghost\" data-act=\"fbCaps\">Generate captions</button>' + (ST.capt ? ST.capt.captions.map((c, i) => '<p data-act=\"useCap\" data-i=\"' + i + '\" style=\"cursor:pointer\">\u2022 ' + esc(c) + '</p>').join('') + '<p class=\"mut\">' + esc(ST.capt.hashtags.join(' ')) + '</p><p class=\"mut\">Tap a caption to use it.</p>' : '') + '</div>'\n    + '<div class=\"card\"><b>Post</b><textarea id=\"fm\" rows=\"3\" placeholder=\"Post text\"></textarea><input id=\"fi\" placeholder=\"Image URL (optional)\"><input id=\"fl\" placeholder=\"Link (optional)\"><input id=\"fp\" placeholder=\"Page ID (blank = server default)\"><button data-act=\"fbPost\">Publish post</button></div>'\n    + '<div class=\"card\"><b>Shop product (catalog)</b><input id=\"sn\" placeholder=\"Name\"><input id=\"sp\" placeholder=\"Price (PKR)\"><input id=\"si\" placeholder=\"Image URL (https)\"><input id=\"su\" placeholder=\"Product page URL (https)\"><button class=\"ghost\" data-act=\"fbShop\">Add to FB Shop catalog</button></div>'\n    + (ST.fbOut ? '<div class=\"card\">' + esc(ST.fbOut) + '</div>' : ''); },\n  dz() { return searchView('dz', 'Daraz', 'e.g. wireless mouse'); },\n  ae() { return searchView('ae', 'AliExpress', 'e.g. phone stand'); },\n  pf() { const c = ST.cmp, e = c && c.evaluation;\n    let h = '<h2>Profit Finder</h2><div class=\"card\"><input id=\"pq\" value=\"' + esc(ST.pfq) + '\" placeholder=\"Product name\"><button data-act=\"compare\"' + (ST.busy ? ' disabled' : '') + '>Compare Daraz vs AliExpress</button><p class=\"mut\">Profit = Daraz price - AliExpress cost x 280 - 15% of Daraz price. Shipping and customs not included.</p></div>';\n    if (ST.err) h += '<div class=\"card er\">' + esc(ST.err) + '</div>'; if (ST.busy) h += '<p class=\"mut\">Searching both sites, can take up to a minute\u2026</p>';\n    if (c) { const side = (n, x, cur) => '<div class=\"card\"><b>' + n + '</b>' + (x ? '<p>' + esc(x.title) + '</p><div class=\"big\">' + cur + x.value + '</div><a href=\"' + esc(safeUrl(x.link)) + '\" target=\"_blank\" rel=\"noopener\">Open</a>' : '<p class=\"er\">No result</p>') + '</div>';\n      h += '<div class=\"grid\">' + side('Daraz (cheapest)', c.daraz.cheapest, 'Rs ') + side('AliExpress (cheapest)', c.aliexpress.cheapest, '$') + '</div>';\n      if (e) h += '<div class=\"card\"><div class=\"row\"><b>Estimated profit Rs ' + e.profitPkr + ' (' + e.profitPercent + '%)</b><span class=\"badge ' + e.recommendation + '\">' + e.recommendation + '</span></div><p class=\"mut\">Cost Rs ' + e.costPkr + ', fee allowance Rs ' + e.feesPkr + '</p>' + (c.strategyText ? '<p><b>Groq strategy</b><br>' + esc(c.strategyText).replace(/\\n/g, '<br>') + '</p>' : '') + (e.recommendation === 'BUY' ? '<button data-act=\"pfPush\">Approve and push to Shopify</button>' : '') + '</div>';\n      else h += '<div class=\"card wn\">Profit cannot be calculated: ' + esc(Object.values(c.errors).filter(Boolean).join(' | ') || 'missing price') + '</div>';\n      h += '<p class=\"mut\">' + c.warnings.map(esc).join('<br>') + '</p>'; }\n    return h; },\n  sh() { const L = ST.sh;\n    return '<h2>Shopify</h2>' + (ST.err ? '<div class=\"card er\">' + esc(ST.err) + '</div>' : '') + '<div class=\"card\"><b>Push new product</b><input id=\"ht\" placeholder=\"Title\"><textarea id=\"hd\" rows=\"2\" placeholder=\"Description\"></textarea><input id=\"hi\" placeholder=\"Image URL (optional)\"><input id=\"ha\" placeholder=\"AliExpress price (USD)\"><input id=\"hz\" placeholder=\"Daraz price (PKR, optional)\"><input id=\"hl\" placeholder=\"AliExpress link (https)\"><button data-act=\"shPush\">Push (asks for approval)</button></div>'\n      + (L ? L.map((p, i) => '<div class=\"card\"><b>' + esc(p.title) + '</b><div class=\"row\"><span>Rs ' + esc(p.price) + ' \u00b7 ' + esc(p.status) + '</span><a href=\"' + esc(safeUrl(p.url)) + '\" target=\"_blank\" rel=\"noopener\">View</a></div><button class=\"red sm\" data-act=\"shDel\" data-i=\"' + i + '\">Delete</button></div>').join('') || '<p class=\"mut\">No products.</p>' : ''); },\n  tt() { return '<h2>TikTok Shop</h2><p class=\"mut\">Needs TikTok Shop Partner access and settings on the server (see README). Nothing is sent until you approve. TikTok may review the product before it is visible.</p>'\n    + '<div class=\"card\"><input id=\"tt_t\" placeholder=\"Title\"><textarea id=\"tt_d\" rows=\"2\" placeholder=\"Description\"></textarea><input id=\"tt_c\" placeholder=\"TikTok category ID (leaf category)\"><textarea id=\"tt_i\" rows=\"2\" placeholder=\"Image URLs, one per line (https, JPEG/PNG/WEBP, max 5 MB each)\"></textarea>'\n    + '<input id=\"tt_a\" placeholder=\"AliExpress price (USD)\"><input id=\"tt_l\" placeholder=\"AliExpress link (https, optional)\"><input id=\"tt_q\" placeholder=\"Stock quantity\"><input id=\"tt_w\" placeholder=\"Package weight (kg)\"><button data-act=\"ttPush\">Push to TikTok (asks for approval)</button></div>' + (ST.ttOut ? '<div class=\"card\">' + esc(ST.ttOut) + '</div>' : ''); },\n  auto() { const j = ST.job;\n    let h = '<h2>Autonomous</h2><div class=\"card\"><input id=\"ak\" placeholder=\"Product keyword (Watch\u2026)\"><button data-act=\"autoRun\"' + (j && ['running', 'executing', 'awaiting_approval'].includes(j.status) ? ' disabled' : '') + '>Full Auto Run</button><p class=\"mut\">It researches and asks Groq for a strategy. It stops and asks you before pushing to Shopify or posting to Facebook.</p></div>';\n    if (j) { h += '<div class=\"card\"><div class=\"row\"><b>Status</b><span class=\"badge\">' + esc(j.status) + '</span></div><div class=\"log\">' + j.logs.map(l => esc(new Date(l.t).toLocaleTimeString() + '  ' + l.m)).join('\\n') + '</div></div>';\n      if (j.report) h += '<div class=\"card\"><b>Report</b><p>' + esc(j.report.product.title) + '</p><p>Estimated profit ' + j.report.profit.profitPercent + '%</p><p>Shopify: ' + (j.report.shopifyUrl ? '<a href=\"' + esc(safeUrl(j.report.shopifyUrl)) + '\" target=\"_blank\" rel=\"noopener\">product</a>' : 'none') + '</p><p>Facebook post ID: ' + esc(j.report.fbPostId || 'none') + '</p><p>Saved to database: ' + (j.report.saved ? 'yes' : 'no') + '</p>' + (j.report.problems.length ? '<p class=\"wn\">' + j.report.problems.map(esc).join('<br>') + '</p>' : '') + '</div>'; }\n    return h; },\n  ord() { const o = ST.ord; return '<h2>Orders</h2>' + (ST.err ? '<div class=\"card er\">' + esc(ST.err) + '</div>' : '') + (o ? '<div class=\"card\"><div class=\"big\">Rs ' + o.totalCommission + '</div>Total estimated commission<p class=\"mut\">' + esc(o.note) + '</p></div>' + (o.orders.map((x, i) => '<div class=\"card\"><div class=\"row\"><b>' + esc(x.order_number) + '</b><span>Rs ' + esc(x.total_price) + '</span></div><p>Commission Rs ' + esc(x.commission) + (x.unmatched && x.unmatched.length ? ' <span class=\"wn\">(unmatched: ' + esc(x.unmatched.join(', ')) + ')</span>' : '') + '</p><button class=\"ghost sm\" data-act=\"fulfill\" data-i=\"' + i + '\">Fulfill (manual steps)</button></div>').join('') || '<p class=\"mut\">No orders yet.</p>') : ''); },\n  sch() { const L = ST.sch; return '<h2>Scheduler</h2><div class=\"card\"><input id=\"sd\" type=\"datetime-local\"><textarea id=\"sm\" rows=\"3\" placeholder=\"Post text\"></textarea><input id=\"sg\" placeholder=\"Page ID (blank = server default)\"><button data-act=\"schAdd\">Schedule post</button><p class=\"mut\">Posts only while the server is awake.</p></div>' + (ST.err ? '<div class=\"card er\">' + esc(ST.err) + '</div>' : '') + (L ? L.map(s => '<div class=\"card\"><div class=\"row\"><b>' + esc(new Date(s.scheduled_at).toLocaleString()) + '</b><span class=\"badge\">' + esc(s.status) + '</span></div><p>' + esc(s.message) + '</p>' + (s.error ? '<p class=\"er\">' + esc(s.error) + '</p>' : '') + '</div>').join('') || '<p class=\"mut\">Nothing scheduled.</p>' : ''); },\n  hl() { const h = ST.hl; return '<h2>Health</h2>' + (h ? '<div class=\"card\">' + Object.entries(h).map(([k, v]) => '<div class=\"row\"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('') + '<p class=\"mut\">\"configured\" means settings are present, not that the service accepted them.</p></div>' : '<div class=\"card er\">' + esc(ST.err) + '</div>'); },\n};\nconst LOAD = {\n  dash: async () => { ST.stats = await api('/api/stats'); },\n  sh: async () => { ST.sh = (await api('/api/shopify/list-products', 'POST', {})).products; },\n  ord: async () => { ST.ord = await api('/api/orders'); },\n  sch: async () => { ST.sch = (await api('/api/schedules')).schedules; },\n  hl: async () => { ST.hl = await api('/api/health'); },\n};\nfunction renderTabs() { $('#tabs').innerHTML = TABS.map(t => '<button data-tab=\"' + t[0] + '\" class=\"' + (ST.tab === t[0] ? 'on' : '') + '\">' + t[1] + '</button>').join(''); }\nfunction draw() { $('#view').innerHTML = R[ST.tab](); }\nasync function go(tab) { ST.tab = tab; ST.err = ''; ST.busy = false; renderTabs(); $('#view').innerHTML = '<p class=\"mut\">Loading\u2026</p>'; try { if (LOAD[tab]) await LOAD[tab](); } catch (e) { ST.err = e.message; if (tab === 'dash') ST.stats = null; } draw(); }\nasync function ttFlow(p) {\n  const sell = Math.round(p.aliPrice * 280 * 1.35); let strat; say('Asking Groq for strategy\u2026');\n  try { strat = (await api('/api/chat', 'POST', { message: `Product: ${p.title}. Cost $${p.aliPrice}, planned TikTok Shop price ${sell}.` })).reply; } catch (e) { say('Could not get Groq strategy, so nothing was sent: ' + e.message, true); return; }\n  const ok = await modal('<h2>Approve push to TikTok Shop?</h2><p><b>' + esc(p.title) + '</b></p><p>Cost $' + esc(p.aliPrice) + ' \u2192 price ' + sell + ' (cost x 280 + 35%), stock ' + esc(p.quantity) + '</p><p class=\"mut\">Groq strategy</p><p>' + esc(strat).replace(/\\n/g, '<br>') + '</p><p class=\"wn\">This creates a product in your TikTok Shop.</p>', [{ t: 'Cancel', cls: 'ghost', v: false }, { t: 'Approve and push', v: true }]);\n  if (!ok) return say('Cancelled. Nothing was sent.');\n  try { const r = await api('/api/tiktok/push-product', 'POST', { ...p, approved: true }); ST.ttOut = 'Created. TikTok product ID: ' + r.tiktokProductId + ' | ' + r.note + (r.warnings.length ? ' | Warnings: ' + r.warnings.join(' ') : ''); say('TikTok product created.'); }\n  catch (e) { ST.ttOut = 'Failed: ' + e.message; say('TikTok push failed.', true); }\n  if (ST.tab === 'tt') draw();\n}\nconst val = id => ($('#' + id) ? $('#' + id).value.trim() : '');\n\n// ---- Autonomous job polling (real status from the server)\nasync function poll() {\n  if (!ST.job) return; let j;\n  try { j = await api('/api/autonomous/job/' + ST.job.id); } catch (e) { say(e.message, true); return; }\n  ST.job = j; if (ST.tab === 'auto') draw();\n  if (j.status === 'awaiting_approval' && !ST.asking) {\n    ST.asking = true; const p = j.plan;\n    const ok = await modal('<h2>Approve push and post?</h2><p><b>' + esc(p.product.title) + '</b></p><p>Cost $' + esc(p.product.aliPriceUsd) + ' \u2192 selling Rs ' + esc(p.sellingPricePkr) + '. Daraz Rs ' + esc(p.darazPricePkr) + '. Estimated profit ' + esc(p.profit.profitPercent) + '%.</p><p class=\"mut\">Groq strategy</p><p>' + esc(p.strategy).replace(/\\n/g, '<br>') + '</p><p class=\"wn\">' + p.warnings.map(esc).join('<br>') + '</p><p class=\"wn\">Approving creates a live Shopify product and a public Facebook post.</p>', [{ t: 'Decline', cls: 'ghost', v: false }, { t: 'Approve', v: true }]);\n    ST.asking = false;\n    try { await api('/api/autonomous/approve', 'POST', { jobId: j.id, approved: ok }); } catch (e) { say(e.message, true); }\n  }\n  if (!['done', 'partial', 'failed', 'skipped', 'needs_review', 'cancelled'].includes(j.status)) setTimeout(poll, 2000); else if (ST.tab === 'auto') draw();\n}\nasync function startAuto(kw) {\n  if (!kw) return; try { const r = await api('/api/autonomous/run', 'POST', { productKeyword: kw }); ST.job = { id: r.jobId, status: 'running', logs: [], plan: null, report: null }; await go('auto'); poll(); } catch (e) { say(e.message, true); }\n}\n// ---- Click actions\nconst ACT = {\n  async search(el) { const t = el.dataset.t, q = val('q_' + t); if (!q) return; ST.busy = true; ST.err = ''; ST[t] = null; draw();\n    try { const r = await api('/api/' + (t === 'dz' ? 'daraz' : 'aliexpress') + '/search', 'POST', { product: q }); ST[t] = r.products; } catch (e) { ST.err = e.message; } ST.busy = false; draw(); },\n  cmp(el) { const p = ST[el.dataset.t][+el.dataset.i]; ST.pfq = clean(p.title); ST.cmp = null; go('pf'); },\n  pushAe(el) { const p = ST.ae[+el.dataset.i], u = usd(p.price); if (!u) return say('No parsable USD price for this item. Open the link and enter it manually in the Shopify tab.', true); pushFlow({ title: p.title, aliUsd: u, aliLink: p.link }); },\n  async compare() { const q = val('pq'); if (!q) return; ST.pfq = q; ST.busy = true; ST.err = ''; ST.cmp = null; draw();\n    try { ST.cmp = await api('/api/compare-profit', 'POST', { productName: q }); } catch (e) { ST.err = e.message; } ST.busy = false; draw(); },\n  pfPush() { const c = ST.cmp; pushFlow({ title: c.aliexpress.cheapest.title, aliUsd: c.aliexpress.cheapest.value, darazPkr: c.daraz.cheapest.value, aliLink: c.aliexpress.cheapest.link }); },\n  shPush() { const u = parseFloat(val('ha')); if (!val('ht') || !(u > 0)) return say('Title and a valid AliExpress USD price are required.', true);\n    pushFlow({ title: val('ht'), description: val('hd'), images: val('hi') ? [val('hi')] : [], aliUsd: u, darazPkr: parseFloat(val('hz')) || null, aliLink: val('hl') || undefined }); },\n  ttPush() { const a = parseFloat(val('tt_a')), q = parseInt(val('tt_q'), 10), w = parseFloat(val('tt_w')), imgs = val('tt_i').split('\\n').map(x => x.trim()).filter(Boolean);\n    if (!val('tt_t') || !val('tt_c') || !imgs.length || !(a > 0) || !(q > 0) || !(w > 0)) return say('Title, category ID, image URL, USD price, quantity and weight are all required.', true);\n    ttFlow({ title: val('tt_t'), description: val('tt_d'), categoryId: val('tt_c'), imageUrls: imgs, aliPrice: a, aliLink: val('tt_l') || undefined, quantity: q, weightKg: w }); },\n  async shDel(el) { const p = ST.sh[+el.dataset.i]; if (!(await modal('<h2>Delete product?</h2><p>' + esc(p.title) + '</p><p class=\"wn\">This permanently removes it from Shopify.</p>', [{ t: 'Cancel', cls: 'ghost', v: false }, { t: 'Delete', cls: 'red', v: true }]))) return;\n    try { await api('/api/shopify/products/' + encodeURIComponent(p.id), 'DELETE', { approved: true }); say('Deleted.'); go('sh'); } catch (e) { say(e.message, true); } },\n  async fbCreate() { const n = val('fn'); if (!n) return; if (!(await modal('<h2>Create Facebook Page?</h2><p>' + esc(n) + '</p>', [{ t: 'Cancel', cls: 'ghost', v: false }, { t: 'Create', v: true }]))) return;\n    try { const r = await api('/api/fb/create-page', 'POST', { name: n, about: val('fa'), approved: true }); ST.fbOut = 'Page created. ID: ' + r.pageId; } catch (e) { ST.fbOut = 'Failed: ' + e.message; } draw(); },\n  async fbCaps() { const t = val('ft'); if (!t) return; try { ST.capt = await api('/api/generate-content', 'POST', { productTitle: t }); } catch (e) { ST.fbOut = 'Failed: ' + e.message; } draw(); },\n  useCap(el) { const m = ST.capt.captions[+el.dataset.i] + '\\n' + ST.capt.hashtags.join(' '); draw(); $('#fm').value = m; },\n  async fbPost() { const m = val('fm'), i = val('fi'); if (!m && !i) return; if (!(await modal('<h2>Publish to Facebook now?</h2><p>' + esc(m).replace(/\\n/g, '<br>') + '</p><p class=\"wn\">This is public.</p>', [{ t: 'Cancel', cls: 'ghost', v: false }, { t: 'Publish', v: true }]))) return;\n    try { const r = await api('/api/fb/post', 'POST', { message: m, imageUrl: i, link: val('fl'), pageId: val('fp'), approved: true }); ST.fbOut = 'Published. Post ID: ' + r.postId; } catch (e) { ST.fbOut = 'Failed: ' + e.message; } draw(); },\n  async fbShop() { const p = { name: val('sn'), price: parseFloat(val('sp')), imageUrl: val('si'), url: val('su') }; if (!(await modal('<h2>Add to Facebook Shop catalog?</h2><p>' + esc(p.name) + '</p>', [{ t: 'Cancel', cls: 'ghost', v: false }, { t: 'Add', v: true }]))) return;\n    try { const r = await api('/api/fb/create-shop-product', 'POST', { product: p, approved: true }); ST.fbOut = 'Catalog product created: ' + r.productId; } catch (e) { ST.fbOut = 'Failed: ' + e.message; } draw(); },\n  dashRun() { startAuto(val('dk')); }, autoRun() { startAuto(val('ak')); },\n  async fulfill(el) { const o = ST.ord.orders[+el.dataset.i]; try { const r = await api('/api/orders/fulfill', 'POST', { orderId: o.shopify_order_id }); await modal('<h2>Manual fulfillment</h2>' + r.instructions.map(x => '<p>' + esc(x) + '</p>').join('') + '<p class=\"mut\">' + esc(r.trackingTemplate) + '</p><p class=\"wn\">' + esc(r.note) + '</p>', [{ t: 'Close', v: true }]); } catch (e) { say(e.message, true); } },\n  async schAdd() { const d = val('sd'), m = val('sm'); if (!d || !m) return say('Date/time and text required.', true); const at = new Date(d);\n    if (!(await modal('<h2>Schedule this post?</h2><p>' + esc(at.toLocaleString()) + '</p><p>' + esc(m) + '</p><p class=\"wn\">It will be posted publicly by itself at that time.</p>', [{ t: 'Cancel', cls: 'ghost', v: false }, { t: 'Schedule', v: true }]))) return;\n    try { await api('/api/schedule', 'POST', { message: m, scheduledAt: at.toISOString(), pageId: val('sg') || undefined, approved: true }); say('Scheduled.'); go('sch'); } catch (e) { say(e.message, true); } },\n};\ndocument.addEventListener('click', e => { const t = e.target.closest('[data-tab]'); if (t) return go(t.dataset.tab); const a = e.target.closest('[data-act]'); if (a && ACT[a.dataset.act]) ACT[a.dataset.act](a); });\n// ---- Header health dots (every 30 s)\nasync function dots() {\n  try { const h = await api('/api/health'), ok = v => ['ok', 'ready', 'configured'].includes(v);\n    $('#dots').innerHTML = [['FB', h.fb], ['Daraz', h.daraz], ['Ali', h.aliexpress], ['Shopify', h.shopify], ['DB', h.supabase]].map(([n, v]) => '<span class=\"dot ' + (ok(v) ? 'ok' : 'bad') + '\" title=\"' + esc(v) + '\">' + n + '</span>').join(''); } catch { }\n}\n$('#theme').onclick = () => { const d = document.documentElement.dataset.theme === 'dark'; document.documentElement.dataset.theme = d ? 'light' : 'dark'; localStorage.setItem('theme', d ? 'light' : 'dark'); };\nif (localStorage.getItem('theme')) document.documentElement.dataset.theme = localStorage.getItem('theme');\nlet started = false;\nfunction boot() { if (started) { go(ST.tab); dots(); return; } started = true; renderTabs(); go('dash'); dots(); setInterval(dots, 30000); }\nPW ? boot() : login();\n";
const STYLE_CSS = ":root{--bg:#f5f6f8;--card:#fff;--tx:#14181f;--mut:#667085;--bd:#e4e7ec;--ac:#4f46e5;--ok:#12805c;--wn:#b54708;--er:#b42318;box-sizing:border-box}\n@media(prefers-color-scheme:dark){:root:not([data-theme=\"light\"]){--bg:#0e1116;--card:#171b22;--tx:#eef0f4;--mut:#98a2b3;--bd:#262c36;--ac:#818cf8;--ok:#4ade80;--wn:#fbbf24;--er:#f87171}}\n:root[data-theme=\"dark\"]{--bg:#0e1116;--card:#171b22;--tx:#eef0f4;--mut:#98a2b3;--bd:#262c36;--ac:#818cf8;--ok:#4ade80;--wn:#fbbf24;--er:#f87171}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.45 -apple-system,system-ui,\"Segoe UI\",sans-serif;padding-bottom:env(safe-area-inset-bottom,0)}\nheader{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--bd);padding-top:env(safe-area-inset-top,0)}\n.top{display:flex;align-items:center;gap:10px;padding:10px 14px}.dots{display:flex;gap:6px;flex:1;flex-wrap:wrap}\n.dot{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid currentColor;color:var(--mut)}.dot.ok{color:var(--ok)}.dot.bad{color:var(--er)}\nnav{display:flex;overflow-x:auto;gap:2px;padding:0 8px}nav button{background:none;color:var(--mut);border:0;border-bottom:3px solid transparent;border-radius:0;padding:10px 12px;white-space:nowrap;min-height:44px}\nnav button.on{color:var(--ac);border-color:var(--ac);font-weight:700}\n.note{margin:10px 14px;font-size:13px;color:var(--mut)}main{padding:0 14px 40px;max-width:900px;margin:0 auto}\n.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:14px;margin:10px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}\n.big{font-size:26px;font-weight:700}.mut{color:var(--mut)}.sm{font-size:13px;padding:6px 10px;min-height:34px}.row{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}\ninput,textarea,select{width:100%;font:inherit;color:var(--tx);background:var(--bg);border:1px solid var(--bd);border-radius:12px;padding:12px;margin:4px 0}\nbutton{font:inherit;border:0;border-radius:12px;padding:10px 14px;background:var(--ac);color:#fff;min-height:44px;cursor:pointer}button.ghost{background:transparent;color:var(--tx);border:1px solid var(--bd)}button.red{background:var(--er)}button:disabled{opacity:.5}\n.badge{padding:3px 10px;border-radius:99px;font-weight:700;font-size:13px;border:1px solid currentColor}.BUY{color:var(--ok)}.SKIP{color:var(--er)}\n.ok{color:var(--ok)}.er{color:var(--er)}.wn{color:var(--wn)}.log{font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap}\n.modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:20}.modal[hidden]{display:none}\n.modal .box{background:var(--card);border-radius:16px;padding:18px;max-width:480px;width:100%;max-height:85vh;overflow:auto}\na{color:var(--ac)}h2{font-size:18px;margin:16px 0 4px}\n";

const port = env.PORT || 3000;
app.listen(port, () => console.log(`Universal AI v2.0 on :${port} db=${sb ? 'supabase' : 'none'}`));
