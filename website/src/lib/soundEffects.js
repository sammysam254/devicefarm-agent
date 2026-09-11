// Browser Web Audio API Sound FX Synthesizer (No external audio file dependencies)

export const playWelcomeSound = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    // Futuristic 4-note ascending chord (E5 -> G#5 -> B5 -> E6)
    const notes = [659.25, 830.61, 987.77, 1318.51];
    notes.forEach((freq, index) => {
      const startTime = ctx.currentTime + index * 0.08;
      
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);

      // Envelope
      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.25, startTime + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.55);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.6);
    });
  } catch (e) {
    console.warn('Audio playback not supported or user gesture required:', e);
  }
};

export const playSuccessSound = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    // High 2-note chime (C6 -> G6)
    [1046.5, 1567.98].forEach((freq, index) => {
      const startTime = ctx.currentTime + index * 0.1;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.2, startTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.4);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.45);
    });
  } catch (e) {
    console.warn('Audio playback error:', e);
  }
};

export const playDingSound = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    // Crisp, bright 2-tone "ding" chime (A6 -> E7)
    const tones = [
      { freq: 1760.00, delay: 0, gain: 0.28, decay: 0.6 },
      { freq: 2637.02, delay: 0.08, gain: 0.24, decay: 0.55 }
    ];

    tones.forEach(({ freq, delay, gain: vol, decay }) => {
      const startTime = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.exponentialRampToValueAtTime(vol, startTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + decay);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + decay + 0.05);
    });
  } catch (e) {
    console.warn('Ding sound playback error:', e);
  }
};

// ── Voice Call Audio Synthesizer (Ringtone, Offline, Connect, Hangup) ────────

let activeRingInterval = null;
let activeRingCtx = null;

export const playRingtone = () => {
  stopRingtone(); // Stop any existing ringing

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    activeRingCtx = new AudioCtx();
    if (activeRingCtx.state === 'suspended') {
      activeRingCtx.resume().catch(() => {});
    }

    const ringBurst = () => {
      if (!activeRingCtx || activeRingCtx.state === 'closed') return;
      const t = activeRingCtx.currentTime;

      // Realistic telephone double-pulse ring (440 Hz + 480 Hz)
      [440, 480].forEach(freq => {
        // Pulse 1 (0s to 0.8s)
        const osc1 = activeRingCtx.createOscillator();
        const gain1 = activeRingCtx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(freq, t);
        gain1.gain.setValueAtTime(0.001, t);
        gain1.gain.exponentialRampToValueAtTime(0.2, t + 0.04);
        gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
        osc1.connect(gain1);
        gain1.connect(activeRingCtx.destination);
        osc1.start(t);
        osc1.stop(t + 0.85);

        // Pulse 2 (1.0s to 1.8s)
        const osc2 = activeRingCtx.createOscillator();
        const gain2 = activeRingCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(freq, t + 1.0);
        gain2.gain.setValueAtTime(0.001, t + 1.0);
        gain2.gain.exponentialRampToValueAtTime(0.2, t + 1.04);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
        osc2.connect(gain2);
        gain2.connect(activeRingCtx.destination);
        osc2.start(t + 1.0);
        osc2.stop(t + 1.85);
      });
    };

    ringBurst();
    activeRingInterval = setInterval(ringBurst, 3500); // 1.8s ring + 1.7s silence cadence
  } catch (e) {
    console.warn('Ringtone playback error:', e);
  }
};

export const stopRingtone = () => {
  if (activeRingInterval) {
    clearInterval(activeRingInterval);
    activeRingInterval = null;
  }
  if (activeRingCtx) {
    try {
      activeRingCtx.close().catch(() => {});
    } catch (_) {}
    activeRingCtx = null;
  }
};

export const playOfflineSound = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    // Two low descending warning buzzes (340 Hz -> 220 Hz)
    const t = ctx.currentTime;
    [
      { freq: 340, start: t, dur: 0.22 },
      { freq: 220, start: t + 0.26, dur: 0.38 }
    ].forEach(({ freq, start, dur }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(start);
      osc.stop(start + dur + 0.05);
    });
  } catch (e) {
    console.warn('Offline sound error:', e);
  }
};

export const playCallConnectedSound = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const st = t + i * 0.09;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, st);
      gain.gain.setValueAtTime(0.001, st);
      gain.gain.exponentialRampToValueAtTime(0.2, st + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(st);
      osc.stop(st + 0.4);
    });
  } catch (_) {}
};

export const playCallEndedSound = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const t = ctx.currentTime;
    [440, 330].forEach((freq, i) => {
      const st = t + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, st);
      gain.gain.setValueAtTime(0.001, st);
      gain.gain.exponentialRampToValueAtTime(0.15, st + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(st);
      osc.stop(st + 0.35);
    });
  } catch (_) {}
};
