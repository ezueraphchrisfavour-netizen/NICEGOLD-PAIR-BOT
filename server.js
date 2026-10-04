require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const pino = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require("@whiskeysockets/baileys");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const BOT_NAME = "NICEGOLDMON V1.1";

const SESSIONS_DIR = path.join(__dirname, "sessions");
const DATA_DIR = path.join(__dirname, "data");

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const GROUP_SETTINGS_FILE = path.join(DATA_DIR, "group-settings.json");
const COMMANDS_FILE = path.join(DATA_DIR, "commands.json");
const REPLIES_FILE = path.join(DATA_DIR, "replies.json");

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const defaultSettings = {
  botName: BOT_NAME,
  prefix: ".",
  ownerName: "NICEGOLD",
  description: "NICEGOLDMON V1.1 WhatsApp Bot",

  autoReply: true,
  welcome: false,
  goodbye: false,
  adminOnly: false,
  antiLink: false,
  antiSpam: false,
  typing: false,

  welcomeText:
    "👋 Welcome @user to the group!\n\n𓉳 NICEGOLDMON V1.1 is online.",

  goodbyeText:
    "👋 Goodbye @user.\n\nNICEGOLDMON V1.1 wishes you well."
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let settings = {
  ...defaultSettings,
  ...readJson(SETTINGS_FILE, {})
};

let customCommands = new Map(
  readJson(COMMANDS_FILE, []).map(item => [
    String(item.name).toLowerCase(),
    item
  ])
);

let autoReplies = new Map(
  readJson(REPLIES_FILE, []).map(item => [
    String(item.trigger).toLowerCase(),
    item
  ])
);

function saveCommands() {
  writeJson(COMMANDS_FILE, [...customCommands.values()]);
}

function saveReplies() {
  writeJson(REPLIES_FILE, [...autoReplies.values()]);
}

function saveSettings() {
  writeJson(SETTINGS_FILE, settings);
}


/*
|--------------------------------------------------------------------------
| V1.1 GROUP SETTINGS
|--------------------------------------------------------------------------
*/

let groupSettings = readJson(GROUP_SETTINGS_FILE, {});

function saveGroupSettings() {
  writeJson(GROUP_SETTINGS_FILE, groupSettings);
}

function defaultGroupSettings() {
  return {
    enabled: true,
    antiLink: null,
    antiSpam: null,
    welcome: null,
    goodbye: null,
    rules: "",
    warnLimit: 3,
    updatedAt: Date.now()
  };
}

function getGroupSettings(groupId) {
  if (!groupSettings[groupId]) {
    groupSettings[groupId] = defaultGroupSettings();
    saveGroupSettings();
  }

  return groupSettings[groupId];
}

function effectiveGroupSetting(groupId, key) {
  const cfg = getGroupSettings(groupId);

  if (cfg[key] === null || cfg[key] === undefined) {
    return settings[key];
  }

  return cfg[key];
}

const sessions = new Map();

const stats = {
  startedAt: Date.now(),
  messages: 0,
  commands: 0,
  replies: 0,
  errors: 0,
  moderated: 0,
  connections: 0
};

const logs = [];

function log(type, message) {
  const item = {
    time: new Date().toISOString(),
    type,
    message
  };

  logs.unshift(item);

  if (logs.length > 200) {
    logs.length = 200;
  }

  console.log(`[${type}] ${message}`);
}

function cleanPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function sessionId(phone) {
  return cleanPhone(phone);
}

function getUptime() {
  const seconds = Math.floor((Date.now() - stats.startedAt) / 1000);

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

function getStoredSessions() {
  try {
    return fs
      .readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(item => item.isDirectory())
      .map(item => item.name);
  } catch {
    return [];
  }
}

function publicSession(item) {
  return {
    id: item.id,
    phone: item.phone,
    status: item.status,
    connected: Boolean(item.sock),
    pairingCode: item.pairingCode || null,
    createdAt: item.createdAt
  };
}

function getMessageText(message) {
  const m = message?.message;

  if (!m) return "";

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  ).trim();
}

function isGroup(jid) {
  return String(jid || "").endsWith("@g.us");
}

async function getGroupMetadata(sock, jid) {
  try {
    return await sock.groupMetadata(jid);
  } catch {
    return null;
  }
}

async function isGroupAdmin(sock, jid, sender) {
  if (!isGroup(jid)) return false;

  const metadata = await getGroupMetadata(sock, jid);

  if (!metadata) return false;

  const member = metadata.participants?.find(
    p => p.id === sender
  );

  return Boolean(
    member?.admin === "admin" ||
    member?.admin === "superadmin"
  );
}

async function sendText(sock, jid, text, quoted) {
  return sock.sendMessage(
    jid,
    { text: String(text) },
    quoted ? { quoted } : undefined
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";

  const units = ["B", "KB", "MB", "GB"];

  let i = 0;
  let value = bytes;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }

  return `${value.toFixed(2)} ${units[i]}`;
}

function randomNumber(min, max) {
  min = Number(min);
  max = Number(max);

  if (!Number.isFinite(min)) min = 1;
  if (!Number.isFinite(max)) max = 100;

  if (min > max) {
    [min, max] = [max, min];
  }

  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function factorial(n) {
  n = Number(n);

  if (!Number.isInteger(n) || n < 0 || n > 170) {
    return null;
  }

  let result = 1;

  for (let i = 2; i <= n; i++) {
    result *= i;
  }

  return result;
}

function isPrime(n) {
  n = Number(n);

  if (!Number.isInteger(n) || n < 2) return false;

  for (let i = 2; i <= Math.sqrt(n); i++) {
    if (n % i === 0) return false;
  }

  return true;
}

function reverseText(text) {
  return [...String(text)].reverse().join("");
}

function base64Encode(text) {
  return Buffer.from(String(text), "utf8").toString("base64");
}

function base64Decode(text) {
  try {
    return Buffer.from(String(text), "base64").toString("utf8");
  } catch {
    return "Invalid Base64.";
  }
}

function binaryEncode(text) {
  return [...String(text)]
    .map(char => char.charCodeAt(0).toString(2).padStart(8, "0"))
    .join(" ");
}

function binaryDecode(text) {
  try {
    return text
      .trim()
      .split(/\s+/)
      .map(binary => String.fromCharCode(parseInt(binary, 2)))
      .join("");
  } catch {
    return "Invalid binary.";
  }
}

function hexEncode(text) {
  return Buffer.from(String(text), "utf8").toString("hex");
}

function hexDecode(text) {
  try {
    return Buffer.from(String(text), "hex").toString("utf8");
  } catch {
    return "Invalid hexadecimal.";
  }
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString();
}

function formatDate(date = new Date()) {
  return date.toLocaleDateString();
}

/*
|--------------------------------------------------------------------------
| 200 COMMAND REGISTRY
|--------------------------------------------------------------------------
*/

const commandNames = [
  "menu",
  "help",
  "commands",
  "ping",
  "alive",
  "botinfo",
  "runtime",
  "uptime",
  "status",
  "owner",
  "version",
  "time",
  "date",
  "id",
  "chatid",
  "groupid",
  "prefix",
  "support",
  "source",
  "system",

  "memory",
  "cpu",
  "platform",
  "hostname",
  "node",
  "process",
  "server",
  "stats",
  "logs",
  "refresh",

  "groupinfo",
  "admins",
  "members",
  "groupname",
  "groupdesc",
  "groupinvite",
  "welcome",
  "goodbye",
  "antilink",
  "antispam",
  "adminonly",
  "promote",
  "demote",
  "kick",
  "add",
  "revoke",
  "join",
  "leave",
  "warn",
  "warnings",

  "clearwarn",
  "setwelcome",
  "setgoodbye",
  "settings",
  "setprefix",
  "setbotname",
  "setowner",
  "setdescription",
  "autoreply",
  "addreply",
  "delreply",
  "listreplies",
  "addcmd",
  "delcmd",
  "listcmd",
  "enablecmd",
  "disablecmd",
  "enablebot",
  "disablebot",
  "reload",

  "joke",
  "quote",
  "fact",
  "truth",
  "dare",
  "riddle",
  "8ball",
  "coinflip",
  "dice",
  "roll",
  "choose",
  "random",
  "roast",
  "compliment",
  "rate",
  "ship",
  "compatibility",
  "say",
  "echo",
  "reverse",

  "guess",
  "guessnumber",
  "rps",
  "trivia",
  "quiz",
  "wordgame",
  "scramble",
  "mathgame",
  "higherlower",
  "memorygame",
  "slots",
  "duel",
  "score",
  "leaderboard",

  "calc",
  "calculate",
  "percentage",
  "average",
  "factorial",
  "prime",
  "randomnum",
  "count",
  "length",
  "uppercase",
  "lowercase",
  "capitalize",
  "repeat",
  "base64",
  "unbase64",
  "binary",
  "unbinary",
  "hex",
  "unhex",
  "timestamp",

  "unix",
  "json",
  "uuid",
  "password",
  "color",
  "unit",
  "convert",
  "calendar",
  "worldtime",
  "timezone",
  "country",
  "currency",
  "define",
  "wiki",
  "translate",
  "search",
  "url",
  "shorturl",
  "qr",

  "bold",
  "italic",
  "strike",
  "mono",
  "small",
  "big",
  "fancy",
  "spoiler",
  "repeattext",
  "copy",
  "save",
  "contact",
  "vcard",
  "poll",
  "react",
  "quote",
  "read",
  "timestamp2",

  "ai",
  "ask",
  "explain",
  "summarize",
  "rewrite",
  "grammar",
  "code",
  "debug",
  "idea",
  "story",

  "github",
  "npm",
  "google",
  "youtube",
  "instagram",
  "telegram",
  "whatsapp",
  "facebook",
  "tiktok",
  "reddit",

  "nicegold",
  "ngm",
  "about",
  "credits",
  "features",
  "dashboard",
  "pair",
  "session",
  "profile",
  "helpme",
  "info"
];

const uniqueCommandNames = [...new Set(commandNames)].slice(0, 200);

const commandRegistry = new Map();

for (const name of uniqueCommandNames) {
  commandRegistry.set(name, {
    name,
    enabled: true,
    description: `${name} command`
  });
}

function commandHelp(prefix) {
  const names = [...commandRegistry.keys()];

  let output = `╔══════════════════════════════╗
║      𓉳 NICEGOLDMON V1.1       ║
║       COMMAND CENTER         ║
╚══════════════════════════════╝

Prefix: ${prefix}

`;

  for (let i = 0; i < names.length; i += 4) {
    output += names
      .slice(i, i + 4)
      .map(name => `${prefix}${name}`)
      .join("   ");

    output += "\n";
  }

  return output;
}

function getCommandList() {
  return [
    ...[...commandRegistry.values()].map(command => ({
      ...command,
      builtin: true
    })),
    ...[...customCommands.values()].map(command => ({
      ...command,
      builtin: false
    }))
  ];
}

/*
|--------------------------------------------------------------------------
| WARNING / SPAM TRACKING
|--------------------------------------------------------------------------
*/

const warnings = new Map();
const spamTracker = new Map();

function warningKey(group, user) {
  return `${group}:${user}`;
}

function addWarning(group, user) {
  const key = warningKey(group, user);

  const current = warnings.get(key) || 0;
  const next = current + 1;

  warnings.set(key, next);

  return next;
}

function getWarnings(group, user) {
  return warnings.get(warningKey(group, user)) || 0;
}

function clearWarnings(group, user) {
  warnings.delete(warningKey(group, user));
}

function checkSpam(group, user, text) {
  const key = `${group}:${user}`;
  const now = Date.now();

  const record = spamTracker.get(key) || {
    timestamps: [],
    lastText: ""
  };

  record.timestamps = record.timestamps.filter(
    time => now - time < 8000
  );

  record.timestamps.push(now);

  const repeated =
    record.lastText &&
    record.lastText.toLowerCase() === text.toLowerCase();

  record.lastText = text;

  spamTracker.set(key, record);

  return record.timestamps.length >= 5 || repeated && record.timestamps.length >= 3;
}

/*
|--------------------------------------------------------------------------
| COMMAND EXECUTION
|--------------------------------------------------------------------------
*/

async function executeCommand({
  sock,
  msg,
  jid,
  sender,
  command,
  args,
  isAdmin
}) {
  const name = command.toLowerCase();

  stats.commands++;

  const prefix = settings.prefix;

  if (customCommands.has(name)) {
    const custom = customCommands.get(name);

    if (custom.enabled === false) {
      return;
    }

    await sendText(
      sock,
      jid,
      String(custom.response || "").replace(
        /@user/g,
        `@${sender.split("@")[0]}`
      ),
      msg
    );

    stats.replies++;
    return;
  }

  if (!commandRegistry.has(name)) {
    return;
  }

  /*
  |--------------------------------------------------------------------------
  | ADMIN CHECK
  |--------------------------------------------------------------------------
  */

  const adminCommands = new Set([
    "promote",
    "demote",
    "kick",
    "add",
    "revoke",
    "join",
    "leave",
    "setwelcome",
    "setgoodbye",
    "setprefix",
    "setbotname",
    "setowner",
    "setdescription",
    "antilink",
    "antispam",
    "adminonly",
    "reload",
    "enablebot",
    "disablebot",
    "addcmd",
    "delcmd",
    "addreply",
    "delreply"
  ]);

  if (
    isGroup(jid) &&
    (settings.adminOnly || adminCommands.has(name)) &&
    !isAdmin
  ) {
    await sendText(
      sock,
      jid,
      "⛔ This command requires group-admin permission.",
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | BASIC
  |--------------------------------------------------------------------------
  */

  if (name === "ping") {
    await sendText(sock, jid, "🏓 PONG!\nNICEGOLDMON is responding.", msg);
    return;
  }

  if (name === "alive") {
    await sendText(
      sock,
      jid,
      `🟢 ${settings.botName}\n\nBot is alive and running.`,
      msg
    );
    return;
  }

  if (
    name === "menu" ||
    name === "help" ||
    name === "commands" ||
    name === "helpme"
  ) {
    await sendText(sock, jid, commandHelp(prefix), msg);
    return;
  }

  if (name === "botinfo" || name === "about" || name === "info") {
    await sendText(
      sock,
      jid,
      `𓉳 ${settings.botName}

Owner: ${settings.ownerName}
Prefix: ${settings.prefix}
Version: V1
Description: ${settings.description}

Commands: ${commandRegistry.size}
Status: ONLINE
Uptime: ${getUptime()}`,
      msg
    );

    return;
  }

  if (
    name === "runtime" ||
    name === "uptime"
  ) {
    await sendText(sock, jid, `⏱️ Runtime: ${getUptime()}`, msg);
    return;
  }

  if (name === "status") {
    await sendText(
      sock,
      jid,
      `🟢 STATUS: ONLINE

Bots: ${[...sessions.values()].length}
Messages: ${stats.messages}
Commands: ${stats.commands}
Replies: ${stats.replies}
Moderated: ${stats.moderated}
Errors: ${stats.errors}
Uptime: ${getUptime()}`,
      msg
    );

    return;
  }

  if (name === "owner") {
    await sendText(
      sock,
      jid,
      `👑 Owner: ${settings.ownerName}`,
      msg
    );

    return;
  }

  if (name === "version") {
    await sendText(sock, jid, "𓉳 NICEGOLDMON V1.1", msg);
    return;
  }

  if (name === "time") {
    await sendText(sock, jid, `🕐 ${formatTime()}`, msg);
    return;
  }

  if (name === "date") {
    await sendText(sock, jid, `📅 ${formatDate()}`, msg);
    return;
  }

  if (
    name === "id" ||
    name === "chatid" ||
    name === "groupid"
  ) {
    await sendText(sock, jid, `🆔 ${jid}`, msg);
    return;
  }

  if (name === "prefix") {
    await sendText(sock, jid, `Prefix: ${settings.prefix}`, msg);
    return;
  }

  if (name === "support") {
    await sendText(
      sock,
      jid,
      "🛠️ NICEGOLDMON V1.1 Support\n\nUse .menu to view available commands.",
      msg
    );

    return;
  }

  if (name === "source") {
    await sendText(
      sock,
      jid,
      "𓉳 NICEGOLDMON V1.1\nWeb Control Center",
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | SYSTEM
  |--------------------------------------------------------------------------
  */

  if (name === "system") {
    await sendText(
      sock,
      jid,
      `🖥️ SYSTEM

OS: ${os.platform()}
Arch: ${os.arch()}
Node: ${process.version}
CPU: ${os.cpus().length}
Memory: ${formatBytes(os.totalmem())}
Free: ${formatBytes(os.freemem())}`,
      msg
    );

    return;
  }

  if (name === "memory") {
    const mem = process.memoryUsage();

    await sendText(
      sock,
      jid,
      `🧠 MEMORY

RSS: ${formatBytes(mem.rss)}
Heap Used: ${formatBytes(mem.heapUsed)}
Heap Total: ${formatBytes(mem.heapTotal)}`,
      msg
    );

    return;
  }

  if (name === "cpu") {
    await sendText(
      sock,
      jid,
      `⚙️ CPU

Cores: ${os.cpus().length}
Architecture: ${os.arch()}
Platform: ${os.platform()}`,
      msg
    );

    return;
  }

  if (name === "platform") {
    await sendText(sock, jid, `${os.platform()} ${os.arch()}`, msg);
    return;
  }

  if (name === "hostname") {
    await sendText(sock, jid, os.hostname(), msg);
    return;
  }

  if (name === "node") {
    await sendText(sock, jid, process.version, msg);
    return;
  }

  if (name === "process") {
    await sendText(
      sock,
      jid,
      `PID: ${process.pid}\nUptime: ${getUptime()}`,
      msg
    );

    return;
  }

  if (name === "server") {
    await sendText(
      sock,
      jid,
      `🟢 Server online\nPort: ${PORT}`,
      msg
    );

    return;
  }

  if (name === "stats") {
    await sendText(
      sock,
      jid,
      `📊 BOT STATISTICS

Messages: ${stats.messages}
Commands: ${stats.commands}
Replies: ${stats.replies}
Moderated: ${stats.moderated}
Errors: ${stats.errors}
Uptime: ${getUptime()}`,
      msg
    );

    return;
  }

  if (name === "logs") {
    const recent = logs
      .slice(0, 8)
      .map(item => `[${item.type}] ${item.message}`)
      .join("\n");

    await sendText(
      sock,
      jid,
      recent || "No logs available.",
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | GROUP INFORMATION
  |--------------------------------------------------------------------------
  */

  if (name === "groupinfo") {
    if (!isGroup(jid)) {
      await sendText(sock, jid, "This command is for groups.", msg);
      return;
    }

    const metadata = await getGroupMetadata(sock, jid);

    if (!metadata) {
      await sendText(sock, jid, "Unable to read group information.", msg);
      return;
    }

    const admins = metadata.participants.filter(
      p => p.admin
    ).length;

    await sendText(
      sock,
      jid,
      `👥 GROUP INFO

Name: ${metadata.subject}
ID: ${metadata.id}
Members: ${metadata.participants.length}
Admins: ${admins}
Description:
${metadata.desc || "No description"}`,
      msg
    );

    return;
  }

  if (name === "admins") {
    if (!isGroup(jid)) return;

    const metadata = await getGroupMetadata(sock, jid);

    const admins = metadata?.participants?.filter(
      p => p.admin
    ) || [];

    await sendText(
      sock,
      jid,
      `👑 ADMINS\n\n${admins
        .map((p, i) => `${i + 1}. @${p.id.split("@")[0]}`)
        .join("\n") || "No admins found."}`,
      msg
    );

    return;
  }

  if (name === "members") {
    if (!isGroup(jid)) return;

    const metadata = await getGroupMetadata(sock, jid);

    await sendText(
      sock,
      jid,
      `👥 Members: ${metadata?.participants?.length || 0}`,
      msg
    );

    return;
  }

  if (name === "groupname") {
    if (!isGroup(jid)) return;

    const metadata = await getGroupMetadata(sock, jid);

    await sendText(
      sock,
      jid,
      `Group: ${metadata?.subject || "Unknown"}`,
      msg
    );

    return;
  }

  if (name === "groupdesc") {
    if (!isGroup(jid)) return;

    const metadata = await getGroupMetadata(sock, jid);

    await sendText(
      sock,
      jid,
      metadata?.desc || "This group has no description.",
      msg
    );

    return;
  }

  if (name === "groupinvite") {
    if (!isGroup(jid)) return;

    try {
      const code = await sock.groupInviteCode(jid);

      await sendText(
        sock,
        jid,
        `🔗 Group invite code:\n${code}`,
        msg
      );
    } catch {
      await sendText(
        sock,
        jid,
        "Unable to retrieve the group invite code.",
        msg
      );
    }

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | GROUP SETTINGS
  |--------------------------------------------------------------------------
  */

  if (name === "welcome") {
    settings.welcome = !settings.welcome;
    saveSettings();

    await sendText(
      sock,
      jid,
      `Welcome messages: ${settings.welcome ? "ON 🟢" : "OFF 🔴"}`,
      msg
    );

    return;
  }

  if (name === "goodbye") {
    settings.goodbye = !settings.goodbye;
    saveSettings();

    await sendText(
      sock,
      jid,
      `Goodbye messages: ${settings.goodbye ? "ON 🟢" : "OFF 🔴"}`,
      msg
    );

    return;
  }

  if (name === "antilink") {
    settings.antiLink = !settings.antiLink;
    saveSettings();

    await sendText(
      sock,
      jid,
      `Anti-link: ${settings.antiLink ? "ON 🟢" : "OFF 🔴"}`,
      msg
    );

    return;
  }

  if (name === "antispam") {
    settings.antiSpam = !settings.antiSpam;
    saveSettings();

    await sendText(
      sock,
      jid,
      `Anti-spam: ${settings.antiSpam ? "ON 🟢" : "OFF 🔴"}`,
      msg
    );

    return;
  }

  if (name === "adminonly") {
    settings.adminOnly = !settings.adminOnly;
    saveSettings();

    await sendText(
      sock,
      jid,
      `Admin-only mode: ${
        settings.adminOnly ? "ON 🟢" : "OFF 🔴"
      }`,
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | WARNINGS
  |--------------------------------------------------------------------------
  */

  if (name === "warn") {
    if (!isGroup(jid)) return;

    const target =
      msg.message?.extendedTextMessage?.contextInfo?.participant;

    if (!target) {
      await sendText(
        sock,
        jid,
        `Reply to a user's message to warn them.`,
        msg
      );

      return;
    }

    const count = addWarning(jid, target);

    await sendText(
      sock,
      jid,
      `⚠️ Warning issued.\n\nUser: @${target.split("@")[0]}\nWarnings: ${count}`,
      msg
    );

    return;
  }

  if (name === "warnings") {
    const target =
      msg.message?.extendedTextMessage?.contextInfo?.participant ||
      sender;

    await sendText(
      sock,
      jid,
      `⚠️ Warnings: ${getWarnings(jid, target)}`,
      msg
    );

    return;
  }

  if (name === "clearwarn") {
    const target =
      msg.message?.extendedTextMessage?.contextInfo?.participant ||
      sender;

    clearWarnings(jid, target);

    await sendText(sock, jid, "✅ Warnings cleared.", msg);
    return;
  }

  /*
  |--------------------------------------------------------------------------
  | GROUP ADMIN ACTIONS
  |--------------------------------------------------------------------------
  */

  if (
    name === "promote" ||
    name === "demote" ||
    name === "kick" ||
    name === "add"
  ) {
    if (!isGroup(jid)) return;

    const target =
      msg.message?.extendedTextMessage?.contextInfo?.participant ||
      args[0];

    if (!target) {
      await sendText(
        sock,
        jid,
        `Reply to a user's message or provide their number.`,
        msg
      );

      return;
    }

    const number = target.includes("@")
      ? target.split("@")[0]
      : target.replace(/\D/g, "");

    const targetJid = target.includes("@")
      ? target
      : `${number}@s.whatsapp.net`;

    try {
      if (name === "promote") {
        await sock.groupParticipantsUpdate(
          jid,
          [targetJid],
          "promote"
        );

        await sendText(sock, jid, "✅ User promoted.", msg);
      }

      if (name === "demote") {
        await sock.groupParticipantsUpdate(
          jid,
          [targetJid],
          "demote"
        );

        await sendText(sock, jid, "✅ User demoted.", msg);
      }

      if (name === "kick") {
        await sock.groupParticipantsUpdate(
          jid,
          [targetJid],
          "remove"
        );

        await sendText(sock, jid, "✅ User removed.", msg);
      }

      if (name === "add") {
        await sock.groupParticipantsUpdate(
          jid,
          [targetJid],
          "add"
        );

        await sendText(sock, jid, "✅ User added.", msg);
      }
    } catch (error) {
      stats.errors++;

      await sendText(
        sock,
        jid,
        `❌ Group action failed.\n\n${error.message || "Unknown error"}`,
        msg
      );
    }

    return;
  }

  if (name === "revoke") {
    if (!isGroup(jid)) return;

    try {
      await sock.groupRevokeInvite(jid);

      await sendText(
        sock,
        jid,
        "🔐 Group invite link has been reset.",
        msg
      );
    } catch {
      await sendText(
        sock,
        jid,
        "Unable to reset the invite link.",
        msg
      );
    }

    return;
  }

  if (name === "leave") {
    await sendText(sock, jid, "👋 NICEGOLDMON is leaving this chat.", msg);

    setTimeout(() => {
      sock.groupLeave(jid).catch(() => {});
    }, 1000);

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | FUN
  |--------------------------------------------------------------------------
  */

  if (name === "joke") {
    const jokes = [
      "Why did the developer go broke? Because he used up all his cache.",
      "My code works. I have no idea why.",
      "There are only 10 kinds of people: those who understand binary and those who don't.",
      "A programmer's favorite place? The coffee cache.",
      "I told my computer I needed a break. Now it keeps sending me KitKat ads."
    ];

    await sendText(
      sock,
      jid,
      `😂 ${jokes[randomNumber(0, jokes.length - 1)]}`,
      msg
    );

    return;
  }

  if (name === "quote") {
    const quotes = [
      "Keep learning.",
      "Small progress is still progress.",
      "Build, test, improve.",
      "Consistency beats temporary excitement.",
      "Your next version can be better than your current one."
    ];

    await sendText(
      sock,
      jid,
      `💭 "${quotes[randomNumber(0, quotes.length - 1)]}"`,
      msg
    );

    return;
  }

  if (name === "fact") {
    const facts = [
      "A day on Venus is longer than its year.",
      "Octopuses have three hearts.",
      "Honey can remain edible for an extremely long time when properly stored.",
      "Bananas are botanically berries.",
      "Water expands when it freezes."
    ];

    await sendText(
      sock,
      jid,
      `🧠 ${facts[randomNumber(0, facts.length - 1)]}`,
      msg
    );

    return;
  }

  if (name === "truth") {
    await sendText(
      sock,
      jid,
      "🎯 Truth: What is one goal you genuinely want to accomplish this year?",
      msg
    );

    return;
  }

  if (name === "dare") {
    await sendText(
      sock,
      jid,
      "🎲 Dare: Send a funny emoji that describes your mood.",
      msg
    );

    return;
  }

  if (name === "riddle") {
    await sendText(
      sock,
      jid,
      "🧩 Riddle:\nWhat has keys but cannot open locks?\n\nAnswer: A keyboard.",
      msg
    );

    return;
  }

  if (name === "8ball") {
    const answers = [
      "Yes.",
      "No.",
      "Probably.",
      "Definitely.",
      "Not likely.",
      "Ask again later.",
      "The signs point to yes.",
      "The answer is unclear."
    ];

    await sendText(
      sock,
      jid,
      `🎱 ${answers[randomNumber(0, answers.length - 1)]}`,
      msg
    );

    return;
  }

  if (name === "coinflip") {
    await sendText(
      sock,
      jid,
      `🪙 ${Math.random() < 0.5 ? "HEADS" : "TAILS"}`,
      msg
    );

    return;
  }

  if (name === "dice" || name === "roll") {
    await sendText(
      sock,
      jid,
      `🎲 You rolled: ${randomNumber(1, 6)}`,
      msg
    );

    return;
  }

  if (name === "choose") {
    if (!args.length) {
      await sendText(
        sock,
        jid,
        `Usage: ${prefix}choose pizza|burger|rice`,
        msg
      );

      return;
    }

    const choices = args
      .join(" ")
      .split("|")
      .map(x => x.trim())
      .filter(Boolean);

    if (!choices.length) return;

    await sendText(
      sock,
      jid,
      `🎯 Choice: ${choices[randomNumber(0, choices.length - 1)]}`,
      msg
    );

    return;
  }

  if (name === "random") {
    await sendText(
      sock,
      jid,
      `🎲 Random number: ${randomNumber(1, 100)}`,
      msg
    );

    return;
  }

  if (name === "roast") {
    await sendText(
      sock,
      jid,
      "🔥 Your Wi-Fi has more personality than you do.",
      msg
    );

    return;
  }

  if (name === "compliment") {
    await sendText(
      sock,
      jid,
      "✨ You're doing better than you think. Keep building.",
      msg
    );

    return;
  }

  if (
    name === "rate" ||
    name === "ship" ||
    name === "compatibility"
  ) {
    await sendText(
      sock,
      jid,
      `💫 Result: ${randomNumber(1, 100)}%`,
      msg
    );

    return;
  }

  if (name === "say" || name === "echo") {
    await sendText(
      sock,
      jid,
      args.join(" ") || "Nothing to echo.",
      msg
    );

    return;
  }

  if (name === "reverse") {
    await sendText(
      sock,
      jid,
      reverseText(args.join(" ")),
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | GAMES
  |--------------------------------------------------------------------------
  */

  if (
    name === "guess" ||
    name === "guessnumber"
  ) {
    const number = randomNumber(1, 10);
    const guess = Number(args[0]);

    if (!Number.isFinite(guess)) {
      await sendText(
        sock,
        jid,
        `🎯 Guess a number from 1 to 10.\nExample: ${prefix}guess 7`,
        msg
      );

      return;
    }

    await sendText(
      sock,
      jid,
      guess === number
        ? `🎉 Correct! The number was ${number}.`
        : `❌ Not this time. The number was ${number}.`,
      msg
    );

    return;
  }

  if (name === "rps") {
    const choices = ["rock", "paper", "scissors"];

    const userChoice = String(args[0] || "").toLowerCase();
    const botChoice =
      choices[randomNumber(0, choices.length - 1)];

    if (!choices.includes(userChoice)) {
      await sendText(
        sock,
        jid,
        `Usage: ${prefix}rps rock\n\nChoose rock, paper or scissors.`,
        msg
      );

      return;
    }

    let result = "Draw.";

    if (
      userChoice === "rock" && botChoice === "scissors" ||
      userChoice === "paper" && botChoice === "rock" ||
      userChoice === "scissors" && botChoice === "paper"
    ) {
      result = "You win! 🎉";
    } else if (userChoice !== botChoice) {
      result = "I win! 🤖";
    }

    await sendText(
      sock,
      jid,
      `🎮 You: ${userChoice}
🤖 Bot: ${botChoice}

${result}`,
      msg
    );

    return;
  }

  if (
    name === "trivia" ||
    name === "quiz"
  ) {
    const questions = [
      ["What planet is known as the Red Planet?", "Mars"],
      ["How many days are in a leap year?", "366"],
      ["What is the largest ocean?", "Pacific Ocean"],
      ["What language runs in a web browser?", "JavaScript"],
      ["What is 5 × 5?", "25"]
    ];

    const question =
      questions[randomNumber(0, questions.length - 1)];

    await sendText(
      sock,
      jid,
      `🧠 QUIZ

Question:
${question[0]}

Answer: ${question[1]}`,
      msg
    );

    return;
  }

  if (
    name === "wordgame" ||
    name === "scramble"
  ) {
    const words = [
      "javascript",
      "whatsapp",
      "nicegold",
      "computer",
      "network",
      "developer"
    ];

    const word = words[randomNumber(0, words.length - 1)];

    await sendText(
      sock,
      jid,
      `🔤 Unscramble this word:

${reverseText(word)}

Answer: ${word}`,
      msg
    );

    return;
  }

  if (name === "mathgame") {
    const a = randomNumber(1, 20);
    const b = randomNumber(1, 20);

    await sendText(
      sock,
      jid,
      `🧮 ${a} + ${b} = ?\n\nAnswer: ${a + b}`,
      msg
    );

    return;
  }

  if (name === "higherlower") {
    const number = randomNumber(1, 100);

    await sendText(
      sock,
      jid,
      `🎯 Secret number generated.\nHint: ${number > 50 ? "Higher than 50" : "50 or lower"}`,
      msg
    );

    return;
  }

  if (name === "memorygame") {
    const symbols = ["🍎", "🚀", "⭐", "🎯", "💎"];

    const first = symbols[randomNumber(0, symbols.length - 1)];
    const second = symbols[randomNumber(0, symbols.length - 1)];

    await sendText(
      sock,
      jid,
      `🧠 MEMORY

Remember:
${first} ${second} ${first}

Can you remember the sequence?`,
      msg
    );

    return;
  }

  if (name === "slots") {
    const symbols = ["🍒", "🍋", "⭐", "💎", "7️⃣"];

    const result = [
      symbols[randomNumber(0, symbols.length - 1)],
      symbols[randomNumber(0, symbols.length - 1)],
      symbols[randomNumber(0, symbols.length - 1)]
    ];

    const win =
      result[0] === result[1] &&
      result[1] === result[2];

    await sendText(
      sock,
      jid,
      `🎰 ${result.join(" | ")}\n\n${win ? "🎉 JACKPOT!" : "Try again."}`,
      msg
    );

    return;
  }

  if (name === "duel") {
    await sendText(
      sock,
      jid,
      `⚔️ DUEL RESULT\n\nPower: ${randomNumber(1, 100)}\nSpeed: ${randomNumber(1, 100)}\nLuck: ${randomNumber(1, 100)}`,
      msg
    );

    return;
  }

  if (
    name === "score" ||
    name === "leaderboard"
  ) {
    await sendText(
      sock,
      jid,
      "🏆 Leaderboard tracking is ready for the next game-system update.",
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | CALCULATOR / UTILITIES
  |--------------------------------------------------------------------------
  */

  if (
    name === "calc" ||
    name === "calculate"
  ) {
    const expression = args.join(" ");

    if (!expression) {
      await sendText(
        sock,
        jid,
        `Usage: ${prefix}calc 25 * 4`,
        msg
      );

      return;
    }

    if (!/^[0-9+\-*/().%\s]+$/.test(expression)) {
      await sendText(
        sock,
        jid,
        "❌ Only basic mathematical expressions are allowed.",
        msg
      );

      return;
    }

    try {
      const result = Function(
        `"use strict"; return (${expression})`
      )();

      await sendText(
        sock,
        jid,
        `🧮 ${expression} = ${result}`,
        msg
      );
    } catch {
      await sendText(
        sock,
        jid,
        "❌ Invalid calculation.",
        msg
      );
    }

    return;
  }

  if (name === "percentage") {
    const value = Number(args[0]);
    const percent = Number(args[1]);

    if (!Number.isFinite(value) || !Number.isFinite(percent)) {
      await sendText(
        sock,
        jid,
        `Usage: ${prefix}percentage 500 20`,
        msg
      );

      return;
    }

    await sendText(
      sock,
      jid,
      `${percent}% of ${value} = ${(value * percent) / 100}`,
      msg
    );

    return;
  }

  if (name === "average") {
    const nums = args
      .map(Number)
      .filter(Number.isFinite);

    if (!nums.length) {
      await sendText(sock, jid, "Provide some numbers.", msg);
      return;
    }

    const result =
      nums.reduce((a, b) => a + b, 0) / nums.length;

    await sendText(
      sock,
      jid,
      `📊 Average: ${result}`,
      msg
    );

    return;
  }

  if (name === "factorial") {
    const result = factorial(args[0]);

    await sendText(
      sock,
      jid,
      result === null
        ? "❌ Enter an integer from 0 to 170."
        : `${args[0]}! = ${result}`,
      msg
    );

    return;
  }

  if (name === "prime") {
    const n = Number(args[0]);

    await sendText(
      sock,
      jid,
      Number.isFinite(n)
        ? `${n} is ${isPrime(n) ? "prime" : "not prime"}.`
        : "Provide a number.",
      msg
    );

    return;
  }

  if (name === "randomnum") {
    const min = Number(args[0] || 1);
    const max = Number(args[1] || 100);

    await sendText(
      sock,
      jid,
      `🎲 ${randomNumber(min, max)}`,
      msg
    );

    return;
  }

  if (name === "count") {
    const text = args.join(" ");

    await sendText(
      sock,
      jid,
      `Characters: ${text.length}\nWords: ${
        text.trim() ? text.trim().split(/\s+/).length : 0
      }`,
      msg
    );

    return;
  }

  if (name === "length") {
    const text = args.join(" ");

    await sendText(
      sock,
      jid,
      `Length: ${text.length}`,
      msg
    );

    return;
  }

  if (name === "uppercase") {
    await sendText(
      sock,
      jid,
      args.join(" ").toUpperCase(),
      msg
    );

    return;
  }

  if (name === "lowercase") {
    await sendText(
      sock,
      jid,
      args.join(" ").toLowerCase(),
      msg
    );

    return;
  }

  if (name === "capitalize") {
    const text = args.join(" ");

    await sendText(
      sock,
      jid,
      text.replace(/\b\w/g, char => char.toUpperCase()),
      msg
    );

    return;
  }

  if (
    name === "repeat" ||
    name === "repeattext"
  ) {
    const count = Math.min(
      Math.max(Number(args[0]) || 1, 1),
      20
    );

    const text = args.slice(1).join(" ");

    await sendText(
      sock,
      jid,
      Array(count).fill(text).join("\n"),
      msg
    );

    return;
  }

  if (name === "base64") {
    await sendText(
      sock,
      jid,
      base64Encode(args.join(" ")),
      msg
    );

    return;
  }

  if (name === "unbase64") {
    await sendText(
      sock,
      jid,
      base64Decode(args.join(" ")),
      msg
    );

    return;
  }

  if (name === "binary") {
    await sendText(
      sock,
      jid,
      binaryEncode(args.join(" ")),
      msg
    );

    return;
  }

  if (name === "unbinary") {
    await sendText(
      sock,
      jid,
      binaryDecode(args.join(" ")),
      msg
    );

    return;
  }

  if (name === "hex") {
    await sendText(
      sock,
      jid,
      hexEncode(args.join(" ")),
      msg
    );

    return;
  }

  if (name === "unhex") {
    await sendText(
      sock,
      jid,
      hexDecode(args.join(" ")),
      msg
    );

    return;
  }

  if (
    name === "timestamp" ||
    name === "timestamp2"
  ) {
    await sendText(
      sock,
      jid,
      String(Date.now()),
      msg
    );

    return;
  }

  if (name === "unix") {
    await sendText(
      sock,
      jid,
      String(Math.floor(Date.now() / 1000)),
      msg
    );

    return;
  }

  if (name === "uuid") {
    await sendText(
      sock,
      jid,
      cryptoRandomUUID(),
      msg
    );

    return;
  }

  if (name === "password") {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    let password = "";

    for (let i = 0; i < 16; i++) {
      password += chars[
        randomNumber(0, chars.length - 1)
      ];
    }

    await sendText(
      sock,
      jid,
      `🔐 Random password:\n${password}`,
      msg
    );

    return;
  }

  if (name === "color") {
    const hex =
      "#" +
      Math.floor(Math.random() * 0xffffff)
        .toString(16)
        .padStart(6, "0");

    await sendText(
      sock,
      jid,
      `🎨 ${hex}`,
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | DATE / WORLD
  |--------------------------------------------------------------------------
  */

  if (name === "calendar") {
    await sendText(
      sock,
      jid,
      new Date().toString(),
      msg
    );

    return;
  }

  if (
    name === "worldtime" ||
    name === "timezone"
  ) {
    await sendText(
      sock,
      jid,
      `🌍 Server time:\n${new Date().toString()}`,
      msg
    );

    return;
  }

  if (name === "country") {
    await sendText(
      sock,
      jid,
      `🌍 Country information requires a country name.\nExample: ${prefix}country Nigeria`,
      msg
    );

    return;
  }

  if (name === "currency") {
    await sendText(
      sock,
      jid,
      "💱 Currency conversion requires two currencies and an amount.",
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | TEXT FORMATTING
  |--------------------------------------------------------------------------
  */

  if (name === "bold") {
    await sendText(
      sock,
      jid,
      `*${args.join(" ")}*`,
      msg
    );

    return;
  }

  if (name === "italic") {
    await sendText(
      sock,
      jid,
      `_${args.join(" ")}_`,
      msg
    );

    return;
  }

  if (name === "strike") {
    await sendText(
      sock,
      jid,
      `~${args.join(" ")}~`,
      msg
    );

    return;
  }

  if (name === "mono") {
    await sendText(
      sock,
      jid,
      "```" + args.join(" ") + "```",
      msg
    );

    return;
  }

  if (name === "small") {
    const text = args.join(" ");

    await sendText(
      sock,
      jid,
      text.toLowerCase(),
      msg
    );

    return;
  }

  if (name === "big") {
    await sendText(
      sock,
      jid,
      args.join(" ").toUpperCase(),
      msg
    );

    return;
  }

  if (name === "fancy") {
    const map = {
      a: "ᴀ",
      b: "ʙ",
      c: "ᴄ",
      d: "ᴅ",
      e: "ᴇ",
      f: "ғ",
      g: "ɢ",
      h: "ʜ",
      i: "ɪ",
      j: "ᴊ",
      k: "ᴋ",
      l: "ʟ",
      m: "ᴍ",
      n: "ɴ",
      o: "ᴏ",
      p: "ᴘ",
      q: "ǫ",
      r: "ʀ",
      s: "s",
      t: "ᴛ",
      u: "ᴜ",
      v: "ᴠ",
      w: "ᴡ",
      x: "x",
      y: "ʏ",
      z: "ᴢ"
    };

    const result = args
      .join(" ")
      .toLowerCase()
      .split("")
      .map(char => map[char] || char)
      .join("");

    await sendText(sock, jid, result, msg);
    return;
  }

  if (name === "spoiler") {
    await sendText(
      sock,
      jid,
      `||${args.join(" ")}||`,
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | BOT SETTINGS
  |--------------------------------------------------------------------------
  */

  if (name === "settings") {
    await sendText(
      sock,
      jid,
      `⚙️ SETTINGS

Bot: ${settings.botName}
Prefix: ${settings.prefix}
Owner: ${settings.ownerName}

Auto Reply: ${settings.autoReply ? "ON" : "OFF"}
Welcome: ${settings.welcome ? "ON" : "OFF"}
Goodbye: ${settings.goodbye ? "ON" : "OFF"}
Admin Only: ${settings.adminOnly ? "ON" : "OFF"}
Anti Link: ${settings.antiLink ? "ON" : "OFF"}
Anti Spam: ${settings.antiSpam ? "ON" : "OFF"}
Typing: ${settings.typing ? "ON" : "OFF"}`,
      msg
    );

    return;
  }

  if (name === "setprefix") {
    if (!args[0]) {
      await sendText(
        sock,
        jid,
        `Current prefix: ${settings.prefix}`,
        msg
      );

      return;
    }

    settings.prefix = args[0][0];
    saveSettings();

    await sendText(
      sock,
      jid,
      `✅ Prefix changed to ${settings.prefix}`,
      msg
    );

    return;
  }

  if (name === "setbotname") {
    settings.botName = args.join(" ") || BOT_NAME;
    saveSettings();

    await sendText(
      sock,
      jid,
      `✅ Bot name: ${settings.botName}`,
      msg
    );

    return;
  }

  if (name === "setowner") {
    settings.ownerName =
      args.join(" ") || settings.ownerName;

    saveSettings();

    await sendText(
      sock,
      jid,
      `✅ Owner: ${settings.ownerName}`,
      msg
    );

    return;
  }

  if (name === "setdescription") {
    settings.description =
      args.join(" ") || settings.description;

    saveSettings();

    await sendText(
      sock,
      jid,
      "✅ Description updated.",
      msg
    );

    return;
  }

  if (name === "enablebot") {
    settings.autoReply = true;
    saveSettings();

    await sendText(
      sock,
      jid,
      "🟢 Bot features enabled.",
      msg
    );

    return;
  }

  if (name === "disablebot") {
    settings.autoReply = false;
    saveSettings();

    await sendText(
      sock,
      jid,
      "🔴 Automatic replies disabled.",
      msg
    );

    return;
  }

  if (name === "reload" || name === "refresh") {
    settings = {
      ...defaultSettings,
      ...readJson(SETTINGS_FILE, {})
    };

    await sendText(
      sock,
      jid,
      "♻️ NICEGOLDMON settings reloaded.",
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | CUSTOM COMMAND MANAGEMENT
  |--------------------------------------------------------------------------
  */

  if (name === "addcmd") {
    const commandName = String(args[0] || "")
      .replace(/^\./, "")
      .toLowerCase();

    const response = args.slice(1).join(" ");

    if (!commandName || !response) {
      await sendText(
        sock,
        jid,
        `Usage: ${prefix}addcmd hello Hello there!`,
        msg
      );

      return;
    }

    customCommands.set(commandName, {
      name: commandName,
      response,
      enabled: true
    });

    saveCommands();

    await sendText(
      sock,
      jid,
      `✅ Custom command ${prefix}${commandName} created.`,
      msg
    );

    return;
  }

  if (name === "delcmd") {
    const commandName = String(args[0] || "")
      .replace(/^\./, "")
      .toLowerCase();

    customCommands.delete(commandName);
    saveCommands();

    await sendText(
      sock,
      jid,
      `🗑️ Custom command removed: ${commandName}`,
      msg
    );

    return;
  }

  if (name === "listcmd") {
    const list = [...customCommands.keys()];

    await sendText(
      sock,
      jid,
      list.length
        ? `🧩 CUSTOM COMMANDS\n\n${list
            .map(x => `${prefix}${x}`)
            .join("\n")}`
        : "No custom commands.",
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | AI PLACEHOLDERS
  |--------------------------------------------------------------------------
  |
  | These are intentionally local until an AI provider is configured.
  |
  */

  if (
    name === "ai" ||
    name === "ask" ||
    name === "explain" ||
    name === "summarize" ||
    name === "rewrite" ||
    name === "grammar" ||
    name === "code" ||
    name === "debug" ||
    name === "idea" ||
    name === "story"
  ) {
    const prompt = args.join(" ");

    if (!prompt) {
      await sendText(
        sock,
        jid,
        `Usage: ${prefix}${name} your question`,
        msg
      );

      return;
    }

    await sendText(
      sock,
      jid,
      `🧠 NICEGOLD AI

Your request was received:

"${prompt}"

AI provider is not configured in this bot yet.`,
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | LINKS / INFORMATION
  |--------------------------------------------------------------------------
  */

  if (name === "github") {
    await sendText(
      sock,
      jid,
      "https://github.com/",
      msg
    );

    return;
  }

  if (name === "npm") {
    await sendText(
      sock,
      jid,
      "https://www.npmjs.com/",
      msg
    );

    return;
  }

  if (name === "google") {
    await sendText(
      sock,
      jid,
      `https://www.google.com/search?q=${encodeURIComponent(
        args.join(" ")
      )}`,
      msg
    );

    return;
  }

  if (name === "youtube") {
    await sendText(
      sock,
      jid,
      `https://www.youtube.com/results?search_query=${encodeURIComponent(
        args.join(" ")
      )}`,
      msg
    );

    return;
  }

  if (name === "instagram") {
    await sendText(
      sock,
      jid,
      "https://www.instagram.com/",
      msg
    );

    return;
  }

  if (name === "telegram") {
    await sendText(
      sock,
      jid,
      "https://telegram.org/",
      msg
    );

    return;
  }

  if (name === "whatsapp") {
    await sendText(
      sock,
      jid,
      "https://www.whatsapp.com/",
      msg
    );

    return;
  }

  if (name === "facebook") {
    await sendText(
      sock,
      jid,
      "https://www.facebook.com/",
      msg
    );

    return;
  }

  if (name === "tiktok") {
    await sendText(
      sock,
      jid,
      "https://www.tiktok.com/",
      msg
    );

    return;
  }

  if (name === "reddit") {
    await sendText(
      sock,
      jid,
      "https://www.reddit.com/",
      msg
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | NICEGOLD
  |--------------------------------------------------------------------------
  */

  if (
    name === "nicegold" ||
    name === "ngm"
  ) {
    await sendText(
      sock,
      jid,
      `𓉳 ⃝𝗡𝗜𝗖𝗘𝗚𝗢𝗟𝗗 ⃝ 𝗠𝗢𝗡𓉳 ⃝ 𓃵

NICEGOLDMON V1.1
WhatsApp Bot Control System`,
      msg
    );

    return;
  }

  if (name === "credits") {
    await sendText(
      sock,
      jid,
      "𓉳 NICEGOLDMON V1.1\nPowered by Baileys + Node.js",
      msg
    );

    return;
  }

  if (name === "features") {
    await sendText(
      sock,
      jid,
      `✨ NICEGOLDMON FEATURES

• WhatsApp pairing
• Web dashboard
• Group management
• Welcome / goodbye
• Anti-link
• Anti-spam
• Custom commands
• Auto replies
• Games
• Utilities
• Text tools
• Statistics
• Logs
• Session management`,
      msg
    );

    return;
  }

  if (name === "dashboard") {
    await sendText(
      sock,
      jid,
      `🌐 NICEGOLDMON WEB CONTROL CENTER

http://127.0.0.1:${PORT}`,
      msg
    );

    return;
  }

  if (name === "session") {
    await sendText(
      sock,
      jid,
      `📱 Active sessions: ${sessions.size}`,
      msg
    );

    return;
  }

  if (name === "profile") {
    await sendText(
      sock,
      jid,
      `👤 ${sender.split("@")[0]}`,
      msg
    );

    return;
  }

  if (name === "pair") {
    await sendText(
      sock,
      jid,
      "Pairing is controlled from the NICEGOLDMON Web Control Center.",
      msg
    );

    return;
  }

  if (name === "save" || name === "copy" || name === "read") {
    await sendText(
      sock,
      jid,
      "📋 This utility is available through the web dashboard.",
      msg
    );

    return;
  }

  if (
    name === "contact" ||
    name === "vcard"
  ) {
    await sendText(
      sock,
      jid,
      "👤 Contact tools are available for future contact-card integration.",
      msg
    );

    return;
  }

  if (name === "poll") {
    await sendText(
      sock,
      jid,
      `📊 Poll creation is ready for the next dashboard update.`,
      msg
    );

    return;
  }

  if (name === "react") {
    await sendText(
      sock,
      jid,
      "❤️ Reply to a message and use the web dashboard for message tools.",
      msg
    );

    return;
  }

  if (name === "url") {
    await sendText(
      sock,
      jid,
      args[0] || "Provide a URL.",
      msg
    );

    return;
  }

  if (name === "shorturl") {
    await sendText(
      sock,
      jid,
      "URL shortening requires an external URL-shortening service.",
      msg
    );

    return;
  }

  if (name === "qr") {
    await sendText(
      sock,
      jid,
      "QR generation can be connected to the dashboard next.",
      msg
    );

    return;
  }

  if (name === "define" || name === "wiki" || name === "translate" || name === "search") {
    await sendText(
      sock,
      jid,
      `🔎 ${name} requires an external information API.\n\nQuery: ${args.join(" ") || "none"}`,
      msg
    );

    return;
  }
}

function cryptoRandomUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
    /[xy]/g,
    char => {
      const random = Math.random() * 16 | 0;

      const value =
        char === "x"
          ? random
          : (random & 0x3) | 0x8;

      return value.toString(16);
    }
  );
}

/*
|--------------------------------------------------------------------------
| MESSAGE HANDLING
|--------------------------------------------------------------------------
*/

async function handleIncomingMessage(sock, msg, session) {
  try {
    if (!msg?.message) return;
    if (msg.key?.fromMe) return;

    const jid = msg.key.remoteJid;

    if (!jid) return;

    const sender =
      msg.key.participant ||
      msg.key.remoteJid;

    const text = getMessageText(msg);

    if (!text) return;

    stats.messages++;

    const group = isGroup(jid);
    const admin = group
      ? await isGroupAdmin(sock, jid, sender)
      : false;

    /*
    |--------------------------------------------------------------------------
    | ANTI-LINK
    |--------------------------------------------------------------------------
    */

    if (
      group &&
      settings.antiLink &&
      !admin &&
      /(https?:\/\/|www\.|t\.me\/|wa\.me\/|chat\.whatsapp\.com\/)/i.test(text)
    ) {
      try {
        await sock.sendMessage(jid, {
          delete: msg.key
        });

        stats.moderated++;

        await sendText(
          sock,
          jid,
          `🚫 @${sender.split("@")[0]}, links are disabled in this group.`,
          msg
        );

        log(
          "MODERATION",
          `Anti-link removed message from ${sender}`
        );
      } catch (error) {
        stats.errors++;

        log(
          "ERROR",
          `Anti-link failed: ${error.message}`
        );
      }

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | ANTI-SPAM
    |--------------------------------------------------------------------------
    */

    if (
      group &&
      settings.antiSpam &&
      !admin &&
      checkSpam(jid, sender, text)
    ) {
      try {
        await sock.sendMessage(jid, {
          delete: msg.key
        });

        stats.moderated++;

        await sendText(
          sock,
          jid,
          `⚠️ @${sender.split("@")[0]}, please slow down.`,
          msg
        );

        log(
          "MODERATION",
          `Anti-spam removed message from ${sender}`
        );
      } catch (error) {
        stats.errors++;

        log(
          "ERROR",
          `Anti-spam failed: ${error.message}`
        );
      }

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | TYPING
    |--------------------------------------------------------------------------
    */

    if (settings.typing) {
      try {
        await sock.sendPresenceUpdate("composing", jid);

        setTimeout(() => {
          sock.sendPresenceUpdate("paused", jid).catch(() => {});
        }, 1200);
      } catch {}
    }

    /*
    |--------------------------------------------------------------------------
    | COMMAND
    |--------------------------------------------------------------------------
    */

    const prefix = settings.prefix;

    if (text.startsWith(prefix)) {
      const body = text.slice(prefix.length).trim();

      const parts = body.split(/\s+/);

      const command = parts.shift()?.toLowerCase();

      const args = parts;

      if (command) {
        await executeCommand({
          sock,
          msg,
          jid,
          sender,
          command,
          args,
          isAdmin: admin
        });
      }

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | AUTO REPLIES
    |--------------------------------------------------------------------------
    */

    if (settings.autoReply) {
      const trigger = text.toLowerCase().trim();

      const reply = autoReplies.get(trigger);

      if (reply && reply.enabled !== false) {
        const response = String(reply.response || "")
          .replace(
            /@user/g,
            `@${sender.split("@")[0]}`
          );

        await sendText(
          sock,
          jid,
          response,
          msg
        );

        stats.replies++;
      }
    }
  } catch (error) {
    stats.errors++;

    log(
      "ERROR",
      error?.stack || error?.message || String(error)
    );
  }
}

/*
|--------------------------------------------------------------------------
| WHATSAPP SESSION
|--------------------------------------------------------------------------
*/

async function createSession(phone) {
  const id = sessionId(phone);

  if (!id) {
    throw new Error("Invalid phone number.");
  }

  const existing = sessions.get(id);

  if (existing?.sock) {
    return existing;
  }

  const sessionFolder = path.join(
    SESSIONS_DIR,
    id
  );

  fs.mkdirSync(sessionFolder, {
    recursive: true
  });

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(sessionFolder);

  const session = existing || {
    id,
    phone: id,
    status: "STARTING",
    sock: null,
    pairingCode: null,
    createdAt: Date.now(),
    reconnecting: false,
    pairingRequested: false
  };

  sessions.set(id, session);

  const sock = makeWASocket({
    auth: state,
    logger: pino({
      level: "silent"
    }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false
  });

  session.sock = sock;
  session.status = "CONNECTING";
  session.pairingCode = null;
  session.pairingRequested = false;

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  /*
  |--------------------------------------------------------------------------
  | AUTOMATIC PAIRING CODE
  |--------------------------------------------------------------------------
  */

  if (!state.creds.registered) {
    setTimeout(async () => {
      if (
        session.pairingRequested ||
        session.pairingCode ||
        session.status === "CONNECTED"
      ) {
        return;
      }

      session.pairingRequested = true;

      try {
        log(
          "PAIRING",
          `Generating WhatsApp pairing code for ${id}`
        );

        const code =
          await sock.requestPairingCode(id);

        session.pairingCode = code;

        log(
          "PAIRING",
          `Pairing code generated for ${id}: ${code}`
        );
      } catch (error) {
        session.pairingRequested = false;
        stats.errors++;

        log(
          "ERROR",
          `Pairing failed: ${error?.message || error}`
        );
      }
    }, 1500);
  }

  sock.ev.on(
    "connection.update",
    async update => {
      const {
        connection,
        lastDisconnect
      } = update;

      if (connection === "open") {
        session.status = "CONNECTED";
        session.pairingCode = null;
        session.pairingRequested = true;

        stats.connections++;

        log(
          "CONNECTED",
          `WhatsApp session connected: ${id}`
        );
      }

      if (connection === "close") {
        session.status = "DISCONNECTED";
        session.sock = null;

        const code =
          lastDisconnect?.error?.output?.statusCode;

        const shouldReconnect =
          code !== DisconnectReason.loggedOut;

        log(
          "DISCONNECTED",
          `${id} disconnected. Reconnect: ${shouldReconnect}`
        );

        if (
          shouldReconnect &&
          !session.reconnecting
        ) {
          session.reconnecting = true;

          setTimeout(async () => {
            try {
              await createSession(phone);
            } catch (error) {
              stats.errors++;

              log(
                "ERROR",
                `Reconnect failed: ${error?.message || error}`
              );
            } finally {
              session.reconnecting = false;
            }
          }, 3000);
        }
      }
    }
  );

  return session;
}

/*
|--------------------------------------------------------------------------
| API
|--------------------------------------------------------------------------
*/

app.get("/api/info", (req, res) => {
  res.json({
    ok: true,
    name: settings.botName,
    version: "V1.1",
    description: settings.description,
    prefix: settings.prefix,
    commands: commandRegistry.size + customCommands.size
  });
});

app.get("/api/settings", (req, res) => {
  res.json({
    ok: true,
    settings
  });
});

app.post("/api/settings", (req, res) => {
  settings = {
    ...settings,
    ...req.body
  };

  saveSettings();

  log(
    "SETTINGS",
    "Dashboard settings updated."
  );

  res.json({
    ok: true,
    settings
  });
});

app.get("/api/stats", (req, res) => {
  const memory = process.memoryUsage();

  res.json({
    ok: true,
    stats: {
      ...stats,
      uptime: getUptime(),
      memory: process.memoryUsage(),
      heap: {
        used: memory.heapUsed,
        total: memory.heapTotal
      },
      cpu: os.cpus().length
    }
  });
});

app.get("/api/logs", (req, res) => {
  res.json({
    ok: true,
    logs
  });
});

app.get("/api/sessions", (req, res) => {
  res.json({
    ok: true,
    sessions: [...sessions.values()].map(publicSession)
  });
});

app.post("/api/pair", async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);

    if (
      phone.length < 8 ||
      phone.length > 15
    ) {
      return res.status(400).json({
        ok: false,
        error: "Enter a valid phone number."
      });
    }

    const session = await createSession(phone);

    const startedAt = Date.now();

    while (
      !session.pairingCode &&
      Date.now() - startedAt < 15000
    ) {
      await new Promise(resolve =>
        setTimeout(resolve, 100)
      );
    }

    if (!session.pairingCode) {
      return res.status(504).json({
        ok: false,
        error: "Pairing code could not be generated yet. Please try again."
      });
    }

    res.json({
      ok: true,
      session: publicSession(session),
      pairingCode: session.pairingCode
    });
  } catch (error) {
    stats.errors++;

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post(
  "/api/sessions/:id/reconnect",
  async (req, res) => {
    try {
      const id = cleanPhone(req.params.id);

      const existing = sessions.get(id);

      if (existing?.sock) {
        try {
          existing.sock.end(
            new Error("Manual reconnect")
          );
        } catch {}
      }

      const session =
        await createSession(id);

      res.json({
        ok: true,
        session: publicSession(session)
      });
    } catch (error) {
      stats.errors++;

      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

app.delete(
  "/api/sessions/:id",
  async (req, res) => {
    const id = cleanPhone(req.params.id);

    const session = sessions.get(id);

    if (session?.sock) {
      try {
        session.sock.logout();
      } catch {}

      try {
        session.sock.end();
      } catch {}
    }

    sessions.delete(id);

    const folder =
      path.join(SESSIONS_DIR, id);

    try {
      fs.rmSync(folder, {
        recursive: true,
        force: true
      });
    } catch {}

    log(
      "SESSION",
      `Session removed: ${id}`
    );

    res.json({
      ok: true
    });
  }
);


/*
|--------------------------------------------------------------------------
| NICEGOLDMON V1.1.1 API
|--------------------------------------------------------------------------
*/

app.get("/api/monitor", (req, res) => {
  const memory = process.memoryUsage();

  const connected = [...sessions.values()]
    .filter(session => session.status === "CONNECTED")
    .length;

  res.json({
    ok: true,
    monitor: {
      bot: settings.botName,
      version: "V1.1",
      status: connected > 0 ? "ONLINE" : "OFFLINE",
      uptime: getUptime(),
      startedAt: stats.startedAt,
      sessions: sessions.size,
      connectedSessions: connected,
      messages: stats.messages,
      commands: stats.commands,
      replies: stats.replies,
      moderated: stats.moderated,
      errors: stats.errors,
      connections: stats.connections,
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal
      },
      groupsConfigured: Object.keys(groupSettings).length,
      commandsAvailable:
        commandRegistry.size + customCommands.size
    }
  });
});

app.get("/api/security", (req, res) => {
  const sessionList = [...sessions.values()].map(session => ({
    id: session.id,
    phone: session.phone,
    status: session.status,
    connected: session.status === "CONNECTED",
    createdAt: session.createdAt
  }));

  res.json({
    ok: true,
    security: {
      sessions: sessionList,
      totalSessions: sessionList.length,
      connectedSessions:
        sessionList.filter(item => item.connected).length,
      loggedEvents: logs.length,
      errors: stats.errors
    }
  });
});

app.get("/api/groups/:id/settings/:groupId", (req, res) => {
  const cfg = getGroupSettings(req.params.groupId);

  res.json({
    ok: true,
    groupId: req.params.groupId,
    settings: cfg,
    effective: {
      antiLink: effectiveGroupSetting(
        req.params.groupId,
        "antiLink"
      ),
      antiSpam: effectiveGroupSetting(
        req.params.groupId,
        "antiSpam"
      ),
      welcome: effectiveGroupSetting(
        req.params.groupId,
        "welcome"
      ),
      goodbye: effectiveGroupSetting(
        req.params.groupId,
        "goodbye"
      )
    }
  });
});

app.post("/api/groups/:id/settings/:groupId", (req, res) => {
  const groupId = String(req.params.groupId || "").trim();

  if (!groupId) {
    return res.status(400).json({
      ok: false,
      error: "Group ID is required."
    });
  }

  const current = getGroupSettings(groupId);
  const body = req.body || {};

  const booleanFields = [
    "enabled",
    "antiLink",
    "antiSpam",
    "welcome",
    "goodbye"
  ];

  for (const field of booleanFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      if (body[field] === null) {
        current[field] = null;
      } else {
        current[field] = Boolean(body[field]);
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "rules")) {
    current.rules = String(body.rules || "").slice(0, 5000);
  }

  if (Object.prototype.hasOwnProperty.call(body, "warnLimit")) {
    const limit = Number(body.warnLimit);

    if (Number.isInteger(limit) && limit >= 1 && limit <= 20) {
      current.warnLimit = limit;
    }
  }

  current.updatedAt = Date.now();

  saveGroupSettings();

  log(
    "GROUP_SETTINGS",
    `Group settings updated: ${groupId}`
  );

  res.json({
    ok: true,
    groupId,
    settings: current
  });
});

app.delete("/api/groups/:id/settings/:groupId", (req, res) => {
  const groupId = String(req.params.groupId || "").trim();

  if (groupSettings[groupId]) {
    delete groupSettings[groupId];
    saveGroupSettings();
  }

  log(
    "GROUP_SETTINGS",
    `Group settings reset: ${groupId}`
  );

  res.json({
    ok: true,
    groupId,
    message: "Group settings reset to global defaults."
  });
});

app.post("/api/groups/:id/:groupId/rules", (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const rules = String(req.body?.rules || "").slice(0, 5000);

  const cfg = getGroupSettings(groupId);
  cfg.rules = rules;
  cfg.updatedAt = Date.now();

  saveGroupSettings();

  res.json({
    ok: true,
    groupId,
    rules
  });
});

app.get("/api/groups/:id/:groupId/rules", (req, res) => {
  const groupId = String(req.params.groupId || "").trim();
  const cfg = getGroupSettings(groupId);

  res.json({
    ok: true,
    groupId,
    rules: cfg.rules || ""
  });
});

/*
|--------------------------------------------------------------------------
| COMMAND API
|--------------------------------------------------------------------------
*/

app.get("/api/commands", (req, res) => {
  res.json({
    ok: true,
    commands: getCommandList()
  });
});

app.post("/api/commands", (req, res) => {
  const name = String(req.body.name || "")
    .replace(/^\./, "")
    .trim()
    .toLowerCase();

  const response = String(
    req.body.response || ""
  ).trim();

  if (!name || !response) {
    return res.status(400).json({
      ok: false,
      error: "Command name and response are required."
    });
  }

  customCommands.set(name, {
    name,
    response,
    enabled: true
  });

  saveCommands();

  res.json({
    ok: true,
    command: customCommands.get(name)
  });
});

app.delete(
  "/api/commands/:name",
  (req, res) => {
    const name =
      String(req.params.name)
        .toLowerCase();

    customCommands.delete(name);

    saveCommands();

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/commands/:name/toggle",
  (req, res) => {
    const name =
      String(req.params.name)
        .toLowerCase();

    const command =
      customCommands.get(name);

    if (!command) {
      return res.status(404).json({
        ok: false,
        error: "Command not found."
      });
    }

    command.enabled =
      req.body.enabled !== false;

    saveCommands();

    res.json({
      ok: true,
      command
    });
  }
);

/*
|--------------------------------------------------------------------------
| AUTO REPLY API
|--------------------------------------------------------------------------
*/

app.get("/api/replies", (req, res) => {
  res.json({
    ok: true,
    replies: [...autoReplies.values()]
  });
});

app.post("/api/replies", (req, res) => {
  const trigger =
    String(req.body.trigger || "")
      .trim()
      .toLowerCase();

  const response =
    String(req.body.response || "")
      .trim();

  if (!trigger || !response) {
    return res.status(400).json({
      ok: false,
      error: "Trigger and response are required."
    });
  }

  autoReplies.set(trigger, {
    trigger,
    response,
    enabled: true
  });

  saveReplies();

  res.json({
    ok: true,
    reply: autoReplies.get(trigger)
  });
});

app.delete(
  "/api/replies/:trigger",
  (req, res) => {
    autoReplies.delete(
      String(req.params.trigger)
        .toLowerCase()
    );

    saveReplies();

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/replies/:trigger/toggle",
  (req, res) => {
    const trigger =
      String(req.params.trigger)
        .toLowerCase();

    const reply =
      autoReplies.get(trigger);

    if (!reply) {
      return res.status(404).json({
        ok: false,
        error: "Reply not found."
      });
    }

    reply.enabled =
      req.body.enabled !== false;

    saveReplies();

    res.json({
      ok: true,
      reply
    });
  }
);

/*
|--------------------------------------------------------------------------
| GROUP API
|--------------------------------------------------------------------------
*/

app.get("/api/groups/:id", async (req, res) => {
  const id =
    cleanPhone(req.params.id);

  const session =
    sessions.get(id);

  if (!session?.sock) {
    return res.status(404).json({
      ok: false,
      error: "Session is not connected."
    });
  }

  try {
    const groups =
      await session.sock.groupFetchAllParticipating();

    res.json({
      ok: true,
      groups: Object.values(groups).map(group => ({
        id: group.id,
        subject: group.subject,
        owner: group.owner,
        size: group.size,
        announce: group.announce,
        restrict: group.restrict,
        desc: group.desc || ""
      }))
    });
  } catch (error) {
    stats.errors++;

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get(
  "/api/groups/:id/:groupId",
  async (req, res) => {
    const id =
      cleanPhone(req.params.id);

    const session =
      sessions.get(id);

    if (!session?.sock) {
      return res.status(404).json({
        ok: false,
        error: "Session is not connected."
      });
    }

    try {
      const group =
        await session.sock.groupMetadata(
          req.params.groupId
        );

      res.json({
        ok: true,
        group
      });
    } catch (error) {
      stats.errors++;

      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    bot: settings.botName,
    uptime: getUptime(),
    sessions: sessions.size,
    commands:
      commandRegistry.size +
      customCommands.size,
    memory: formatBytes(
      process.memoryUsage().rss
    )
  });
});

/*
|--------------------------------------------------------------------------
| FALLBACK
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

/*
|--------------------------------------------------------------------------
| RESTORE SESSIONS
|--------------------------------------------------------------------------
*/

async function restoreSessions() {
  const stored =
    getStoredSessions();

  for (const id of stored) {
    try {
      await createSession(id);

      log(
        "RESTORE",
        `Restoring session ${id}`
      );
    } catch (error) {
      stats.errors++;

      log(
        "ERROR",
        `Could not restore ${id}: ${error.message}`
      );
    }
  }
}

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════╗
║        NICEGOLDMON V1.1            ║
║        WEB CONTROL CENTER        ║
╚══════════════════════════════════╝

Dashboard:
http://127.0.0.1:${PORT}

Built-in commands:
${commandRegistry.size}

Custom commands:
${customCommands.size}

Auto replies:
${autoReplies.size}
`);

  await restoreSessions();
});
