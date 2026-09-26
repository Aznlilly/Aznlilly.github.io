(function () {
  const audio = document.getElementById("audioplayer");
  const artFrame = document.querySelector(".art-frame");
  const body = document.body;
  const bpmEl = document.getElementById("track-bpm");

  if (!audio || !artFrame) return;

  const FFT_SIZE = 4096;
  const ENV_MS = 10;
  const ENV_SECONDS = 8;
  const ENV_SIZE = Math.round((ENV_SECONDS * 1000) / ENV_MS);
  const MIN_BPM = 76;
  const MAX_BPM = 172;
  const COMFY_BPM = 160;
  const TEMPO_UPDATE_MS = 450;
  const MIN_ENV_FOR_TEMPO = Math.round(ENV_SIZE * 0.5);
  const MIN_ONSET_GAP = 280;
  const FLUX_HISTORY = 80;
  const VOTE_WINDOW = 7;
  const VOTES_TO_LOCK = 5;
  const HOLD_MS = 4500;
  const RATIOS = [0.5, 2 / 3, 0.75, 4 / 3, 1.5, 2];

  let audioCtx = null;
  let analyser = null;
  let source = null;
  let rafId = null;
  let freqData = null;
  let kickStart = 1;
  let kickEnd = 8;
  let bodyEnd = 16;

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

  let displayBpm = null;
  let hintBpm = null;
  let pendingBpm = null;
  let pendingSince = 0;
  let animBpm = null;
  let beatPeriod = null;
  let nextPulseTime = 0;
  let tempoConfidence = 0;
  let tempoLocked = false;
  let votes = [];
  let bestPhaseLag = 0;

  function init() {
    if (audioCtx) return true;

    try {
      audioCtx = new AudioContext();
      source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.06;
      analyser.minDecibels = -82;
      analyser.maxDecibels = -18;

      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      freqData = new Uint8Array(analyser.frequencyBinCount);
      const hzPerBin = audioCtx.sampleRate / analyser.fftSize;
      kickStart = Math.max(1, Math.floor(40 / hzPerBin));
      kickEnd = Math.max(kickStart + 2, Math.ceil(100 / hzPerBin));
      bodyEnd = Math.max(kickEnd + 2, Math.ceil(160 / hzPerBin));
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
    const kick = bandMean(kickStart, kickEnd);
    const bodyBand = bandMean(kickEnd, bodyEnd);
    const energy = kick * 0.86 + bodyBand * 0.14;
    const flux = Math.max(0, energy - kickFloor);
    kickFloor = kickFloor * 0.9 + energy * 0.1;

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
    if (flux < Math.max(0.012, mean * 1.5 + std * 1.1)) return false;
    lastOnsetTime = now;
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
    const logRatio = Math.log(bpm / 118);
    return Math.exp(-0.5 * (logRatio / 0.3) ** 2);
  }

  function combScore(periodLag) {
    if (periodLag < 4 || envFilled < periodLag * 3) return { score: 0, phase: 0 };

    let best = 0;
    let bestPhase = 0;
    const step = periodLag > 50 ? 2 : 1;

    for (let phase = 0; phase < periodLag; phase += step) {
      let sum = 0;
      let count = 0;
      for (let i = phase; i < envFilled; i += periodLag) {
        sum += envAt(i);
        count += 1;
      }
      const score = count ? sum / count : 0;
      if (score > best) {
        best = score;
        bestPhase = phase;
      }
    }

    return { score: best, phase: bestPhase };
  }

  function scoreBpm(bpm) {
    const periodLag = 60000 / bpm / ENV_MS;
    const comb = combScore(Math.round(periodLag));
    return {
      bpm,
      score: comb.score * songPrior(bpm),
      raw: comb.score,
      phase: comb.phase,
    };
  }

  function pickMetrical(candidate) {
    let best = candidate;

    for (let i = 0; i < RATIOS.length; i += 1) {
      const bpm = foldBpm(candidate.bpm * RATIOS[i]);
      if (bpm < MIN_BPM || bpm > MAX_BPM) continue;
      const option = scoreBpm(bpm);
      if (option.score > best.score * 1.12) best = option;
      else if (
        option.score > best.score * 0.88 &&
        bpm >= 92 &&
        bpm <= 140 &&
        (best.bpm < 92 || best.bpm > 145)
      ) {
        best = option;
      }
    }

    if (best.bpm > 148) {
      const slower = scoreBpm(foldBpm(best.bpm * (2 / 3)));
      if (slower.bpm >= 90 && slower.bpm <= 140 && slower.raw >= best.raw * 0.55) {
        return slower;
      }
    }

    return best;
  }

  function estimateFromComb() {
    if (envFilled < MIN_ENV_FOR_TEMPO) return null;

    let best = null;
    for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 1) {
      const candidate = scoreBpm(bpm);
      if (!best || candidate.score > best.score) best = candidate;
    }
    if (!best || best.raw < 1e-5) return null;

    let refined = best;
    for (let bpm = best.bpm - 2; bpm <= best.bpm + 2; bpm += 0.25) {
      if (bpm < MIN_BPM || bpm > MAX_BPM) continue;
      const candidate = scoreBpm(bpm);
      if (candidate.score > refined.score) refined = candidate;
    }

    const chosen = pickMetrical(refined);
    if (hintBpm) {
      const hint = scoreBpm(hintBpm);
      const close = Math.abs(chosen.bpm - hintBpm) / hintBpm <= 0.07;
      const related = RATIOS.some(
        (ratio) => Math.abs(chosen.bpm / hintBpm - ratio) < 0.08
      );
      if (close || related) return hint;
    }

    return chosen;
  }

  function renderBpm() {
    if (!bpmEl) return;
    if (!displayBpm) {
      bpmEl.hidden = true;
      bpmEl.textContent = "";
      return;
    }
    bpmEl.hidden = false;
    bpmEl.textContent = `${displayBpm} BPM`;
  }

  function applyLockedBpm(now, bpm, confidence, phaseLag) {
    displayBpm = Math.round(bpm);
    animBpm = pickAnimBpm(bpm);
    tempoConfidence = confidence;
    tempoLocked = true;
    bestPhaseLag = phaseLag || bestPhaseLag;

    const targetPeriod = 60000 / animBpm;
    beatPeriod = targetPeriod;

    if (envFilled > 4) {
      const lastBeatIndex =
        bestPhaseLag +
        Math.floor((envFilled - 1 - bestPhaseLag) / Math.round(targetPeriod / ENV_MS)) *
          Math.round(targetPeriod / ENV_MS);
      const lastBeatTime = lastEnvTime - (envFilled - lastBeatIndex) * ENV_MS;
      nextPulseTime = lastBeatTime + targetPeriod;
      while (nextPulseTime <= now) nextPulseTime += targetPeriod;
    } else if (!nextPulseTime) {
      nextPulseTime = now + targetPeriod;
    }

    applyPulseDuration();
    renderBpm();
  }

  function modeVote() {
    if (votes.length < VOTES_TO_LOCK) return null;
    const counts = new Map();
    for (let i = 0; i < votes.length; i += 1) {
      counts.set(votes[i], (counts.get(votes[i]) || 0) + 1);
    }
    let mode = null;
    let top = 0;
    counts.forEach((count, bpm) => {
      if (count > top) {
        top = count;
        mode = bpm;
      }
    });
    return top >= VOTES_TO_LOCK ? mode : null;
  }

  function estimateTempo(now) {
    const guess = estimateFromComb();
    if (!guess) return;

    const rounded = Math.round(guess.bpm);
    votes.push(rounded);
    if (votes.length > VOTE_WINDOW) votes.shift();

    const confidence = Math.min(1, guess.raw * 8 + 0.2);

    if (!tempoLocked) {
      const stable = modeVote();
      if (stable) applyLockedBpm(now, stable, confidence, guess.phase);
      return;
    }

    if (rounded === displayBpm) {
      pendingBpm = null;
      bestPhaseLag = guess.phase;
      return;
    }

    if (pendingBpm !== rounded) {
      pendingBpm = rounded;
      pendingSince = now;
      return;
    }

    if (now - pendingSince < HOLD_MS) return;
    if ((modeVote() || rounded) !== rounded) return;

    applyLockedBpm(now, rounded, confidence, guess.phase);
    pendingBpm = null;
  }

  function setHint(bpm) {
    const value = foldBpm(Number(bpm));
    if (value) hintBpm = value;
  }

  function nudgePhase(now) {
    if (!beatPeriod || !nextPulseTime) return;
    let error = (now - nextPulseTime) % beatPeriod;
    if (error > beatPeriod / 2) error -= beatPeriod;
    if (error < -beatPeriod / 2) error += beatPeriod;
    if (Math.abs(error) < beatPeriod * 0.28) nextPulseTime += error * 0.35;
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

    if (onset && now - lastPulseTime >= 440) triggerPulse(flux);
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

  function resetTempo(keepHint) {
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
    pendingBpm = null;
    pendingSince = 0;
    animBpm = null;
    beatPeriod = null;
    nextPulseTime = 0;
    votes = [];
    bestPhaseLag = 0;
    window.clearTimeout(pulseClearTimer);

    if (!keepHint) hintBpm = null;
    displayBpm = null;
    tempoConfidence = 0;
    tempoLocked = false;
    renderBpm();
  }

  async function start() {
    if (!init()) return;
    if (audioCtx.state === "suspended") await audioCtx.resume();
    resetTempo(true);
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
    setHint,
    getTempo() {
      return {
        bpm: displayBpm,
        pulseBpm: animBpm ? Number(animBpm.toFixed(1)) : null,
        confidence: Number(tempoConfidence.toFixed(2)),
        locked: tempoLocked,
      };
    },
  };
})();
