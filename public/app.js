const $ = (id) => document.getElementById(id);
let csrf,
  user,
  messages = [],
  reply = null,
  file = null,
  editing = null,
  recorder = null,
  chunks = [],
  poll,
  busy = false,
  searchTimer,
  loading = false,
  currentSearch = null;
function toast(text) {
  $("toast").textContent = text;
  $("toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").style.display = "none"), 4500);
}
async function api(url, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData))
    headers["Content-Type"] = "application/json";
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch("/api" + url, {
    ...options,
    headers,
    body:
      options.body instanceof FormData
        ? options.body
        : options.body
          ? JSON.stringify(options.body)
          : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== "/login") showLogin();
    throw Error(data.error || "הבקשה נכשלה");
  }
  return data;
}
function showLogin() {
  clearInterval(poll);
  $("login").hidden = false;
  $("chat").hidden = true;
  user = null;
  messages = [];
  currentSearch = null;
  $("messages").replaceChildren();
  csrf = null;
}
async function enter(data) {
  csrf = data.csrf;
  user = data.user;
  $("login").hidden = true;
  $("chat").hidden = false;
  $("who").textContent = user.name;
  $("admin").hidden = !user.admin;
  await refresh();
  clearInterval(poll);
  poll = setInterval(() => {
    if (!document.hidden && !loading) refresh().catch((e) => toast(e.message));
  }, 10000);
}
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  try {
    const data = await api("/login", {
      method: "POST",
      body: Object.fromEntries(new FormData(e.target)),
    });
    e.target.reset();
    await enter(data);
  } catch (e) {
    $("loginError").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function setReply(m) {
  reply = m;
  $("reply").hidden = false;
  $("replyText").textContent =
    "תגובה ל" + m.name + ": " + (m.body || "הקלטה").slice(0, 120);
  $("body").focus();
}
function clearReply() {
  reply = null;
  $("reply").hidden = true;
}
$("cancelReply").onclick = clearReply;
function renderMessage(m) {
  const card = el("article", "message" + (m.user_id === user.id ? " own" : ""));
  card.id = "message-" + m.id;
  card.dataset.version = m.version;
  card.dataset.transcript = m.transcript || "";
  const meta = el("div", "meta");
  meta.append(
    el("span", "author", m.name),
    el(
      "time",
      "",
      new Date(m.created_at).toLocaleString("he-IL", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    ),
  );
  card.append(meta);
  if (m.parent_id) {
    const quote = el(
      "button",
      "quote",
      "↪ " +
        (m.parent_name || "") +
        ": " +
        (m.parent_body || "הקלטה").slice(0, 140),
    );
    quote.onclick = () => {
      const target = $("message-" + m.parent_id);
      target
        ? target.scrollIntoView({ block: "center", behavior: "smooth" })
        : toast("הודעת המקור קודמת לרשימה. טענו הודעות קודמות.");
    };
    card.append(quote);
  }
  if (m.kind === "text") card.append(el("div", "content", m.body));
  else {
    const audio = el("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = "/api/messages/" + m.id + "/audio";
    card.append(audio);
    const details = el("details");
    details.append(
      el("summary", "", m.transcript ? "תמלול ההקלטה" : "טרם נוסף תמלול"),
      el("p", "content", m.transcript || "ניתן להוסיף תמלול באמצעות עריכה."),
    );
    card.append(details);
  }
  card.append(
    el(
      "span",
      "sync",
      m.synced_version === m.version ? "✓ זמין גם בקו" : "◷ ממתין לסנכרון לקו",
    ),
  );
  const actions = el("div", "actions"),
    answer = el("button", "", "תגובה");
  answer.onclick = () => setReply(m);
  actions.append(answer);
  if (m.user_id === user.id || user.admin) {
    const edit = el("button", "", m.kind === "audio" ? "עריכת תמלול" : "עריכה");
    edit.onclick = () => openEdit(m);
    actions.append(edit);
  }
  card.append(actions);
  return card;
}
async function refresh(older = false) {
  if (loading || !user) return;
  loading = true;
  try {
    const firstLoad = messages.length === 0;
    const nearBottom =
      $("conversation").scrollHeight -
        $("conversation").scrollTop -
        $("conversation").clientHeight <
      150;
    const query = $("search").value.trim();
    const params = new URLSearchParams();
    if ($("search").value.trim())
      params.set("search", $("search").value.trim());
    if (older && messages.length)
      params.set("before", Math.min(...messages.map((m) => m.id)));
    const data = await api("/messages?" + params);
    if (!user) return;
    const map = new Map(
      (older || (!query && currentSearch === query) ? messages : []).map(
        (m) => [m.id, m],
      ),
    );
    currentSearch = query;
    for (const m of data) map.set(m.id, m);
    messages = [...map.values()].sort((a, b) => a.id - b.id);
    const old = new Map([...$("messages").children].map((n) => [n.id, n]));
    let position = 0;
    for (const m of messages) {
      const key = "message-" + m.id;
      let node = old.get(key);
      if (
        !node ||
        Number(node.dataset.version) !== m.version ||
        node.dataset.transcript !== (m.transcript || "") ||
        node.dataset.synced !== String(m.synced_version)
      ) {
        const previous = node;
        node = renderMessage(m);
        node.dataset.synced = m.synced_version;
        if (
          previous?.querySelector("details")?.open &&
          node.querySelector("details")
        )
          node.querySelector("details").open = true;
        if (previous && m.kind === "audio") {
          // Keep the actual audio element mounted while sync/transcription updates.
          previous.querySelector("summary").textContent = node.querySelector("summary").textContent;
          previous.querySelector("details .content").textContent = node.querySelector("details .content").textContent;
          previous.querySelector(".sync").textContent = node.querySelector(".sync").textContent;
          previous.querySelector(".actions").replaceWith(node.querySelector(".actions"));
          Object.assign(previous.dataset, node.dataset);
          node = previous;
        } else {
          previous ? previous.replaceWith(node) : $("messages").append(node);
        }
      }
      if ($("messages").children[position] !== node)
        $("messages").insertBefore(
          node,
          $("messages").children[position] || null,
        );
      position++;
      old.delete(key);
    }
    for (const node of old.values()) node.remove();
    $("empty").hidden = messages.length > 0;
    $("older").hidden = data.length < 50;
    $("read").textContent = messages.some((m) => m.id > user.last_read)
      ? "סימון כנקרא ✓"
      : "הכול נקרא ✓";
    if (!older && (nearBottom || firstLoad)) {
      $("conversation").scrollTop = $("conversation").scrollHeight;
    }
  } finally {
    loading = false;
  }
}
$("older").onclick = () => refresh(true).catch((e) => toast(e.message));
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh().catch((e) => toast(e.message)), 350);
};
async function openEdit(m) {
  editing = m;
  $("editBody").value = m.kind === "audio" ? m.transcript || "" : m.body;
  $("versions").textContent = "";
  $("editDialog").showModal();
  try {
    const versions = await api("/messages/" + m.id + "/versions");
    if (editing === m)
      $("versions").textContent = versions
        .map((v) => "גרסה " + v.version + " · " + (v.transcript || v.body))
        .join("\n\n");
  } catch (e) {
    toast(e.message);
  }
}
$("closeEdit").onclick = () => $("editDialog").close();
$("editForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/messages/" + editing.id, {
      method: "PATCH",
      body: {
        version: editing.version,
        ...(editing.kind === "audio"
          ? { transcript: $("editBody").value }
          : { body: $("editBody").value }),
      },
    });
    $("editDialog").close();
    await refresh();
    toast("השינויים נשמרו");
  } catch (e) {
    toast(e.message);
  }
};
function selectFile(value) {
  file = value;
  $("fileLabel").textContent = value ? value.name || "הקלטה חדשה" : "";
  $("clearAudio").hidden = !value;
}
$("audio").onchange = (e) => {
  const f = e.target.files[0];
  if (f?.size > 12 * 1024 * 1024) {
    toast("מותר לצרף עד 12MB");
    e.target.value = "";
    return;
  }
  selectFile(f);
};
$("clearAudio").onclick = () => {
  selectFile(null);
  $("audio").value = "";
};
$("record").onclick = async () => {
  if (recorder?.state === "recording") {
    recorder.stop();
    $("record").disabled = true;
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast("הקלטה דורשת HTTPS ודפדפן תומך. אפשר לצרף קובץ שמע.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      clearTimeout(recorder.timer);
      const blob = new Blob(chunks, { type: recorder.mimeType });
      stream.getTracks().forEach((t) => t.stop());
      selectFile(new File([blob], "recording.webm", { type: blob.type }));
      $("record").textContent = "◉ הקלטה";
      $("record").disabled = false;
    };
    recorder.onerror = () => {
      stream.getTracks().forEach((t) => t.stop());
      toast("ההקלטה נכשלה");
    };
    recorder.start();
    recorder.timer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 180000);
    $("record").textContent = "■ סיום הקלטה";
  } catch {
    toast("לא התקבלה גישה למיקרופון");
  }
};
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  if (busy) return;
  if (recorder?.state === "recording") {
    toast("סיימו את ההקלטה לפני השליחה");
    return;
  }
  if (!file && !$("body").value.trim()) return;
  if (file && $("body").value.trim()) {
    toast("שלחו את הטקסט ואת ההקלטה כהודעות נפרדות");
    return;
  }
  busy = true;
  e.submitter.disabled = true;
  try {
    if (file) {
      const form = new FormData();
      form.append("audio", file);
      if (reply) form.append("parentId", reply.id);
      await api("/audio", { method: "POST", body: form });
    } else
      await api("/messages", {
        method: "POST",
        body: { body: $("body").value, parentId: reply?.id },
      });
    $("body").value = "";
    selectFile(null);
    $("audio").value = "";
    clearReply();
    await refresh();
    $("conversation").scrollTop = $("conversation").scrollHeight;
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
    e.submitter.disabled = false;
  }
};
$("read").onclick = async () => {
  try {
    const id = Math.max(0, ...messages.map((m) => m.id));
    await api("/read", { method: "POST", body: { id } });
    user.last_read = id;
    await refresh();
  } catch (e) {
    toast(e.message);
  }
};
$("push").onclick = async () => {
  try {
    const { pushKey } = await api("/config");
    if (!pushKey) throw Error("התראות פוש עדיין לא הוגדרו על ידי המנהל");
    if (!("serviceWorker" in navigator) || !("PushManager" in window))
      throw Error("הדפדפן אינו תומך בפוש");
    if ((await Notification.requestPermission()) !== "granted")
      throw Error("לא התקבל אישור להתראות");
    const registration = await navigator.serviceWorker.ready;
    const bytes = Uint8Array.from(
      atob(pushKey.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const sub =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      }));
    await api("/push", { method: "POST", body: sub.toJSON() });
    toast("ההתראות הופעלו");
  } catch (e) {
    toast(e.message);
  }
};
$("logout").onclick = async () => {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api("/push", {
        method: "DELETE",
        body: { endpoint: sub.endpoint },
      }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch {}
  try {
    await api("/logout", { method: "POST" });
    showLogin();
  } catch (e) {
    toast(e.message);
  }
};
$("mobileLogout").onclick = () => $("logout").click();
$("admin").onclick = async () => {
  try {
    const data = await api("/admin");
    const panel = $("adminPanel");
    panel.hidden = !panel.hidden;
    panel.replaceChildren(el("h3", "", "מצב המערכת"));
    for (const u of data.users)
      panel.append(
        el(
          "p",
          "",
          u.name +
            " · " +
            (u.active ? "פעיל" : "מושבת") +
            (u.admin ? " · מנהל" : ""),
        ),
      );
    panel.append(el("h3", "", "משימות רקע"));
    for (const j of data.jobs)
      panel.append(el("p", "", j.type + " · " + j.state + " · " + j.count));
  } catch (e) {
    toast(e.message);
  }
};
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
api("/me")
  .then(enter)
  .catch(() => showLogin());
