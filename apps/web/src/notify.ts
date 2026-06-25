// Lightweight notification sounds (Web Audio, no asset files) + browser
// notifications so messages/calls are noticed when the tab is in the background.

let ctx: AudioContext | null = null;
function audio() {
  if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return ctx;
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

export function ensureNotificationPermission() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") void Notification.requestPermission();
}

export function showNotification(title: string, body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden) return; // only notify when the tab isn't focused
  try {
    const n = new Notification(title, { body, icon: "/favicon.svg", tag: "nexus" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* ignore */
  }
}
