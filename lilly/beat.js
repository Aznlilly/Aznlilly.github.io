(function () {
  const audio = document.getElementById("audioplayer");
  const artFrame = document.querySelector(".art-frame");
  const body = document.body;

  if (!audio || !artFrame) return;

  const ONSET_RATIO = 2.1;
  const MIN_ONSET_GAP = 200;
  const MAX_COMFY_BPM = 160;
  const INTERVAL_WINDOW = 10;
  const MIN_INTERVALS = 4;
  const TEMPO_LERP = 0.2;

  let audioCtx = null;
  let analyser = null;
  let source = null;
  let rafId = null;
  let freqData = null;
  let prevSpectrum = null;
  let fluxBaseline = 0;

  let pulsing = false;
  let lastOnsetTime = 0;
  let lastPulseTime = 0;
  let intervals = [];

  let estimatedBpm = null;
  let animBpm = null;
  let beatPeriod = null;
  let nextPulseTime = 0;
  let tempoConfidence = 0;

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
    if (!freqData || !prevSpectrum) return 0;

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

    return flux / (fluxBaseline + 0.004);
  }

  function normalizeBpm(bpm) {
    let value = bpm;
    while (value < 72) value *= 2;
    while (value > 190) value /= 2;
    return value;
  }

  function medianInterval(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  function trimmedMedian(values) {
    if (values.length < 4) return medianInterval(values);

    const sorted = [...values].sort((a, b) => a - b);
    const trim = Math.max(1, Math.floor(sorted.length * 0.15));
    const trimmed = sorted.slice(trim, sorted.length - trim);
    return medianInterval(trimmed.length ? trimmed : sorted);
  }

  function measureConfidence() {
    if (intervals.length < MIN_INTERVALS) return 0;

    const median = trimmedMedian(intervals);
    const matching = intervals.filter(
      (interval) => Math.abs(interval - median) / median <= 0.18
    );

    return matching.length / intervals.length;
  }

  function updateTempo(now) {
    if (intervals.length < MIN_INTERVALS) {
      tempoConfidence = 0;
      return;
    }

    tempoConfidence = measureConfidence();

    const median = trimmedMedian(intervals);
    estimatedBpm = normalizeBpm(60000 / median);

    animBpm = estimatedBpm;
    if (animBpm > MAX_COMFY_BPM) {
      animBpm /= 2;
    }

    const targetPeriod = 60000 / animBpm;

    if (beatPeriod === null) {
      beatPeriod = targetPeriod;
      nextPulseTime = now + beatPeriod;
    } else {
      beatPeriod = beatPeriod * (1 - TEMPO_LERP) + targetPeriod * TEMPO_LERP;
    }

    applyPulseDuration();
  }

  function recordOnset(now) {
    if (now - lastOnsetTime < MIN_ONSET_GAP) return;

    if (lastOnsetTime > 0) {
      const interval = now - lastOnsetTime;
      if (interval >= 280 && interval <= 1800) {
        intervals.push(interval);
        if (intervals.length > INTERVAL_WINDOW) intervals.shift();
        updateTempo(now);
      }
    }

    lastOnsetTime = now;
  }

  function minPulseGap() {
    if (!beatPeriod) return 400;
    return beatPeriod * 0.58;
  }

  function pulseStrength(ratio) {
    if (tempoConfidence < 0.45) {
      return Math.min(1, Math.max(0.6, (ratio - ONSET_RATIO) / 2.5 + 0.65));
    }
    return 0.88;
  }

  function pulseDurationMs() {
    if (!beatPeriod) return 720;
    return Math.min(760, Math.max(360, beatPeriod * 0.82));
  }

  function applyPulseDuration() {
    const seconds = (pulseDurationMs() / 1000).toFixed(3);
    body.style.setProperty("--pulse-duration", `${seconds}s`);
  }

  function triggerPulse(ratio) {
    applyPulseDuration();
    const strength = pulseStrength(ratio);

    body.style.setProperty("--pulse-power", strength.toFixed(2));
    body.classList.remove("beat-hit");
    void body.offsetWidth;
    body.classList.add("beat-hit");

    pulsing = true;
    lastPulseTime = performance.now();
  }

  function onPulseEnd(event) {
    if (event.animationName !== "beat-art") return;
    body.classList.remove("beat-hit");
    pulsing = false;
  }

  artFrame.addEventListener("animationend", onPulseEnd);

  function shouldPulseOnOnset(now) {
    if (now - lastPulseTime < minPulseGap()) return false;
    if (!beatPeriod) return true;

    const nearGrid = Math.abs(now - nextPulseTime) < beatPeriod * 0.28;
    const overdue = now - lastPulseTime >= beatPeriod * 0.92;

    if (tempoConfidence < 0.45) return overdue || nearGrid;
    return nearGrid || overdue;
  }

  function tick() {
    const now = performance.now();

    if (!analyser || audio.paused) {
      if (!audio.paused || pulsing) {
        rafId = requestAnimationFrame(tick);
      } else {
        body.classList.remove("is-vibing", "beat-hit");
        resetTempo();
        pulsing = false;
        rafId = null;
      }
      return;
    }

    const ratio = measureFlux();
    const isOnset = ratio > ONSET_RATIO;

    if (isOnset) {
      recordOnset(now);

      if (shouldPulseOnOnset(now)) {
        triggerPulse(ratio);
        nextPulseTime = now + (beatPeriod || minPulseGap());
      } else if (beatPeriod && Math.abs(now - nextPulseTime) < beatPeriod * 0.18) {
        nextPulseTime = now;
      }
    }

    if (
      beatPeriod &&
      tempoConfidence >= 0.4 &&
      now >= nextPulseTime &&
      now - lastPulseTime >= minPulseGap()
    ) {
      triggerPulse(ratio);
      nextPulseTime += beatPeriod;

      while (nextPulseTime <= now) {
        nextPulseTime += beatPeriod;
      }
    }

    rafId = requestAnimationFrame(tick);
  }

  function resetTempo() {
    fluxBaseline = 0;
    lastOnsetTime = 0;
    lastPulseTime = 0;
    intervals = [];
    estimatedBpm = null;
    animBpm = null;
    beatPeriod = null;
    nextPulseTime = 0;
    tempoConfidence = 0;
    if (prevSpectrum) prevSpectrum.fill(0);
  }

  async function start() {
    if (!init()) return;

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    resetTempo();
    body.classList.add("is-vibing");
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    }
  }

  function reset() {
    resetTempo();
  }

  window.lillyBeat = { start, stop, reset };
})();
