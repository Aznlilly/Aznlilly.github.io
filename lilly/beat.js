(function () {
  const audio = document.getElementById("audioplayer");
  const artFrame = document.querySelector(".art-frame");
  const body = document.body;
  const bpmEl = document.getElementById("track-bpm");

  if (!audio || !artFrame) return;

  const FFT_SIZE = 2048;
  const ENV_MS = 10;
  const ENV_SECONDS = 8;
  const ENV_SIZE = Math.round((ENV_SECONDS * 1000) / ENV_MS);
  const MIN_BPM = 78;
  const MAX_BPM = 175;
  const COMFY_BPM = 168;
  const TEMPO_UPDATE_MS = 350;
  const MIN_ENV_FOR_TEMPO = Math.round(ENV_SIZE * 0.45);
  const MIN_ONSET_GAP = 270;
  const FLUX_HISTORY = 72;
  const ONSET_LIMIT = 28;
  const RATIOS = [0.5, 2 / 3, 0.75, 4 / 3, 1.5, 2];

  let audioCtx = null;
  let analyser = null;
  let source = null;
  let rafId = null;
  let freqData = null;
  let kickStart = 1;
  let kickEnd = 6;
  let bodyEnd = 14;

  let kickFloor = 0;
  let fluxHistory = [];
  let env = new Float32Array(ENV_SIZE);
  let envWrite = 0;
  let envFilled = 0;
  let envPeak = 0;
  let lastEnvTime = 0;

  let lastOnsetTime = 0;
  let lastPulseTime = 0;
  let lastTempoUpdate = 0;
  let pulseClearTimer = 0;

  let estimatedBpm = null;
  let animBpm = null;
  let beatPeriod = null;
  let nextPulseTime = 0;
  let tempoConfidence = 0;
  let tempoLocked = false;
  let recentOnsets = [];

  function init() {
    if (audioCtx) return true;

    try {
      audioCtx = new AudioContext();
      source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.08;
      analyser.minDecibels = -80;
      analyser.maxDecibels = -20;

      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      freqData = new Uint8Array(analyser.frequencyBinCount);
      const hzPerBin = audioCtx.sampleRate / analyser.fftSize;
      kickStart = Math.max(1, Math.floor(48 / hzPerBin));
      kickEnd = Math.max(kickStart + 2, Math.ceil(110 / hzPerBin));
      bodyEnd = Math.max(kickEnd + 2, Math.ceil(180 / hzPerBin));
      return true;
    } catch (err) {
      console.warn("Beat visualizer unavailable:", err);
      return false;
    }
  }

  function bandMean(start, end) {
    let sum = 0;
    const last = Math.min(end, freqData.length);
    const first = Math.min(start, last - 1);
    for (let i = first; i < last; i += 1) sum += freqData[i];
    return sum / Math.max(1, last - first) / 255;
  }

  function measureFlux() {
    analyser.getByteFrequencyData(freqData);
    const energy = bandMean(kickStart, kickEnd) * 0.9 + bandMean(kickEnd, bodyEnd) * 0.1;
    const flux = Math.max(0, energy - kickFloor);
    kickFloor = kickFloor * 0.88 + energy * 0.12;

    fluxHistory.push(flux);
    if (fluxHistory.length > FLUX_HISTORY) fluxHistory.shift();
    return flux;
  }

  function fluxStats() {
    if (!fluxHistory.length) return { mean: 0, std: 0 };

    let mean = 0;
    for (let i = 0; i < fluxHistory.length; i += 1) mean += fluxHistory[i];
    mean /= fluxHistory.length;

    let variance = 0;
    for (let i = 0; i < fluxHistory.length; i += 1) {
      const delta = fluxHistory[i] - mean;
      variance += delta * delta;
    }

    return { mean, std: Math.sqrt(variance / fluxHistory.length) };
  }

  function detectOnset(now, flux) {
    if (now - lastOnsetTime < MIN_ONSET_GAP) return false;

    const { mean, std } = fluxStats();
    const threshold = Math.max(0.01, mean * 1.45 + std * 1.05);
    if (flux < threshold) return false;

    lastOnsetTime = now;
    recentOnsets.push(now);
    if (recentOnsets.length > ONSET_LIMIT) recentOnsets.shift();
    return true;
  }

  function pushEnvelope(now, flux) {
    envPeak = Math.max(envPeak, flux);

    if (!lastEnvTime) {
      lastEnvTime = now;
      return;
    }

    while (now - lastEnvTime >= ENV_MS) {
      env[envWrite] = envPeak;
      envWrite = (envWrite + 1) % ENV_SIZE;
      if (envFilled < ENV_SIZE) envFilled += 1;
      envPeak = 0;
      lastEnvTime += ENV_MS;
    }
  }

  function envAt(indexFromOldest) {
    const start = envFilled < ENV_SIZE ? 0 : envWrite;
    return env[(start + indexFromOldest) % ENV_SIZE];
  }

  function autocorr(lag) {
    const count = envFilled - lag;
    if (count < 32) return 0;

    let sum = 0;
    for (let i = lag; i < envFilled; i += 1) {
      sum += envAt(i) * envAt(i - lag);
    }
    return sum / count;
  }

  function foldBpm(bpm) {
    let value = bpm;
    while (value < MIN_BPM) value *= 2;
    while (value > MAX_BPM) value /= 2;
    return value;
  }

  function pickAnimBpm(bpm) {
    let value = foldBpm(bpm);
    if (value > COMFY_BPM) value /= 2;
    return value;
  }

  function songPrior(bpm) {
    const logRatio = Math.log(bpm / 115);
    return Math.exp(-0.5 * (logRatio / 0.27) ** 2);
  }

  function inSweetSpot(bpm) {
    return bpm >= 92 && bpm <= 142;
  }

  function alignmentScore(bpm) {
    const period = 60000 / bpm;
    if (recentOnsets.length < 8) return 0;

    let x = 0;
    let y = 0;
    for (let i = 0; i < recentOnsets.length; i += 1) {
      const angle = ((recentOnsets[i] % period) / period) * Math.PI * 2;
      x += Math.cos(angle);
      y += Math.sin(angle);
    }
    return Math.hypot(x, y) / recentOnsets.length;
  }

  function refineByGrid(seed, windowBpm, step) {
    let bestBpm = seed;
    let bestScore = -Infinity;

    for (let bpm = seed - windowBpm; bpm <= seed + windowBpm; bpm += step) {
      if (bpm < MIN_BPM || bpm > MAX_BPM) continue;
      const score = alignmentScore(bpm) - Math.abs(bpm - seed) * 0.0008;
      if (score > bestScore) {
        bestScore = score;
        bestBpm = bpm;
      }
    }

    return bestBpm;
  }

  function pairwiseIoiBpm() {
    if (recentOnsets.length < 8) return null;

    const weights = new Map();
    for (let i = 0; i < recentOnsets.length; i += 1) {
      for (let j = i + 1; j < Math.min(i + 7, recentOnsets.length); j += 1) {
        let dt = recentOnsets[j] - recentOnsets[i];
        while (dt < 330) dt *= 2;
        while (dt > 760) dt /= 2;
        if (dt < 330 || dt > 760) continue;
        const bin = Math.round(dt / 6) * 6;
        weights.set(bin, (weights.get(bin) || 0) + 1);
      }
    }

    let bestBin = 0;
    let bestWeight = 0;
    weights.forEach((count, bin) => {
      const score =
        (count +
          (weights.get(bin - 6) || 0) * 0.6 +
          (weights.get(bin + 6) || 0) * 0.6) *
        songPrior(60000 / bin);
      if (score > bestWeight) {
        bestWeight = score;
        bestBin = bin;
      }
    });

    if (bestWeight < 5) return null;
    return 60000 / bestBin;
  }

  function autocorrBpm() {
    if (envFilled < MIN_ENV_FOR_TEMPO) return null;

    const minLag = Math.round(60000 / MAX_BPM / ENV_MS);
    const maxLag = Math.round(60000 / MIN_BPM / ENV_MS);
    let bestLag = 0;
    let bestScore = 0;
    let second = 0;

    for (let lag = minLag; lag <= maxLag; lag += 1) {
      const score = autocorr(lag) + autocorr(lag * 2) * 0.35;
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        bestLag = lag;
      } else if (score > second) {
        second = score;
      }
    }

    if (bestLag < 2 || bestScore < 1e-5) return null;

    const prev = autocorr(bestLag - 1);
    const next = autocorr(bestLag + 1);
    const denom = prev - 2 * bestScore + next;
    const shift = denom === 0 ? 0 : (prev - next) / (2 * denom);
    const lag = bestLag + Math.max(-0.45, Math.min(0.45, shift));
    const prominence = (bestScore - second) / (bestScore + 1e-6);

    return { bpm: foldBpm(60000 / (lag * ENV_MS)), prominence };
  }

  function chooseMetricalBpm(bpm) {
    const options = [foldBpm(bpm)];
    for (let i = 0; i < RATIOS.length; i += 1) {
      const candidate = foldBpm(bpm * RATIOS[i]);
      if (candidate >= MIN_BPM && candidate <= MAX_BPM) options.push(candidate);
    }

    let best = options[0];
    let bestScore = alignmentScore(best) * songPrior(best);

    for (let i = 1; i < options.length; i += 1) {
      const candidate = options[i];
      const score = alignmentScore(candidate) * songPrior(candidate);
      if (score > bestScore * 1.06) {
        best = candidate;
        bestScore = score;
      } else if (score > bestScore * 0.92 && inSweetSpot(candidate) && !inSweetSpot(best)) {
        best = candidate;
        bestScore = score;
      }
    }

    if (best > 148) {
      const twoThirds = foldBpm(best * (2 / 3));
      if (inSweetSpot(twoThirds) && alignmentScore(twoThirds) >= alignmentScore(best) * 0.5) {
        return twoThirds;
      }
    }

    return best;
  }

  function metricalRelative(a, b) {
    if (!a || !b) return false;
    const ratio = a > b ? a / b : b / a;
    return (
      Math.abs(ratio - 2) < 0.09 ||
      Math.abs(ratio - 1.5) < 0.09 ||
      Math.abs(ratio - 4 / 3) < 0.08
    );
  }

  function renderBpm() {
    if (!bpmEl) return;
    if (!estimatedBpm || !tempoLocked) {
      bpmEl.hidden = true;
      bpmEl.textContent = "";
      return;
    }
    bpmEl.hidden = false;
    bpmEl.textContent = `${Math.round(estimatedBpm)} BPM`;
  }

  function commitTempo(now, bpm, confidence) {
    const nextBpm = refineByGrid(chooseMetricalBpm(bpm), 5, 0.25);
    const jumped = estimatedBpm && Math.abs(nextBpm - estimatedBpm) / estimatedBpm > 0.12;
    const blend = jumped ? 0.8 : tempoLocked ? 0.22 : 0.45;
    estimatedBpm = estimatedBpm
      ? estimatedBpm + (nextBpm - estimatedBpm) * blend
      : nextBpm;
    animBpm = pickAnimBpm(estimatedBpm);
    tempoConfidence = tempoConfidence * 0.4 + confidence * 0.6;
    tempoLocked = true;

    const targetPeriod = 60000 / animBpm;
    if (beatPeriod === null) {
      beatPeriod = targetPeriod;
      nextPulseTime = now + beatPeriod;
    } else {
      beatPeriod += (targetPeriod - beatPeriod) * 0.2;
    }

    applyPulseDuration();
    renderBpm();
  }

  function estimateTempo(now) {
    const iois = pairwiseIoiBpm();
    const ac = autocorrBpm();
    if (!iois && !ac) return;

    let seed = iois || ac.bpm;
    if (iois && ac) {
      const close = Math.abs(iois - ac.bpm) / iois < 0.08;
      seed = close ? iois * 0.65 + ac.bpm * 0.35 : iois;
    }

    const refined = refineByGrid(chooseMetricalBpm(seed), 8, 0.25);
    const confidence = Math.max(
      ac?.prominence || 0,
      alignmentScore(refined)
    );

    if (!tempoLocked) {
      if (recentOnsets.length < 10 || confidence < 0.28) return;
      commitTempo(now, refined, confidence);
      return;
    }

    const delta = Math.abs(refined - estimatedBpm) / estimatedBpm;
    if (delta <= 0.09 || confidence > 0.55 || metricalRelative(refined, estimatedBpm)) {
      commitTempo(now, refined, confidence);
    }
  }

  function nudgePhase(now) {
    if (!beatPeriod || !nextPulseTime) return;

    let error = (now - nextPulseTime) % beatPeriod;
    if (error > beatPeriod / 2) error -= beatPeriod;
    if (error < -beatPeriod / 2) error += beatPeriod;
    if (Math.abs(error) < beatPeriod * 0.3) {
      nextPulseTime += error * 0.4;
    }
  }

  function pulseStrength(flux) {
    if (!tempoLocked) {
      const { mean, std } = fluxStats();
      return Math.min(1, Math.max(0.62, (flux - mean) / (std * 3 + 0.02) + 0.7));
    }
    return 0.9;
  }

  function pulseDurationMs() {
    if (!beatPeriod) return 520;
    return Math.min(640, Math.max(320, beatPeriod * 0.52));
  }

  function applyPulseDuration() {
    body.style.setProperty("--pulse-duration", `${(pulseDurationMs() / 1000).toFixed(3)}s`);
  }

  function triggerPulse(flux) {
    applyPulseDuration();
    body.style.setProperty("--pulse-power", pulseStrength(flux).toFixed(2));
    body.classList.remove("beat-hit");
    void body.offsetWidth;
    body.classList.add("beat-hit");

    lastPulseTime = performance.now();
    window.clearTimeout(pulseClearTimer);
    pulseClearTimer = window.setTimeout(() => {
      body.classList.remove("beat-hit");
    }, pulseDurationMs() + 32);
  }

  function maybePulse(now, flux, onset) {
    if (tempoLocked && beatPeriod) {
      if (now >= nextPulseTime && now - lastPulseTime >= beatPeriod * 0.55) {
        triggerPulse(flux);
        nextPulseTime += beatPeriod;
        while (nextPulseTime <= now) nextPulseTime += beatPeriod;
      }
      return;
    }

    if (onset && now - lastPulseTime >= 430) {
      triggerPulse(flux);
    }
  }

  function tick() {
    const now = performance.now();

    if (!analyser || audio.paused) {
      if (!audio.paused) {
        rafId = requestAnimationFrame(tick);
      } else {
        body.classList.remove("is-vibing", "beat-hit");
        resetTempo();
        rafId = null;
      }
      return;
    }

    const flux = measureFlux();
    const onset = detectOnset(now, flux);
    pushEnvelope(now, flux);

    if (onset && tempoLocked) nudgePhase(now);

    if (now - lastTempoUpdate >= TEMPO_UPDATE_MS) {
      estimateTempo(now);
      lastTempoUpdate = now;
    }

    maybePulse(now, flux, onset);
    rafId = requestAnimationFrame(tick);
  }

  function resetTempo() {
    kickFloor = 0;
    fluxHistory = [];
    env.fill(0);
    envWrite = 0;
    envFilled = 0;
    envPeak = 0;
    lastEnvTime = 0;
    lastOnsetTime = 0;
    lastPulseTime = 0;
    lastTempoUpdate = 0;
    estimatedBpm = null;
    animBpm = null;
    beatPeriod = null;
    nextPulseTime = 0;
    tempoConfidence = 0;
    tempoLocked = false;
    recentOnsets = [];
    window.clearTimeout(pulseClearTimer);
    renderBpm();
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

  window.lillyBeat = {
    start,
    stop,
    reset,
    getTempo() {
      return {
        bpm: estimatedBpm ? Number(estimatedBpm.toFixed(1)) : null,
        pulseBpm: animBpm ? Number(animBpm.toFixed(1)) : null,
        confidence: Number(tempoConfidence.toFixed(2)),
        locked: tempoLocked,
      };
    },
  };
})();
