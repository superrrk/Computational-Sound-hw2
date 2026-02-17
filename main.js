document.addEventListener("DOMContentLoaded", function (event) {
  // set up WebAudio
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // global gain knob for laptop
  const globalGain = audioCtx.createGain();
  globalGain.gain.setValueAtTime(0.8, audioCtx.currentTime)
  globalGain.connect(audioCtx.destination);

  const ADSR = { attack: 0.02, decay: 0.10, sustain: 0.5, release: 0.15 };
  const EPS = 0.0001;
  const PEAK = 0.4;

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

  // select between different types of waves
  const waveButtons = document.querySelectorAll(".wave-btn");
  waveButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      currentWave = btn.dataset.wave;
      waveButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  const activeOscillators = {};

  // Cat creation per key
  const catContainer = document.getElementById('cat-container');
  const activeCats = {};

  window.addEventListener('keydown', keyDown, false); // key is pressed, call KeyDown
  window.addEventListener('keyup', keyUp, false); // key is released, call KeyUp

  function keyDown(event) {
    const key = String(event.keyCode || event.which);
    if (keyboardFrequencyMap[key] && !activeOscillators[key]) {
      playNote(key);
      
      // Create a new cat for this key
      if (catContainer && !activeCats[key]) {
        const newCat = document.createElement('div');
        newCat.className = 'cat-note';
        catContainer.appendChild(newCat);
        activeCats[key] = newCat;
        
        // Start animation
        setTimeout(() => {
          const animationName = `wave-${currentWave}`;
          newCat.style.animation = `${animationName} 0.6s linear infinite`;
        }, 10);
      }
    }
  }

  function keyUp(event) {
    const key = String(event.keyCode || event.which);
    if (!keyboardFrequencyMap[key] || !activeOscillators[key]) return;

    const { osc, gainNode } = activeOscillators[key];
    const curr = audioCtx.currentTime;

    // Release
    gainNode.gain.cancelScheduledValues(curr);
    gainNode.gain.setValueAtTime(Math.max(EPS, gainNode.gain.value), curr);
    gainNode.gain.setTargetAtTime(EPS, curr, Math.max(0.001, ADSR.release / 4));

    // Stop after release tail
    osc.stop(curr + ADSR.release * 4);

    delete activeOscillators[key];

    polyphonic();
    
    // Remove the cat for this key
    if (activeCats[key]) {
      activeCats[key].remove();
      delete activeCats[key];
    }
  }

  function playNote(key) {
    const curr = audioCtx.currentTime;

    const osc = audioCtx.createOscillator();
    osc.frequency.setValueAtTime(keyboardFrequencyMap[key], curr);
    osc.type = currentWave;

    // ADSR envelope gain (time shape)
    const gainNode = audioCtx.createGain();
    gainNode.gain.cancelScheduledValues(curr);
    gainNode.gain.setValueAtTime(EPS, curr);

    // per-voice gain (poly scaling)
    const voiceGain = audioCtx.createGain();
    voiceGain.gain.setValueAtTime(1.0, curr); // will be adjusted by polyphonic()

    // Chain: osc -> ADSR -> voiceGain -> global
    osc.connect(gainNode);
    gainNode.connect(voiceGain);
    voiceGain.connect(globalGain);

    // Attack to PEAK (not 1.0)
    gainNode.gain.exponentialRampToValueAtTime(PEAK, curr + ADSR.attack);

    // Decay to sustain level (a fraction of PEAK)
    gainNode.gain.exponentialRampToValueAtTime(
      Math.max(EPS, PEAK * ADSR.sustain),
      curr + ADSR.attack + ADSR.decay
    );

    osc.start(curr);

    activeOscillators[key] = { osc, gainNode, voiceGain };

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