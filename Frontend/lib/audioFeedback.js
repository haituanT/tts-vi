let errorAudioContext = null;
let lastErrorSoundAt = 0;

function getErrorAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!errorAudioContext || errorAudioContext.state === 'closed') {
    errorAudioContext = new AudioContextClass();
  }
  return errorAudioContext;
}

function primeErrorSound() {
  const audioContext = getErrorAudioContext();
  if (!audioContext) return null;
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}

export function playErrorSound() {
  const audioContext = primeErrorSound();
  if (!audioContext) return;

  const nowMs = Date.now();
  if (nowMs - lastErrorSoundAt < 600) return;
  lastErrorSoundAt = nowMs;

  const play = () => {
    const startAt = audioContext.currentTime + 0.03;
    [
      { frequency: 392, offset: 0, duration: 0.16 },
      { frequency: 247, offset: 0.16, duration: 0.24 },
    ].forEach((note) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const noteStart = startAt + note.offset;
      const noteEnd = noteStart + note.duration;
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.14, noteStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd + 0.05);
    });
  };

  if (audioContext.state === 'suspended') {
    audioContext.resume().then(play).catch(() => {});
  } else {
    play();
  }
}
