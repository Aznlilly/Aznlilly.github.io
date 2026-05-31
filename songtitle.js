var mountPoint = window.location.pathname.split("/")[1];
const defaultAlbumArt = "/default-art.jpg"; // ✅ absolute path from root

const SHOUTCAST_STREAMS = {
  lilly: { sid: 1 },
};

const SHOUTCAST_ORIGIN = "http://music.elsewhere.moe:18000";

let shoutcastReadyPromise = null;

function waitForServiceWorkerControl() {
  if (navigator.serviceWorker.controller) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5000);
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

function ensureShoutcastProxy() {
  if (!("serviceWorker" in navigator)) {
    return Promise.reject(new Error("Service workers are not supported"));
  }

  if (!shoutcastReadyPromise) {
    shoutcastReadyPromise = (async () => {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });

      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }

      await navigator.serviceWorker.ready;
      await waitForServiceWorkerControl();

      // First visit: SW installs after the page loads, so reload once to get control.
      if (
        !navigator.serviceWorker.controller &&
        !sessionStorage.getItem("shoutcast-sw-ready")
      ) {
        sessionStorage.setItem("shoutcast-sw-ready", "1");
        window.location.reload();
        return new Promise(() => {});
      }

      return registration;
    })();
  }

  return shoutcastReadyPromise;
}

window.ensureShoutcastProxy = ensureShoutcastProxy;

async function fetchShoutcastStats(sid) {
  const upstream = `${SHOUTCAST_ORIGIN}/stats?sid=${sid}&json=1`;

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    const response = await fetch(`/api/shoutcast/stats?sid=${sid}`);
    if (response.ok) {
      return response.json();
    }
  }

  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(upstream)}`;
  const response = await fetch(proxyUrl);
  if (!response.ok) {
    throw new Error(`Shoutcast stats proxy failed: ${response.status}`);
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

async function initTitlePolling(mountPoint) {
  if (SHOUTCAST_STREAMS[mountPoint]) {
    try {
      await ensureShoutcastProxy();
    } catch (err) {
      console.error("Shoutcast proxy setup failed:", err);
    }
  }

  setTitle(mountPoint);
  window.setInterval(setTitle, 3000, mountPoint);
}

initTitlePolling(mountPoint);

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
