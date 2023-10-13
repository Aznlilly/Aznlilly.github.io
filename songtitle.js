const re = new RegExp(
  '(<td>Currently playing:<\/td>)[\n|\r](<td class="streamstats">)(.+)(<\/td>)'
);

let res = () => {
  fetch("https://music.pixelhumble.com/")
    .then(function (response) {
      // When the page is loaded convert it to text
      return response.text();
    })
    .then(function (html) {
      //console.log(html);

      let myArray = re.exec(html);
      if (myArray !== null) {
        if (myArray.length > 0) {
          let songTitle = myArray[3];
          //console.log(myArray[3]);
          document.getElementById("currentsongtitletext").textContent = songTitle;
        }else{
          document.getElementById("currentsongtitletext").textContent = "OFFLINE";
        }
      }else {
        document.getElementById("currentsongtitletext").textContent = "OFFLINE";
      }
    })
    .catch(function (err) {
      console.log("Failed to fetch page: ", err);
    });
};

const interval = setInterval(() => {
  res();
}, 8000);
