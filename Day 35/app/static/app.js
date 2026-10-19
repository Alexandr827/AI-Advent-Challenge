const state = { sessionId: null, sectionId: null, polling: null, localBusy: false, profileId: "" };

const gate = document.querySelector("#gate");
const work = document.querySelector("#work");
const composer = document.querySelector("#composer");
const statusEl = document.querySelector("#status");
const chatStatusEl = document.querySelector("#chat-status");

function paintUsage(usage) {
  const line = document.querySelector("#token-status");
  if (!line) return;
  if (!usage) {
    line.textContent = "";
    return;
  }
  line.textContent = `Токены: этап ${usage.stage}, история ${usage.history}, ответ ${usage.reply}`;
}

function paintStatus(text, thinking) {
  if (thinking !== undefined) statusEl.classList.toggle("thinking", thinking);
  statusEl.textContent = text;
  if (!chatStatusEl) return;
  chatStatusEl.textContent = text;
  if (thinking !== undefined) chatStatusEl.classList.toggle("thinking", thinking);
}

function scrollThread() {
  const thread = document.querySelector(".thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function profileSelects() {
  return [document.querySelector("#profile-select"), document.querySelector("#menu-profile")];
}

function sessionFromLocation() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(location.search);
  if (query.get("profile") && !hash.get("s")) return null;
  if (hash.get("s")) return hash.get("s");
  const cookie = document.cookie.split("; ").find((row) => row.startsWith("session_id="));
  return cookie ? cookie.split("=")[1] : null;
}

function profileFromLocation() {
  return new URLSearchParams(location.search).get("profile") || "";
}

function rememberProfile(id) {
  state.profileId = id || "";
  for (const select of profileSelects()) {
    if ([...select.options].some((option) => option.value === state.profileId)) {
      select.value = state.profileId;
    }
  }
  const selected = document.querySelector("#profile-select").selectedOptions[0];
  document.querySelector("#writing-note").value = selected?.dataset.note || "";
  document.querySelector("#clear-session").disabled = !state.sessionId;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = await response.json();
      detail = payload.detail || detail;
    } catch (_error) {
      /* ignore */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) return response.json();
  return response;
}

function setSession(id) {
  state.sessionId = id;
  location.hash = `s=${id}`;
  gate.hidden = true;
  work.hidden = false;
  composer.hidden = false;
  document.querySelector("#download").href = `/api/sessions/${id}/markdown`;
  document.querySelector("#clear-session").disabled = false;
}

function leaveSession(profileId) {
  clearTimeout(state.polling);
  state.sessionId = null;
  state.sectionId = null;
  state.localBusy = false;
  document.cookie = "session_id=; Max-Age=0; path=/; SameSite=Lax";
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  if (profileId) url.searchParams.set("profile", profileId);
  history.replaceState(null, "", `${url.pathname}${url.search}`);
  gate.hidden = false;
  work.hidden = true;
  composer.hidden = true;
  composer.classList.remove("busy");
  document.querySelector("#thinking-banner").hidden = true;
  document.querySelector("#feature").value = "";
  document.querySelector("#project").value = "";
  document.querySelector("#message").value = "";
  document.querySelector("#section-target").textContent = "";
  document.querySelector("#feed").innerHTML = "";
  for (const id of ["#skeleton", "#choice", "#proposal", "#sections"]) {
    document.querySelector(id).innerHTML = "";
  }
  const diff = document.querySelector("#diff");
  diff.hidden = true;
  diff.textContent = "";
  paintStatus("Нет сессии", false);
  paintUsage(null);
  rememberProfile(profileId);
}

async function loadProfiles() {
  const data = await api("/api/profiles");
  for (const select of profileSelects()) {
    select.innerHTML = `<option value="">Выберите профиль</option>`;
    for (const profile of data.profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name + (profile.skeleton ? " · есть шаблон" : "");
      option.dataset.note = profile.writing_note || "";
      select.append(option);
    }
  }
  rememberProfile(state.profileId || profileFromLocation());
}

for (const select of profileSelects()) {
  select.addEventListener("change", () => rememberProfile(select.value));
}

document.querySelector("#start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    let profileId = document.querySelector("#profile-select").value;
    const name = document.querySelector("#profile-name").value.trim();
    const note = document.querySelector("#writing-note").value;
    if (name) {
      const created = await api("/api/profiles", {
        method: "POST",
        body: JSON.stringify({ name, writing_note: note }),
      });
      profileId = created.id;
      state.profileId = profileId;
      await loadProfiles();
    } else if (profileId && note) {
      await api(`/api/profiles/${profileId}`, {
        method: "PATCH",
        body: JSON.stringify({ writing_note: note }),
      });
    }
    if (!profileId) throw new Error("Выберите или создайте профиль");
    markBusy();
    const view = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        profile_id: profileId,
        feature: document.querySelector("#feature").value,
        project: document.querySelector("#project").value,
      }),
    });
    setSession(view.session.id);
    state.localBusy = isWorking(view);
    render(view);
    schedule(view);
  } catch (error) {
    state.localBusy = false;
    paintStatus(error.message, false);
  }
});

function isWorking(view) {
  if (!view) return false;
  return view.session.phase === "running" || (view.job && view.job.status === "pending");
}

function schedule(view) {
  clearTimeout(state.polling);
  if (isWorking(view)) {
    state.polling = setTimeout(refresh, 800);
  }
}

async function refresh() {
  if (!state.sessionId) return;
  try {
    const view = await api(`/api/sessions/${state.sessionId}`);
    state.localBusy = isWorking(view);
    render(view);
    schedule(view);
  } catch (error) {
    paintStatus(error.message);
  }
}

function render(view) {
  const working = state.localBusy || isWorking(view);
  composer.classList.toggle("busy", working);
  const banner = document.querySelector("#thinking-banner");
  banner.hidden = !working;
  const stage = view.session.stage || "brief";
  let text = "Ждёт вашего ответа";
  if (working) text = "Агент думает";
  else if (view.session.phase === "needs_key") text = "Нужен ключ модели";
  else if (view.session.phase === "error") text = "Ход остановился";
  else if (stage === "plan") text = "Каркас на утверждении";
  else if (stage === "approved") text = "Каркас принят";
  else if (stage === "draft") text = "Черновик на проверке";
  else if (stage === "validated") text = "Проверка пройдена";
  else if (stage === "done") text = "ТЗ готово";
  paintStatus(text, working);
  paintUsage(view.usage);
  if (!state.profileId && view.session.profile_id) rememberProfile(view.session.profile_id);
  renderFeed(view.snapshots, view.sections);
  renderSkeleton(view.skeleton, view.snapshots, view.sections);
  renderChoice(view.choice);
  renderProposal(view.proposal);
  renderSections(view.sections, view.snapshots);
}

function messageBubble(role, label, text, warn = false) {
  const node = document.createElement("div");
  node.className = `bubble ${role}`;
  if (warn) node.classList.add("warn");
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = label;
  const body = document.createElement("p");
  body.textContent = text;
  node.append(who, body);
  return node;
}

function systemRow(text) {
  const node = document.createElement("p");
  node.className = "system-row";
  node.textContent = text;
  return node;
}

function sectionTitle(sections, id) {
  const found = (sections || []).find((item) => item.id === id);
  return found ? cleanTitle(found.title) : "";
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/\*+:?\s*$/g, "")
    .replace(/\s*\(способ оценки результата\), Acceptance Criteria/gi, "")
    .trim();
}

function answerParts(block) {
  const sourced = (block.sources || []).some((source) => source.type === "answer");
  if (!sourced) return null;
  const text = block.text || "";
  const question = text.match(/^(.+?\?)\s+(.+)$/);
  if (question) return { prompt: question[1], answer: question[2] };
  const labeled = text.match(/^([^:]{3,80}):\s+(.+)$/);
  if (labeled) return { prompt: labeled[1], answer: labeled[2] };
  return null;
}

function sectionWasAnswered(section) {
  return (section.blocks || []).some(
    (block) => (block.sources || []).some((source) => source.type === "answer"),
  );
}

function errorSectionId(snapshots, error) {
  if (error.payload.section_id) return error.payload.section_id;
  const earlier = snapshots.filter(
    (item) => item.id < error.id && item.kind === "author_message" && item.payload.section_id,
  );
  return earlier.length ? earlier[earlier.length - 1].payload.section_id : "";
}

function errorWasRepaired(snapshots, error) {
  const sectionId = errorSectionId(snapshots, error);
  return snapshots.some((item) => {
    if (item.id <= error.id) return false;
    if (item.payload && (item.payload.action === "requirements" || item.payload.action === "rebuild_section")) {
      return !sectionId || item.payload.section_id === sectionId || item.payload.action === "requirements";
    }
    return (
      item.kind === "section_version" &&
      item.payload.section &&
      (!sectionId || item.payload.section.id === sectionId)
    );
  });
}

function failedSectionId(snapshots) {
  const error = [...snapshots].reverse().find((item) => item.kind === "agent_message" && item.payload.action === "error");
  if (!error) return "";
  const sectionId = errorSectionId(snapshots, error);
  const fixed = snapshots.some(
    (item) => item.id > error.id && item.kind === "section_version" && item.payload.section && item.payload.section.id === sectionId,
  );
  return fixed ? "" : sectionId;
}

function renderFeed(snapshots, sections) {
  const feed = document.querySelector("#feed");
  feed.innerHTML = "";
  for (const snap of snapshots) {
    if (snap.kind === "author_message") {
      const title = sectionTitle(sections, snap.payload.section_id);
      feed.append(messageBubble("author", title ? `Вы · ${title}` : "Вы", snap.payload.text));
    } else if (snap.kind === "decision" && /по правилам/i.test(snap.payload.text || "")) {
      continue;
    } else if (snap.kind === "agent_message" || snap.kind === "decision") {
      if (snap.payload.action === "error" && errorWasRepaired(snapshots, snap)) continue;
      const warn = snap.payload.action === "needs_key" || snap.payload.action === "error";
      let text = snap.payload.text || snap.payload.reason || "";
      if (/[0-9a-f]{8}/i.test(text) && /каркас/i.test(text)) {
        text = "Черновик собран по выбранному каркасу.";
      }
      if (snap.payload.action === "rebuild_section" && snap.payload.section_title) {
        text = `Ответы записаны в раздел «${cleanTitle(snap.payload.section_title)}». Карточка справа отмечена.`;
      }
      if (snap.payload.action === "requirements" && Array.isArray(snap.payload.section_titles)) {
        const names = snap.payload.section_titles.map((title) => `«${cleanTitle(title)}»`).join(", ");
        text = `Требования записаны в разделы ${names}. Эти карточки справа отмечены.`;
      }
      if (snap.payload.action === "error" && !snap.payload.section_title) {
        const sectionId = errorSectionId(snapshots, snap);
        const title = sectionTitle(sections, sectionId);
        if (title) {
          const later = snapshots.some(
            (item) =>
              item.id > snap.id &&
              item.kind === "section_version" &&
              item.payload.section &&
              item.payload.section.id === sectionId,
          );
          text = later
            ? `Раздел «${title}» тогда не обновился. Сейчас ответы записаны в этот раздел.`
            : `Раздел «${title}» не обновлён. Замечание сохранено, текст раздела не изменился.`;
        } else if (/section/i.test(text)) {
          text = "Ответ модели не разобран, раздел не был указан. Текст остался в диалоге.";
        }
      }
      feed.append(messageBubble("agent", "Агент", text, warn));
    } else if (snap.kind === "tool_call") {
      feed.append(systemRow(`Инструмент ${snap.payload.name}`));
    } else if (snap.kind === "file") {
      feed.append(systemRow(`Файл ${snap.payload.filename} · ${snap.payload.purpose}`));
    } else if (snap.kind === "example_saved") {
      feed.append(systemRow("Пример сохранён в RAG"));
    }
  }
  if (!feed.children.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Сообщения агента и ваши ответы появятся здесь.";
    feed.append(empty);
  }
  scrollThread();
}

function renderSkeleton(skeleton, snapshots, sections) {
  const host = document.querySelector("#skeleton");
  host.innerHTML = "";
  if (!skeleton) return;
  const latest = [...snapshots].reverse().find((item) => item.kind === "skeleton_current");
  const card = document.createElement("article");
  card.className = "card";
  const heading = document.createElement("h2");
  heading.textContent = "Каркас";
  const list = document.createElement("ul");
  list.className = "outline";
  for (const item of skeleton.sections || []) {
    const live = (sections || []).find((section) => section.id === item.id);
    const row = document.createElement("li");
    row.textContent = cleanTitle(item.title);
    row.className = live && sectionWasAnswered(live) ? "done" : "wait";
    list.append(row);
  }
  card.append(heading, list);
  if (latest && latest.payload.immediate && latest.payload.previous) {
    const button = document.createElement("button");
    button.className = "secondary";
    button.type = "button";
    button.textContent = "Вернуть прежний каркас";
    button.addEventListener("click", () => act("/skeleton", { action: "reject" }));
    card.append(button);
  }
  host.append(card);
}

function renderChoice(choice) {
  const host = document.querySelector("#choice");
  host.innerHTML = "";
  if (!choice) return;
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = "<h2>Выберите один каркас</h2>";
  for (const option of choice.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${option.which}. ${option.filename}`;
    button.addEventListener("click", () => act("/skeleton-choice", { which: option.which }));
    card.append(button);
  }
  const own = document.createElement("textarea");
  own.placeholder = "# Свой раздел";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "secondary";
  save.textContent = "Свой вариант";
  save.addEventListener("click", () => act("/skeleton-choice", { which: "own", text: own.value }));
  card.append(own, save);
  host.append(card);
}

function renderProposal(proposal) {
  const host = document.querySelector("#proposal");
  host.innerHTML = "";
  if (!proposal) return;
  const card = document.createElement("article");
  card.className = "card";
  const reason = document.createElement("p");
  reason.textContent = proposal.message;
  card.append(reason);
  const list = document.createElement("ul");
  for (const candidate of proposal.candidates || []) {
    const item = document.createElement("li");
    const titles = (candidate.sections || []).map((section) => section.title).join(" · ");
    item.textContent = `${candidate.title || candidate.id}: ${titles}`;
    list.append(item);
  }
  const accept = document.createElement("button");
  accept.type = "button";
  accept.textContent = "Принять каркас";
  accept.addEventListener("click", () => act("/skeleton", { action: "accept" }));
  const editor = document.createElement("textarea");
  editor.value = (proposal.skeleton.sections || []).map((section) => `# ${section.title}`).join("\n");
  const replace = document.createElement("button");
  replace.type = "button";
  replace.className = "secondary";
  replace.textContent = "Заменить своим текстом";
  replace.addEventListener("click", () => act("/skeleton", { action: "replace_text", text: editor.value }));
  card.append(list, accept, editor, replace);
  host.append(card);
}

function renderSections(sections, snapshots) {
  const host = document.querySelector("#sections");
  host.innerHTML = "";
  const marks = new Map();
  for (const snap of snapshots) {
    if (snap.kind !== "section_version") continue;
    for (const mark of snap.payload.marks || []) marks.set(mark.section_id, mark.text);
  }
  const failed = failedSectionId(snapshots);
  const filled = sections.filter(sectionWasAnswered);
  const waiting = sections.filter((section) => !sectionWasAnswered(section));
  // #region agent log
  fetch("http://127.0.0.1:7695/ingest/c56cadae-16e8-4f66-86f4-1d56394a7e62", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "3097ee" }, body: JSON.stringify({ sessionId: "3097ee", hypothesisId: "D", location: "app.js:renderSections", message: "filled cards", data: { filled: filled.map((section) => cleanTitle(section.title)), waiting: waiting.length, failed: failed || "" }, timestamp: Date.now() }) }).catch(() => {});
  // #endregion
  const repaired = repairedTitles(snapshots, sections);
  // #region agent log
  fetch("http://127.0.0.1:7695/ingest/c56cadae-16e8-4f66-86f4-1d56394a7e62", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "3097ee" }, body: JSON.stringify({ sessionId: "3097ee", hypothesisId: "E", location: "app.js:renderSections", message: "error banner", data: { repaired }, timestamp: Date.now() }) }).catch(() => {});
  // #endregion
  if (repaired.length) {
    const banner = document.createElement("p");
    banner.className = "error-resolved";
    banner.textContent = `Ошибка была в разделе ${repaired.map((title) => `«${title}»`).join(", ")}. Ответы уже записаны в карточку.`;
    host.append(banner);
  }
  if (filled.length) host.append(sectionHeading("Заполнено"));
  for (const section of filled) host.append(sectionCard(section, failed, marks));
  if (waiting.length) {
    const details = document.createElement("details");
    details.className = "waiting";
    const summary = document.createElement("summary");
    summary.textContent = `Ждут ответа: ${waiting.length}`;
    details.append(summary);
    for (const section of waiting) details.append(sectionCard(section, failed, marks));
    host.append(details);
  }
}

function repairedTitles(snapshots, sections) {
  const titles = [];
  for (const snap of snapshots) {
    if (snap.kind !== "agent_message" || snap.payload.action !== "error") continue;
    if (!errorWasRepaired(snapshots, snap)) continue;
    const title = sectionTitle(sections, errorSectionId(snapshots, snap));
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles;
}

function sectionHeading(text) {
  const heading = document.createElement("h2");
  heading.className = "section-group";
  heading.textContent = text;
  return heading;
}

function sectionCard(section, failed, marks) {
    const card = document.createElement("article");
    card.className = "card";
    if (section.id === failed) {
      card.classList.add("attention");
      const banner = document.createElement("p");
      banner.className = "section-error";
      banner.textContent = `Раздел «${cleanTitle(section.title)}» не обновлён`;
      card.append(banner);
    } else if (sectionWasAnswered(section)) {
      card.classList.add("filled");
      const banner = document.createElement("p");
      banner.className = "section-filled";
      banner.textContent = "Записано из вашего ответа";
      card.append(banner);
    }
    const title = document.createElement("h3");
    title.textContent = cleanTitle(section.title);
    card.append(title);
    for (const block of section.blocks) {
      const parts = answerParts(block);
      const paragraph = document.createElement("p");
      if (parts) {
        paragraph.className = "block answer";
        const prompt = document.createElement("span");
        prompt.className = "prompt";
        prompt.textContent = parts.prompt;
        const value = document.createElement("span");
        value.className = "value";
        value.textContent = parts.answer;
        paragraph.append(prompt, value);
      } else {
        paragraph.className = "block" + (block.kind === "question" ? " question" : "");
        paragraph.textContent = block.text;
      }
      card.append(paragraph);
    }
    if (marks.has(section.id)) {
      const note = document.createElement("p");
      note.className = "marks";
      note.textContent = "Проверка заменила утверждение без опоры на вопрос.";
      card.append(note);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Замечание к этому разделу";
    button.addEventListener("click", () => {
      state.sectionId = section.id;
      document.querySelector("#section-target").textContent = `Замечание к разделу «${section.title}»`;
      document.querySelector("#message").focus();
    });
    card.append(button);
    return card;
}

function markBusy() {
  state.localBusy = true;
  paintStatus("Агент думает", true);
  composer.classList.add("busy");
  document.querySelector("#thinking-banner").hidden = false;
  scrollThread();
}

async function act(path, body) {
  const quiet = path === "/cancel" || path === "/stop" || path === "/diff" || path === "/examples";
  if (!quiet) markBusy();
  try {
    const view = await api(`/api/sessions/${state.sessionId}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.localBusy = isWorking(view);
    render(view);
    if (path === "/stop") {
      clearTimeout(state.polling);
      state.polling = setTimeout(refresh, 600);
    } else {
      schedule(view);
    }
  } catch (error) {
    state.localBusy = false;
    composer.classList.remove("busy");
    document.querySelector("#thinking-banner").hidden = true;
    paintStatus(error.message, false);
  }
}

document.querySelector("#message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    document.querySelector("#send").click();
  }
});

document.querySelector("#send").addEventListener("click", async () => {
  const text = document.querySelector("#message").value.trim();
  if (!text) return;
  await act("/messages", { text, section_id: state.sectionId });
  document.querySelector("#message").value = "";
  state.sectionId = null;
  document.querySelector("#section-target").textContent = "";
});

document.querySelector("#cancel").addEventListener("click", () => act("/cancel", {}));
document.querySelector("#new-window").addEventListener("click", () => {
  const profileId = document.querySelector("#menu-profile").value;
  if (!profileId) {
    paintStatus("Выберите профиль");
    return;
  }
  const url = new URL(location.href);
  url.search = `?profile=${encodeURIComponent(profileId)}`;
  url.hash = "";
  window.open(url.toString(), "_blank", "noopener");
});
document.querySelector("#clear-session").addEventListener("click", async () => {
  if (!state.sessionId) return;
  if (!window.confirm("Очистить это ТЗ? Диалог, черновик и файлы сессии будут удалены.")) return;
  try {
    const result = await api(`/api/sessions/${state.sessionId}`, { method: "DELETE" });
    leaveSession(result.profile_id);
  } catch (error) {
    paintStatus(error.message, false);
  }
});
document.querySelector("#stop").addEventListener("click", () => act("/stop", {}));
document.querySelector("#validate").addEventListener("click", () => act("/validate", {}));
document.querySelector("#done").addEventListener("click", () => act("/done", {}));
document.querySelector("#save-example").addEventListener("click", () => act("/examples", {}));

document.querySelector("#diff-btn").addEventListener("click", async () => {
  const box = document.querySelector("#diff");
  try {
    const diff = await api(`/api/sessions/${state.sessionId}/diff`);
    const parts = diff.sections.map((section) => (
      section.unchanged ? `## ${section.title}\nбез изменений` : `## ${section.title}\n${section.diff}`
    ));
    box.hidden = false;
    box.textContent = parts.join("\n\n") + (diff.document_diff ? `\n\n${diff.document_diff}` : "");
  } catch (error) {
    paintStatus(error.message);
  }
});

document.querySelector("#repo-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await act("/repo", { path: document.querySelector("#repo-path").value });
});

function bindFile(id, purpose) {
  document.querySelector(id).addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const body = new FormData();
    body.append("purpose", purpose);
    body.append("file", file);
    markBusy();
    try {
      const response = await fetch(`/api/sessions/${state.sessionId}/files`, { method: "POST", body });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.detail || "Файл не принят");
      }
      const view = await response.json();
      state.localBusy = isWorking(view);
      render(view);
      schedule(view);
    } catch (error) {
      state.localBusy = false;
      composer.classList.remove("busy");
      document.querySelector("#thinking-banner").hidden = true;
      paintStatus(error.message, false);
    }
    event.target.value = "";
  });
}

bindFile("#req-file", "requirements");
bindFile("#skel-file", "skeleton");
bindFile("#ex-file", "example");
bindFile("#audio-file", "audio");

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

loadProfiles()
  .then(() => {
    const existing = sessionFromLocation();
    if (!existing) return;
    setSession(existing);
    return refresh();
  })
  .catch((error) => {
    paintStatus(error.message);
  });
