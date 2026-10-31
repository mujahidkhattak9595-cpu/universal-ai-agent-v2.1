process.env.SUPABASE_URL = Object.values(process.env).find(v=>v&&v.includes("supabase.co")) || process.env.SUPABASE_URL;
let jwts = Object.values(process.env).filter(v=>v&&v.length>100&&v.startsWith("eyJ"));
if(jwts[0]) process.env.SUPABASE_ANON_KEY = jwts[0];
if(jwts[1]) process.env.SUPABASE_SERVICE_ROLE_KEY = jwts[1];
if(jwts.length==1) process.env.SUPABASE_SERVICE_ROLE_KEY = jwts[0];
let groq = Object.values(process.env).find(v=>v&&v.startsWith("gsk_"));
if(groq) process.env.GROQ_API_KEY = groq;
console.log("ENV FIX:", !!process.env.SUPABASE_URL, !!process.env.SUPABASE_ANON_KEY, !!process.env.GROQ_API_KEY);
