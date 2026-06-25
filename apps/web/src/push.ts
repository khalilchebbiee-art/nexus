// Web Push registration: registers the service worker, subscribes the device
// with the server's VAPID key, and hands the subscription to the API so the
// backend can notify this device when the app is closed.

import { api } from "./api";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export async function registerPush(token: string): Promise<void> {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") return;

    // Skip entirely if the server hasn't configured push (no VAPID key).
    const { key } = await api.pushPublicKey();
    if (!key) return;

    const registration = await navigator.serviceWorker.register("/sw.js");

    if (Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;
    }
    if (Notification.permission !== "granted") return;

    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
      }));

    await api.pushSubscribe(token, subscription.toJSON());
  } catch (error) {
    // Push is a progressive enhancement — never let it break the app.
    console.warn("Push registration skipped:", error);
  }
}
