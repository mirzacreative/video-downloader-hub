// Video Downloader Hub — backend (Node.js + Express + yt-dlp).
// The frontend cannot fetch videos directly from the platforms (CORS,
// signed URLs, login walls), so this server does the extraction with yt-dlp
// and streams the chosen format back to the user.
//
// Requires: yt-dlp and ffmpeg installed on the server (see README.md).
// Run:  npm install && npm start        (PORT env, default 3000)

const express = require("express");
const cors = require("cors");
const { execFile, spawn } = require("child_process");
const { Readable } = require("stream");

const PORT = parseInt(process.env.PORT || "3000", 10);
const YT_DLP = process.env.YT_DLP_PATH || "yt-dlp";
const COOKIES_FILE = process.env.COOKIES_FILE || "";
const INFO_TIMEOUT_MS = parseInt(process.env.INFO_TIMEOUT_MS || "60000", 10);
// FastSaverAPI (free tier: 1,000 credits, no card) — YouTube fallback only.
// Set on the SnapDeploy container as FASTSAVER_API_KEY; the key is never
// committed to the repo. Free-plan costs: YouTube info 2 credits,
// YouTube download 15 credits (1080p and below) — about 66 downloads
// per 1,000 credits. yt-dlp stays the first try for YouTube (free when
// it works); FastSaver runs only when yt-dlp is bot-blocked.
const FASTSAVER_API_KEY = process.env.FASTSAVER_API_KEY || "";
const FASTSAVER_BASE = "https://api.fastsaver.io/v1";

const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));

// ---- Platform allow-list -------------------------------------------------
const ALLOWED = [
  { id: "YouTube", hosts: ["youtube.com", "www.youtube.com", "youtu.be", "music.youtube.com", "www.music.youtube.com"] },
  { id: "TikTok", hosts: ["tiktok.com", "www.tiktok.com", "vt.tiktok.com", "vm.tiktok.com"] },
  { id: "Instagram", hosts: ["instagram.com", "www.instagram.com"] },
  { id: "Facebook", hosts: ["facebook.com", "www.facebook.com", "fb.watch", "www.fb.watch"] },
  { id: "Snapchat", hosts: ["snapchat.com", "www.snapchat.com"] },
];

function platformOf(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  for (const p of ALLOWED) if (p.hosts.includes(host)) return p.id;
  return null;
}

// ---- Simple in-memory rate limiting --------------------------------------
const hits = new Map(); // ip -> [timestamps]
function rateLimit(maxPerMin) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || "unknown";
    const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
    if (list.length >= maxPerMin) {
      return res.status(429).json({ error: "Too many requests — please wait a minute and try again." });
    }
    list.push(now);
    hits.set(ip, list);
    next();
  };
}

// ---- Plain-language error mapping ----------------------------------------
function friendlyError(stderr) {
  const s = (stderr || "").toLowerCase();
  if (s.includes("private video") || s.includes("this video is private")) return "This video is private and cannot be downloaded.";
  if (s.includes("login required") || s.includes("sign in") || s.includes("cookies")) return "This video needs a login to view, so it cannot be downloaded here.";
  if (s.includes("age") && s.includes("confirm")) return "This video is age-restricted and cannot be downloaded here.";
  if (s.includes("not available") || s.includes("removed") || s.includes("deleted")) return "This video is not available (removed or deleted).";
  if (s.includes("unsupported url")) return "This link is not a supported video link.";
  if (s.includes("unable to download") || s.includes("http error 403") || s.includes("http error 429")) return "The platform blocked this request. Try again later — platforms change their systems often.";
  return "Could not fetch this video. The link may be private, login-only, or temporarily blocked.";
}

function ytDlpArgs(extra) {
  const args = ["--no-playlist", "--no-warnings"];
  // YouTube bot-checks datacenter IPs ("Sign in to confirm you're not a
  // bot") on its default web player client. Other player clients use
  // different API paths and usually return formats without a login;
  // yt-dlp tries them in order and uses the first that works. The
  // youtube:-prefixed args only apply to YouTube, so other platforms
  // are unaffected. Round 2026-11-11: added web_embedded, web_music,
  // mweb (not tried before) + player_skip=webpage — skipping the watch
  // page fetch (where the bot-check often triggers) and using only the
  // Innertube API.
  args.push("--extractor-args", "youtube:player_client=tv,web_safari,android,ios,web_embedded,web_music,mweb,web");
  args.push("--extractor-args", "youtube:player_skip=webpage");
  if (COOKIES_FILE) args.push("--cookies", COOKIES_FILE);
  return args.concat(extra);
}

// ---- FastSaverAPI (YouTube fallback) --------------------------------------
// Free plan allows 10 requests/min per key, so space calls out (6 s gap)
// to avoid 429s from a burst of visitors. Docs: read the `ok` field,
// not the status code; a failed call costs 0.1 credits.
let lastFastSaverCall = 0;
async function fastSaverThrottle() {
  const now = Date.now();
  const wait = 6000 - (now - lastFastSaverCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFastSaverCall = Date.now();
}

async function fastSaverFetch(path, opts = {}) {
  const res = await fetch(FASTSAVER_BASE + path, {
    ...opts,
    headers: { "X-Api-Key": FASTSAVER_API_KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    // Log the reason (never the key) so a bad key / bad request is
    // diagnosable from the container logs.
    console.error("FastSaver failed:", path.split("?")[0], "HTTP", res.status, JSON.stringify(data).slice(0, 300));
    throw new Error(data.error || data.message || data.detail || "FastSaver request failed");
  }
  return data;
}

// YouTube info via FastSaver, mapped to our /api/info shape. Format ids
// are "fs-<quality>" (e.g. fs-1080p, fs-mp3) so /api/download can tell
// them apart from yt-dlp ids; the download endpoint takes the quality,
// not FastSaver's own format_id.
async function fastSaverYouTubeInfo(url) {
  await fastSaverThrottle();
  const data = await fastSaverFetch(`/youtube/info?url=${encodeURIComponent(url)}`);
  const formats = (data.formats || []).map((f) => {
    // Quality can live in label ("1080p"), in quality ("1080p" or the
    // number 1080), or both — check every string form before giving up.
    const labelText = `${f.label || ""} ${f.quality || ""} ${f.resolution || ""}`;
    let fsFormat = null;
    let audioOnly = false;
    if (/audio/i.test(labelText)) {
      audioOnly = true;
      fsFormat = /m4a/i.test(labelText) ? "m4a" : /mp3/i.test(labelText) ? "mp3" : "audio";
    } else {
      const m = labelText.match(/(\d{3,4})p/i);
      if (m) fsFormat = m[1] + "p";
    }
    if (!fsFormat) return null;
    return {
      format_id: `fs-${fsFormat}`,
      label: `${f.label || fsFormat}${f.size_readable ? " — " + f.size_readable : ""}`,
      height: audioOnly ? 0 : (parseInt(fsFormat, 10) || 0),
      ext: f.ext || (fsFormat === "mp3" ? "mp3" : fsFormat === "m4a" ? "m4a" : "mp4"),
      audioOnly,
    };
  }).filter(Boolean);
  if (!formats.length) {
    console.error("FastSaver info: no usable formats. Raw sample:", JSON.stringify((data.formats || []).slice(0, 3)).slice(0, 500));
    throw new Error("No FastSaver formats");
  }
  return {
    title: data.title || "Untitled video",
    thumbnail: data.thumbnail || data.thumbnail_url || "",
    duration: data.duration || null,
    uploader: data.channel || "",
    platform: "YouTube",
    watermark_free: false,
    formats,
  };
}

// ---- Snapchat (no yt-dlp extractor exists) -------------------------------
// Public Spotlight pages carry an og:video tag with a direct MP4 URL —
// verified 2026-11-10 (8.2 MB MP4, no login). Stories and private snaps
// have no og:video, so they correctly fail here.
const SNAP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SNAP_FORMAT_ID = "snapchat-video";

async function fetchSnapchatInfo(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": SNAP_UA, Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("Snapchat page fetch failed");
  const html = await res.text();
  const pick = (prop) => {
    const m = html.match(new RegExp(`<meta\\s+property="${prop}"\\s+content="([^"]+)"`))
      || html.match(new RegExp(`<meta\\s+content="([^"]+)"\\s+property="${prop}"`));
    return m ? m[1].replace(/&amp;/g, "&") : "";
  };
  const videoUrl = pick("og:video");
  if (!videoUrl) throw new Error("No video on this Snapchat link");
  const dur = html.match(/"duration":"PT(\d+)S"/);
  return {
    videoUrl,
    title: pick("og:title") || "Snapchat video",
    thumbnail: pick("og:image"),
    duration: dur ? parseInt(dur[1], 10) : null,
  };
}

// ---- Format picking -------------------------------------------------------
function pickFormats(info, platform) {
  const formats = (info.formats || []).filter((f) => f.url);
  // Best audio track (for merging and for the audio-only option).
  const audios = formats
    .filter((f) => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none")
    .sort((a, b) => (b.abr || 0) - (a.abr || 0));
  const bestAudio = audios.find((f) => f.ext === "m4a") || audios[0];
  // Combined video+audio formats, best per height (TikTok/Instagram/FB often have these).
  const combined = formats.filter((f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none");
  const byHeight = new Map();
  for (const f of combined) {
    const h = f.height || 0;
    if (!byHeight.has(h) || (f.filesize || 0) > (byHeight.get(h).filesize || 0)) byHeight.set(h, f);
  }
  // YouTube now mostly serves DASH video-only + audio-only: merge them
  // (yt-dlp + ffmpeg combine "videoId+audioId" at download time).
  const videoOnly = formats.filter((f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none"));
  const scoreVideo = (f) => (f.ext === "mp4" ? 2 : 0) + (/^avc1/.test(f.vcodec || "") ? 1 : 0);
  for (const f of videoOnly) {
    const h = f.height || 0;
    if (!h) continue;
    if (byHeight.has(h)) continue; // combined already covers this height
    const cur = byHeight.get(h);
    const cand = { ...f, format_id: bestAudio ? `${f.format_id}+${bestAudio.format_id}` : String(f.format_id), merged: true };
    if (!cur || scoreVideo(f) > scoreVideo(cur)) byHeight.set(h, cand);
  }
  let list = [...byHeight.values()].sort((a, b) => (b.height || 0) - (a.height || 0));
  // TikTok: prefer formats without a watermark marker when yt-dlp exposes one.
  let watermarkFree = false;
  if (platform === "TikTok") {
    const clean = list.filter((f) => !/watermark/i.test(`${f.format_note || ""} ${f.format_id || ""}`));
    if (clean.length) { list = clean; watermarkFree = true; }
    else if (list.some((f) => /no.?watermark/i.test(f.format_note || ""))) watermarkFree = true;
  }
  const out = list.slice(0, 6).map((f) => ({
    format_id: String(f.format_id),
    label: `${f.height ? f.height + "p" : "Video"}${f.ext ? " (" + f.ext + ")" : ""}${f.filesize ? " — " + Math.round(f.filesize / 1048576) + " MB" : ""}`,
    height: f.height || 0,
    ext: f.ext || "mp4",
  }));
  // Audio-only option.
  const audio = formats
    .filter((f) => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none")
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
  if (audio) out.push({ format_id: String(audio.format_id), label: `Audio only${audio.abr ? " (" + Math.round(audio.abr) + " kbps)" : ""}`, height: 0, ext: audio.ext || "m4a", audioOnly: true });
  return { formats: out, watermarkFree };
}

function safeFilename(title) {
  return (title || "video").replace(/[^\w\- .()[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

// ---- Routes ---------------------------------------------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/info", rateLimit(20), (req, res) => {
  const url = (req.query.url || "").toString().trim();
  const platform = url ? platformOf(url) : null;
  if (!url || !platform) {
    return res.status(400).json({ error: "Paste a valid video link from YouTube, TikTok, Instagram, Facebook or Snapchat." });
  }
  if (platform === "Snapchat") {
    fetchSnapchatInfo(url).then((snap) => {
      res.json({
        title: snap.title,
        thumbnail: snap.thumbnail,
        duration: snap.duration,
        uploader: "",
        platform,
        watermark_free: true,
        formats: [{ format_id: SNAP_FORMAT_ID, label: "Video (MP4)", height: 0, ext: "mp4" }],
      });
    }).catch(() => res.status(422).json({ error: "Snapchat could not read this link. Only public Spotlight videos work — private snaps and stories cannot be downloaded." }));
    return;
  }
  execFile(
    YT_DLP,
    ytDlpArgs(["-J", "--no-check-certificates", url]),
    { timeout: INFO_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        // yt-dlp is bot-blocked for YouTube on this host. Fall back to
        // FastSaverAPI (2 credits) instead of failing the user outright.
        if (platform === "YouTube" && FASTSAVER_API_KEY) {
          fastSaverYouTubeInfo(url)
            .then((fsInfo) => res.json(fsInfo))
            .catch(() => res.status(422).json({ error: "YouTube downloads are temporarily unavailable. Please try again in a few minutes." }));
          return;
        }
        return res.status(422).json({ error: friendlyError(stderr || err.message) });
      }
      let info;
      try { info = JSON.parse(stdout); } catch { return res.status(502).json({ error: "The video service returned an unreadable response. Try again later." }); }
      const { formats, watermarkFree } = pickFormats(info, platform);
      if (!formats.length) {
        if (platform === "YouTube" && FASTSAVER_API_KEY) {
          fastSaverYouTubeInfo(url)
            .then((fsInfo) => res.json(fsInfo))
            .catch(() => res.status(422).json({ error: "No downloadable formats found for this video." }));
          return;
        }
        return res.status(422).json({ error: "No downloadable formats found for this video." });
      }
      res.json({
        title: info.title || "Untitled video",
        thumbnail: info.thumbnail || "",
        duration: info.duration || null,
        uploader: info.uploader || info.channel || "",
        platform,
        watermark_free: watermarkFree,
        formats,
      });
    }
  );
});

app.get("/api/download", rateLimit(10), (req, res) => {
  const url = (req.query.url || "").toString().trim();
  const formatId = (req.query.format_id || "").toString().trim();
  const platform = url ? platformOf(url) : null;
  if (!url || !platform) {
    return res.status(400).json({ error: "Paste a valid video link from YouTube, TikTok, Instagram, Facebook or Snapchat." });
  }
  // Merged pairs look like "298+140" — allow letters, digits, _ - + .
  // Instagram/Facebook dash IDs run ~45 chars, so the cap is generous.
  if (!/^[A-Za-z0-9_+.\-]+$/.test(formatId) || formatId.length > 100) {
    return res.status(400).json({ error: "Pick a resolution first." });
  }
  // FastSaver-backed YouTube formats (fs-1080p, fs-mp3, ...). FastSaver
  // returns a signed tunnel link (expires in 5 min, max 3 opens) and its
  // docs say to hand it straight to the user's browser — so redirect
  // instead of proxying. Each call costs 15 credits (free tier: 1,000).
  if (formatId.startsWith("fs-")) {
    if (platform !== "YouTube" || !/^fs-(audio|mp3|m4a|\d{3,4}p)$/.test(formatId) || !FASTSAVER_API_KEY) {
      return res.status(422).json({ error: "YouTube downloads are temporarily unavailable. Please try again in a few minutes." });
    }
    fastSaverThrottle()
      .then(() => fastSaverFetch("/youtube/download", { method: "POST", body: JSON.stringify({ url, format: formatId.slice(3) }) }))
      .then((data) => {
        if (!data.download_url) throw new Error("No download link");
        res.redirect(302, data.download_url);
      })
      .catch(() => {
        if (!res.headersSent) res.status(422).json({ error: "YouTube download failed. Please try again in a few minutes." });
      });
    return;
  }
  if (platform === "Snapchat") {
    if (formatId !== SNAP_FORMAT_ID) return res.status(400).json({ error: "Pick a resolution first." });
    fetchSnapchatInfo(url).then(async (snap) => {
      try {
        const up = await fetch(snap.videoUrl, {
          headers: { "User-Agent": SNAP_UA },
          redirect: "follow",
          signal: AbortSignal.timeout(90000),
        });
        if (!up.ok || !up.body) return res.status(502).json({ error: "Snapchat download failed. Try again later." });
        res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(snap.title)}.mp4"`);
        res.setHeader("Content-Type", "video/mp4");
        Readable.fromWeb(up.body).pipe(res);
      } catch {
        if (!res.headersSent) res.status(502).json({ error: "Snapchat download failed. Try again later." });
      }
    }).catch(() => {
      if (!res.headersSent) res.status(422).json({ error: "Snapchat could not read this link. Only public Spotlight videos work." });
    });
    return;
  }
  // Resolve the title first (cheap metadata call) so the filename is sane.
  execFile(
    YT_DLP,
    ytDlpArgs(["-J", "--no-check-certificates", url]),
    { timeout: INFO_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) return res.status(422).json({ error: friendlyError(stderr || err.message) });
      let info;
      try { info = JSON.parse(stdout); } catch { return res.status(502).json({ error: "The video service returned an unreadable response. Try again later." }); }
      const { formats } = pickFormats(info, platform);
      const chosen = formats.find((f) => f.format_id === formatId);
      if (!chosen) return res.status(400).json({ error: "That resolution is not available for this video. Fetch the video again." });
      // Merged (video+audio) downloads cannot be streamed as MP4 — MP4 needs
      // its index (moov) at the end, which stdout streaming cannot provide,
      // so yt-dlp falls back to MPEG-TS. Force MKV instead: it streams
      // cleanly and plays in VLC and most players.
      const merged = formatId.includes("+");
      const ext = merged ? "mkv" : (chosen.ext || "mp4");
      const filename = `${safeFilename(info.title)}.${ext}`;
      const dlArgs = ["-f", formatId, "-o", "-", "--no-check-certificates"];
      if (merged) dlArgs.push("--merge-output-format", "mkv");
      dlArgs.push(url);
      const child = spawn(YT_DLP, ytDlpArgs(dlArgs), { stdio: ["ignore", "pipe", "pipe"] });
      let stderrBuf = "";
      let started = false;
      child.stderr.on("data", (d) => { stderrBuf += d.toString(); });
      // Only send headers + start the response once yt-dlp actually
      // produces bytes. If it fails first (bot-check, login wall), the
      // user gets a clear JSON error instead of an empty file.
      child.stdout.on("data", (chunk) => {
        if (!started) {
          started = true;
          res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
          res.setHeader("Content-Type", chosen.audioOnly ? "audio/mp4" : (merged ? "video/x-matroska" : "video/mp4"));
        }
        res.write(chunk);
      });
      child.on("error", () => {
        if (!started) res.status(502).json({ error: "Download failed. Try again later." });
        else res.end();
      });
      child.on("close", (code) => {
        if (!started) {
          if (code !== 0) res.status(422).json({ error: friendlyError(stderrBuf) });
          else res.status(502).json({ error: "Download produced no data. Try again later." });
        } else if (!res.writableEnded) res.end();
      });
      req.on("close", () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
    }
  );
});

app.listen(PORT, () => {
  console.log(`Video Downloader Hub API listening on :${PORT}`);
  // Presence only — never log the key itself.
  console.log("FastSaver key:", FASTSAVER_API_KEY ? `set (${FASTSAVER_API_KEY.length} chars)` : "NOT SET");
});
