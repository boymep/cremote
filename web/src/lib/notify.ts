let ctx: AudioContext | null = null;

/** Разблокировать звук: iOS разрешает AudioContext только после жеста пользователя. */
export function unlockAudio() {
  if (ctx) return;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) ctx = new AC();
  } catch {
    ctx = null;
  }
}

function beep() {
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const start = t + i * 0.14;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.13);
    }
  } catch {
    /* звук не критичен */
  }
}

export function alertNewPending() {
  try {
    navigator.vibrate?.([120, 60, 120]);
  } catch {
    /* не все браузеры */
  }
  beep();
}
