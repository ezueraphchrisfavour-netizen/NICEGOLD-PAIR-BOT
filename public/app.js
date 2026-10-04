const state = {
  commands: [],
  replies: [],
  logs: [],
  groups: [],
  sessions: [],
  settings: {},
  stats: {},
  commandFilter: "all",
  commandSearch: ""
};

const $ = (selector) => document.querySelector(selector);

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function prettyCommand(command) {
  return String(command || "")
    .replace(/^\./, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function commandName(item) {
  return item.command || item.name || item.cmd || "";
}

function commandDescription(item) {
  return (
    item.description ||
    item.desc ||
    item.help ||
    item.usage ||
    "NICEGOLDMON built-in command"
  );
}

function isBuiltin(item) {
  return (
    item.builtin === true ||
    item.type === "builtin" ||
    item.source === "builtin"
  );
}

async function api(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...options
    });

    const text = await response.text();

    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      throw new Error(data.error || data.message || `HTTP ${response.status}`);
    }

    return data;
  } catch (error) {
    console.error("API error:", error);
    throw error;
  }
}

function notify(message, type = "info") {
  let box = document.querySelector("#nicegold-toast");

  if (!box) {
    box = document.createElement("div");
    box.id = "nicegold-toast";
    box.style.cssText = `
      position:fixed;
      left:50%;
      bottom:24px;
      transform:translateX(-50%) translateY(20px);
      z-index:99999;
      padding:13px 18px;
      border-radius:16px;
      background:rgba(10,14,25,.94);
      border:1px solid rgba(255,255,255,.14);
      box-shadow:0 15px 45px rgba(0,0,0,.45);
      color:#fff;
      font-size:14px;
      font-weight:700;
      opacity:0;
      transition:.25s ease;
      max-width:90%;
      text-align:center;
      backdrop-filter:blur(18px);
    `;
    document.body.appendChild(box);
  }

  box.textContent = message;

  if (type === "success") {
    box.style.borderColor = "rgba(0,255,170,.45)";
  } else if (type === "error") {
    box.style.borderColor = "rgba(255,70,100,.5)";
  } else {
    box.style.borderColor = "rgba(80,150,255,.45)";
  }

  requestAnimationFrame(() => {
    box.style.opacity = "1";
    box.style.transform = "translateX(-50%) translateY(0)";
  });

  clearTimeout(box._timer);

  box._timer = setTimeout(() => {
    box.style.opacity = "0";
    box.style.transform = "translateX(-50%) translateY(20px)";
  }, 2600);
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value ?? "0";
}

function renderCommands() {
  const container =
    $("#commandsList") ||
    $("#commandList") ||
    document.querySelector("[data-commands]");

  if (!container) return;

  const search = state.commandSearch.trim().toLowerCase();

  let commands = [...state.commands];

  if (state.commandFilter === "builtin") {
    commands = commands.filter(isBuiltin);
  }

  if (state.commandFilter === "custom") {
    commands = commands.filter(item => !isBuiltin(item));
  }

  if (search) {
    commands = commands.filter(item => {
      const name = commandName(item).toLowerCase();
      const desc = commandDescription(item).toLowerCase();

      return name.includes(search) || desc.includes(search);
    });
  }

  if (!commands.length) {
    container.innerHTML = `
      <div class="ng-empty">
        <div class="ng-empty-icon">⌕</div>
        <strong>No commands found</strong>
        <span>Try another search or filter.</span>
      </div>
    `;
    updateCommandCounters();
    return;
  }

  container.innerHTML = commands.map((item, index) => {
    const name = commandName(item);
    const description = commandDescription(item);
    const builtin = isBuiltin(item);

    return `
      <article class="ng-command-card ${builtin ? "builtin" : "custom"}">
        <div class="ng-command-number">${index + 1}</div>

        <div class="ng-command-main">
          <div class="ng-command-top">
            <code>${esc(name.startsWith(".") ? name : "." + name)}</code>

            <span class="ng-command-badge ${builtin ? "builtin" : "custom"}">
              ${builtin ? "BUILT-IN" : "CUSTOM"}
            </span>
          </div>

          <div class="ng-command-title">
            ${esc(prettyCommand(name))}
          </div>

          <div class="ng-command-description">
            ${esc(description)}
          </div>
        </div>

        ${
          builtin
            ? `
              <div class="ng-command-lock" title="Built-in command">
                ✓
              </div>
            `
            : `
              <button
                class="ng-delete-command"
                data-command="${esc(name)}"
                type="button"
              >
                Delete
              </button>
            `
        }
      </article>
    `;
  }).join("");

  container.querySelectorAll(".ng-delete-command").forEach(button => {
    button.addEventListener("click", async () => {
      const command = button.dataset.command;

      if (!command) return;

      const confirmed = confirm(
        `Delete ${command.startsWith(".") ? command : "." + command}?`
      );

      if (!confirmed) return;

      try {
        await api(`/api/commands/${encodeURIComponent(command.replace(/^\./, ""))}`, {
          method: "DELETE"
        });

        notify("Command deleted", "success");
        await loadCommands();
      } catch (error) {
        notify(error.message || "Could not delete command", "error");
      }
    });
  });

  updateCommandCounters();
}

function updateCommandCounters() {
  const builtinCount = state.commands.filter(isBuiltin).length;
  const customCount = state.commands.filter(item => !isBuiltin(item)).length;

  setText("#builtinCommandCount", builtinCount);
  setText("#customCommandCount", customCount);
  setText("#totalCommandCount", state.commands.length);

  document.querySelectorAll("[data-command-count]").forEach(el => {
    const type = el.dataset.commandCount;

    if (type === "builtin") el.textContent = builtinCount;
    else if (type === "custom") el.textContent = customCount;
    else el.textContent = state.commands.length;
  });
}

function setupCommandControls() {
  const search =
    $("#commandSearch") ||
    $("#commandsSearch") ||
    document.querySelector("[data-command-search]");

  if (search) {
    search.addEventListener("input", () => {
      state.commandSearch = search.value;
      renderCommands();
    });
  }

  document.querySelectorAll(
    "[data-command-filter], .command-filter, .commandFilter"
  ).forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(
        "[data-command-filter], .command-filter, .commandFilter"
      ).forEach(btn => btn.classList.remove("active"));

      button.classList.add("active");

      state.commandFilter =
        button.dataset.commandFilter ||
        button.dataset.filter ||
        button.value ||
        "all";

      renderCommands();
    });
  });
}

async function loadCommands() {
  try {
    const data = await api("/api/commands");

    let commands = [];

    if (Array.isArray(data)) {
      commands = data;
    } else if (Array.isArray(data.commands)) {
      commands = data.commands;
    } else if (Array.isArray(data.data)) {
      commands = data.data;
    }

    state.commands = commands.map(item => {
      if (typeof item === "string") {
        return {
          command: item,
          builtin: true,
          description: "NICEGOLDMON command"
        };
      }

      return item;
    });

    renderCommands();
  } catch (error) {
    console.error(error);

    const container =
      $("#commandsList") ||
      $("#commandList") ||
      document.querySelector("[data-commands]");

    if (container) {
      container.innerHTML = `
        <div class="ng-empty">
          <div class="ng-empty-icon">!</div>
          <strong>Unable to load commands</strong>
          <span>${esc(error.message)}</span>
        </div>
      `;
    }
  }
}

function renderReplies() {
  const container =
    $("#repliesList") ||
    $("#replyList") ||
    document.querySelector("[data-replies]");

  if (!container) return;

  if (!state.replies.length) {
    container.innerHTML = `
      <div class="ng-empty">
        <div class="ng-empty-icon">↯</div>
        <strong>No auto replies</strong>
        <span>Add a reply from the dashboard.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = state.replies.map((reply, index) => {
    const trigger = reply.trigger || reply.key || reply.word || "";
    const response = reply.response || reply.reply || reply.text || "";

    return `
      <article class="ng-reply-card">
        <div>
          <div class="ng-reply-trigger">${esc(trigger)}</div>
          <div class="ng-reply-response">${esc(response)}</div>
        </div>

        <button
          type="button"
          class="ng-delete-reply"
          data-trigger="${esc(trigger)}"
        >
          Delete
        </button>
      </article>
    `;
  }).join("");

  container.querySelectorAll(".ng-delete-reply").forEach(button => {
    button.addEventListener("click", async () => {
      const trigger = button.dataset.trigger;

      if (!confirm(`Delete reply "${trigger}"?`)) return;

      try {
        await api(`/api/replies/${encodeURIComponent(trigger)}`, {
          method: "DELETE"
        });

        notify("Reply deleted", "success");
        await loadReplies();
      } catch (error) {
        notify(error.message || "Could not delete reply", "error");
      }
    });
  });
}

async function loadReplies() {
  try {
    const data = await api("/api/replies");

    if (Array.isArray(data)) {
      state.replies = data;
    } else if (Array.isArray(data.replies)) {
      state.replies = data.replies;
    } else {
      state.replies = [];
    }

    renderReplies();
  } catch (error) {
    console.error(error);
  }
}

function renderLogs() {
  const container =
    $("#logsList") ||
    $("#logList") ||
    document.querySelector("[data-logs]");

  if (!container) return;

  if (!state.logs.length) {
    container.innerHTML = `
      <div class="ng-empty">
        <div class="ng-empty-icon">◌</div>
        <strong>No activity yet</strong>
        <span>NICEGOLDMON logs will appear here.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = state.logs.slice(0, 100).map(log => {
    const message =
      log.message ||
      log.text ||
      log.action ||
      JSON.stringify(log);

    const time =
      log.time ||
      log.timestamp ||
      log.createdAt ||
      "";

    return `
      <div class="ng-log-row">
        <div class="ng-log-dot"></div>
        <div class="ng-log-content">
          <div>${esc(message)}</div>
          <small>${esc(time)}</small>
        </div>
      </div>
    `;
  }).join("");
}

async function loadLogs() {
  try {
    const data = await api("/api/logs");

    if (Array.isArray(data)) {
      state.logs = data;
    } else if (Array.isArray(data.logs)) {
      state.logs = data.logs;
    } else {
      state.logs = [];
    }

    renderLogs();
  } catch (error) {
    console.error(error);
  }
}

function renderGroups() {
  const container =
    $("#groupsList") ||
    $("#groupList") ||
    document.querySelector("[data-groups]");

  if (!container) return;

  if (!state.groups.length) {
    container.innerHTML = `
      <div class="ng-empty">
        <div class="ng-empty-icon">⌂</div>
        <strong>No groups detected</strong>
        <span>Connect the bot to see WhatsApp groups here.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = state.groups.map(group => {
    const id = group.id || group.jid || "";
    const name = group.name || group.subject || "Unnamed Group";
    const participants =
      group.participants ||
      group.memberCount ||
      group.size ||
      "?";

    return `
      <div class="ng-group-card">
        <div class="ng-group-icon">⌂</div>

        <div class="ng-group-info">
          <strong>${esc(name)}</strong>
          <span>${esc(participants)} members</span>
        </div>

        <code>${esc(id)}</code>
      </div>
    `;
  }).join("");
}

async function loadGroups() {
  try {
    const data = await api("/api/groups");

    if (Array.isArray(data)) {
      state.groups = data;
    } else if (Array.isArray(data.groups)) {
      state.groups = data.groups;
    } else {
      state.groups = [];
    }

    renderGroups();
  } catch (error) {
    console.error(error);
  }
}

function renderSessions() {
  const container =
    $("#sessionsList") ||
    $("#sessionList") ||
    document.querySelector("[data-sessions]");

  if (!container) return;

  if (!state.sessions.length) {
    container.innerHTML = `
      <div class="ng-empty">
        <div class="ng-empty-icon">◉</div>
        <strong>No active sessions</strong>
        <span>Pair a WhatsApp number to create a session.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = state.sessions.map(session => {
    const id = session.id || session.sessionId || "default";
    const status = session.status || "connected";

    return `
      <div class="ng-session-card">
        <div class="ng-session-status"></div>

        <div>
          <strong>${esc(id)}</strong>
          <span>${esc(status)}</span>
        </div>
      </div>
    `;
  }).join("");
}

async function loadSessions() {
  try {
    const data = await api("/api/sessions");

    if (Array.isArray(data)) {
      state.sessions = data;
    } else if (Array.isArray(data.sessions)) {
      state.sessions = data.sessions;
    } else {
      state.sessions = [];
    }

    renderSessions();
  } catch (error) {
    console.error(error);
  }
}

function applySettings(settings) {
  state.settings = settings || {};

  Object.entries(state.settings).forEach(([key, value]) => {
    const element = document.querySelector(`[name="${key}"]`);

    if (!element) return;

    if (element.type === "checkbox") {
      element.checked = Boolean(value);
    } else {
      element.value = value ?? "";
    }
  });

  document.querySelectorAll("[data-setting]").forEach(element => {
    const key = element.dataset.setting;

    if (!(key in state.settings)) return;

    if (element.type === "checkbox") {
      element.checked = Boolean(state.settings[key]);
    } else {
      element.value = state.settings[key];
    }
  });
}

async function loadInfo() {
  try {
    const data = await api("/api/info");

    const info = data.info || data;

    setText("#botName", info.name || info.botName || "NICEGOLDMON V1");
    setText("#botVersion", info.version || "V1");
    setText("#botStatus", info.status || "ONLINE");

    if (info.settings) {
      applySettings(info.settings);
    }
  } catch (error) {
    console.error(error);
  }
}

async function loadSettings() {
  try {
    const data = await api("/api/settings");
    const settings = data.settings || data;
    applySettings(settings);
  } catch (error) {
    console.error(error);
  }
}

async function loadStats() {
  try {
    const data = await api("/api/stats");

    state.stats = data.stats || data;

    setText(
      "#messagesCount",
      state.stats.messages ??
      state.stats.messagesReceived ??
      state.stats.messageCount ??
      0
    );

    setText(
      "#commandsCount",
      state.stats.commands ??
      state.stats.commandsUsed ??
      state.stats.commandCount ??
      0
    );

    setText(
      "#groupsCount",
      state.stats.groups ??
      state.stats.groupCount ??
      0
    );

    setText(
      "#usersCount",
      state.stats.users ??
      state.stats.userCount ??
      0
    );

    setText(
      "#uptime",
      state.stats.uptime ??
      "ONLINE"
    );
  } catch (error) {
    console.error(error);
  }
}

async function saveSettings() {
  const settings = {};

  document.querySelectorAll("[data-setting], [name]").forEach(element => {
    const key = element.dataset.setting || element.name;

    if (!key) return;

    settings[key] =
      element.type === "checkbox"
        ? element.checked
        : element.value;
  });

  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify(settings)
    });

    state.settings = {
      ...state.settings,
      ...settings
    };

    notify("Settings saved successfully", "success");
  } catch (error) {
    notify(error.message || "Could not save settings", "error");
  }
}

async function pairBot() {
  const input =
    $("#phoneNumber") ||
    $("#phone") ||
    document.querySelector("[name=" + CSS.escape("phone") + "]");

  if (!input) return;

  const phone = input.value.trim();

  if (!phone) {
    notify("Enter a WhatsApp number first", "error");
    return;
  }

  try {
    const button =
      $("#pairButton") ||
      $("#pairBtn") ||
      document.querySelector("[data-pair]");

    if (button) {
      button.disabled = true;
      button.dataset.oldText = button.textContent;
      button.textContent = "Generating Code...";
    }

    const data = await api("/api/pair", {
      method: "POST",
      body: JSON.stringify({ phone })
    });

    if (data.code || data.pairingCode) {
      showPairingCode(data.code || data.pairingCode);
    } else {
      notify(
        data.message || "Pairing code ready",
        "success"
      );
    }

    await loadSessions();
    await loadInfo();
  } catch (error) {
    notify(error.message || "Pairing failed", "error");
  } finally {
    const button =
      $("#pairButton") ||
      $("#pairBtn") ||
      document.querySelector("[data-pair]");

    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.oldText || "Pair";
    }
  }
}

function showPairingCode(code) {
  let modal = $("#pairingModal");

  if (!modal) {
    modal = document.createElement("div");
    modal.id = "pairingModal";

    modal.innerHTML = `
      <div class="ng-modal-backdrop">
        <div class="ng-pairing-modal">
          <button class="ng-modal-close" type="button">×</button>

          <div class="ng-modal-icon">◆</div>

          <h2>WhatsApp Pairing Code</h2>
          <p>Enter this code in WhatsApp Linked Devices.</p>

          <div class="ng-pairing-code"></div>

          <button class="ng-copy-code" type="button">
            Copy Code
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector(".ng-modal-close").onclick = () => {
      modal.remove();
    };

    modal.querySelector(".ng-copy-code").onclick = async () => {
      const value = modal.querySelector(".ng-pairing-code").textContent;

      try {
        await navigator.clipboard.writeText(value);
        notify("Pairing code copied", "success");
      } catch {
        notify("Could not copy automatically", "error");
      }
    };
  }

  modal.querySelector(".ng-pairing-code").textContent = code;
}

function setupForms() {
  const settingsButton =
    $("#saveSettings") ||
    $("#saveSettingsBtn") ||
    document.querySelector("[data-save-settings]");

  if (settingsButton) {
    settingsButton.addEventListener("click", saveSettings);
  }

  const pairButton =
    $("#pairButton") ||
    $("#pairBtn") ||
    document.querySelector("[data-pair]");

  if (pairButton) {
    pairButton.addEventListener("click", pairBot);
  }

  const phoneInput =
    $("#phoneNumber") ||
    $("#phone") ||
    document.querySelector("[name=phone]");

  /*
   * Enter NEVER sends the form automatically.
   * This keeps the pairing field predictable.
   */
  if (phoneInput) {
    phoneInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
      }
    });
  }

  document.querySelectorAll("form").forEach(form => {
    form.addEventListener("submit", event => {
      event.preventDefault();
    });
  });
}

function injectCommandStyles() {
  if ($("#nicegold-command-styles")) return;

  const style = document.createElement("style");
  style.id = "nicegold-command-styles";

  style.textContent = `
    .ng-command-card {
      display:flex;
      align-items:center;
      gap:13px;
      padding:14px;
      margin:8px 0;
      border-radius:18px;
      border:1px solid rgba(255,255,255,.09);
      background:linear-gradient(
        135deg,
        rgba(255,255,255,.055),
        rgba(255,255,255,.018)
      );
      backdrop-filter:blur(14px);
      transition:.2s ease;
      min-width:0;
    }

    .ng-command-card:hover {
      transform:translateY(-1px);
      border-color:rgba(100,170,255,.3);
    }

    .ng-command-number {
      width:32px;
      height:32px;
      min-width:32px;
      display:grid;
      place-items:center;
      border-radius:11px;
      background:rgba(100,150,255,.12);
      color:#91baff;
      font-size:11px;
      font-weight:800;
    }

    .ng-command-main {
      flex:1;
      min-width:0;
    }

    .ng-command-top {
      display:flex;
      align-items:center;
      gap:8px;
      flex-wrap:wrap;
    }

    .ng-command-top code {
      color:#fff;
      font-size:13px;
      font-weight:800;
      background:rgba(0,0,0,.2);
      border-radius:8px;
      padding:5px 8px;
    }

    .ng-command-badge {
      font-size:8px;
      letter-spacing:1px;
      font-weight:900;
      padding:4px 7px;
      border-radius:999px;
    }

    .ng-command-badge.builtin {
      color:#8fc4ff;
      background:rgba(70,140,255,.12);
      border:1px solid rgba(70,140,255,.18);
    }

    .ng-command-badge.custom {
      color:#ff9be8;
      background:rgba(255,80,190,.11);
      border:1px solid rgba(255,80,190,.18);
    }

    .ng-command-title {
      margin-top:8px;
      color:#f7f9ff;
      font-size:14px;
      font-weight:800;
    }

    .ng-command-description {
      margin-top:3px;
      color:rgba(220,230,245,.58);
      font-size:11px;
      line-height:1.45;
    }

    .ng-command-lock {
      width:30px;
      height:30px;
      min-width:30px;
      display:grid;
      place-items:center;
      border-radius:50%;
      color:#6fffd0;
      background:rgba(0,255,170,.08);
      border:1px solid rgba(0,255,170,.16);
      font-weight:900;
    }

    .ng-delete-command,
    .ng-delete-reply {
      border:0;
      border-radius:11px;
      padding:8px 11px;
      background:rgba(255,65,95,.1);
      border:1px solid rgba(255,65,95,.2);
      color:#ff8fa4;
      font-size:10px;
      font-weight:800;
      cursor:pointer;
    }

    .ng-delete-command:hover,
    .ng-delete-reply:hover {
      background:rgba(255,65,95,.18);
    }

    .ng-empty {
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      text-align:center;
      gap:5px;
      min-height:150px;
      padding:24px;
      color:rgba(255,255,255,.55);
      border:1px dashed rgba(255,255,255,.1);
      border-radius:18px;
      background:rgba(255,255,255,.025);
    }

    .ng-empty strong {
      color:#fff;
      font-size:14px;
    }

    .ng-empty span {
      font-size:11px;
    }

    .ng-empty-icon {
      width:42px;
      height:42px;
      display:grid;
      place-items:center;
      margin-bottom:5px;
      border-radius:14px;
      background:rgba(90,140,255,.1);
      color:#8fb8ff;
      font-size:20px;
      font-weight:900;
    }

    .ng-reply-card,
    .ng-group-card,
    .ng-session-card {
      display:flex;
      align-items:center;
      gap:12px;
      padding:13px;
      margin:8px 0;
      border-radius:16px;
      background:rgba(255,255,255,.035);
      border:1px solid rgba(255,255,255,.08);
    }

    .ng-reply-card > div {
      flex:1;
      min-width:0;
    }

    .ng-reply-trigger {
      color:#fff;
      font-weight:800;
      font-size:13px;
    }

    .ng-reply-response {
      color:rgba(255,255,255,.55);
      font-size:11px;
      margin-top:4px;
    }

    .ng-group-icon {
      width:38px;
      height:38px;
      display:grid;
      place-items:center;
      border-radius:13px;
      background:rgba(80,150,255,.1);
      color:#8bb8ff;
    }

    .ng-group-info {
      flex:1;
      min-width:0;
      display:flex;
      flex-direction:column;
      gap:4px;
    }

    .ng-group-info strong {
      color:#fff;
      font-size:13px;
    }

    .ng-group-info span,
    .ng-session-card span {
      color:rgba(255,255,255,.5);
      font-size:10px;
    }

    .ng-group-card code {
      max-width:35%;
      overflow:hidden;
      text-overflow:ellipsis;
      color:rgba(255,255,255,.4);
      font-size:9px;
    }

    .ng-session-status {
      width:10px;
      height:10px;
      border-radius:50%;
      background:#5dffba;
      box-shadow:0 0 15px rgba(80,255,180,.7);
    }

    .ng-session-card > div:last-child {
      display:flex;
      flex-direction:column;
      gap:4px;
    }

    .ng-log-row {
      display:flex;
      gap:10px;
      padding:10px 2px;
      border-bottom:1px solid rgba(255,255,255,.05);
    }

    .ng-log-dot {
      width:7px;
      height:7px;
      margin-top:5px;
      border-radius:50%;
      background:#7faeff;
      box-shadow:0 0 12px rgba(90,150,255,.7);
    }

    .ng-log-content {
      flex:1;
      color:rgba(255,255,255,.75);
      font-size:11px;
    }

    .ng-log-content small {
      display:block;
      margin-top:3px;
      color:rgba(255,255,255,.35);
      font-size:9px;
    }

    .ng-modal-backdrop {
      position:fixed;
      inset:0;
      z-index:100000;
      display:grid;
      place-items:center;
      padding:20px;
      background:rgba(0,0,0,.7);
      backdrop-filter:blur(15px);
    }

    .ng-pairing-modal {
      position:relative;
      width:min(420px,100%);
      padding:28px;
      text-align:center;
      border-radius:26px;
      background:rgba(12,16,29,.96);
      border:1px solid rgba(120,170,255,.2);
      box-shadow:0 25px 80px rgba(0,0,0,.55);
    }

    .ng-modal-close {
      position:absolute;
      right:14px;
      top:12px;
      border:0;
      background:none;
      color:#fff;
      font-size:25px;
      cursor:pointer;
    }

    .ng-modal-icon {
      width:54px;
      height:54px;
      display:grid;
      place-items:center;
      margin:0 auto 12px;
      border-radius:18px;
      color:#91bbff;
      background:rgba(80,140,255,.12);
    }

    .ng-pairing-modal h2 {
      color:#fff;
      margin:0;
      font-size:20px;
    }

    .ng-pairing-modal p {
      color:rgba(255,255,255,.5);
      font-size:12px;
    }

    .ng-pairing-code {
      margin:20px 0;
      padding:18px 10px;
      border-radius:16px;
      background:rgba(255,255,255,.045);
      border:1px solid rgba(255,255,255,.09);
      color:#fff;
      font-size:23px;
      font-weight:900;
      letter-spacing:5px;
      word-break:break-all;
    }

    .ng-copy-code {
      width:100%;
      padding:12px;
      border:0;
      border-radius:14px;
      color:#fff;
      background:linear-gradient(135deg,#397dff,#9b4dff);
      font-weight:800;
      cursor:pointer;
    }

    @media(max-width:600px) {
      .ng-command-card {
        padding:11px;
        gap:9px;
      }

      .ng-command-number {
        width:27px;
        height:27px;
        min-width:27px;
        font-size:9px;
      }

      .ng-command-title {
        font-size:12px;
      }

      .ng-command-description {
        font-size:10px;
      }

      .ng-delete-command {
        padding:7px 8px;
        font-size:9px;
      }
    }
  `;

  document.head.appendChild(style);
}

async function refreshDashboard() {
  await Promise.allSettled([
    loadInfo(),
    loadSettings(),
    loadStats(),
    loadCommands(),
    loadReplies(),
    loadLogs(),
    loadGroups(),
    loadSessions()
  ]);
}

function setupAutoRefresh() {
  setInterval(async () => {
    await Promise.allSettled([
      loadStats(),
      loadLogs(),
      loadGroups(),
      loadSessions()
    ]);
  }, 15000);
}

document.addEventListener("DOMContentLoaded", async () => {
  injectCommandStyles();
  setupCommandControls();
  setupForms();

  await refreshDashboard();

  setupCommandControls();
  setupAutoRefresh();

  console.log("NICEGOLDMON V1 dashboard ready.");
});
