(function () {
  const audio = document.getElementById("audioplayer");
  const artFrame = document.querySelector(".art-frame");
  const body = document.body;

  if (!audio || !artFrame) return;

  const BEAT_RATIO = 2.4;
  const MIN_GAP_MS = 560;

  let audioCtx = null;
  let analyser = null;
  let source = null;
  let rafId = null;
  let freqData = null;
  let prevSpectrum = null;
  let fluxBaseline = 0;
  let lastBeatTime = 0;
  let pulsing = false;

  function init() {
    if (audioCtx) return true;

    try {
      audioCtx = new AudioContext();
      source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.55;
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

  function measureFlux() {
    if (!freqData || !prevSpectrum) return { flux: 0, ratio: 0 };

    analyser.getByteFrequencyData(freqData);

    let flux = 0;
    const bins = Math.min(20, freqData.length);

    for (let i = 0; i < bins; i += 1) {
      const rise = freqData[i] - prevSpectrum[i];
      if (rise > 0) flux += rise;
      prevSpectrum[i] = freqData[i];
    }

    flux /= bins * 255;
    fluxBaseline = fluxBaseline * 0.985 + flux * 0.015;

    const ratio = flux / (fluxBaseline + 0.004);
    return { flux, ratio };
  }

  function triggerPulse(ratio) {
    const strength = Math.min(1, Math.max(0.55, (ratio - BEAT_RATIO) / 2.8 + 0.65));

    body.style.setProperty("--pulse-power", strength.toFixed(2));
    body.classList.remove("beat-hit");
    void body.offsetWidth;
    body.classList.add("beat-hit");

    pulsing = true;
    lastBeatTime = performance.now();
  }

  function onPulseEnd(event) {
    if (event.animationName !== "beat-art") return;
    body.classList.remove("beat-hit");
    pulsing = false;
  }

  artFrame.addEventListener("animationend", onPulseEnd);

  function tick() {
    if (!analyser || audio.paused) {
      if (!audio.paused || pulsing) {
        rafId = requestAnimationFrame(tick);
      } else {
        body.classList.remove("is-vibing", "beat-hit");
        fluxBaseline = 0;
        pulsing = false;
        rafId = null;
      }
      return;
    }

    const { ratio } = measureFlux();
    const now = performance.now();

    if (
      !pulsing &&
      ratio > BEAT_RATIO &&
      now - lastBeatTime > MIN_GAP_MS
    ) {
      triggerPulse(ratio);
    }

    rafId = requestAnimationFrame(tick);
  }

  async function start() {
    if (!init()) return;

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    fluxBaseline = 0;
    lastBeatTime = 0;
    pulsing = false;
    if (prevSpectrum) prevSpectrum.fill(0);

    body.classList.add("is-vibing");
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
