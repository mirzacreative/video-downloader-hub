// Video Downloader Hub — frontend.
//
// HYBRID fetching (free, temporary setup):
//   - TikTok: TikWM public API, called directly from the browser
//     (GET https://www.tikwm.com/api/?url=...). CORS-open, no key needed.
//     data.play = no-watermark video, data.wmplay = watermarked video,
//     data.music = audio track.
//   - YouTube / Instagram / Facebook / Snapchat: our own API, which
//     extracts with yt-dlp and streams the chosen format back
//     (GET <API_BASE>/api/info and /api/download). After the API is
//     deployed on Render, set API_BASE to its URL, e.g.
//     "https://video-downloader-hub-api.onrender.com".
//     Leave it as "" to use the same origin (when frontend + API are
//     served together).
const API_BASE = ""; // <-- SET THIS to the Render API URL after deploy
const TIKWM_API = "https://www.tikwm.com/api/";

const PLATFORMS = {
  youtube:   { name: "YouTube",   hint: "YouTube links: youtube.com/watch?v=… or youtu.be/…",   domains: ["youtube.com", "youtu.be", "music.youtube.com"], wmSupport: false, placeholder: "Paste a YouTube link — e.g. youtube.com/watch?v=…" },
  tiktok:    { name: "TikTok",    hint: "TikTok links: tiktok.com/@user/video/… or vt.tiktok.com/…", domains: ["tiktok.com", "vt.tiktok.com", "vm.tiktok.com"], wmSupport: true, placeholder: "Paste a TikTok link — e.g. tiktok.com/@user/video/…" },
  instagram: { name: "Instagram", hint: "Instagram links: instagram.com/reel/… or instagram.com/p/…", domains: ["instagram.com"], wmSupport: true, placeholder: "Paste an Instagram link — a Reel, video post or story…" },
  facebook:  { name: "Facebook",  hint: "Facebook links: facebook.com/watch?v=… or fb.watch/…", domains: ["facebook.com", "fb.watch"], wmSupport: true, placeholder: "Paste a Facebook video link — a watch link or fb.watch short link…" },
  snapchat:  { name: "Snapchat",  hint: "Snapchat links: snapchat.com/spotlight/… — often blocked, may fail.", domains: ["snapchat.com"], wmSupport: true, placeholder: "Paste a Snapchat link — a Spotlight or public story link…" },
};

let currentPlatform = "youtube";
let currentUrl = "";
let currentFormats = [];   // API path: [{format_id, label, ...}]
let tikwmMode = false;     // true when the current result came from TikWM
let tikwmLinks = null;     // {play, wmplay, music}
let removeWatermark = false;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const resultEl = $("result");

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return "";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function setWm(on) {
  removeWatermark = on;
  $("wm-switch").setAttribute("aria-checked", on ? "true" : "false");
}

function selectPlatform(key, opts) {
  opts = opts || {};
  currentPlatform = key;
  const p = PLATFORMS[key];
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.platform === key;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".plat-card").forEach((c) => {
    const on = c.dataset.platform === key;
    c.classList.toggle("active", on);
    c.setAttribute("aria-pressed", on ? "true" : "false");
  });
  $("platform-hint").textContent = p.hint;
  $("url-input").placeholder = p.placeholder;
  // Watermark switch: only the four social platforms support it.
  const sw = $("wm-switch");
  if (p.wmSupport) {
    sw.disabled = false;
    $("wm-hint").textContent = "Available for " + p.name + " — downloads the clean original video, without the platform logo overlay.";
    setWm(true);
  } else {
    sw.disabled = true;
    setWm(false);
    $("wm-hint").textContent = p.name + " videos don't carry a moving watermark, so there's nothing to remove.";
  }
  tikwmMode = false;
  tikwmLinks = null;
  resultEl.hidden = true;
  setStatus("");
  if (opts.focus) $("url-input").focus();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectPlatform(tab.dataset.platform));
});

document.querySelectorAll(".plat-card").forEach((card) => {
  card.addEventListener("click", () => {
    selectPlatform(card.dataset.platform);
    document.querySelector(".hero").scrollIntoView({ behavior: "smooth", block: "start" });
    $("url-input").focus();
  });
});

$("wm-switch").addEventListener("click", () => {
  const sw = $("wm-switch");
  if (sw.disabled) return;
  setWm(!removeWatermark);
  // Re-order the TikTok options so the preferred version is selected.
  if (tikwmMode && tikwmLinks) renderTikTokFormats();
  updateWmTag();
});

function updateWmTag() {
  const show = PLATFORMS[currentPlatform].wmSupport && removeWatermark;
  $("res-wm-tag").hidden = !show;
  $("wm-note").hidden = !show;
}

function detectPlatformFromUrl(rawUrl) {
  let host = "";
  try {
    host = new URL(rawUrl.indexOf("://") === -1 ? "https://" + rawUrl : rawUrl).hostname.toLowerCase();
  } catch { return null; }
  for (const [key, p] of Object.entries(PLATFORMS)) {
    if (p.domains.some((d) => host === d || host.endsWith("." + d))) return key;
  }
  return null;
}

function fillFormatSelect(options) {
  const select = $("format-select");
  select.innerHTML = "";
  options.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.selected) opt.selected = true;
    select.appendChild(opt);
  });
}

// ---- TikTok via TikWM (direct from the browser, no key) ------------------
function renderTikTokFormats() {
  if (!tikwmLinks) return;
  const opts = [];
  if (tikwmLinks.play) opts.push({ value: "tikwm:play", label: "No watermark (HD)", selected: removeWatermark });
  if (tikwmLinks.wmplay) opts.push({ value: "tikwm:wmplay", label: "With watermark", selected: !removeWatermark && !tikwmLinks.play });
  if (tikwmLinks.music) opts.push({ value: "tikwm:music", label: "Audio only (MP3)" });
  if (!opts.length) throw new Error("No downloadable version was returned for this TikTok video.");
  fillFormatSelect(opts);
}

async function fetchTikTok(url) {
  let data;
  try {
    const res = await fetch(`${TIKWM_API}?url=${encodeURIComponent(url)}`);
    data = await res.json();
  } catch {
    throw new Error("TikTok did not answer. Check your connection and try again in a moment.");
  }
  if (!data || data.code !== 0 || !data.data || !data.data.play) {
    // TikWM returns code -1 for links it cannot parse (deleted, private,
    // or malformed URLs). Keep the message plain and actionable.
    throw new Error("TikTok could not read this link. Check it is a public TikTok video and try again.");
  }
  const d = data.data;
  tikwmLinks = { play: d.play || "", wmplay: d.wmplay || "", music: d.music || "" };
  tikwmMode = true;
  $("res-thumb").src = d.cover || "";
  $("res-thumb").alt = d.title || "Video thumbnail";
  $("res-title").textContent = d.title || "Untitled video";
  const bits = [];
  if (d.author && d.author.nickname) bits.push(d.author.nickname);
  if (d.duration) bits.push(formatDuration(d.duration));
  bits.push("TikTok · No watermark");
  $("res-info").textContent = bits.join(" · ");
  renderTikTokFormats();
  updateWmTag();
  resultEl.hidden = false;
  setStatus("Video found — pick a version and press Download.", "ok");
}

// ---- YouTube / Instagram / Facebook / Snapchat via our own API -----------
async function fetchViaApi(url, platform) {
  const res = await fetch(`${API_BASE}/api/info?url=${encodeURIComponent(url)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not fetch this video.");
  currentFormats = data.formats || [];
  if (!currentFormats.length) throw new Error("No downloadable formats found for this video.");
  tikwmMode = false;
  $("res-thumb").src = data.thumbnail || "";
  $("res-thumb").alt = data.title || "Video thumbnail";
  $("res-title").textContent = data.title || "Untitled video";
  const bits = [];
  if (data.uploader) bits.push(data.uploader);
  if (data.duration) bits.push(formatDuration(data.duration));
  if (data.platform) bits.push(data.platform);
  $("res-info").textContent = bits.join(" · ");
  fillFormatSelect(currentFormats.map((f) => ({ value: f.format_id, label: f.label })));
  updateWmTag();
  resultEl.hidden = false;
  setStatus("Video found — pick a resolution and press Download.", "ok");
}

$("dl-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("url-input").value.trim();
  if (!url) return;
  const detected = detectPlatformFromUrl(url);
  if (detected && detected !== currentPlatform) selectPlatform(detected);
  const platform = detected || currentPlatform;
  currentUrl = url;
  tikwmMode = false;
  tikwmLinks = null;
  resultEl.hidden = true;
  setStatus("Fetching video info…");
  $("fetch-btn").disabled = true;
  try {
    if (platform === "tiktok") await fetchTikTok(url);
    else await fetchViaApi(url, platform);
  } catch (err) {
    setStatus(err.message || "Something went wrong. Try another link.", "error");
  } finally {
    $("fetch-btn").disabled = false;
  }
});

$("download-btn").addEventListener("click", () => {
  const choice = $("format-select").value;
  if (!currentUrl || !choice) return;
  setStatus("Download starting…");
  if (tikwmMode) {
    // Direct file URL from TikWM — the browser downloads it as-is.
    const link = choice === "tikwm:wmplay" ? tikwmLinks.wmplay
      : choice === "tikwm:music" ? tikwmLinks.music
      : tikwmLinks.play;
    if (!link) { setStatus("That version is not available for this video.", "error"); return; }
    window.location.href = link;
    return;
  }
  window.location.href =
    `${API_BASE}/api/download?url=${encodeURIComponent(currentUrl)}&format_id=${encodeURIComponent(choice)}`;
});
