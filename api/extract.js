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

function getCookies() {
  const cookies = [];
  for (let i = 1; i <= 10; i++) {
    const val = process.env[`TERABOX_COOKIE_${i}`];
    if (val && val.trim()) cookies.push(val.trim());
  }
  if (cookies.length === 0 && process.env.TERABOX_COOKIE) {
    cookies.push(process.env.TERABOX_COOKIE);
  }
  return cookies;
}

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  if (cache.size >= 500) { const firstKey = cache.keys().next().value; cache.delete(firstKey); }
  cache.set(key, { data, time: Date.now() });
}

async function fetchWithRetry(url, options, cookies, maxRetries = 3) {
  let lastError;
  const tried = new Set();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const available = cookies.filter(c => !tried.has(c));
    if (available.length === 0) break;
    const cookie = available[Math.floor(Math.random() * available.length)];
    tried.add(cookie);
    try {
      const res = await fetch(url, {
        ...options,
        headers: { ...options.headers, "Cookie": cookie }
      });
      const data = await res.json();
      if (data.errno === 0) return { data };
      lastError = data;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(lastError?.errmsg || lastError?.message || "All cookies failed");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let shareUrl;
  try { shareUrl = req.body?.shareUrl; } catch { return res.status(400).json({ error: "Invalid request" }); }
  if (!shareUrl) return res.status(400).json({ error: "No URL provided" });

  const match = shareUrl.match(/\/s\/([a-zA-Z0-9_-]+)/);
  if (!match) return res.status(400).json({ error: "Invalid TeraBox link. Please check the URL." });

  const shorturl = match[1];

  const cached = getCache(shorturl);
  if (cached) return res.status(200).json({ ...cached, fromCache: true });

  const cookies = getCookies();
  if (cookies.length === 0) return res.status(500).json({ error: "Server not configured. No cookies found." });

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
  const BASE_HEADERS = {
    "User-Agent": UA,
    "Referer": "https://www.1024terabox.com/",
    "Accept": "application/json, text/plain, */*"
  };

  try {
    const { data: infoData } = await fetchWithRetry(
      `https://www.1024terabox.com/api/shorturlinfo?app_id=250528&shorturl=${shorturl}&root=1`,
      { headers: BASE_HEADERS },
      cookies,
      Math.min(cookies.length, 3)
    );

    if (infoData.errno && infoData.errno !== 0) {
      return res.status(404).json({ error: "File not found or link expired. Please check the link." });
    }

    const fileList = infoData.list || [];
    if (fileList.length === 0) return res.status(404).json({ error: "No files found in this link." });

    const file = fileList[0];
    if (isAdultContent(file.server_filename || file.filename)) {
      return res.status(403).json({ error: "This content is not allowed." });
    }

    const fsId = file.fs_id || file.fid;
    const uk = infoData.uk;
    const shareId = infoData.shareid;
    const sign = infoData.sign;
    const timestamp = infoData.timestamp;

    const { data: dlData } = await fetchWithRetry(
      `https://www.1024terabox.com/api/sharedownload?app_id=250528&sign=${sign}&timestamp=${timestamp}&shorturl=${shorturl}&fid_list=[${fsId}]&uk=${uk}&primaryid=${shareId}&root=1`,
      { headers: BASE_HEADERS },
      cookies,
      Math.min(cookies.length, 3)
    );

    if (!dlData.dlink && (!dlData.list || dlData.list.length === 0)) {
      return res.status(404).json({ error: "Could not get download link." });
    }

    const dlink = dlData.dlink || dlData.list?.[0]?.dlink;
    const result = {
      filename: file.server_filename || file.filename,
      size: file.size,
      dlink: dlink,
      thumbnail: file.thumbs?.url3 || file.thumbs?.url1 || "",
      isVideo: file.category === 1,
    };

    setCache(shorturl, result);
    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: "All servers busy. Please try again in a few seconds." });
  }
}