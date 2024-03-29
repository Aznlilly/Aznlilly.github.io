var mountPoint = window.location.pathname.split("/")[1];

async function songTitle(mountPoint) {
  const response = await fetch("https://music.pixelhumble.com/status-json.xsl");
  icecast_stats = await response.json();
  if (icecast_stats.icestats.source === undefined) {
    return "OFFLINE";
  }
  if (!Array.isArray(icecast_stats.icestats.source)) {
    if (icecast_stats.icestats.source.listenurl.indexOf(mountPoint) > 0) {
      return icecast_stats.icestats.source.title;
    } else {
      return "OFFLINE";
    }
  }
  var filtered = await icecast_stats.icestats.source.filter(function (str) {
    if (str.listenurl.indexOf(mountPoint) > 0) return str.title;
  });
  if (!Array.isArray(filtered) || !filtered.length) {
    return "OFFLINE";
  }
  var title = filtered[0].title;
  return title;
}

async function setTitle(mountPoint) {
  var title = "OFFLINE";
  title = await songTitle(mountPoint);
  document.getElementById("currentsongtitletext").textContent = title;

  try {
    var title = "OFFLINE";
    title = await songTitle(mountPoint);
    document.getElementById("currentsongtitletext").textContent = title;
  } catch (err) {
    console.error("Error in setTitle: %o", err);
    if (intervalTimerId) {
      window.clearInterval(intervalTimerId);
    }
  }
}

intervalTimerId = window.setInterval(setTitle, 3 * 1000, mountPoint);
