const messageDate = new Intl.DateTimeFormat("he-IL", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const messageFields = [
  "id", "user_id", "kind", "name", "created_at", "body", "parent_id",
  "parent_name", "parent_body", "transcript", "version", "synced_version",
];

function sameMessage(a, b) {
  return messageFields.every((field) => a[field] === b[field]);
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

export function createConversationView({
  list, scroller, empty, olderButton, onReply, onEdit, onMissingParent,
}) {
  const document = list.ownerDocument;
  const cards = new Map();
  let previous = [], previousViewer;

  function element(tag, className = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function createCard(message) {
    const card = element("article", "message");
    card.id = "message-" + message.id;
    const meta = element("div", "meta");
    const author = element("span", "author");
    const date = element("time");
    meta.append(author, date);
    card.append(meta);

    const content = element(message.kind === "text" ? "div" : "p", "content");
    let audio, summary;
    if (message.kind === "text") {
      card.append(content);
    } else {
      audio = element("audio");
      audio.controls = true;
      audio.preload = "none";
      audio.src = "/api/messages/" + message.id + "/audio";
      summary = element("summary");
      const details = element("details");
      details.append(summary, content);
      card.append(audio, details);
    }
    const sync = element("span", "sync");
    const actions = element("div", "actions");
    const reply = element("button");
    reply.textContent = "תגובה";
    actions.append(reply);
    card.append(sync, actions);
    const entry = { card, author, date, content, audio, summary, sync, actions };
    reply.onclick = () => onReply(entry.message);
    return entry;
  }

  function updateCard(entry, message, viewer) {
    if (entry.message?.created_at !== message.created_at)
      setText(entry.date, messageDate.format(new Date(message.created_at)));
    entry.message = message;
    entry.card.classList.toggle("own", message.user_id === viewer.id);
    setText(entry.author, message.name);
    if (message.parent_id) {
      if (!entry.quote) {
        entry.quote = element("button", "quote");
        entry.card.insertBefore(entry.quote, entry.card.children[1]);
        entry.quote.onclick = () => {
          const parent = cards.get(entry.message.parent_id);
          if (parent) parent.card.scrollIntoView({ block: "center", behavior: "smooth" });
          else onMissingParent();
        };
      }
      setText(entry.quote,
        "↪ " + (message.parent_name || "") + ": " + (message.parent_body || "הקלטה").slice(0, 140),
      );
    } else if (entry.quote) {
      entry.quote.remove();
      entry.quote = null;
    }
    if (entry.summary) {
      setText(entry.summary, message.transcript ? "תמלול ההקלטה" : "טרם נוסף תמלול");
      setText(entry.content, message.transcript || "ניתן להוסיף תמלול באמצעות עריכה.");
    } else {
      setText(entry.content, message.body);
    }
    setText(entry.sync, message.synced_version === message.version
      ? "✓ זמין גם בקו"
      : "◷ ממתין לסנכרון לקו",
    );
    const canEdit = message.user_id === viewer.id || viewer.admin;
    if (canEdit && !entry.edit) {
      entry.edit = element("button");
      entry.edit.textContent = message.kind === "audio" ? "עריכת תמלול" : "עריכה";
      entry.edit.onclick = () => onEdit(entry.message);
      entry.actions.append(entry.edit);
    } else if (!canEdit && entry.edit) {
      entry.edit.remove();
      entry.edit = null;
    }
    const attributes = {
      version: String(message.version),
      transcript: message.transcript || "",
      synced: String(message.synced_version),
    };
    for (const [name, value] of Object.entries(attributes))
      if (entry.card.dataset[name] !== value) entry.card.dataset[name] = value;
  }

  function reconcile(messages, viewer, viewerChanged) {
    const ids = new Set(messages.map((message) => message.id));
    for (const [id, entry] of cards) {
      if (ids.has(id)) continue;
      entry.card.remove();
      cards.delete(id);
    }
    let position = list.firstElementChild;
    for (const message of messages) {
      let entry = cards.get(message.id);
      if (entry?.message.kind !== message.kind) {
        const replacement = createCard(message);
        if (entry?.card === position) position = position.nextElementSibling;
        entry?.card.remove();
        entry = replacement;
        cards.set(message.id, entry);
      }
      if (!entry.message || viewerChanged || !sameMessage(entry.message, message))
        updateCard(entry, message, viewer);
      if (entry.card !== position) list.insertBefore(entry.card, position);
      position = entry.card.nextElementSibling;
    }
  }

  function firstVisibleCard() {
    const top = scroller.getBoundingClientRect().top;
    for (const node of list.children) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > top) return { node, top: rect.top };
    }
    return null;
  }

  return {
    render(messages, viewer, { older, hasMore }) {
      const viewerChanged = previousViewer?.id !== viewer.id || previousViewer?.admin !== viewer.admin;
      const cardsChanged = viewerChanged || previous.length !== messages.length ||
        messages.some((message, index) => !sameMessage(previous[index], message));
      const hideOlder = !hasMore, hideEmpty = messages.length > 0;
      if (!cardsChanged && olderButton.hidden === hideOlder && empty.hidden === hideEmpty) return;

      const followEnd = !older && (!previous.length ||
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 150);
      const anchor = followEnd ? null : firstVisibleCard();
      if (cardsChanged) reconcile(messages, viewer, viewerChanged);
      if (olderButton.hidden !== hideOlder) olderButton.hidden = hideOlder;
      if (empty.hidden !== hideEmpty) empty.hidden = hideEmpty;
      previous = messages;
      previousViewer = { id: viewer.id, admin: viewer.admin };

      if (followEnd) {
        scroller.scrollTop = scroller.scrollHeight;
      } else if (anchor && list.contains(anchor.node)) {
        const delta = anchor.node.getBoundingClientRect().top - anchor.top;
        if (delta) scroller.scrollTop += delta;
      }
    },
    clear() {
      for (const { audio } of cards.values()) {
        if (!audio) continue;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      list.replaceChildren();
      cards.clear();
      previous = [];
      previousViewer = undefined;
    },
  };
}
