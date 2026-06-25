// Lightweight notification sounds (Web Audio, no asset files) + browser
// notifications so messages/calls are noticed when the tab is in the background.

let ctx: AudioContext | null = null;
function audio() {
  if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return ctx;
}

// Browsers start the AudioContext suspended until a user gesture. Unlock it on
// the first interaction so notification/call sounds actually play afterwards.
let unlocked = false;
export function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  const resume = () => {
    void audio().resume();
    window.removeEventListener("pointerdown", resume);
    window.removeEventListener("keydown", resume);
    window.removeEventListener("touchstart", resume);
  };
  window.addEventListener("pointerdown", resume);
  window.addEventListener("keydown", resume);
  window.addEventListener("touchstart", resume);
}

function tone(freq: number, start: number, duration: number, gain = 0.08) {
  const ac = audio();
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  vol.gain.setValueAtTime(0, ac.currentTime + start);
  vol.gain.linearRampToValueAtTime(gain, ac.currentTime + start + 0.02);
  vol.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + duration);
  osc.connect(vol).connect(ac.destination);
  osc.start(ac.currentTime + start);
  osc.stop(ac.currentTime + start + duration);
}

export type SoundKind = "message" | "sent" | "ring" | "incoming";

export function playSound(kind: SoundKind) {
  try {
    if (audio().state === "suspended") void audio().resume();
    if (kind === "message") {
      tone(660, 0, 0.18);
      tone(880, 0.1, 0.2);
    } else if (kind === "sent") {
      tone(720, 0, 0.1, 0.04);
    } else if (kind === "ring" || kind === "incoming") {
      tone(520, 0, 0.4, 0.06);
      tone(660, 0.25, 0.5, 0.06);
    }
  } catch {
    /* audio not available */
  }
}

// Looping ring tones for calls. "incoming" = the callee's ringer; "outgoing" =
// the caller's ringback. Returns a stop function.
export function startRinging(kind: "incoming" | "outgoing") {
  let stopped = false;
  void audio().resume();
  const pattern = () => {
    if (stopped) return;
    if (kind === "incoming") {
      tone(660, 0, 0.45, 0.09);
      tone(550, 0.5, 0.45, 0.09);
    } else {
      tone(440, 0, 0.6, 0.05);
    }
  };
  pattern();
  const handle = window.setInterval(pattern, kind === "incoming" ? 2200 : 3200);
  return () => {
    stopped = true;
    window.clearInterval(handle);
  };
}

export function ensureNotificationPermission() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") void Notification.requestPermission();
}

export function showNotification(
  title: string,
  body: string,
  options: { icon?: string; tag?: string; onClick?: () => void } = {}
) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden) return; // only notify when the tab isn't focused
  try {
    const n = new Notification(title, {
      body,
      icon: options.icon || "/favicon.ico",
      badge: "/favicon.ico",
      // Per-conversation tag so a new message replaces the previous one for that
      // chat (like a messenger) instead of stacking; renotify re-alerts.
      tag: options.tag ?? "nexus",
      renotify: Boolean(options.tag)
    } as NotificationOptions);
    n.onclick = () => {
      window.focus();
      options.onClick?.();
      n.close();
    };
  } catch {
    /* ignore */
  }
}
