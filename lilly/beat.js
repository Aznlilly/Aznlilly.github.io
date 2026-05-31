(function () {
  const audio = document.getElementById("audioplayer");
  const player = document.getElementById("player-container");
  const artFrame = document.querySelector(".art-frame");
  const bgBlur = document.getElementById("bg-blur");

  if (!audio || !player) return;

  let audioCtx = null;
  let analyser = null;
  let source = null;
  let rafId = null;
  let displayEnergy = 0;
  let freqData = null;

  function init() {
    if (audioCtx) return true;

    try {
      audioCtx = new AudioContext();
      source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      analyser.minDecibels = -90;
      analyser.maxDecibels = -10;

      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      freqData = new Uint8Array(analyser.frequencyBinCount);
      return true;
    } catch (err) {
      console.warn("Beat visualizer unavailable:", err);
      return false;
    }
  }

  function readBassEnergy() {
    if (!freqData) return 0;

    analyser.getByteFrequencyData(freqData);

    let sum = 0;
    const bins = Math.min(10, freqData.length);
    for (let i = 0; i < bins; i += 1) {
      sum += freqData[i];
    }

    return sum / (bins * 255);
  }

  function tick() {
    if (!analyser || audio.paused) {
      displayEnergy *= 0.9;
      if (displayEnergy < 0.003) displayEnergy = 0;
      applyEnergy(displayEnergy);

      if (!audio.paused || displayEnergy > 0) {
        rafId = requestAnimationFrame(tick);
      } else {
        document.body.classList.remove("is-vibing");
        rafId = null;
      }
      return;
    }

    const bass = readBassEnergy();
    const shaped = Math.pow(Math.min(1, bass * 2.2), 1.35);
    displayEnergy = displayEnergy * 0.78 + shaped * 0.22;

    applyEnergy(displayEnergy);
    rafId = requestAnimationFrame(tick);
  }

  function applyEnergy(value) {
    const energy = value.toFixed(4);
    document.body.style.setProperty("--beat-energy", energy);

    if (player) {
      player.style.setProperty("--beat-energy", energy);
    }
    if (artFrame) {
      artFrame.style.setProperty("--beat-energy", energy);
    }
    if (bgBlur) {
      bgBlur.style.setProperty("--beat-energy", energy);
    }
  }

  async function start() {
    if (!init()) return;

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    document.body.classList.add("is-vibing");
    if (!rafId) {
      rafId = requestAnimationFrame(tick);
    }
  }

  function stop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    }
  }

  window.lillyBeat = { start, stop };
})();
