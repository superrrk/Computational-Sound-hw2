document.addEventListener("DOMContentLoaded", function (event) {
  // set up WebAudio
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // band-limited oscillator waves (square / sawtooth) to avoid extreme highs
  const periodicWaveCache = new Map();
  function getBandlimitedWave(type, harmonics) {
    const key = `${type}:${harmonics}`;
    const cached = periodicWaveCache.get(key);
    if (cached) return cached;

    const real = new Float32Array(harmonics + 1);
    const imag = new Float32Array(harmonics + 1);

    if (type === 'square') {
      // square: odd harmonics only, amplitude 4/(pi*n)
      for (let n = 1; n <= harmonics; n++) {
        if (n % 2 === 1) imag[n] = 4 / (Math.PI * n);
      }
    } else if (type === 'sawtooth') {
      // sawtooth: all harmonics, amplitude 2 * (-1)^(n+1) / n
      for (let n = 1; n <= harmonics; n++) {
        imag[n] = 2 * Math.pow(-1, n + 1) / n;
      }
    } else {
      imag[1] = 1.0;
    }

    const pw = audioCtx.createPeriodicWave(real, imag, { disableNormalization: false });
    periodicWaveCache.set(key, pw);
    return pw;
  }

  function setOscWave(osc, wave, freq) {
    if (wave === 'square' || wave === 'sawtooth') {
      // choose harmonic count based on note frequency to reduce aliasing
      const nyquist = audioCtx.sampleRate / 2 - 50;
      const maxFromFreq = Math.max(1, Math.floor(nyquist / Math.max(1, freq)));
      const harmonics = Math.min(12, maxFromFreq);
      osc.setPeriodicWave(getBandlimitedWave(wave, harmonics));
    } else {
      osc.type = wave;
    }
  }

  // always run in clean/no-clipping mode
  const outputMode = 'clean';

  // global gain knob for overall volume
  const globalGain = audioCtx.createGain();

  // master safety stage (compressor + adaptive final gain)
  const masterComp = audioCtx.createDynamicsCompressor();
  const finalGain = audioCtx.createGain();

  // analyser for peak monitoring (used in clean mode)
  const peakAnalyser = audioCtx.createAnalyser();
  peakAnalyser.fftSize = 2048;
  const peakBuf = new Float32Array(peakAnalyser.fftSize);

  // wiring: globalGain -> comp -> finalGain -> analyser -> destination
  globalGain.connect(masterComp);
  masterComp.connect(finalGain);
  finalGain.connect(peakAnalyser);
  peakAnalyser.connect(audioCtx.destination);

  const CLEAN_PRESET = {
    global: 0.60,
    comp: { threshold: -12, knee: 6, ratio: 14, attack: 0.003, release: 0.25 },
    final: 0.90,
    peakTarget: 0.92,
    recovery: 0.0012,   // per frame gain recovery
    reduction: 0.08,    // per frame reduction when peaking
  };

  function applyOutputPreset() {
    const p = CLEAN_PRESET;
    const t = audioCtx.currentTime;
    globalGain.gain.setValueAtTime(p.global, t);
    masterComp.threshold.setValueAtTime(p.comp.threshold, t);
    masterComp.knee.setValueAtTime(p.comp.knee, t);
    masterComp.ratio.setValueAtTime(p.comp.ratio, t);
    masterComp.attack.setValueAtTime(p.comp.attack, t);
    masterComp.release.setValueAtTime(p.comp.release, t);
    finalGain.gain.setValueAtTime(p.final, t);
  }

  // adaptive peak limiter loop (only actively clamps in clean mode)
  function peakLimiterTick() {
    const p = CLEAN_PRESET;
    peakAnalyser.getFloatTimeDomainData(peakBuf);
    let peak = 0;
    for (let i = 0; i < peakBuf.length; i++) {
      const a = Math.abs(peakBuf[i]);
      if (a > peak) peak = a;
    }

    const curr = finalGain.gain.value;
    if (peak > p.peakTarget) {
      // reduce quickly to keep headroom
      const target = Math.max(0.05, curr * (1 - p.reduction));
      finalGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.01);
    } else {
      // slow recovery back toward preset final gain
      const base = p.final;
      if (curr < base) {
        finalGain.gain.setTargetAtTime(Math.min(base, curr + p.recovery), audioCtx.currentTime, 0.05);
      }
    }

    requestAnimationFrame(peakLimiterTick);
  }

  applyOutputPreset();
  peakLimiterTick();

  const ADSR = { attack: 0.02, decay: 0.10, sustain: 0.5, release: 0.15 };
  const EPS = 0.0001;
  const PEAK = 0.2;

  // keyboard assignments
  const keyboardFrequencyMap = {
    '90': 261.625565300598634,  //Z - C
    '83': 277.182630976872096, //S - C#
    '88': 293.664767917407560,  //X - D
    '68': 311.126983722080910, //D - D#
    '67': 329.627556912869929,  //C - E
    '86': 349.228231433003884,  //V - F
    '71': 369.994422711634398, //G - F#
    '66': 391.995435981749294,  //B - G
    '72': 415.304697579945138, //H - G#
    '78': 440.000000000000000,  //N - A
    '74': 466.163761518089916, //J - A#
    '77': 493.883301256124111,  //M - B
    '81': 523.251130601197269,  //Q - C
    '50': 554.365261953744192, //2 - C#
    '87': 587.329535834815120,  //W - D
    '51': 622.253967444161821, //3 - D#
    '69': 659.255113825739859,  //E - E
    '82': 698.456462866007768,  //R - F
    '53': 739.988845423268797, //5 - F#
    '84': 783.990871963498588,  //T - G
    '54': 830.609395159890277, //6 - G#
    '89': 880.000000000000000,  //Y - A
    '55': 932.327523036179832, //7 - A#
    '85': 987.766602512248223,  //U - B
  };

  // default wave when opening page
  let currentWave = "sine";

  // synth mode (additive / am / fm) and UI hooks
  let currentMode = "additive";
  const modeButtons = document.querySelectorAll('.mode-btn');
  const numPartialsInput = document.getElementById('num-partials');
  const amModFreqInput = document.getElementById('mod-freq');
  const amDepthInput = document.getElementById('mod-depth-am');
  const fmModFreqInput = document.getElementById('fm-mod-freq');
  const fmIndexInput = document.getElementById('fm-index');
  const lfoEnableInput = document.getElementById('lfo-enable');
  const lfoRateInput = document.getElementById('lfo-rate');
  const lfoDepthInput = document.getElementById('lfo-depth');
  // ADSR control inputs
  const adsrAttackInput = document.getElementById('adsr-attack');
  const adsrDecayInput = document.getElementById('adsr-decay');
  const adsrSustainInput = document.getElementById('adsr-sustain');
  const adsrReleaseInput = document.getElementById('adsr-release');

  function getNumPartials() {
    const v = numPartialsInput ? parseInt(numPartialsInput.value, 10) : 3;
    return Math.max(1, isNaN(v) ? 3 : v);
  }
  function getAmModFreq() { return amModFreqInput ? parseFloat(amModFreqInput.value) : 5; }
  function getAmDepth() { return amDepthInput ? parseFloat(amDepthInput.value) : 0.4; }
  function getFmModFreq() { return fmModFreqInput ? parseFloat(fmModFreqInput.value) : 220; }
  function getFmIndex() { return fmIndexInput ? parseFloat(fmIndexInput.value) : 100; }
  function getLfoEnabled() { return lfoEnableInput ? lfoEnableInput.checked : false; }
  function getLfoRate() { return lfoRateInput ? parseFloat(lfoRateInput.value) : 5; }
  function getLfoDepth() { return lfoDepthInput ? parseFloat(lfoDepthInput.value) : 0.3; }
  function getAdsrAttack() { return adsrAttackInput ? parseFloat(adsrAttackInput.value) : ADSR.attack; }
  function getAdsrDecay() { return adsrDecayInput ? parseFloat(adsrDecayInput.value) : ADSR.decay; }
  function getAdsrSustain() { return adsrSustainInput ? parseFloat(adsrSustainInput.value) : ADSR.sustain; }
  function getAdsrRelease() { return adsrReleaseInput ? parseFloat(adsrReleaseInput.value) : ADSR.release; }
  // clamp FM index to safe value depending on waveform to avoid extreme sidebands
  function getFmSafeIndex(freq) {
    const raw = getFmIndex();
    if (!currentWave) return raw;
    // for bright waveforms, cap index to a conservative value relative to fundamental
    if (currentWave === 'square' || currentWave === 'sawtooth') {
      // cap to half the frequency but at least 20Hz, and at most raw
      const capBase = Math.max(20, Math.min(raw, freq * 0.5));
      return Math.min(raw, Math.min(capBase, 180));
    }
    // triangle behaves closer to sine, be a bit more permissive
    if (currentWave === 'triangle') {
      const cap = Math.max(20, Math.min(raw, freq * 1.0));
      return Math.min(raw, cap);
    }
    // sine: allow full range
    return Math.min(raw, 600);
  }

  function showControlsForMode(mode) {
    if (numPartialsInput) numPartialsInput.parentElement.style.display = (mode === 'additive') ? '' : 'none';
    const amDiv = document.getElementById('am-controls');
    const fmDiv = document.getElementById('fm-controls');
    if (amDiv) amDiv.style.display = (mode === 'am') ? '' : 'none';
    if (fmDiv) fmDiv.style.display = (mode === 'fm') ? '' : 'none';
  }

  // wire up mode buttons (not a dropdown)
  if (modeButtons && modeButtons.length) {
    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        modeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = btn.dataset.mode || currentMode;
        showControlsForMode(currentMode);
      });
    });
    // set initial mode from the active button if present
    const activeModeBtn = Array.from(modeButtons).find(b => b.classList.contains('active'));
    if (activeModeBtn) currentMode = activeModeBtn.dataset.mode || currentMode;
  }
  // initialize visibility
  showControlsForMode(currentMode);

  // apply clean preset on load
  applyOutputPreset();

  // select between different types of waves
  const waveButtons = document.querySelectorAll(".wave-btn");
  waveButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      currentWave = btn.dataset.wave;
      waveButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const disp = document.getElementById('current-wave-display');
      if (disp) disp.textContent = currentWave.charAt(0).toUpperCase() + currentWave.slice(1);
      // adjust FM index slider constraints when bright waveforms selected
      if (typeof fmIndexInput !== 'undefined' && fmIndexInput) {
        if (currentWave === 'square' || currentWave === 'sawtooth') {
          // reduce maximum to make clipping less likely
          fmIndexInput.max = 500;
          // if current value exceeds safe soft cap, reduce it gracefully
          const safeSoft = Math.min(parseFloat(fmIndexInput.value), 200);
          if (parseFloat(fmIndexInput.value) > safeSoft) {
            fmIndexInput.value = safeSoft;
            // update displayed value
            setDisplay('fm-index-value', fmIndexInput.value, 0, 'Hz');
            const warn = document.getElementById('fm-warning');
            if (warn) warn.textContent = 'FM index reduced for bright waveform to avoid clipping';
            setTimeout(() => { if (warn) warn.textContent = ''; }, 2000);
          }
        } else {
          fmIndexInput.max = 1000;
        }
      }
    });
  });
  // initialize current wave display
  const waveDispInit = document.getElementById('current-wave-display');
  if (waveDispInit) waveDispInit.textContent = currentWave.charAt(0).toUpperCase() + currentWave.slice(1);

  // helper: update numeric display next to sliders (optionally append unit)
  function setDisplay(id, value, decimals = (Number.isInteger(value) ? 0 : 2), unit = '') {
    const el = document.getElementById(id);
    if (!el) return;
    const formatted = (decimals === 0) ? String(Math.round(value)) : Number.parseFloat(value).toFixed(decimals);
    el.textContent = unit ? `${formatted} ${unit}` : formatted;
  }
  // wire up slider inputs to value spans (if present) with units
  const mappings = [
    { in: 'num-partials', out: 'num-partials-value', decimals: 0, unit: '' },
    { in: 'mod-freq', out: 'am-mod-freq-value', decimals: 2, unit: 'Hz' },
    { in: 'mod-depth-am', out: 'am-depth-value', decimals: 2, unit: '' },
    { in: 'fm-mod-freq', out: 'fm-mod-freq-value', decimals: 2, unit: 'Hz' },
    { in: 'fm-index', out: 'fm-index-value', decimals: 0, unit: 'Hz' },
    { in: 'lfo-rate', out: 'lfo-rate-value', decimals: 2, unit: 'Hz' },
    { in: 'lfo-depth', out: 'lfo-depth-value', decimals: 2, unit: '' },
    { in: 'adsr-attack', out: 'adsr-attack-value', decimals: 3, unit: 's' },
    { in: 'adsr-decay', out: 'adsr-decay-value', decimals: 3, unit: 's' },
    { in: 'adsr-sustain', out: 'adsr-sustain-value', decimals: 2, unit: '' },
    { in: 'adsr-release', out: 'adsr-release-value', decimals: 2, unit: 's' },
  ];
  mappings.forEach(m => {
    const input = document.getElementById(m.in);
    if (!input) return;
    // initialize
    setDisplay(m.out, input.value, m.decimals, m.unit);
    input.addEventListener('input', () => setDisplay(m.out, input.value, m.decimals, m.unit));
  });

  // update ADSR object live when sliders change
  function updateAdsrFromUI() {
    ADSR.attack = getAdsrAttack();
    ADSR.decay = getAdsrDecay();
    ADSR.sustain = getAdsrSustain();
    ADSR.release = getAdsrRelease();
  }
  if (adsrAttackInput) adsrAttackInput.addEventListener('input', updateAdsrFromUI);
  if (adsrDecayInput) adsrDecayInput.addEventListener('input', updateAdsrFromUI);
  if (adsrSustainInput) adsrSustainInput.addEventListener('input', updateAdsrFromUI);
  if (adsrReleaseInput) adsrReleaseInput.addEventListener('input', updateAdsrFromUI);

  const activeOscillators = {};

  window.addEventListener('keydown', keyDown, false); // key is pressed, call KeyDown
  window.addEventListener('keyup', keyUp, false); // key is released, call KeyUp

  function keyDown(event) {
    const key = String(event.keyCode || event.which);
    if (keyboardFrequencyMap[key] && !activeOscillators[key]) {
      playNote(key);
    }
  }

  function keyUp(event) {
    const key = String(event.keyCode || event.which);
    if (!keyboardFrequencyMap[key] || !activeOscillators[key]) return;
    const entry = activeOscillators[key];
    const curr = audioCtx.currentTime;

    // shared gainNode expected for all modes
    if (entry && entry.gainNode) {
      entry.gainNode.gain.cancelScheduledValues(curr);
      entry.gainNode.gain.setValueAtTime(Math.max(EPS, entry.gainNode.gain.value), curr);
      entry.gainNode.gain.setTargetAtTime(EPS, curr, Math.max(0.001, ADSR.release / 4));
    }

    // Stop different oscillator shapes after release tail
    const stopTime = curr + ADSR.release * 4;
    if (entry) {
      // additive: entry.partials = [{osc, gain}, ...]
      if (entry.partials && Array.isArray(entry.partials)) {
        entry.partials.forEach(p => {
          try { p.osc.stop(stopTime); } catch (e) {}
        });
      }
      // AM/FM or simple: possibly carrier/mod oscillators
      if (entry.carrier) {
        try { entry.carrier.stop(stopTime); } catch (e) {}
      }
      if (entry.mod) {
        try { entry.mod.stop(stopTime); } catch (e) {}
      }
      if (entry.lfo && entry.lfo.lfo) {
        try { entry.lfo.lfo.stop(stopTime); } catch (e) {}
      }
      if (entry.lfo && entry.lfo.dc) {
        try { entry.lfo.dc.stop(stopTime); } catch (e) {}
      }
      if (entry.osc) {
        try { entry.osc.stop(stopTime); } catch (e) {}
      }
    }

    delete activeOscillators[key];
    // visual: spawn a floating music note for this key
    try {
      const noteContainer = document.getElementById('note-container');
      if (noteContainer) {
        const note = document.createElement('div');
        note.className = 'music-note';
        const symbols = ['♪','♫','♩','♬'];
        note.textContent = symbols[Math.floor(Math.random() * symbols.length)];
        const x = 8 + Math.random() * 84; // percent across screen
        note.style.left = `${x}%`;
        const size = 18 + Math.random() * 22;
        note.style.fontSize = `${size}px`;
        noteContainer.appendChild(note);
        note.addEventListener('animationend', () => note.remove());
      }
    } catch (e) {
      // ignore visual errors
    }

    polyphonic();
  }

  function playNote(key) {
    const curr = audioCtx.currentTime;
    const freq = keyboardFrequencyMap[key];

    // shared ADSR gain for this voice
    const gainNode = audioCtx.createGain();
    gainNode.gain.cancelScheduledValues(curr);
    gainNode.gain.setValueAtTime(EPS, curr);

    // per-voice gain (poly scaling)
    const voiceGain = audioCtx.createGain();
    voiceGain.gain.setValueAtTime(1.0, curr); // will be adjusted by polyphonic()
    gainNode.connect(voiceGain);

    // tremolo stage (LFO modulates this, polyphonic scaling modulates voiceGain)
    const tremoloGain = audioCtx.createGain();
    tremoloGain.gain.setValueAtTime(1.0, curr);
    voiceGain.connect(tremoloGain);
    tremoloGain.connect(globalGain);

    if (currentMode === 'additive') {
      const numPartials = getNumPartials();
      // create decreasing harmonic weights (1, 1/2, 1/3, ...) normalized
      const rawWeights = [];
      for (let i = 1; i <= numPartials; i++) rawWeights.push(1 / i);
      const sumRaw = rawWeights.reduce((s, v) => s + v, 0);
      const partialAmps = rawWeights.map(w => w / sumRaw);

      const partials = [];
      for (let i = 0; i < numPartials; i++) {
        const ratio = i + 1; // harmonic ratio
        const pOsc = audioCtx.createOscillator();
        setOscWave(pOsc, currentWave, freq * ratio);
        pOsc.frequency.setValueAtTime(freq * ratio, curr);

        const pGain = audioCtx.createGain();
        pGain.gain.setValueAtTime(partialAmps[i], curr);

        pOsc.connect(pGain);
        pGain.connect(gainNode); // share ADSR
        pOsc.start(curr);
        partials.push({ osc: pOsc, gain: pGain, ratio });
      }

      // ADSR on the shared gainNode
      gainNode.gain.exponentialRampToValueAtTime(PEAK, curr + ADSR.attack);
      gainNode.gain.exponentialRampToValueAtTime(
        Math.max(EPS, PEAK * ADSR.sustain),
        curr + ADSR.attack + ADSR.decay
      );

      activeOscillators[key] = { partials, gainNode, voiceGain, tremoloGain };
      // optionally add per-voice LFO (tremolo) for additive voices
      if (getLfoEnabled() && getLfoDepth() > 0) {
        const lfo = audioCtx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.setValueAtTime(getLfoRate(), curr);
        const lfoGain = audioCtx.createGain();
        const lfoDepth = Math.min(1, Math.max(0, getLfoDepth()));
        lfoGain.gain.setValueAtTime(lfoDepth / 2, curr);
        const dc = audioCtx.createConstantSource();
        dc.offset.setValueAtTime(1 - (lfoDepth / 2), curr);

        lfo.connect(lfoGain);
        lfoGain.connect(tremoloGain.gain);
        dc.connect(tremoloGain.gain);

        lfo.start(curr);
        dc.start(curr);

        activeOscillators[key].lfo = { lfo, lfoGain, dc };
      }
    } else {
      if (currentMode === 'am') {
        // AM: carrier amplitude modulated by a low-frequency modulator
        const carrier = audioCtx.createOscillator();
        setOscWave(carrier, currentWave, freq);
        carrier.frequency.setValueAtTime(freq, curr);

        const carrierGain = audioCtx.createGain();
        // we'll control carrierGain.gain via a constant + modulator
        carrierGain.gain.setValueAtTime(0.0, curr);

        // modulator
        const mod = audioCtx.createOscillator();
        mod.type = 'sine';
        mod.frequency.setValueAtTime(getAmModFreq(), curr);
        const modGain = audioCtx.createGain();
        const amDepth = Math.min(1, Math.max(0, getAmDepth()));
        modGain.gain.setValueAtTime(amDepth / 2, curr);

        // constant source to provide base level so carrier gain stays positive
        const dc = audioCtx.createConstantSource();
        dc.offset.setValueAtTime(1 - (amDepth / 2), curr);

        // connect mod -> modGain -> carrierGain.gain (AudioParam)
        mod.connect(modGain);
        modGain.connect(carrierGain.gain);
        dc.connect(carrierGain.gain);

        // audio chain: carrier -> carrierGain -> ADSR gainNode -> voiceGain -> global
        carrier.connect(carrierGain);
        carrierGain.connect(gainNode);

        // ADSR on the shared gainNode
        gainNode.gain.exponentialRampToValueAtTime(PEAK, curr + ADSR.attack);
        gainNode.gain.exponentialRampToValueAtTime(
          Math.max(EPS, PEAK * ADSR.sustain),
          curr + ADSR.attack + ADSR.decay
        );

        carrier.start(curr);
        mod.start(curr);
        dc.start(curr);

        activeOscillators[key] = { carrier, mod, dc, modGain, carrierGain, gainNode, voiceGain, tremoloGain };
        // optional per-voice LFO on voiceGain for AM voices
        if (getLfoEnabled() && getLfoDepth() > 0) {
          const lfo = audioCtx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.setValueAtTime(getLfoRate(), curr);
          const lfoGain = audioCtx.createGain();
          const lfoDepth = Math.min(1, Math.max(0, getLfoDepth()));
          lfoGain.gain.setValueAtTime(lfoDepth / 2, curr);
          const dc = audioCtx.createConstantSource();
          dc.offset.setValueAtTime(1 - (lfoDepth / 2), curr);

          lfo.connect(lfoGain);
          lfoGain.connect(tremoloGain.gain);
          dc.connect(tremoloGain.gain);

          lfo.start(curr);
          dc.start(curr);
          activeOscillators[key].lfo = { lfo, lfoGain, dc };
        }
      } else if (currentMode === 'fm') {
        // FM: modulator connected to carrier.frequency
        const carrier = audioCtx.createOscillator();
        setOscWave(carrier, currentWave, freq);
        carrier.frequency.setValueAtTime(freq, curr);

        const mod = audioCtx.createOscillator();
        mod.type = 'sine';
        mod.frequency.setValueAtTime(getFmModFreq(), curr);

        const modGain = audioCtx.createGain();
        // apply a safe FM index depending on waveform to reduce clipping
        const requestedIndex = getFmIndex();
        const safeIndex = getFmSafeIndex(freq);
        modGain.gain.setValueAtTime(safeIndex, curr); // frequency deviation in Hz
        if (safeIndex < requestedIndex) {
          const warn = document.getElementById('fm-warning');
          if (warn) {
            warn.textContent = `FM index clamped to ${Math.round(safeIndex)} Hz for ${currentWave}`;
            setTimeout(() => { if (warn) warn.textContent = ''; }, 2500);
          }
        }

        mod.connect(modGain);
        modGain.connect(carrier.frequency); // audio-rate FM

        // chain carrier -> ADSR -> voiceGain -> global
        carrier.connect(gainNode);

        // ADSR on the shared gainNode
        gainNode.gain.exponentialRampToValueAtTime(PEAK, curr + ADSR.attack);
        gainNode.gain.exponentialRampToValueAtTime(
          Math.max(EPS, PEAK * ADSR.sustain),
          curr + ADSR.attack + ADSR.decay
        );

        carrier.start(curr);
        mod.start(curr);

        activeOscillators[key] = { carrier, mod, modGain, gainNode, voiceGain, tremoloGain };
        // optional per-voice LFO (tremolo) for FM voices
        if (getLfoEnabled() && getLfoDepth() > 0) {
          const lfo = audioCtx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.setValueAtTime(getLfoRate(), curr);
          const lfoGain = audioCtx.createGain();
          const lfoDepth = Math.min(1, Math.max(0, getLfoDepth()));
          lfoGain.gain.setValueAtTime(lfoDepth / 2, curr);
          const dc = audioCtx.createConstantSource();
          dc.offset.setValueAtTime(1 - (lfoDepth / 2), curr);

          lfo.connect(lfoGain);
          lfoGain.connect(tremoloGain.gain);
          dc.connect(tremoloGain.gain);

          lfo.start(curr);
          dc.start(curr);
          activeOscillators[key].lfo = { lfo, lfoGain, dc };
        }
      } else {
        // fallback: simple single oscillator
        const osc = audioCtx.createOscillator();
        osc.frequency.setValueAtTime(freq, curr);
        setOscWave(osc, currentWave, freq);
        osc.connect(gainNode);

        // ADSR on the shared gainNode
        gainNode.gain.exponentialRampToValueAtTime(PEAK, curr + ADSR.attack);
        gainNode.gain.exponentialRampToValueAtTime(
          Math.max(EPS, PEAK * ADSR.sustain),
          curr + ADSR.attack + ADSR.decay
        );

        osc.start(curr);
        activeOscillators[key] = { osc, gainNode, voiceGain, tremoloGain };
      }
    }

    polyphonic();
  }


  function polyphonic() {
    const keys = Object.keys(activeOscillators);
    const n = Math.max(1, keys.length);
    const curr = audioCtx.currentTime;

    // must be < 1 to guarantee no clipping
    const HEADROOM = 0.95;                 
    const master = globalGain.gain.value;  // 0.8 

    // safe per voice gain for ANY number of voices
    const perVoice = HEADROOM / (n * PEAK * master);

    keys.forEach(k => {
      activeOscillators[k].voiceGain.gain.setTargetAtTime(perVoice, curr, 0.01);
    });
  }

});

