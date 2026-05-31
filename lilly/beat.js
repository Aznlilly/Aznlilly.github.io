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
  let prevSpectrum = null;
  let fluxBaseline = 0;

  function init() {
    if (audioCtx) return true;

    try {
      audioCtx = new AudioContext();
      source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.35;
      analyser.minDecibels = -85;
      analyser.maxDecibels = -25;

      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      freqData = new Uint8Array(analyser.frequencyBinCount);
      prevSpectrum = new Uint8Array(analyser.frequencyBinCount);
      return true;
    } catch (err) {
      console.warn("Beat visualizer unavailable:", err);
      return false;
    }
  }

  function readBeatTransient() {
    if (!freqData || !prevSpectrum) return 0;

    analyser.getByteFrequencyData(freqData);

    let flux = 0;
    const bins = Math.min(24, freqData.length);

    for (let i = 0; i < bins; i += 1) {
      const rise = freqData[i] - prevSpectrum[i];
      if (rise > 0) flux += rise;
      prevSpectrum[i] = freqData[i];
    }

    flux /= bins * 255;

    fluxBaseline = fluxBaseline * 0.965 + flux * 0.035;

    const excess = Math.max(0, flux - fluxBaseline * 1.25);
    return Math.min(1, excess / 0.07);
  }

  function tick() {
    if (!analyser || audio.paused) {
      displayEnergy *= 0.85;
      if (displayEnergy < 0.002) displayEnergy = 0;
      applyEnergy(displayEnergy);

      if (!audio.paused || displayEnergy > 0) {
        rafId = requestAnimationFrame(tick);
      } else {
        document.body.classList.remove("is-vibing");
        fluxBaseline = 0;
        rafId = null;
      }
      return;
    }

    const hit = readBeatTransient();
    const peak = hit * hit;

    if (peak > displayEnergy) {
      displayEnergy = peak;
    } else {
      displayEnergy *= 0.8;
    }

    applyEnergy(displayEnergy);
    rafId = requestAnimationFrame(tick);
  }

  function applyEnergy(value) {
    const energy = value.toFixed(4);
    document.body.style.setProperty("--beat-energy", energy);

    if (player) player.style.setProperty("--beat-energy", energy);
    if (artFrame) artFrame.style.setProperty("--beat-energy", energy);
    if (bgBlur) bgBlur.style.setProperty("--beat-energy", energy);
  }

  async function start() {
    if (!init()) return;

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    fluxBaseline = 0;
    displayEnergy = 0;
    if (prevSpectrum) prevSpectrum.fill(0);

    document.body.classList.add("is-vibing");
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    }
  }

  window.lillyBeat = { start, stop };
})();
