/* Nexus service worker — Web Push for closed-app notifications. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Nexus";
  const options = {
    body: data.body || "New message",
    icon: data.icon || "/favicon.ico",
    badge: "/favicon.ico",
    // One notification per conversation, re-alerting on each new message.
    tag: data.conversationId || "nexus",
    renotify: Boolean(data.conversationId),
    data: { conversationId: data.conversationId || null }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow("/");
    })()
  );
});
