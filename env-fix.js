// Render ENV fix - ye purani file ko chede bina kaam karega
process.env.SUPABASE_URL = process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || process.env.VITE_SUPABASE_URL || "";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON || process.env.VITE_SUPABASE_ANON_KEY || "";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GROQ_KEY || process.env.GROK_API_KEY || process.env.GROK_KEY || "";
console.log("ENV FIX Loaded: Supabase & Groq keys mapped");
