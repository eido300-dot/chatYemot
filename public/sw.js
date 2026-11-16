self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || "ChatYemot", {
      body: data.body || "הודעה חדשה בקבוצה",
      icon: "/icon.svg",
      tag: "message-" + (data.id || "new"),
      data: { url: "/" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) =>
        list.length ? list[0].focus() : clients.openWindow("/"),
      ),
  );
});
