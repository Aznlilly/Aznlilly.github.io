(function () {
  const audio = document.getElementById("audioplayer");
  const artFrame = document.querySelector(".art-frame");
  const body = document.body;

  if (!audio || !artFrame) return;

  const FFT_SIZE = 2048;
  const ENV_MS = 12;
  const ENV_SECONDS = 6;
  const ENV_SIZE = Math.round((ENV_SECONDS * 1000) / ENV_MS);
  const MIN_BPM = 72;
  const MAX_BPM = 184;
  const COMFY_BPM = 168;
  const TEMPO_UPDATE_MS = 400;
  const MIN_ENV_FOR_TEMPO = Math.round(ENV_SIZE * 0.55);
  const LOCK_PROMINENCE = 0.16;
  const OCTAVE_HOLD_MS = 2800;
  const RELATIVE_HOLD_MS = 3200;
  const TEMPO_LERP_LOCKED = 0.018;
  const TEMPO_LERP_UNLOCKED = 0.12;
  const PHASE_NUDGE = 0.28;
  const MIN_ONSET_GAP = 260;
  const FLUX_HISTORY = 64;
  const IOI_WINDOW = 12;

  let audioCtx = null;
  let analyser = null;
  let source = null;
  let rafId = null;
  let freqData = null;
  let bassStart = 1;
  let bassEnd = 8;
  let midEnd = 20;

  let energyFloor = 0;
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
  let pendingOctaveBpm = null;
  let pendingOctaveSince = 0;
  let pendingAltBpm = null;
  let pendingAltSince = 0;
  let recentEstimates = [];
  let intervals = [];
  let recentOnsets = [];

  function init() {
    if (audioCtx) return true;

    try {
      audioCtx = new AudioContext();
      source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.12;
      analyser.minDecibels = -82;
      analyser.maxDecibels = -22;

      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      freqData = new Uint8Array(analyser.frequencyBinCount);
      const hzPerBin = audioCtx.sampleRate / analyser.fftSize;
      bassStart = Math.max(1, Math.floor(45 / hzPerBin));
      bassEnd = Math.max(bassStart + 2, Math.ceil(170 / hzPerBin));
      midEnd = Math.max(bassEnd + 2, Math.ceil(430 / hzPerBin));
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

    const energy = bandMean(bassStart, bassEnd) * 0.74 + bandMean(bassEnd, midEnd) * 0.26;
    const flux = Math.max(0, energy - energyFloor);
    energyFloor = energyFloor * 0.9 + energy * 0.1;

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
    const gap = beatPeriod ? Math.max(220, beatPeriod * 0.42) : MIN_ONSET_GAP;
    if (now - lastOnsetTime < gap) return false;

    const { mean, std } = fluxStats();
    const threshold = Math.max(0.012, mean * 1.35 + std * 1.15);
    if (flux < threshold) return false;

    if (lastOnsetTime > 0) {
      const interval = now - lastOnsetTime;
      if (interval >= 280 && interval <= 1400) {
        intervals.push(interval);
        if (intervals.length > IOI_WINDOW) intervals.shift();
      }
    }

    lastOnsetTime = now;
    recentOnsets.push(now);
    if (recentOnsets.length > 20) recentOnsets.shift();
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
    if (count < 24) return 0;

    let sum = 0;
    for (let i = lag; i < envFilled; i += 1) {
      sum += envAt(i) * envAt(i - lag);
    }
    return sum / count;
  }

  function tempoPrior(bpm) {
    const logRatio = Math.log(bpm / 120);
    return Math.exp(-0.5 * (logRatio / 0.48) ** 2);
  }

  function lagToBpm(lag) {
    return 60000 / (lag * ENV_MS);
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

    if (animBpm) {
      const options = [value];
      if (value * 2 <= COMFY_BPM + 8) options.push(value * 2);
      if (value / 2 >= 60) options.push(value / 2);
      value = options.reduce((best, candidate) =>
        Math.abs(candidate - animBpm) < Math.abs(best - animBpm) ? candidate : best
      );
    }

    return value;
  }

  function interpolatePeak(scores, index) {
    const prev = scores[index - 1]?.score ?? scores[index].score;
    const next = scores[index + 1]?.score ?? scores[index].score;
    const peak = scores[index].score;
    const denom = prev - 2 * peak + next;
    const shift = denom === 0 ? 0 : (prev - next) / (2 * denom);
    return scores[index].lag + Math.max(-0.48, Math.min(0.48, shift));
  }

  function localPeaks(scores) {
    const peaks = [];
    for (let i = 1; i < scores.length - 1; i += 1) {
      if (scores[i].score >= scores[i - 1].score && scores[i].score >= scores[i + 1].score) {
        peaks.push({ ...scores[i], index: i });
      }
    }
    peaks.sort((a, b) => b.score - a.score);
    return peaks;
  }

  const TEMPO_RATIOS = [0.5, 2 / 3, 0.75, 0.8, 5 / 6, 6 / 5, 1.25, 4 / 3, 1.5, 2];

  function relatedTempo(a, b) {
    if (!a || !b) return false;
    const ratio = a > b ? a / b : b / a;
    if (Math.abs(ratio - 1) < 0.06) return true;
    return TEMPO_RATIOS.some((factor) => Math.abs(ratio - factor) < 0.06);
  }

  function chooseCanonicalBpm(bpm) {
    let best = foldBpm(bpm);
    let bestScore = tempoPrior(best) * (0.35 + 0.65 * alignmentScore(best));

    for (let i = 0; i < TEMPO_RATIOS.length; i += 1) {
      const candidate = foldBpm(bpm * TEMPO_RATIOS[i]);
      if (candidate < MIN_BPM || candidate > MAX_BPM) continue;
      const score = tempoPrior(candidate) * (0.35 + 0.65 * alignmentScore(candidate));
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
  }

  function ioiBpm() {
    if (intervals.length < 5) return null;
    const sorted = [...intervals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return foldBpm(60000 / median);
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function alignmentScore(bpm) {
    const period = 60000 / bpm;
    if (recentOnsets.length < 6) return 0.5;

    let x = 0;
    let y = 0;
    for (let i = 0; i < recentOnsets.length; i += 1) {
      const angle = ((recentOnsets[i] % period) / period) * Math.PI * 2;
      x += Math.cos(angle);
      y += Math.sin(angle);
    }
    return Math.hypot(x, y) / recentOnsets.length;
  }

  function commitTempo(now, bpm, prominence) {
    const nextBpm = chooseCanonicalBpm(bpm);
    estimatedBpm = estimatedBpm
      ? estimatedBpm + (nextBpm - estimatedBpm) * (tempoLocked ? 0.08 : 0.28)
      : nextBpm;
    animBpm = pickAnimBpm(estimatedBpm);
    tempoConfidence = tempoConfidence * 0.4 + prominence * 0.6;
    tempoLocked = true;

    const targetPeriod = 60000 / animBpm;
    const lerp = tempoLocked && beatPeriod ? TEMPO_LERP_LOCKED : TEMPO_LERP_UNLOCKED;

    if (beatPeriod === null) {
      beatPeriod = targetPeriod;
      nextPulseTime = now + beatPeriod;
    } else {
      beatPeriod += (targetPeriod - beatPeriod) * lerp;
    }

    applyPulseDuration();
  }

  function estimateTempo(now) {
    if (envFilled < MIN_ENV_FOR_TEMPO) return;

    const minLag = Math.round(60000 / MAX_BPM / ENV_MS);
    const maxLag = Math.round(60000 / MIN_BPM / ENV_MS);
    const scores = [];

    for (let lag = minLag; lag <= maxLag; lag += 1) {
      const bpm = lagToBpm(lag);
      const fundamental = autocorr(lag);
      const half = lag >= minLag * 2 ? autocorr(Math.round(lag / 2)) : 0;
      const third = lag >= minLag * 3 ? autocorr(Math.round(lag / 3)) : 0;
      const double = autocorr(lag * 2);
      const score = (fundamental + half * 0.55 + third * 0.2 + double * 0.25) * tempoPrior(bpm);
      scores.push({ lag, bpm, score });
    }

    if (!scores.length) return;

    const peaks = localPeaks(scores);
    if (!peaks.length) return;

    const ranked = peaks.slice(0, 5).map((peak) => {
      const bpm = foldBpm(peak.bpm);
      const fit = alignmentScore(bpm);
      return { ...peak, bpm, fit, combined: peak.score * (0.5 + 0.5 * fit) };
    });
    ranked.sort((a, b) => b.combined - a.combined);

    const best = ranked[0];
    const rival = ranked.find((peak) => !relatedTempo(peak.bpm, best.bpm)) || ranked[1];
    const prominence = rival
      ? (best.combined - rival.combined) / (best.combined + 1e-6)
      : 1;
    if (best.score < 1e-5) {
      tempoConfidence = Math.max(0, tempoConfidence - 0.06);
      return;
    }

    const refinedLag = interpolatePeak(scores, best.index);
    let rawBpm = foldBpm(lagToBpm(refinedLag));
    if (Math.abs(foldBpm(best.bpm) - rawBpm) > 8) rawBpm = best.bpm;
    const intervalBpm = ioiBpm();
    if (intervalBpm && relatedTempo(intervalBpm, rawBpm)) {
      rawBpm = rawBpm * 0.72 + foldBpm(intervalBpm) * 0.28;
    }

    recentEstimates.push(rawBpm);
    if (recentEstimates.length > 8) recentEstimates.shift();

    if (!tempoLocked) {
      const agreed = intervalBpm && relatedTempo(intervalBpm, rawBpm);
      const ready = recentEstimates.length >= 5 &&
        (prominence >= LOCK_PROMINENCE + 0.06 || (agreed && prominence >= LOCK_PROMINENCE));
      if (!ready) return;
      commitTempo(now, chooseCanonicalBpm(median(recentEstimates)), prominence);
      return;
    }

    const delta = Math.abs(rawBpm - estimatedBpm) / estimatedBpm;
    if (delta <= 0.045 && prominence >= 0.08) {
      pendingAltBpm = null;
      pendingOctaveBpm = null;
      commitTempo(now, chooseCanonicalBpm(rawBpm), prominence);
      return;
    }

    const ratio = rawBpm / estimatedBpm;
    const isOctave = Math.abs(ratio - 2) < 0.08 || Math.abs(ratio - 0.5) < 0.08;
    if (isOctave) {
      if (pendingOctaveBpm && Math.abs(pendingOctaveBpm - rawBpm) / rawBpm < 0.05) {
        if (now - pendingOctaveSince >= OCTAVE_HOLD_MS && prominence >= LOCK_PROMINENCE) {
          commitTempo(now, rawBpm, prominence);
          pendingOctaveBpm = null;
        }
      } else {
        pendingOctaveBpm = rawBpm;
        pendingOctaveSince = now;
      }
      return;
    }

    if (prominence >= LOCK_PROMINENCE + 0.08) {
      if (pendingAltBpm && Math.abs(pendingAltBpm - rawBpm) / rawBpm < 0.05) {
        if (now - pendingAltSince >= RELATIVE_HOLD_MS) {
          commitTempo(now, rawBpm, prominence);
          pendingAltBpm = null;
        }
      } else {
        pendingAltBpm = rawBpm;
        pendingAltSince = now;
      }
    }
  }

  function nudgePhase(now) {
    if (!beatPeriod || !nextPulseTime) return;

    let error = (now - nextPulseTime) % beatPeriod;
    if (error > beatPeriod / 2) error -= beatPeriod;
    if (error < -beatPeriod / 2) error += beatPeriod;
    if (Math.abs(error) < beatPeriod * 0.34) {
      nextPulseTime += error * PHASE_NUDGE;
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
    if (!beatPeriod) return 560;
    return Math.min(680, Math.max(340, beatPeriod * 0.56));
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

    if (onset && now - lastPulseTime >= (beatPeriod || 420)) {
      triggerPulse(flux);
      if (beatPeriod) nextPulseTime = now + beatPeriod;
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
    pushEnvelope(now, onset ? Math.max(flux * 2.4, 0.09) : flux * 0.16);

    if (onset && tempoLocked) nudgePhase(now);

    if (now - lastTempoUpdate >= TEMPO_UPDATE_MS) {
      estimateTempo(now);
      lastTempoUpdate = now;
    }

    maybePulse(now, flux, onset);
    rafId = requestAnimationFrame(tick);
  }

  function resetTempo() {
    energyFloor = 0;
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
    pendingOctaveBpm = null;
    pendingOctaveSince = 0;
    pendingAltBpm = null;
    pendingAltSince = 0;
    recentEstimates = [];
    intervals = [];
    recentOnsets = [];
    window.clearTimeout(pulseClearTimer);
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
