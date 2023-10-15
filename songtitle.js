var mountPoint = window.location.pathname.split("/")[1];

async function songTitle(mountPoint) {
  const response = await fetch("https://music.pixelhumble.com/status-json.xsl");
  icecast_stats = await response.json();
  console.log("icecast_stats: \n");
  console.log(icecast_stats);
  if (!Array.isArray(icecast_stats.icestats.source)) {
    if (icecast_status.icestats.source.listenurl.indexOf(mountPoint) > 0) {
      return icecast_stats.icestats.source.title;
    } else {
      return "OFFLINE";
    }
  }
  var filtered = await icecast_stats.icestats.source.filter(function (str) {
    if (str.listenurl.indexOf(mountPoint) > 0) return str.title;
  });
  console.log("filtered: \n");
  console.log(filtered);
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
}

function sleep(fn, par) {
  return new Promise((resolve) => {
    // wait 3s before calling fn(par)
    setTimeout(() => resolve(fn(par)), 3000);
  });
}

sleep(setTitle, mountPoint);
