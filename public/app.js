import { createConversationView } from "./conversation-view.js";

const $ = (id) => document.getElementById(id);
const conversationView = createConversationView({
  list: $("messages"),
  scroller: $("conversation"),
  empty: $("empty"),
  olderButton: $("older"),
  onReply: setReply,
  onEdit: openEdit,
  onMissingParent: () => toast("הודעת המקור קודמת לרשימה. טענו הודעות קודמות."),
});
let csrf,
  user,
  messages = [],
  reply = null,
  file = null,
  editing = null,
  recorder = null,
  poll,
  busy = false,
  searchTimer,
  scheduleMessageRefresh = null,
  currentSearch = null,
  sessionId = 0;
const requests = new Set();
function invalidateSession() {
  sessionId++;
  scheduleMessageRefresh = null;
  for (const controller of requests) controller.abort();
  requests.clear();
}
function checkSession(id) {
  if (id !== sessionId) throw new DOMException("Session changed", "AbortError");
}
function reportError(error) {
  if (error.name !== "AbortError") toast(error.message);
}
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
  const session = sessionId;
  const controller = new AbortController();
  requests.add(controller);
  try {
    const res = await fetch("/api" + url, {
      ...options,
      signal: controller.signal,
      headers,
      body:
        options.body instanceof FormData
          ? options.body
          : options.body
            ? JSON.stringify(options.body)
            : undefined,
    });
    const data = await res.json().catch(() => ({}));
    checkSession(session);
    if (!res.ok) {
      if (res.status === 401 && url !== "/login") {
        showLogin();
        checkSession(session);
      }
      throw Error(data.error || "הבקשה נכשלה");
    }
    return data;
  } catch (error) {
    checkSession(session);
    throw error;
  } finally {
    requests.delete(controller);
  }
}
function showLogin() {
  invalidateSession();
  clearInterval(poll);
  clearTimeout(searchTimer);
  clearTimeout(toast.timer);
  const active = recorder;
  recorder = null;
  if (active) {
    clearTimeout(active.timer);
    if (active.state !== "inactive") active.stop();
    active.stream.getTracks().forEach((track) => track.stop());
  }
  $("composer").reset();
  $("loginForm").reset();
  $("loginForm").querySelector("button[type=submit]").disabled = false;
  $("editForm").reset();
  $("editDialog").close();
  editing = null;
  clearReply();
  $("replyText").textContent = "";
  selectFile(null);
  $("versions").textContent = "";
  $("adminPanel").replaceChildren();
  $("adminPanel").hidden = true;
  $("admin").hidden = true;
  $("who").textContent = "";
  $("search").value = "";
  $("loginError").textContent = "";
  $("toast").textContent = "";
  $("toast").style.display = "none";
  $("record").textContent = "◉ הקלטה";
  $("record").disabled = false;
  $("composer").querySelector("[type=submit]").disabled = false;
  busy = false;
  $("login").hidden = false;
  $("chat").hidden = true;
  user = null;
  messages = [];
  currentSearch = null;
  conversationView.clear();
  csrf = null;
}
async function enter(data) {
  invalidateSession();
  const session = sessionId;
  scheduleMessageRefresh = createMessageRefresh(session);
  csrf = data.csrf;
  user = data.user;
  $("login").hidden = true;
  $("chat").hidden = false;
  $("who").textContent = user.name;
  $("admin").hidden = !user.admin;
  await refresh();
  checkSession(session);
  clearInterval(poll);
  poll = setInterval(() => {
    if (!document.hidden) refresh({ poll: true }).catch(reportError);
  }, 10000);
}
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.submitter;
  let session = sessionId;
  button.disabled = true;
  try {
    const data = await api("/login", {
      method: "POST",
      body: Object.fromEntries(new FormData(e.target)),
    });
    e.target.reset();
    const entering = enter(data);
    session = sessionId;
    await entering;
  } catch (e) {
    if (e.name !== "AbortError") $("loginError").textContent = e.message;
  } finally {
    if (session === sessionId) button.disabled = false;
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
function refresh(options) {
  return scheduleMessageRefresh?.(options) ?? Promise.resolve();
}
const searchQuery = () => $("search").value.trim();
function createMessageRefresh(session) {
  let tail = Promise.resolve();
  let running = false;
  const queued = new Map();

  async function loadMessages(query, older) {
    const sameSearch = currentSearch === query;
    const oldest = messages.length ? Math.min(...messages.map((m) => m.id)) : null;
    const params = new URLSearchParams();
    if (query) params.set("search", query);
    if (older) params.set("before", oldest);
    const stillRelevant = () => {
      checkSession(session);
      return query === searchQuery();
    };
    let page = await api("/messages?" + params);
    if (!stillRelevant()) return;
    const data = [...page];
    // Refresh every loaded page, including search history, using the existing cursor.
    while (!older && sameSearch && oldest && page.length === 50 && page.at(-1).id > oldest) {
      params.set("before", page.at(-1).id);
      page = await api("/messages?" + params);
      if (!stillRelevant()) return;
      data.push(...page);
    }
    const map = new Map(
      (older && sameSearch ? messages : []).map(
        (m) => [m.id, m],
      ),
    );
    currentSearch = query;
    for (const m of data)
      if (older || !sameSearch || !oldest || m.id >= oldest) map.set(m.id, m);
    messages = [...map.values()].sort((a, b) => a.id - b.id);
    const hasMore = page.length >= 50 ||
      (!older && sameSearch && oldest && data.some((m) => m.id < oldest));
    conversationView.render(messages, user, { older, hasMore });
    const readLabel = messages.some((m) => m.id > user.last_read)
      ? "סימון כנקרא ✓"
      : "הכול נקרא ✓";
    if ($("read").textContent !== readLabel) $("read").textContent = readLabel;
  }

  return function schedule({ older = false, poll = false } = {}) {
    if (poll && (running || queued.size)) return Promise.resolve();
    const query = searchQuery();
    // A cursor only belongs to the search currently displayed.
    const loadOlder = older && currentSearch === query && messages.length > 0;
    const pending = queued.get(loadOlder);
    if (pending) {
      pending.query = query;
      return pending.done;
    }
    const request = { query, done: null };
    request.done = tail.then(async () => {
      queued.delete(loadOlder);
      checkSession(session);
      if (request.query !== searchQuery()) return;
      running = true;
      try {
        await loadMessages(request.query, loadOlder && currentSearch === request.query);
      } finally {
        running = false;
      }
    });
    queued.set(loadOlder, request);
    // A failed request must not prevent later refreshes.
    tail = request.done.catch(() => {});
    return request.done;
  };
}
$("older").onclick = () => refresh({ older: true }).catch(reportError);
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh().catch((e) => reportError(e)), 350);
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
    reportError(e);
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
    reportError(e);
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
  const session = sessionId;
  let stream;
  $("record").disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (session !== sessionId || !user) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const chunks = [];
    const active = new MediaRecorder(stream);
    recorder = active;
    const isCurrent = () => session === sessionId && recorder === active;
    active.ondataavailable = (e) => {
      if (isCurrent() && e.data.size) chunks.push(e.data);
    };
    active.onstop = () => {
      clearTimeout(active.timer);
      stream.getTracks().forEach((track) => track.stop());
      if (!isCurrent()) return;
      const blob = new Blob(chunks, { type: active.mimeType });
      recorder = null;
      selectFile(new File([blob], "recording.webm", { type: blob.type }));
      $("record").textContent = "◉ הקלטה";
      $("record").disabled = false;
    };
    active.onerror = () => {
      clearTimeout(active.timer);
      stream.getTracks().forEach((track) => track.stop());
      if (!isCurrent()) return;
      recorder = null;
      $("record").textContent = "◉ הקלטה";
      $("record").disabled = false;
      toast("ההקלטה נכשלה");
    };
    active.start();
    active.timer = setTimeout(() => {
      if (isCurrent() && active.state === "recording") active.stop();
    }, 180000);
    $("record").textContent = "■ סיום הקלטה";
    $("record").disabled = false;
  } catch {
    stream?.getTracks().forEach((track) => track.stop());
    if (session === sessionId) {
      recorder = null;
      $("record").disabled = false;
      toast("לא התקבלה גישה למיקרופון");
    }
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
  const session = sessionId;
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
    reportError(e);
  } finally {
    if (session === sessionId) {
      busy = false;
      e.submitter.disabled = false;
    }
  }
};
$("read").onclick = async () => {
  try {
    const id = Math.max(0, ...messages.map((m) => m.id));
    await api("/read", { method: "POST", body: { id } });
    user.last_read = id;
    await refresh();
  } catch (e) {
    reportError(e);
  }
};
$("push").onclick = async () => {
  const session = sessionId;
  try {
    const { pushKey } = await api("/config");
    if (!pushKey) throw Error("התראות פוש עדיין לא הוגדרו על ידי המנהל");
    if (!("serviceWorker" in navigator) || !("PushManager" in window))
      throw Error("הדפדפן אינו תומך בפוש");
    if ((await Notification.requestPermission()) !== "granted")
      throw Error("לא התקבל אישור להתראות");
    checkSession(session);
    const registration = await navigator.serviceWorker.ready;
    checkSession(session);
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
    checkSession(session);
    await api("/push", { method: "POST", body: sub.toJSON() });
    toast("ההתראות הופעלו");
  } catch (e) {
    reportError(e);
  }
};
$("logout").onclick = async () => {
  const headers = { "X-CSRF-Token": csrf };
  showLogin();
  // Finish invalidating the cookie before allowing another account to log in.
  const button = $("loginForm").querySelector("button[type=submit]");
  button.disabled = true;
  try {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push", {
          method: "DELETE",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
    } catch {}
    const res = await fetch("/api/logout", { method: "POST", headers });
    if (!res.ok && res.status !== 401) throw Error("היציאה נכשלה. נסו שוב");
  } catch (e) {
    reportError(e);
  } finally {
    button.disabled = false;
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
    reportError(e);
  }
};
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
api("/me")
  .then(enter)
  .catch((e) => { if (e.name !== "AbortError") showLogin(); });
