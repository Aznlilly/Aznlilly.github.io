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

let res = () => {
        document.getElementById("currentsongtitletext").textContent = songTitle(mountPoint);
    })
    .catch(function (err) {
      console.log("Failed to fetch page: ", err);
    });
};

const interval = setInterval(() => {
  res();
}, 5000);
