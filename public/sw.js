self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch {}
  const options = {
    body: data.body || "הודעה חדשה בקבוצה",
    icon: "/icon.svg",
    tag: "message-" + (data.id || "new"),
    data: { id: data.id || null },
  };
  if (data.reply && data.id)
    options.actions = [
      {
        action: "reply",
        type: "text",
        title: "השב",
        placeholder: "הקלידו תגובה…",
      },
    ];
  event.waitUntil(
    self.registration.showNotification(data.title || "ChatYemot", options),
  );
});
async function sendReply(id, text) {
  const me = await fetch("/api/me", { credentials: "same-origin" });
  if (!me.ok) throw Error("auth");
  const { csrf } = await me.json();
  const res = await fetch("/api/messages", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ body: text, parentId: id }),
  });
  if (!res.ok) throw Error("send");
}
async function openApp(id) {
  const list = await clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  if (list.length) {
    const client = await list[0].focus();
    if (id) client.postMessage({ type: "reply-to", id });
    return;
  }
  await clients.openWindow(id ? "/?reply=" + encodeURIComponent(id) : "/");
}
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  const text = (event.reply || "").trim();
  if (event.action === "reply" && text && id) {
    event.waitUntil(
      sendReply(id, text).catch(() =>
        self.registration
          .showNotification("התגובה לא נשלחה", {
            body: "פתחו את האפליקציה ונסו שוב",
            icon: "/icon.svg",
            tag: "reply-failed",
          })
          .then(() => undefined),
      ),
    );
    return;
  }
  event.waitUntil(openApp(event.action === "reply" ? id : null));
});
