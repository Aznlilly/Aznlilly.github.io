var mountPoint = window.location.pathname.split('/')[1];

async function songTitle(mountPoint) {

  const response = await fetch("https://music.pixelhumble.com/status-json.xsl");
  icecast_stats = await response.json();  
  var filtered = icecast_stats.icestats.source.filter(function (str) { if (str.listenurl.indexOf(mountPoint) > 0) return str.title; });
  if (!Array.isArray(filtered) || !filtered.length) {
    return "OFFLINE";
  } 
  var title = filtered[0].title;
  return title;
}

async function setTitle(mountPoint){
  var title = "OFFLINE"
  await title = songTitle(mountPoint);
  await document.getElementById("currentsongtitletext").textContent = title;
}

function sleep (fn, par) {
  return new Promise((resolve) => {
    // wait 3s before calling fn(par)
    setTimeout(() => resolve(fn(par)), 3000)
  })
}

sleep(setTitle, mountPoint)
