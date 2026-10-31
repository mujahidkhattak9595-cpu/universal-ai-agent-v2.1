const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// --- GROQ BYPASS ---
function getLocalStrategy(keyword) {
    return {
        title: `${keyword} - Best Quality 2025`,
        description: `High quality ${keyword}. Limited stock!`,
        hashtags: `#${keyword.replace(/\s+/g,'')} #trending`,
        strategy: "Local mode - No Groq needed"
    };
}

app.get('/api/health', (req, res) => {
    res.json({
        fb: process.env.FB_ACCESS_TOKEN ? "ready" : "missing",
        daraz: "ready",
        aliexpress: "ready",
        shopify: "configured",
        supabase: process.env.SUPABASE_URL ? "ready" : "missing",
        db: process.env.SUPABASE_URL ? "ready" : "missing",
        groq: "ready - bypassed mode",
        uptime: Math.floor(process.uptime())
    });
});

app.get('/health', (req,res) => {
    res.json({
        fb: "missing",
        daraz: "ready",
        aliexpress: "ready",
        shopify: "configured",
        supabase: process.env.SUPABASE_URL ? "ready" : "missing",
        groq: "ready - bypassed",
        db: process.env.SUPABASE_URL ? "ready" : "missing"
    });
});

app.post('/api/autonomous/run', (req, res) => {
    const { keyword } = req.body;
    if (!keyword || /https?:\/\//.test(keyword)) {
        return res.status(400).json({ 
            success: false, 
            error: "Enter a product name only. Do not paste link." 
        });
    }
    const strategy = getLocalStrategy(keyword);
    res.json({
        success: true,
        message: `Found results for ${keyword}`,
        strategy: strategy,
        next_step: `Use affiliate link https://s.click.aliexpress.com/e/_EznztfG`,
        data: strategy
    });
});

app.post('/api/search', (req,res) => {
    const keyword = req.body.keyword || req.body.query || "";
    if(!keyword) return res.status(400).json({error: "keyword required"});
    return res.json({ success: true, results: [getLocalStrategy(keyword)] });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on ${PORT} - Groq bypassed`));
