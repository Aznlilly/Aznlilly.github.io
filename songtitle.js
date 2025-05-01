var mountPoint = window.location.pathname.split("/")[1];

async function songTitle(mountPoint) {
  const response = await fetch("https://music.pixelhumble.com/status-json.xsl");
  const stats = await response.json();

  let sources = stats.icestats.source;
  if (!sources) return "OFFLINE";

  if (!Array.isArray(sources)) sources = [sources];

  const match = sources.find((s) => s.listenurl.includes(mountPoint));
  if (!match || !match.title) return "OFFLINE";

  return match.title;
}

async function fetchAlbumArt(title) {
  const query = encodeURIComponent(title);
  const url = `https://itunes.apple.com/search?term=${query}&entity=song&limit=1`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.resultCount > 0) {
      // Upgrade artwork to higher resolution
      return data.results[0].artworkUrl100.replace('100x100', '300x300');
    }
  } catch (err) {
    console.warn("Album art fetch failed:", err);
  }

  return "default-art.jpg";
}

async function setTitle(mountPoint) {
  try {
    const title = await songTitle(mountPoint);
    document.getElementById("currentsongtitletext").textContent = title;

    const art = await fetchAlbumArt(title);
    document.getElementById("albumart").src = art;
  } catch (err) {
    console.error("Error in setTitle:", err);
    document.getElementById("currentsongtitletext").textContent = "OFFLINE";
    document.getElementById("albumart").src = "default-art.jpg";

    if (intervalTimerId) {
      window.clearInterval(intervalTimerId);
    }
  }
}


intervalTimerId = window.setInterval(setTitle, 3 * 1000, mountPoint);
