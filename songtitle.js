var mountPoint = window.location.pathname.split("/")[1];
const defaultAlbumArt = "/default-art.jpg"; // ✅ absolute path from root

const SHOUTCAST_STREAMS = {
  lilly: {
    statsUrl: "http://music.elsewhere.moe:18000/stats",
    sid: 1,
  },
};

function shoutcastSongTitle({ statsUrl, sid }) {
  return new Promise((resolve, reject) => {
    const callbackName = `shoutcastCb_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
    const script = document.createElement("script");

    const cleanup = () => {
      delete window[callbackName];
      script.remove();
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Shoutcast stats timeout"));
    }, 8000);

    window[callbackName] = (data) => {
      clearTimeout(timeout);
      cleanup();
      if (!data || data.streamstatus !== 1 || !data.songtitle) {
        resolve(null);
        return;
      }
      resolve(data.songtitle.trim());
    };

    script.onerror = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error("Failed to load Shoutcast stats"));
    };

    script.src = `${statsUrl}?sid=${sid}&json=1&callback=${callbackName}`;
    document.head.appendChild(script);
  });
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

async function fetchAlbumArt(title) {
  const query = encodeURIComponent(title);
  const url = `https://itunes.apple.com/search?term=${query}&entity=song&limit=1`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.resultCount > 0) {
      return data.results[0].artworkUrl100.replace("100x100", "300x300");
    }
  } catch (err) {
    console.warn("Album art fetch failed:", err);
  }

  return defaultAlbumArt;
}

function updateScrollTitles(text) {
  const titleElements = document.querySelectorAll(".scroll-title");
  titleElements.forEach(el => el.textContent = text);
}

async function setTitle(mountPoint) {
  try {
    const title = await songTitle(mountPoint);
    if (!title) {
      updateScrollTitles("OFFLINE");
      document.getElementById("albumart").src = defaultAlbumArt;
      return;
    }

    updateScrollTitles(title);

    const artUrl = await fetchAlbumArt(title);
    document.getElementById("albumart").src = artUrl || defaultAlbumArt;
  } catch (err) {
    console.error("Error in setTitle:", err);
    updateScrollTitles("OFFLINE");
    document.getElementById("albumart").src = defaultAlbumArt;
  }
}

const intervalTimerId = window.setInterval(setTitle, 3000, mountPoint);

// Enable click-to-copy on scroll-container
document.getElementById("scroll-container").addEventListener("click", (e) => {
  const titleEl = document.querySelector(".scroll-title");
  if (!titleEl) return;

  const text = titleEl.textContent.trim();
  if (!text) return;

  navigator.clipboard.writeText(text).then(() => {
    const tooltip = document.getElementById("copy-tooltip");

    // Position it near the mouse
    tooltip.style.left = `${e.clientX}px`;
    tooltip.style.top = `${e.clientY}px`;

    tooltip.classList.add("visible");

    // Hide after 1.5 seconds
    setTimeout(() => {
      tooltip.classList.remove("visible");
    }, 1500);
  }).catch(err => {
    console.warn("Clipboard copy failed:", err);
  });
});
