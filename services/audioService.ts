// Simple synthesizer using Web Audio API to avoid external asset dependencies
const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
let audioCtx: AudioContext | null = null;

const getContext = () => {
  if (!audioCtx) {
    audioCtx = new AudioContextClass();
  }
  return audioCtx;
};

export const playSuccessSound = () => {
  try {
    const ctx = getContext();
    if (ctx.state === 'suspended') ctx.resume();

    const t = ctx.currentTime;
    
    // First Note (High) - "Ding"
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(800, t); 
    gain1.gain.setValueAtTime(0.1, t);
    gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(t);
    osc1.stop(t + 0.6);

    // Second Note (Lower) - "Dong"
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(600, t + 0.2); 
    gain2.gain.setValueAtTime(0.1, t + 0.2);
    gain2.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(t + 0.2);
    osc2.stop(t + 1.2);

  } catch (e) {
    console.error("Audio playback failed", e);
  }
};

export const playErrorSound = () => {
  try {
    const ctx = getContext();
    if (ctx.state === 'suspended') ctx.resume();

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(150, ctx.currentTime);
    oscillator.frequency.linearRampToValueAtTime(80, ctx.currentTime + 0.3);

    gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.3);
  } catch (e) {
    console.error("Audio playback failed", e);
  }
};

export const speakMessage = (text: string) => {
  if (!window.speechSynthesis) return;
  
  // Cancel previous speech to avoid queueing
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ko-KR'; // Korean
  utterance.rate = 1.2; // Slightly faster
  utterance.pitch = 1.0;
  
  window.speechSynthesis.speak(utterance);
};
