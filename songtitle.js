var mountPoint = window.location.pathname.split("/")[1];
const defaultAlbumArt = "/default-art.jpg";

const SHOUTCAST_ORIGIN = "https://music.elsewhere.moe";

const SHOUTCAST_STREAMS = {
  lilly: { sid: 1, logo: "/lilly/DJ-LILLY-LOGO.png" },
};

const artCache = new Map();
let lastRawTitle = null;

function isDjLilly(artist) {
  return normalizeForMatch(artist) === "dj lilly";
}

function parseTrackMetadata(raw) {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const parts = cleaned.split(/\s-\s/).map((p) => p.trim()).filter(Boolean);

  if (parts.length >= 2) {
    return {
      artist: parts[0],
      track: parts.slice(1).join(" - "),
      raw: cleaned,
    };
  }

  return { artist: "", track: cleaned, raw: cleaned };
}

function normalizeForMatch(value) {
  return value
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreTrackResult(result, artist, track, source) {
  const trackNorm = normalizeForMatch(track);
  const artistNorm = normalizeForMatch(artist);
  const nameNorm = normalizeForMatch(
    source === "deezer" ? result.title : result.trackName
  );
  const artistResultNorm = normalizeForMatch(
    source === "deezer" ? result.artist?.name : result.artistName
  );

  let score = 0;

  if (trackNorm && nameNorm === trackNorm) score += 12;
  else if (trackNorm && nameNorm.includes(trackNorm)) score += 6;

  if (artistNorm && artistResultNorm === artistNorm) score += 10;
  else if (artistNorm && artistResultNorm.includes(artistNorm)) score += 5;

  return score;
}

function pickBestResult(results, artist, track, source) {
  return results
    .map((result) => ({
      result,
      score: scoreTrackResult(result, artist, track, source),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.result;
}

async function searchItunes(artist, track) {
  const queries = [];

  if (artist && track) queries.push(`${artist} ${track}`);
  if (track) queries.push(track);
  if (artist) queries.push(artist);

  for (const query of queries) {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=8`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.resultCount) continue;

    const best = pickBestResult(data.results, artist, track, "itunes");
    if (best?.artworkUrl100) {
      return best.artworkUrl100.replace("100x100bb", "600x600bb").replace("100x100", "600x600");
    }
  }

  return null;
}

async function searchDeezer(artist, track) {
  const queries = [];

  if (artist && track) queries.push(`artist:"${artist}" track:"${track}"`);
  if (track) queries.push(track);

  for (const query of queries) {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=8`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.data?.length) continue;

    const best = pickBestResult(data.data, artist, track, "deezer");
    if (best?.album?.cover_xl) return best.album.cover_xl;
    if (best?.album?.cover_big) return best.album.cover_big;
  }

  return null;
}

async function fetchAlbumArt(metadata, mountPoint) {
  const { artist, track } = metadata;
  const cacheKey = `${artist}|${track}`;

  if (artCache.has(cacheKey)) {
    return artCache.get(cacheKey);
  }

  const streamConfig = SHOUTCAST_STREAMS[mountPoint];
  if (streamConfig?.logo && isDjLilly(artist)) {
    artCache.set(cacheKey, streamConfig.logo);
    return streamConfig.logo;
  }

  const genericTitles = /^(various artists|unknown|loading|offline)$/i;
  if (!track || genericTitles.test(track)) {
    return defaultAlbumArt;
  }

  try {
    const art =
      (await searchItunes(artist, track)) ||
      (await searchDeezer(artist, track));

    const url = art || defaultAlbumArt;
    artCache.set(cacheKey, url);
    return url;
  } catch (err) {
    console.warn("Album art fetch failed:", err);
    return defaultAlbumArt;
  }
}

async function fetchShoutcastStats(sid) {
  const response = await fetch(`${SHOUTCAST_ORIGIN}/stats?sid=${sid}&json=1`);
  if (!response.ok) {
    throw new Error(`Shoutcast stats failed: ${response.status}`);
  }
  return response.json();
}

async function shoutcastSongTitle({ sid }) {
  const data = await fetchShoutcastStats(sid);

  if (!data || data.streamstatus !== 1 || !data.songtitle) return null;
  return data.songtitle.trim();
}

async function icecastSongTitle(mountPoint) {
  const response = await fetch("https://music.pixelhumble.com/status-json.xsl");
  const stats = await response.json();

  let sources = stats.icestats.source;
  if (!sources) return null;
  if (!Array.isArray(sources)) sources = [sources];

  const match = sources.find((s) => s.listenurl.includes(mountPoint));
  if (!match || !match.title) return null;

  return match.title;
}

async function songTitle(mountPoint) {
  const shoutcast = SHOUTCAST_STREAMS[mountPoint];
  if (shoutcast) return shoutcastSongTitle(shoutcast);
  return icecastSongTitle(mountPoint);
}

function updateLegacyTitles(text) {
  document.querySelectorAll(".scroll-title").forEach((el) => {
    el.textContent = text;
  });

  const legacy = document.getElementById("currentsongtitletext");
  if (legacy) legacy.textContent = text;
}

function setMarqueeTitle(element, text) {
  element.classList.remove("is-marquee");
  element.textContent = text;

  requestAnimationFrame(() => {
    if (element.scrollWidth > element.clientWidth + 4) {
      element.classList.add("is-marquee");
      element.innerHTML = `<span class="marquee-inner">${text} &nbsp;·&nbsp; ${text}</span>`;
    }
  });
}

const LILLY_DEFAULT_THEME = {
  bg: [207, 168, 171],
  bgDeep: [196, 154, 158],
  accent: [168, 85, 99],
};

let lastArtPalette = null;
let themeActive = false;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rgbCss([r, g, b], alpha) {
  if (alpha !== undefined) {
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `rgb(${r}, ${g}, ${b})`;
}

function blendRgb(from, to, amount) {
  return [
    Math.round(from[0] * amount + to[0] * (1 - amount)),
    Math.round(from[1] * amount + to[1] * (1 - amount)),
    Math.round(from[2] * amount + to[2] * (1 - amount)),
  ];
}

function shiftRgb([r, g, b], amount) {
  return [clamp(r + amount, 0, 255), clamp(g + amount, 0, 255), clamp(b + amount, 0, 255)];
}

function luminance([r, g, b]) {
  const channels = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function getDefaultTheme() {
  const { bg, bgDeep, accent } = LILLY_DEFAULT_THEME;

  return buildTheme({
    primary: bg,
    vibrant: accent,
    muted: bgDeep,
    isDefault: true,
  });
}

function buildTheme({ primary, vibrant, muted, isDefault = false, active = false }) {
  if (isDefault) {
    const { bg, bgDeep, accent } = LILLY_DEFAULT_THEME;
    const card = blendRgb(bg, [255, 255, 255], 0.18);
    const cardBorder = blendRgb(accent, bg, 0.62);
    const cardGlow = blendRgb(accent, bg, 0.35);
    const cardLight = luminance(card) > 0.58;
    const text = cardLight ? [34, 22, 26] : [248, 244, 245];
    const textMutedAlpha = cardLight ? 0.64 : 0.72;

    return {
      bg,
      bgDeep,
      accent,
      card: rgbCss(card, 0.92),
      cardBorder: rgbCss(cardBorder, 0.75),
      cardGlow: rgbCss(cardGlow, 0.34),
      text: rgbCss(text),
      textMuted: rgbCss(text, textMutedAlpha),
      shadow: rgbCss(shiftRgb(accent, -24), 0.34),
      control: rgbCss(text, cardLight ? 0.1 : 0.14),
      controlHover: rgbCss(text, cardLight ? 0.16 : 0.22),
      blurOverlay: rgbCss(blendRgb(bg, bgDeep, 0.55), 0.58),
      blurSaturation: 1.35,
      electricHot: rgbCss(accent),
      electricCore: rgbCss(blendRgb(bg, accent, 0.45)),
      electricSpark: rgbCss(blendRgb(accent, [255, 255, 255], 0.2)),
      electricGlow: rgbCss(blendRgb(accent, bg, 0.35), 0.45),
    };
  }

  const bg = primary;
  const bgDeep = muted;
  const accent = vibrant;

  const card = blendRgb(primary, vibrant, active ? 0.38 : 0.26);
  const cardBorder = blendRgb(vibrant, primary, active ? 0.75 : 0.62);
  const cardGlow = blendRgb(vibrant, primary, active ? 0.62 : 0.48);

  const cardLight = luminance(card) > 0.58;
  const text = cardLight ? [34, 22, 26] : [248, 244, 245];
  const textMutedAlpha = cardLight ? 0.64 : 0.72;

  return {
    bg,
    bgDeep,
    accent,
    card: rgbCss(card, active ? 0.74 : 0.82),
    cardBorder: rgbCss(cardBorder, active ? 0.85 : 0.72),
    cardGlow: rgbCss(cardGlow, active ? 0.58 : 0.42),
    text: rgbCss(text),
    textMuted: rgbCss(text, textMutedAlpha),
    shadow: rgbCss(shiftRgb(accent, -24), active ? 0.44 : 0.36),
    control: rgbCss(text, cardLight ? 0.1 : 0.14),
    controlHover: rgbCss(text, cardLight ? 0.16 : 0.22),
    blurOverlay: rgbCss(blendRgb(primary, muted, active ? 0.68 : 0.52), active ? 0.86 : 0.74),
    blurSaturation: active ? 2.15 : 1.85,
    electricHot: rgbCss(blendRgb(vibrant, [255, 255, 255], active ? 0.04 : 0.12)),
    electricCore: rgbCss(blendRgb(primary, vibrant, active ? 0.32 : 0.48)),
    electricSpark: rgbCss(blendRgb(vibrant, [255, 255, 255], active ? 0.02 : 0.08)),
    electricGlow: rgbCss(blendRgb(vibrant, primary, 0.25), active ? 0.78 : 0.55),
  };
}

function applyLillyTheme(theme) {
  if (!document.body.classList.contains("lilly-player")) return;

  const root = document.body;
  root.style.setProperty("--theme-bg", rgbCss(theme.bg));
  root.style.setProperty("--theme-bg-deep", rgbCss(theme.bgDeep));
  root.style.setProperty("--theme-accent", rgbCss(theme.accent));
  root.style.setProperty("--theme-card", theme.card);
  root.style.setProperty("--theme-card-border", theme.cardBorder);
  root.style.setProperty("--theme-card-glow", theme.cardGlow);
  root.style.setProperty("--theme-text", theme.text);
  root.style.setProperty("--theme-text-muted", theme.textMuted);
  root.style.setProperty("--theme-shadow", theme.shadow);
  root.style.setProperty("--theme-control", theme.control);
  root.style.setProperty("--theme-control-hover", theme.controlHover);
  root.style.setProperty("--theme-blur-overlay", theme.blurOverlay);
  root.style.setProperty("--theme-blur-saturation", theme.blurSaturation);
  root.style.setProperty("--theme-electric-hot", theme.electricHot);
  root.style.setProperty("--theme-electric-core", theme.electricCore);
  root.style.setProperty("--theme-electric-spark", theme.electricSpark);
  root.style.setProperty("--theme-electric-glow", theme.electricGlow);
}

function refreshTheme() {
  if (lastArtPalette) {
    applyLillyTheme(buildTheme({ ...lastArtPalette, active: themeActive }));
    return;
  }

  applyLillyTheme(getDefaultTheme());
}

function setThemeActive(active) {
  themeActive = active;
  refreshTheme();
}

window.lillyTheme = { setActive: setThemeActive, refresh: refreshTheme };

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  const size = 64;
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(image, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let weightSum = 0;
  let bestSatScore = 0;
  let vibrant = null;
  let darkR = 0;
  let darkG = 0;
  let darkB = 0;
  let darkWeight = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const alpha = data[i + 3];

    if (alpha < 128) continue;

    const brightness = (r + g + b) / 3;
    if (brightness < 22 || brightness > 248) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const weight = 0.25 + saturation * 1.65;

    rSum += r * weight;
    gSum += g * weight;
    bSum += b * weight;
    weightSum += weight;

    const satScore = saturation * (1 - Math.abs(brightness - 132) / 132);
    if (satScore > bestSatScore) {
      bestSatScore = satScore;
      vibrant = [r, g, b];
    }

    if (brightness < 118 && saturation > 0.08) {
      const darkPixelWeight = (118 - brightness) * (0.4 + saturation);
      darkR += r * darkPixelWeight;
      darkG += g * darkPixelWeight;
      darkB += b * darkPixelWeight;
      darkWeight += darkPixelWeight;
    }
  }

  if (!weightSum) return null;

  const primary = [
    Math.round(rSum / weightSum),
    Math.round(gSum / weightSum),
    Math.round(bSum / weightSum),
  ];

  const muted = darkWeight
    ? [
        Math.round(darkR / darkWeight),
        Math.round(darkG / darkWeight),
        Math.round(darkB / darkWeight),
      ]
    : shiftRgb(primary, -36);

  return {
    primary,
    vibrant: vibrant || primary,
    muted,
  };
}

function applyThemeFromImage(image) {
  const palette = extractPalette(image);
  if (!palette) {
    lastArtPalette = null;
    applyLillyTheme(getDefaultTheme());
    return;
  }

  lastArtPalette = palette;
  applyLillyTheme(buildTheme({ ...palette, active: themeActive }));
}

function setAlbumArt(url, { skipTheme = false } = {}) {
  const img = document.getElementById("albumart");
  const blur = document.getElementById("bg-blur");
  if (!img) return;

  const absoluteUrl = new URL(url, window.location.origin).href;
  const isLogo = url.includes("DJ-LILLY-LOGO");

  if (img.dataset.current === absoluteUrl) return;

  img.classList.toggle("is-logo", isLogo);
  img.classList.add("is-loading");

  const next = new Image();
  next.onload = () => {
    img.src = absoluteUrl;
    img.dataset.current = absoluteUrl;
    img.classList.remove("is-loading");
    if (blur) {
      blur.style.backgroundImage =
        skipTheme || isLogo ? "none" : `url("${absoluteUrl}")`;
    }
    if (isLogo) {
      lastArtPalette = null;
      applyLillyTheme(getDefaultTheme());
    } else if (!skipTheme) {
      applyThemeFromImage(next);
    }
  };
  next.onerror = () => {
    img.classList.remove("is-loading");
    applyLillyTheme(getDefaultTheme());
    lastArtPalette = null;
  };
  next.src = absoluteUrl;
}

function updateNowPlaying(metadata, isOffline) {
  const artistEl = document.getElementById("track-artist");
  const titleEl = document.getElementById("track-title");

  if (isOffline) {
    updateLegacyTitles("OFFLINE");
    if (artistEl) artistEl.textContent = "—";
    if (titleEl) setMarqueeTitle(titleEl, "Stream offline");
    applyLillyTheme(getDefaultTheme());
    lastArtPalette = null;
    setAlbumArt(defaultAlbumArt, { skipTheme: true });
    return;
  }

  const display = metadata.artist
    ? `${metadata.artist} — ${metadata.track}`
    : metadata.track;

  updateLegacyTitles(display);

  if (artistEl) {
    artistEl.textContent = metadata.artist || "Now playing";
  }

  if (titleEl) {
    setMarqueeTitle(titleEl, metadata.track || metadata.raw);
  }
}

async function setTitle(mountPoint) {
  try {
    const raw = await songTitle(mountPoint);

    if (!raw) {
      lastRawTitle = null;
      updateNowPlaying({ artist: "", track: "", raw: "" }, true);
      return;
    }

    if (raw === lastRawTitle) return;

    lastRawTitle = raw;
    window.lillyBeat?.reset();

    const metadata = parseTrackMetadata(raw);

    updateNowPlaying(metadata, false);

    const artUrl = await fetchAlbumArt(metadata, mountPoint);
    setAlbumArt(artUrl || defaultAlbumArt);
  } catch (err) {
    console.error("Error in setTitle:", err);
    lastRawTitle = null;
    updateNowPlaying({ artist: "", track: "", raw: "" }, true);
  }
}

setTitle(mountPoint);
window.setInterval(setTitle, 5000, mountPoint);

if (document.body.classList.contains("lilly-player")) {
  applyLillyTheme(getDefaultTheme());
}

const copyTarget =
  document.getElementById("track-title") ||
  document.getElementById("scroll-container");

if (copyTarget) {
  copyTarget.addEventListener("click", (e) => {
    const text = lastRawTitle?.trim();
    if (!text || text === "OFFLINE") return;

    navigator.clipboard
      .writeText(text)
      .then(() => {
        const tooltip = document.getElementById("copy-tooltip");
        if (!tooltip) return;

        tooltip.style.left = `${e.clientX}px`;
        tooltip.style.top = `${e.clientY}px`;
        tooltip.classList.add("visible");

        setTimeout(() => tooltip.classList.remove("visible"), 1500);
      })
      .catch((err) => console.warn("Clipboard copy failed:", err));
  });
}
