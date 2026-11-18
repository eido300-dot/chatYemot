const $ = (id) => document.getElementById(id);
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
  loading = false,
  currentSearch = null,
  sessionId = 0;
const requests = new Set();
function invalidateSession() {
  sessionId++;
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
  for (const audio of $("messages").querySelectorAll("audio")) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
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
  loading = false;
  $("login").hidden = false;
  $("chat").hidden = true;
  user = null;
  messages = [];
  currentSearch = null;
  $("messages").replaceChildren();
  csrf = null;
}
async function enter(data) {
  invalidateSession();
  csrf = data.csrf;
  user = data.user;
  $("login").hidden = true;
  $("chat").hidden = false;
  $("who").textContent = user.name;
  $("admin").hidden = !user.admin;
  await refresh();
  applyPendingReply();
  // Re-register this device after login if notifications were already allowed.
  subscribePush(sessionId, false).catch(() => {});
  clearInterval(poll);
  poll = setInterval(() => {
    if (!document.hidden && !loading) refresh().catch((e) => reportError(e));
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
let pendingReply = new URLSearchParams(location.search).get("reply");
if (pendingReply) history.replaceState(null, "", "/");
async function applyPendingReply() {
  const id = pendingReply;
  pendingReply = null;
  if (!id || !user) return;
  let m = messages.find((x) => String(x.id) === String(id));
  if (!m) {
    try {
      m = (await api("/messages?before=" + (Number(id) + 1))).find(
        (x) => String(x.id) === String(id),
      );
    } catch (e) {
      return reportError(e);
    }
  }
  if (m) setReply(m);
}
if ("serviceWorker" in navigator)
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "reply-to") {
      pendingReply = e.data.id;
      applyPendingReply();
    }
  });
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
  const session = sessionId;
  try {
    const firstLoad = messages.length === 0;
    const nearBottom =
      $("conversation").scrollHeight -
        $("conversation").scrollTop -
        $("conversation").clientHeight <
      150;
    const query = $("search").value.trim();
    const sameSearch = currentSearch === query;
    const oldest = messages.length ? Math.min(...messages.map((m) => m.id)) : null;
    const scroller = $("conversation");
    const anchor = [...$("messages").children].find(
      (node) => node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top,
    );
    const anchorTop = anchor?.getBoundingClientRect().top;
    const params = new URLSearchParams();
    if ($("search").value.trim())
      params.set("search", $("search").value.trim());
    if (older && messages.length)
      params.set("before", Math.min(...messages.map((m) => m.id)));
    let page = await api("/messages?" + params);
    const data = [...page];
    // Refresh every loaded page, including search history, using the existing cursor.
    while (!older && sameSearch && oldest && page.length === 50 && page.at(-1).id > oldest) {
      params.set("before", page.at(-1).id);
      page = await api("/messages?" + params);
      data.push(...page);
    }
    if (!user) return;
    const map = new Map(
      (older && sameSearch ? messages : []).map(
        (m) => [m.id, m],
      ),
    );
    currentSearch = query;
    for (const m of data)
      if (older || !sameSearch || !oldest || m.id >= oldest) map.set(m.id, m);
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
    if (older || !sameSearch || !oldest)
      $("older").hidden = page.length < 50;
    else
      $("older").hidden = page.length < 50 && !data.some((m) => m.id < oldest);
    $("read").textContent = messages.some((m) => m.id > user.last_read)
      ? "סימון כנקרא ✓"
      : "הכול נקרא ✓";
    if (!older && (nearBottom || firstLoad)) {
      $("conversation").scrollTop = $("conversation").scrollHeight;
    } else if (anchor && $(anchor.id)) {
      scroller.scrollTop += $(anchor.id).getBoundingClientRect().top - anchorTop;
    }
  } finally {
    if (session === sessionId) loading = false;
  }
}
$("older").onclick = () => refresh(true).catch((e) => reportError(e));
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
async function subscribePush(session, interactive) {
  const { pushKey } = await api("/config");
  if (!pushKey) {
    if (interactive) throw Error("התראות פוש עדיין לא הוגדרו על ידי המנהל");
    return false;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (interactive) throw Error("הדפדפן אינו תומך בפוש");
    return false;
  }
  if (interactive && (await Notification.requestPermission()) !== "granted")
    throw Error("לא התקבל אישור להתראות");
  if (Notification.permission !== "granted") return false;
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
  return true;
}
$("push").onclick = async () => {
  try {
    if (await subscribePush(sessionId, true)) toast("ההתראות הופעלו");
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
