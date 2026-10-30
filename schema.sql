-- Run once in Supabase: SQL Editor > New query > paste > Run.
create table if not exists products (
  id bigint generated always as identity primary key,
  title text not null, ali_link text, ali_price_usd numeric, daraz_price_pkr numeric, selling_price_pkr numeric, profit_percent numeric,
  shopify_product_id text unique, shopify_url text, fb_post_id text, tiktok_product_id text, status text, created_at timestamptz not null default now());
create table if not exists orders (
  id bigint generated always as identity primary key,
  shopify_order_id text unique not null, order_number text, total_price numeric, currency text, commission numeric,
  items jsonb, unmatched jsonb, created_at timestamptz not null default now());
create table if not exists schedules (
  id bigint generated always as identity primary key,
  page_id text not null, message text not null, scheduled_at timestamptz not null, status text not null default 'pending', post_id text, error text, created_at timestamptz not null default now());
alter table products enable row level security; alter table orders enable row level security; alter table schedules enable row level security;
-- No policies on purpose: only the server's service_role key can read/write. Never put that key in the frontend.
-- Already have an older products table? Also run: alter table products add column if not exists tiktok_product_id text;
