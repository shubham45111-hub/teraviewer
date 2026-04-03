// api/extract.js
// TeraViewer Backend - Production Ready
// Features: Cookie Rotation + In-Memory Cache + Retry Logic + Content Filter

// ─────────────────────────────────────────
// 1. CONTENT FILTER
// ─────────────────────────────────────────
const BLOCKED_KEYWORDS = [
  "sex","xxx","porn","nude","naked","adult","18+","xvideo","xnxx",
  "onlyfans","hentai","erotic","bhabhi","randi","chudai","bf video",
  "boobs","pussy","dick","cock","anal","blowjob","hardcore","horny",
  "sexy girl","hot girl","leaked","mms","viral xxx","fsiblog","fsi blog",
  "desi sex","indian sex","aunty sex","wife sex","girlfriend sex"
];

function isAdultContent(filename) {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return BLOCKED_KEYWORDS.some(kw => lower.includes(kw));
}

// ─────────────────────────────────────────
// 2. COOKIE ROTATION
// Load all 10 cookies from environment variables
// ─────────────────────────────────────────
function getCookies() {
  const cookies = [];
  for (let i = 1; i <= 10; i++) {
    const val = process.env[`TERABOX_COOKIE_${i}`];
    if (val && val.trim()) cookies.push(val.trim());
  }
  // Fallback: if only TERABOX_COOKIE is set (single cookie)
  if (cookies.length === 0 && process.env.TERABOX_COOKIE) {
    cookies.push(process.env.TERABOX_COOKIE);
  }
  return cookies;
}

function getRandomCookie(cookies) {
  return cookies[Math.floor(Math.random() * cookies.length)];
}

// ─────────────────────────────────────────
// 3. IN-MEMORY CACHE
// Same link = no repeat API call for 10 minutes
// ─────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  // Limit cache size to 500 entries (memory safe)
  if (cache.size >= 500) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, time: Date.now() });
}

// ─────────────────────────────────────────
// 4. TERABOX API CALL WITH RETRY
// Tries each cookie until one works
// ─────────────────────────────────────────
async function fetchWithRetry(url, options, cookies, maxRetries = 3) {
  let lastError;
  const tried = new Set();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Pick a cookie not tried yet
    let cookie;
    const available = cookies.filter(c => !tried.has(c));
    if (available.length === 0) break;
    cookie = available[Math.floor(Math.random() * available.length)];
    tried.add(cookie);

    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          "Cookie":cookie,
        }
      });

      // If rate limited, try next cookie
      if (res.status === 429 || res.status === 403) {
        lastError = `Cookie ${attempt + 1} rate limited`;
        continue;
      }

      const data = await res.json();

      // If TeraBox returns auth error, try next cookie
      if (data.errno === -6 || data.errno === -9) {
        lastError = `Cookie ${attempt + 1} auth failed`;
        continue;
      }

      return { data, cookie }; // Success!

    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  throw new Error(lastError || "All cookies failed");
}

// ─────────────────────────────────────────
// 5. MAIN HANDLER
// ─────────────────────────────────────────
export default async function handler(req, res) {

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Parse body
  let shareUrl;
  try {
    shareUrl = req.body?.shareUrl;
  } catch {
    return res.status(400).json({ error: "Invalid request" });
  }

  if (!shareUrl) return res.status(400).json({ error: "No URL provided" });

  // Extract share key
  const match = shareUrl.match(/\/s\/([a-zA-Z0-9_-]+)/);

  const shorturl = match[1];

  // Check cache first
  const cached = getCache(shorturl);
  if (cached) {
    console.log(`Cache hit: ${shorturl}`);
    return res.status(200).json({ ...cached, fromCache: true });
  }

  // Load cookies
  const cookies = getCookies();
  if (cookies.length === 0) {
    return res.status(500).json({ error: "Server not configured. No cookies found." });
  }

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
  const BASE_HEADERS = {
    "User-Agent": UA,
    "Referer": "https://www.terabox.com/",
    "Accept": "application/json, text/plain, */*"
  };

  try {
    // ── STEP 1: Get file info ──
    const { data: infoData } = await fetchWithRetry(
      `https://www.terabox.com/api/shorturlinfo?app_id=250528&shorturl=${shorturl}`,
      { headers: BASE_HEADERS },
      cookies,
      Math.min(cookies.length, 3)
    );

    if (infoData.errno && infoData.errno !== 0) {
      return res.status(404).json({ error: "File not found or link expired. Please check the link." });
    }

    if (!infoData.list || infoData.list.length === 0) {
      return res.status(404).json({ error: "No files found in this link." });
    }

    const file = infoData.list[0];

    // ── CONTENT FILTER ──
    if (isAdultContent(file.server_filename)) {
      return res.status(403).json({
        error: "🚫 This file contains restricted content and cannot be downloaded via TeraViewer."
      });
    }

    // ── STEP 2: Get download links ──
    const { data: dlData } = await fetchWithRetry(
      `https://www.terabox.com/api/download?app_id=250528&sign=${infoData.sign}&timestamp=${infoData.timestamp}&fs_ids=[${file.fs_id}]&shareid=${infoData.shareid}&uk=${infoData.uk}`,
      { headers: BASE_HEADERS },
      cookies,
      Math.min(cookies.length, 3)
    );

    // Build server list
    const servers = [];
    if (dlData.list && dlData.list.length > 0) {
      const dl = dlData.list[0];
      if (dl.dlink) servers.push({ label: "Server 1", icon: "⚡", url: dl.dlink, speed: "Fast" });
      if (file.dlink && file.dlink !== dl.dlink) {
        servers.push({ label: "Server 2", icon: "🚀", url: file.dlink, speed: "Fast" });
      }
    }
    if (file.dlink && !servers.some(s => s.url === file.dlink)) {
      servers.push({ label: "Server 2", icon: "🚀", url: file.dlink, speed: "Normal" });
    }

    if (servers.length === 0) {
      return res.status(500).json({ error: "Could not extract download links. Link may be private." });
    }

    // ── STEP 3: Build response ──
    const result = {
      success: true,
      fileName: file.server_filename || "unknown",
      fileSize: file.size || 0,
      thumbnail: file.thumbs?.url3 || file.thumbs?.url2 || null,
      category: file.category,
      servers
    };

    // Save to cache
    setCache(shorturl, result);

    return res.status(200).json(result);

  } catch (err) {
    console.error("TeraViewer Error:", err.message);
    return res.status(500).json({
      error: "All servers busy. Please try again in a few seconds."
    });
  }
}
