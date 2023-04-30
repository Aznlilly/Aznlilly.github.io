const re = new RegExp(
  '(<td>Current Song:</td>)[\n|\r](<td class="streamdata">)(.+)(</td>)'
);

let res = () => {
  fetch("http://music.pixelhumble.com:8000/")
    .then(function (response) {
      // When the page is loaded convert it to text
      return response.text();
    })
    .then(function (html) {

      console.log(html);


      let myArray = re.exec(html);
      if (myArray.length > 0) {
        let songTitle = myArray[3];
        console.log(myArray[3]);
        document.getElementById("currentsongtitle").textContent = songTitle;
      }
    })
    .catch(function (err) {
      console.log("Failed to fetch page: ", err);
    });
};

const interval = setInterval(() => {
  res();
}, 8000);
