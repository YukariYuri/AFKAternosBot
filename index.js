"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const IS_MINECRAFT_WORKER = process.env.BOTMINECRAFT_ROLE === "minecraft";

if (IS_MINECRAFT_WORKER) {
  console.log(`[System] Worker starting... CWD: ${process.cwd()} DIR: ${__dirname}`);
}

let { addLog, getLogs } = require("./logger");

// FIX: Prevent worker from logging locally to console.
// Worker logs will only be printed by the master process to avoid visual duplication.
if (IS_MINECRAFT_WORKER && process.send) {
  // Global error handler for worker
  process.on("uncaughtException", (err) => {
    const msg = String(err.message || err);
    const stack = err.stack || msg;

    // Only log once
    addLog(`[WORKER ERROR] ${msg}`);

    // If it's a known network error, don't crash the worker, just reconnect
    if (msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') || msg.includes('EPIPE') || msg.includes('keepAliveError')) {
      if (typeof scheduleReconnect === 'function') {
        scheduleReconnect();
        return;
      }
    }

    // For other fatal errors, log stack and exit
    console.error(`[WORKER FATAL] ${stack}`);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    addLog(`[Worker Unhandled Rejection] ${reason}`);
  });

  const originalAddLog = addLog;
  addLog = (line) => {
    // Only send to master, do not call originalAddLog (which prints to console)
    try {
      process.send({ type: "log", payload: { line } });
    } catch (e) {
      // Ignore IPC send errors
    }
  };
}

const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const { fork } = require("child_process");

const USE_SPLIT_MINECRAFT = !IS_MINECRAFT_WORKER && process.env.BOTMINECRAFT_SPLIT !== "false";

// ============================================================
// EXPRESS SERVER - Keep Render alive
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// Stats tracking (Persistent)
let stats = { totalPlaytime: 0 };
let memoryStats = {
  totalHeapUsed: 0,
  samples: 0,
  avgHeapUsed: 0
};

const statsPath = path.join(__dirname, "stats.json");

try {
  if (fs.existsSync(statsPath)) {
    stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
    // Migration: Set unit to ticks if not already done
    if (!stats.unit || stats.unit !== 'ticks') {
      stats.unit = 'ticks';
      saveStats();
    }
  } else {
    stats.unit = 'ticks';
  }
} catch (e) {
  addLog("[Stats] Failed to load stats.json, starting fresh.");
  stats.unit = 'ticks';
}

function saveStats() {
  try {
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  } catch (e) {
    // Ignore save errors
  }
}

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  lastPacket: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

// Sample memory every 10 seconds for average and force GC if possible
setInterval(() => {
  if (global.gc) {
    try { global.gc(); } catch (e) { }
  }

  const currentHeap = process.memoryUsage().heapUsed / 1024 / 1024;
  memoryStats.totalHeapUsed += currentHeap;
  memoryStats.samples++;
  memoryStats.avgHeapUsed = memoryStats.totalHeapUsed / memoryStats.samples;

  if (botState.connected) {
    // Note: totalPlaytime is now synced with in-game age delta below
  }
}, 10000); // Increased interval to 10s to reduce CPU/Memory churn

// Also save stats on exit
process.on("SIGINT", () => {
  saveStats();
  process.exit();
});
process.on("SIGTERM", () => {
  saveStats();
  process.exit();
});

// ============================================================
//                    WEB SERVER & DASHBOARD
// ============================================================

// Load HTML templates once at startup
const templates = {};
const templateFiles = ["dashboard.html", "tutorial.html", "logs.html"];

templateFiles.forEach(f => {
  try {
    templates[f] = fs.readFileSync(path.join(__dirname, f), "utf8");
  } catch (e) {
    addLog(`[Server] Warning: ${f} not found.`);
  }
});

/**
 * Helper to get template and inject basic variables
 */
function getTemplate(name) {
  if (!templates[name]) return `Template ${name} not found`;
  return templates[name]
    .replace(/{{BOT_NAME}}/g, config.name)
    .replace(/{{SERVER_IP}}/g, config.server.ip)
    .replace(/{{SERVER_PORT}}/g, config.server.port);
}

// Web Endpoints
app.get('/', (req, res) => res.send(getTemplate("dashboard.html")));
app.get('/logs', (req, res) => res.send(getTemplate("logs.html")));

app.get("/health", (req, res) => {
  const splitState = USE_SPLIT_MINECRAFT ? minecraftSnapshot : null;
  const state = splitState || botState;

  res.json({
    status: state.connected ? "connected" : "disconnected",
    uptime: Number(stats.totalPlaytime || 0),
    logs: getLogs(),
    coords: state.coords,
    lastActivity: state.lastActivity,
    reconnectAttempts: state.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    avgMemory: memoryStats.avgHeapUsed,
    // Enhanced World Data
    playerCount: state.playerCount || 0,
    playerNames: state.playerNames || [],
    weather: state.weather || "Unknown",
    dimension: state.dimension || "overworld",
    worldTime: state.worldTime || "Unknown",
    worldDay: state.worldDay || 0
  });
});

app.get("/ping", (req, res) => res.send("pong"));


let botRunning = false;
let isConnecting = false;
let minecraftWorker = null;
let minecraftSnapshot = {
  bot: null,
  connected: false,
  reconnecting: false,
  coords: null,
  playerCount: 0,
  playerNames: [],
  weather: "Unknown",
  worldTime: "Unknown",
  worldDay: 0,
  label: "Unknown"
};

function sendToMinecraftWorker(type, payload = {}) {
  if (!minecraftWorker || !minecraftWorker.connected) return false;
  minecraftWorker.send({ type, payload });
  addLog(`[Worker] Sent ${type} to Minecraft worker.`);
  return true;
}

const ATERNOS_SERVICE_URL = process.env.ATERNOS_SERVICE_URL || "http://localhost:5001"

let lastAternosNotification = 0;
async function notifyAternosToStart(reason = "minecraft-bot-trigger") {
  const now = Date.now();
  if (now - lastAternosNotification < 180000) return; // อย่าส่งแจ้งเตือนรัวเกินไป (3 นาที) ป้องกัน 503
  lastAternosNotification = now;
  try {
    const protocol = ATERNOS_SERVICE_URL.startsWith("https") ? require("https") : require("http");
    const data = JSON.stringify({ reason });
    const url = new URL(`${ATERNOS_SERVICE_URL}/aternos/start`);

    const req = protocol.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }, (res) => {
      // Success
      addLog(`[AternosLink] Notified BotAternos: ${res.statusCode}`);
    });
    req.on("error", (e) => {
      addLog(`[AternosLink] Could not notify BotAternos: ${e.message || 'Connection refused/timeout'}`);
    });
    req.write(data);
    req.end();
  } catch (err) {
    // Ignore errors
  }
}

let isStartingWorker = false;
function startMinecraftWorker() {
  if (!USE_SPLIT_MINECRAFT) return;
  if (isStartingWorker) return;
  if (minecraftWorker && !minecraftWorker.killed) return;
  isStartingWorker = true;

  try {

    minecraftWorker = fork(__filename, [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOTMINECRAFT_ROLE: "minecraft",
        BOTMINECRAFT_SPLIT: "false",
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });

    minecraftWorker.on("message", (message) => {
      if (!message || typeof message !== "object") return;

      // NEW: Handle ready signal from worker
      if (message.type === "ready") {
        addLog("[System] Worker reported READY. Sending start signal...");
        sendToMinecraftWorker("start");
        return;
      }

      if (message.type === "state") {
        // MASTER IPC: Update historical stats using session ticks from worker
        if (typeof message.payload.sessionTicks === 'number' && message.payload.connected) {
          stats.totalPlaytime = Number(stats.totalPlaytime || 0) + message.payload.sessionTicks;
          if (stats.totalPlaytime % 100 === 0) saveStats();
        }

        minecraftSnapshot = {
          ...minecraftSnapshot,
          ...message.payload,
          bot: message.payload && message.payload.hasBot ? true : null,
        };
        botState.connected = Boolean(minecraftSnapshot.connected);
        botState.lastActivity = message.payload.lastActivity || botState.lastActivity;
        botState.lastPacket = message.payload.lastPacket || botState.lastPacket;
        botState.reconnectAttempts = message.payload.reconnectAttempts || 0;
        return;
      }
      if (message.type === "log" && message.payload && message.payload.line) {
        addLog(message.payload.line);
      }
    });

    minecraftWorker.on("exit", (code, signal) => {
      addLog(`[MinecraftWorker] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      minecraftWorker = null;
      minecraftSnapshot = {
        bot: null, connected: false, reconnecting: false, coords: null,
        playerCount: 0, playerNames: [], weather: "Unknown", worldTime: "Unknown", worldDay: 0, label: "Unknown"
      };
      botState.connected = false;
      if (botRunning) {
        addLog("[System] Bot was running, restarting worker in 5s...");
        setTimeout(() => {
          startMinecraftWorker();
          // Automatically send start signal after worker starts
          setTimeout(() => {
            if (botRunning && minecraftWorker) {
              addLog("[System] Auto-sending start signal to restarted worker.");
              sendToMinecraftWorker("start");
            }
          }, 3000);
        }, 5000);
      }
    });

    addLog("[MinecraftWorker] started as separated process.");
    isStartingWorker = false;
  } catch (e) {
    isStartingWorker = false;
    addLog(`[System] Failed to fork worker: ${e.message}`);
  }
}

function stopMinecraftWorker() {
  if (!minecraftWorker) return;
  sendToMinecraftWorker("stop");
  setTimeout(() => {
    if (minecraftWorker && !minecraftWorker.killed) minecraftWorker.kill();
  }, 5000);
}

app.post("/start", (req, res) => {
  // FIX: Always update IP and Port if provided, even if bot is already running or connecting
  if (req.body.ip && req.body.port) {
    const oldTarget = `${config.server.ip}:${config.server.port}`;
    const newTarget = `${req.body.ip}:${req.body.port}`;

    if (oldTarget !== newTarget) {
      addLog(`[Control] Server target changed: ${oldTarget} -> ${newTarget}. Resetting bot...`);

      // Force cleanup of current connection/bot
      if (USE_SPLIT_MINECRAFT) {
        stopMinecraftWorker();
      } else {
        disconnectCurrentBot("port-change");
      }

      // Update config
      config.server.ip = req.body.ip;
      config.server.port = parseInt(req.body.port, 10);

      // Reset flags to allow immediate restart
      botRunning = false;
      isConnecting = false;
      isReconnecting = false;
    }
  }

  if (botRunning || isConnecting) {
    // ไม่ต้องส่ง Log ซ้ำถ้ากำลังเชื่อมต่ออยู่แล้ว
    return res.json({ success: true, msg: "Already in progress" });
  }

  botRunning = true;
  resetReconnectState();
  botState.connected = false;
  botState.lastActivity = Date.now();
  botState.lastPacket = Date.now();

  if (USE_SPLIT_MINECRAFT) {
    startMinecraftWorker();
    // Pass IP/Port to worker if provided
    setTimeout(() => sendToMinecraftWorker("start", { ip: req.body.ip, port: req.body.port }), 1000);
  } else {
    createBot();
  }
  addLog("[Control] Bot started via HTTP");

  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });

  botRunning = false;
  isConnecting = false;
  resetReconnectState();
  if (USE_SPLIT_MINECRAFT) {
    stopMinecraftWorker();
    botState.connected = false;
    addLog("[Control] Bot stopped");
    return res.json({ success: true });
  }

  if (bot) {
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      addLog(`[Control] Error while stopping bot: ${e.message}`);
    }
    bot = null;
  }

  botState.connected = false;
  clearAllIntervals();
  addLog("[Control] Bot stopped");

  res.json({ success: true });
});

app.post("/command", express.json(), (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });

  addLog(`[Console] > ${cmd}`);

  if (cmd === "/help") {
    const lines = [
      "Available commands:",
      "  /help          - Show this help message",
      "  /pos           - Show bot's current coordinates",
      "  /status        - Show bot connection status",
      "  /list          - Ask server for player list",
      "  /say <message> - Send a chat message in-game",
      "  /<anything>    - Send any Minecraft command directly",
      "  <text>         - Send plain chat (no slash needed)",
    ];
    lines.forEach((l) => addLog(`[Console] ${l}`));
    return res.json({ success: true, msg: lines.join("\n") });
  }

  if (cmd === "/pos" || cmd === "/coords") {
    const pos = USE_SPLIT_MINECRAFT ? minecraftSnapshot.coords : (bot && bot.entity ? bot.entity.position : null);
    const msg = pos
      ? `Position: X=${Math.floor(pos.x)}  Y=${Math.floor(pos.y)}  Z=${Math.floor(pos.z)}`
      : "Position unavailable (bot not spawned).";
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (cmd === "/status") {
    const status = (USE_SPLIT_MINECRAFT ? minecraftSnapshot.connected : botState.connected) ? "Connected" : "Disconnected";
    const uptime = Math.floor((Date.now() - botState.startTime) / 1000);
    const msg = `Status: ${status} | Uptime: ${uptime}s | Reconnects: ${botState.reconnectAttempts}`;
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (USE_SPLIT_MINECRAFT) {
    if (!sendToMinecraftWorker("command", { command: cmd })) {
      const msg = "Minecraft worker is not running.";
      addLog(`[Console] ${msg}`);
      return res.json({ success: false, msg });
    }
    return res.json({ success: true, msg: `Queued: ${cmd}` });
  }

  if (!bot || typeof bot.chat !== "function") {
    const msg = bot
      ? "Bot is still connecting — try again in a moment."
      : "Bot is not running.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: false, msg });
  }

  try {
    bot.chat(cmd);
    addLog(`[Console] Sent to server: ${cmd}`);
    return res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    addLog(`[Console] Error: ${err.message}`);
    return res.json({ success: false, msg: err.message });
  }
});

// ============================================================
//                    END OF WEB TOOLS
//============================================================

// FIX: handle port conflict gracefully - try next port if taken
if (!IS_MINECRAFT_WORKER) {
  const server = app.listen(PORT, "0.0.0.0", () => {
    addLog(`[Server] HTTP server started on port ${server.address().port} `);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      const fallbackPort = PORT + 1;
      addLog(`[Server] Port ${PORT} in use - trying port ${fallbackPort} `);
      server.listen(fallbackPort, "0.0.0.0");
    } else {
      addLog(`[Server] HTTP server error: ${err.message} `);
    }
  });
}

// FIX: only one definition of formatUptime
function formatUptime(ticks) {
  const seconds = Math.floor(ticks / 20);
  if (!seconds || seconds <= 0) return '0s';
  const y = Math.floor(seconds / (3600 * 24 * 365));
  const mo = Math.floor((seconds % (3600 * 24 * 365)) / (3600 * 24 * 30));
  const d = Math.floor((seconds % (3600 * 24 * 30)) / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  let res = '';
  if (y > 0) res += y + 'y ';
  if (mo > 0) res += mo + 'mo ';
  if (d > 0) res += d + 'd ';
  if (h > 0 || res !== '') res += h + 'h ';
  if (m > 0 || res !== '') res += m + 'm ';
  res += s + 's';
  return res.trim();
}

// ============================================================
// SELF-PING - Prevent Render from sleeping
// FIX: only ping if RENDER_EXTERNAL_URL is set (skip useless localhost ping)
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;

function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) {
    addLog(
      "[KeepAlive] No RENDER_EXTERNAL_URL set - self-ping disabled (running locally)",
    );
    return;
  }
  setInterval(() => {
    const protocol = renderUrl.startsWith("https") ? https : http;
    protocol
      .get(`${renderUrl}/ping`, (res) => {
        // Silent success
      })
      .on("error", (err) => {
        addLog(`[KeepAlive] Self-ping failed: ${err.message}`);
      });
  }, SELF_PING_INTERVAL);
  addLog("[KeepAlive] Self-ping system started (every 10 min)");
}

if (!IS_MINECRAFT_WORKER) {
  startSelfPing();
}

// ============================================================
// MEMORY MONITORING (STRICT LIMIT)
// ============================================================
const MEMORY_LIMIT_MB = 350; // Set a stricter limit to trigger cleanup early

setInterval(
  () => {
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / 1024 / 1024);
    const heapMB = (mem.heapUsed / 1024 / 1024);

    // addLog(`[Memory] RSS: ${rssMB.toFixed(2)} MB, Heap: ${heapMB.toFixed(2)} MB`);

    if (rssMB > MEMORY_LIMIT_MB) {
      addLog(`[Memory] Memory usage (${rssMB.toFixed(2)} MB) high. Cleaning up...`);

      if (global.gc) {
        try { global.gc(); } catch (e) { }
      }

      if (rssMB > 450) {
        addLog("[Memory] CRITICAL: high memory usage detected.");
      }

      // Restart process if it hits the near-fatal limit
      if (rssMB > 500) {
        addLog("[Memory] FATAL: Process near 512MB limit. Restarting...");
        process.exit(1);
      }
    }
  },
  60 * 1000, // Check every minute
);
// ============================================================
// BOT CREATION WITH RECONNECTION LOGIC
// ============================================================
// ============================================================
// RECONNECTION & TIMEOUT MANAGEMENT
// ============================================================
let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;
let forceAutoDetectVersion = false;

function clearBotTimeouts() {
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  }
}

function resetReconnectState() {
  clearBotTimeouts();
  isReconnecting = false;
  botState.reconnectAttempts = 0;
  botState.wasThrottled = false;
}

function getBotDimension(currentBot) {
  return String(
    currentBot?.game?.dimension ||
    currentBot?.game?.dimensionName ||
    currentBot?.entity?.dimension ||
    "",
  ).toLowerCase();
}

function isOverworldDimension(currentBot) {
  const dimension = getBotDimension(currentBot);
  return !dimension || dimension === "overworld" || dimension === "minecraft:overworld" || dimension === "0";
}

function enforceOverworld(currentBot, source) {
  if (!currentBot || !botState.connected || isOverworldDimension(currentBot)) return;
  const dimension = getBotDimension(currentBot) || "unknown";
  addLog(`[Bot] Not in overworld (${dimension}) after ${source}; reconnecting.`);
  try {
    currentBot.end("not-overworld");
  } catch (e) {
    scheduleReconnect();
  }
}

function disconnectCurrentBot(reason) {
  clearAllIntervals();
  clearBotTimeouts();
  botState.connected = false;
  isReconnecting = false;
  isConnecting = false;

  if (!bot) return;

  try {
    bot.removeAllListeners();
    bot.end(reason || "dashboard-stop");
  } catch (e) {
    addLog(`[Cleanup] Error ending bot: ${e.message}`);
  }

  bot = null;
}

// FIX: Discord rate limiting - track last send time
let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000; // min 5s between webhook calls

function clearAllIntervals() {
  if (activeIntervals.length > 0) {
    addLog(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  }
  activeIntervals.forEach((id) => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    const throttleDelay = 60000 + Math.floor(Math.random() * 60000);
    addLog(
      `[Bot] Throttle detected - using extended delay: ${throttleDelay / 1000}s`,
    );
    return throttleDelay;
  }

  // FIX: Smarter delay based on Aternos status if known
  // If we know the server is starting, wait longer (30s)
  if (USE_SPLIT_MINECRAFT && minecraftSnapshot && (minecraftSnapshot.label || "").toLowerCase().includes("starting")) {
    return 30000 + Math.floor(Math.random() * 5000);
  }

  // ปรับจังหวะการเชื่อมต่อใหม่ให้เสถียรสำหรับเครือข่าย Render
  const baseDelay = config.utils["auto-reconnect-delay"] || 30000;
  const maxDelay = config.utils["max-reconnect-delay"] || 180000;

  let delay;
  if (botState.reconnectAttempts <= 3) {
    // 3 ครั้งแรกให้รออย่างน้อย 45-60 วินาที เพื่อให้ Aternos Proxy พร้อม
    delay = 60000;
  } else {
    // หลังจากนั้นใช้ Exponential Backoff (เพิ่มทีละ 1.5 เท่า) เพื่อไม่ให้โดนแบน IP
    delay = Math.min(baseDelay * Math.pow(1.5, botState.reconnectAttempts - 3), maxDelay);
  }

  const jitter = Math.floor(Math.random() * 10000); // เพิ่มค่าสุ่ม 0-10 วิ
  return delay + jitter;
}

function createBot() {
  // สำรองค่า IP ปัจจุบันไว้ (กรณีเป็น Numerical IP จาก AternosController)
  const currentIp = config.server.ip;
  const currentPort = config.server.port;

  try {
    if (fs.existsSync(path.join(__dirname, "settings.json"))) {
      const freshConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "settings.json"), "utf8"));
      Object.assign(config, freshConfig);

      // บน Render หากได้รับ Dynamic IP มาแล้ว ให้ใช้ค่านั้นแทนค่าในไฟล์ settings.json
      if (currentIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(currentIp)) {
        config.server.ip = currentIp;
        config.server.port = currentPort;
      }
    }
  } catch (e) {
    addLog(`[Config] Failed to reload settings.json: ${e.message}`);
  }

  if (!botRunning) {
    addLog("[Bot] Bot is stopped, skipping connect.");
    isConnecting = false;
    return;
  }

  if (isConnecting) {
    addLog("[Bot] Connection in progress, skipping...");
    return;
  }

  if (isReconnecting) {
    addLog("[Bot] Already reconnecting, skipping...");
    return;
  }

  isConnecting = true;

  // Cleanup previous bot properly to avoid ghost bots
  if (bot) {
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
      bot.quit();
    } catch (e) { }
    bot = null;
  }

  addLog(`[Bot] Creating bot instance...`);
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      fakeHost: "AbsoluteSybau.aternos.me",
      version: config.server.version,
      connectTimeout: 90000, 
      checkTimeoutInterval: 90000,
      keepAlive: true,
    });

    // SPECTATOR MODE OPTIMIZATION: 
    // Since the bot is in spectator mode, physics (gravity, collision) are not needed.
    // Disabling this saves significant CPU and Memory.
    bot.physicsEnabled = false;

    bot.loadPlugin(pathfinder);

    if (bot._client) {
      bot._client.on("packet", () => {
        botState.lastPacket = Date.now();
      });
    }

    // FIX: connection timeout - increased to 300s for slow Aternos startup
    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (botRunning && !botState.connected) {
        addLog("[Bot] Connection timeout - no spawn received within 300s.");
        isConnecting = false;
        notifyAternosToStart("connection-timeout");
        scheduleReconnect();
      }
    }, 180000 + 10000); // 3 นาที + 10 วินาที buffer

    // FIX: guard against spawn firing twice (can happen on some servers)
    let spawnHandled = false;

    // DEBUG: Log login phase
    bot.on("login", () => {
      addLog("[Bot] Login successful! Waiting for spawn...");
    });

    if (bot._client) {
      bot._client.on("inject_allowed", () => {
        addLog("[Bot] Handshake successful, injecting protocol...");
      });
    }

    bot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;

      clearBotTimeouts();
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.lastPacket = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;
      isConnecting = false;
      forceAutoDetectVersion = false;
      addLog(
        `[Bot] [+] Successfully spawned on server! (Version: ${bot.version})`,
      );
      if (
        config.discord &&
        config.discord.events &&
        config.discord.events.connect
      ) {
        sendDiscordWebhook(
          `[+] **Connected** to \`${config.server.ip}\``,
          0x4ade80,
        );
      }

      // FIX: use bot.version (auto-detected) instead of config value so minecraft-data always matches
      const mcData = require("minecraft-data")(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;
      defaultMove.liquidCost = 1000;
      defaultMove.fallDamageCost = 1000;

      initializeModules(bot, mcData, defaultMove);
      startConnectionWatchdog(bot);
      setTimeout(() => enforceOverworld(bot, "spawn"), 5000);

      // Attempt creative mode (only works if bot has OP and enabled in settings)
      setTimeout(() => {
        if (bot && botState.connected && config.server["try-creative"]) {
          bot.chat("/gamemode creative");
          addLog("[INFO] Attempted to set creative mode (requires OP)");
        }
      }, 3000);

      bot.on("messagestr", (message) => {
        if (
          message.includes("commands.gamemode.success.self") ||
          message.includes("Set own game mode to Creative Mode")
        ) {
          addLog("[INFO] Bot is now in Creative Mode.");
        }
      });

      bot.on("game", () => enforceOverworld(bot, "game update"));
    });

    // FIX: 'kicked' fires before 'end'. Remove the scheduleReconnect from 'kicked'
    // so that 'end' is the single source of reconnect truth, preventing double-trigger.
    bot.on("kicked", (reason) => {
      isConnecting = false;
      let kickReason = typeof reason === "object" ? JSON.stringify(reason) : String(reason);

      // FIX: Better JSON kick message parsing
      try {
        const parsed = JSON.parse(kickReason);
        if (parsed.text === "" && parsed.extra) {
          kickReason = parsed.extra.map(e => e.text).join("");
        } else if (parsed.text) {
          kickReason = parsed.text;
        }
      } catch (e) { }

      addLog(`[Bot] Kicked: ${kickReason}`);

      // FIX: If duplicate login, wait longer to let the server clear the old session
      if (kickReason.includes("duplicate_login") || kickReason.includes("already logged in")) {
        addLog("[Bot] Duplicate login detected. Waiting 15s for session to clear...");
        botState.reconnectAttempts++; // Increment so we don't spam
        setTimeout(createBot, 15000);
        return;
      }
      botState.connected = false;
      botState.errors.push({
        type: "kicked",
        reason: kickReason,
        time: Date.now(),
      });
      clearAllIntervals();

      const reasonStr = String(kickReason).toLowerCase();
      if (
        reasonStr.includes("version") ||
        reasonStr.includes("incompatible") ||
        reasonStr.includes("outdated") ||
        reasonStr.includes("unsupported") ||
        reasonStr.includes("whitelist")
      ) {
        forceAutoDetectVersion = true;
        addLog("[Bot] Version mismatch suspected - auto-detect fallback armed.");
      }
      if (
        reasonStr.includes("throttl") ||
        reasonStr.includes("wait before reconnect") ||
        reasonStr.includes("too fast")
      ) {
        addLog(
          "[Bot] Throttle kick detected - will use extended reconnect delay",
        );
        botState.wasThrottled = true;
      }

      if (
        config.discord &&
        config.discord.events &&
        config.discord.events.disconnect
      ) {
        sendDiscordWebhook(`[!] **Kicked**: ${kickReason}`, 0xff0000);
      }
      // NOTE: do NOT call scheduleReconnect() here - 'end' will fire right after 'kicked' and handle it
    });

    // FIX: 'end' is the single reconnect trigger
    bot.on("end", (reason) => {
      isConnecting = false;
      addLog(`[Bot] Disconnected: ${reason || "socketClosed"}`);
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false; // reset for next connection

      if (
        config.discord &&
        config.discord.events &&
        config.discord.events.disconnect
      ) {
        sendDiscordWebhook(
          `[-] **Disconnected**: ${reason || "Unknown"}`,
          0xf87171,
        );
      }

      // ALWAYS reconnect — bot must never leave the server
      scheduleReconnect();
    });

    bot.on("error", (err) => {
      isConnecting = false;
      const msg = err.message || "";
      addLog(`[Bot] Error: ${msg}`);
      notifyAternosToStart(`connection-error-${err.code || 'unknown'}`);
      botState.errors.push({ type: "error", message: msg, time: Date.now() });
      const lower = msg.toLowerCase();
      if (
        lower.includes("version") ||
        lower.includes("incompatible") ||
        lower.includes("outdated") ||
        lower.includes("unsupported")
      ) {
        forceAutoDetectVersion = true;
        addLog("[Bot] Version error detected - auto-detect fallback armed.");
      }
      // Don't reconnect on error - let 'end' event handle it
    });
  } catch (err) {
    isConnecting = false;
    addLog(`[Bot] Failed to create bot: ${err.message}`);
    const msg = String(err.message || err).toLowerCase();
    if (
      msg.includes("version") ||
      msg.includes("incompatible") ||
      msg.includes("outdated") ||
      msg.includes("unsupported")
    ) {
      forceAutoDetectVersion = true;
      addLog("[Bot] Creation failed due to version mismatch - fallback armed.");
    }
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearBotTimeouts();
  isConnecting = false; // Reset lock to allow fresh start

  if (!botRunning || !config.utils["auto-reconnect"]) {
    isReconnecting = false;
    addLog("[Bot] Auto-reconnect disabled or bot stopped, not reconnecting.");
    return;
  }

  // FIX: don't stack reconnect if already waiting
  if (isReconnecting) {
    addLog("[Bot] Reconnect already scheduled, skipping duplicate.");
    return;
  }

  isReconnecting = true;
  botState.reconnectAttempts++;

  const delay = getReconnectDelay();
  addLog(
    `[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`,
  );

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function startConnectionWatchdog(currentBot) {
  const staleAfterMs = 3 * 60 * 1000;

  addInterval(() => {
    if (!botRunning || !currentBot || !botState.connected) return;

    const idleMs = Date.now() - botState.lastPacket;
    if (idleMs < staleAfterMs) return;

    addLog(
      `[Watchdog] No packets for ${Math.round(idleMs / 1000)}s - forcing reconnect`,
    );
    botState.connected = false;

    try {
      currentBot.end();
    } catch (e) {
      addLog(`[Watchdog] Error ending stale bot: ${e.message}`);
      scheduleReconnect();
    }
  }, 60 * 1000);
}

function initializeModules(bot, mcData, defaultMove) {
  addLog("[Modules] Initializing all modules...");

  // ---------- AUTO AUTH (REACTIVE) ----------
  if (config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
    const password = config.utils["auto-auth"].password;
    let authHandled = false;

    const tryAuth = (type) => {
      if (authHandled || !bot || !botState.connected) return;
      authHandled = true;
      if (type === "register") {
        bot.chat(`/register ${password} ${password}`);
        addLog("[Auth] Detected register prompt - sent /register");
      } else {
        bot.chat(`/login ${password}`);
        addLog("[Auth] Detected login prompt - sent /login");
      }
    };

    bot.on("messagestr", (message) => {
      if (authHandled) return;
      const msg = message.toLowerCase();
      if (
        msg.includes("/register") ||
        msg.includes("register ") ||
        msg.includes("지정된 비밀번호")
      ) {
        tryAuth("register");
      } else if (
        msg.includes("/login") ||
        msg.includes("login ") ||
        msg.includes("로그인")
      ) {
        tryAuth("login");
      }
    });

    // Failsafe: if no prompt after 10s, try login anyway
    setTimeout(() => {
      if (!authHandled && bot && botState.connected) {
        addLog(
          "[Auth] No prompt detected after 10s, sending /login as failsafe",
        );
        bot.chat(`/login ${password}`);
        authHandled = true;
      }
    }, 10000);
  }

  // ---------- CHAT MESSAGES ----------
  if (config.utils["chat-messages"] && config.utils["chat-messages"].enabled) {
    const messages = config.utils["chat-messages"].messages;
    if (config.utils["chat-messages"].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) {
          bot.chat(messages[i]);
          botState.lastActivity = Date.now();
          i = (i + 1) % messages.length;
        }
      }, config.utils["chat-messages"]["repeat-delay"] * 1000);
    } else {
      messages.forEach((msg, idx) => {
        setTimeout(() => {
          if (bot && botState.connected) bot.chat(msg);
        }, idx * 1000);
      });
    }
  }

  // ---------- MOVE TO POSITION ----------
  // FIX: only use position goal if circle-walk is NOT enabled (they fight over pathfinder)
  if (
    config.position &&
    config.position.enabled &&
    !(
      config.movement &&
      config.movement["circle-walk"] &&
      config.movement["circle-walk"].enabled
    )
  ) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(
      new GoalBlock(config.position.x, config.position.y, config.position.z),
    );
    addLog("[Position] Navigating to configured position...");
  }

  // ---------- ANTI-AFK ----------
  if (config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
    // Arm swinging
    addInterval(
      () => {
        if (!bot || !botState.connected) return;
        try {
          bot.swingArm();
        } catch (e) { }
      },
      10000 + Math.floor(Math.random() * 50000),
    );

    // Hotbar cycling
    addInterval(
      () => {
        if (!bot || !botState.connected) return;
        try {
          const slot = Math.floor(Math.random() * 9);
          bot.setQuickBarSlot(slot);
        } catch (e) { }
      },
      30000 + Math.floor(Math.random() * 90000),
    );

    // Teabagging
    addInterval(
      () => {
        if (
          !bot ||
          !botState.connected ||
          typeof bot.setControlState !== "function"
        )
          return;
        if (Math.random() > 0.9) {
          let count = 2 + Math.floor(Math.random() * 4);
          const doTeabag = () => {
            if (count <= 0 || !bot || typeof bot.setControlState !== "function")
              return;
            try {
              bot.setControlState("sneak", true);
              setTimeout(() => {
                if (bot && typeof bot.setControlState === "function")
                  bot.setControlState("sneak", false);
                count--;
                setTimeout(doTeabag, 150);
              }, 150);
            } catch (e) { }
          };
          doTeabag();
        }
      },
      120000 + Math.floor(Math.random() * 180000),
    );

    // FIX: micro-walk only when circle-walk is NOT running, to avoid interrupting pathfinder
    if (
      !(
        config.movement &&
        config.movement["circle-walk"] &&
        config.movement["circle-walk"].enabled
      )
    ) {
      addInterval(
        () => {
          if (
            !bot ||
            !botState.connected ||
            typeof bot.setControlState !== "function"
          )
            return;
          try {
            const yaw = Math.random() * Math.PI * 2;
            bot.look(yaw, 0, true);
            bot.setControlState("forward", true);
            setTimeout(
              () => {
                if (bot && typeof bot.setControlState === "function")
                  bot.setControlState("forward", false);
              },
              500 + Math.floor(Math.random() * 1500),
            );
            botState.lastActivity = Date.now();
          } catch (e) {
            addLog("[AntiAFK] Walk error:", e.message);
          }
        },
        120000 + Math.floor(Math.random() * 360000),
      );
    }

    if (config.utils["anti-afk"].sneak) {
      try {
        if (typeof bot.setControlState === "function")
          bot.setControlState("sneak", true);
      } catch (e) { }
    }
  }

  // ---------- MOVEMENT MODULES ----------
  // FIX: check top-level movement.enabled flag
  if (config.movement && config.movement.enabled !== false) {
    // FIX: circle-walk and random-jump both jump - only run one jumping mechanism
    // random-jump is skipped if anti-afk jump is handled elsewhere; we only use random-jump here
    if (
      config.movement["circle-walk"] &&
      config.movement["circle-walk"].enabled
    ) {
      startCircleWalk(bot, defaultMove);
    }
    // FIX: only run random-jump if circle-walk is NOT running (circle-walk also keeps bot moving)
    if (
      config.movement["random-jump"] &&
      config.movement["random-jump"].enabled &&
      !(
        config.movement["circle-walk"] && config.movement["circle-walk"].enabled
      )
    ) {
      startRandomJump(bot);
    }
    if (
      config.movement["look-around"] &&
      config.movement["look-around"].enabled
    ) {
      startLookAround(bot);
    }
  }

  // ---------- CUSTOM MODULES ----------
  // FIX: avoidMobs AND combatModule conflict - if combat is enabled, don't run avoidMobs at the same time
  if (config.modules.avoidMobs && !config.modules.combat) {
    avoidMobs(bot);
  }
  if (config.modules.combat) {
    combatModule(bot, mcData);
  }
  if (config.modules.beds) {
    bedModule(bot, mcData);
  }
  if (config.modules.chat) {
    chatModule(bot);
  }

  addLog("[Modules] All modules initialized!");
}

// ============================================================
// MOVEMENT HELPERS
// ============================================================
function startCircleWalk(bot, defaultMove) {
  const radius = config.movement["circle-walk"].radius;
  let angle = 0;
  let lastPathTime = 0;

  addInterval(() => {
    if (!bot || !botState.connected) return;
    const now = Date.now();
    if (now - lastPathTime < 2000) return;
    lastPathTime = now;
    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(
        new GoalBlock(
          Math.floor(x),
          Math.floor(bot.entity.position.y),
          Math.floor(z),
        ),
      );
      angle += Math.PI / 4;
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[CircleWalk] Error:", e.message);
    }
  }, config.movement["circle-walk"].speed);
}

function startRandomJump(bot) {
  addInterval(() => {
    if (
      !bot ||
      !botState.connected ||
      typeof bot.setControlState !== "function"
    )
      return;
    try {
      bot.setControlState("jump", true);
      setTimeout(() => {
        if (bot && typeof bot.setControlState === "function")
          bot.setControlState("jump", false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[RandomJump] Error:", e.message);
    }
  }, config.movement["random-jump"].interval);
}

function startLookAround(bot) {
  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      const yaw = Math.random() * Math.PI * 2 - Math.PI;
      const pitch = (Math.random() * Math.PI) / 2 - Math.PI / 4;
      bot.look(yaw, pitch, false);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[LookAround] Error:", e.message);
    }
  }, config.movement["look-around"].interval);
}

// ============================================================
// CUSTOM MODULES
// ============================================================

// Avoid mobs/players
// FIX: e.username only exists on players; use e.name for mobs - now handled properly
function avoidMobs(bot) {
  const safeDistance = 5;
  addInterval(() => {
    if (
      !bot ||
      !botState.connected ||
      typeof bot.setControlState !== "function"
    )
      return;
    try {
      const entities = Object.values(bot.entities).filter(
        (e) =>
          e.type === "mob" ||
          (e.type === "player" && e.username !== bot.username),
      );
      for (const e of entities) {
        if (!e.position) continue;
        const distance = bot.entity.position.distanceTo(e.position);
        if (distance < safeDistance) {
          bot.setControlState("back", true);
          setTimeout(() => {
            if (bot && typeof bot.setControlState === "function")
              bot.setControlState("back", false);
          }, 500);
          break;
        }
      }
    } catch (e) {
      addLog("[AvoidMobs] Error:", e.message);
    }
  }, 2000);
}

// Combat module
// FIX: attack cooldown for 1.9+ (600ms minimum between attacks)
// FIX: lock onto a target for multiple ticks instead of randomly switching every tick
// FIX: autoEat - use i.foodPoints directly (mineflayer item property) instead of broken mcData lookup
function combatModule(bot, mcData) {
  let lastAttackTime = 0;
  let lockedTarget = null;
  let lockedTargetExpiry = 0;

  // FIX: use physicsTick (not the deprecated physicTick)
  bot.on("physicsTick", () => {
    if (!bot || !botState.connected) return;
    if (!config.combat["attack-mobs"]) return;

    const now = Date.now();
    // FIX: 1.9+ attack cooldown - respect at least 600ms between swings
    if (now - lastAttackTime < 620) return;

    try {
      // FIX: only pick a new target if current one is gone or lock expired
      if (
        lockedTarget &&
        now < lockedTargetExpiry &&
        bot.entities[lockedTarget.id] &&
        lockedTarget.position
      ) {
        const dist = bot.entity.position.distanceTo(lockedTarget.position);
        if (dist < 4) {
          bot.attack(lockedTarget);
          lastAttackTime = now;
          return;
        } else {
          lockedTarget = null;
        }
      }

      // Pick a new target
      const mobs = Object.values(bot.entities).filter(
        (e) =>
          e.type === "mob" &&
          e.position &&
          bot.entity.position.distanceTo(e.position) < 4,
      );
      if (mobs.length > 0) {
        lockedTarget = mobs[0];
        lockedTargetExpiry = now + 3000; // stick to same mob for 3 seconds
        bot.attack(lockedTarget);
        lastAttackTime = now;
      }
    } catch (e) {
      addLog("[Combat] Error:", e.message);
    }
  });

  // FIX: autoEat - check foodPoints property on the item directly (works reliably)
  bot.on("health", () => {
    if (!config.combat["auto-eat"]) return;
    try {
      if (bot.food < 14) {
        const food = bot.inventory
          .items()
          .find((i) => i.foodPoints && i.foodPoints > 0);
        if (food) {
          bot
            .equip(food, "hand")
            .then(() => bot.consume())
            .catch((e) => addLog("[AutoEat] Error:", e.message));
        }
      }
    } catch (e) {
      addLog("[AutoEat] Error:", e.message);
    }
  });
}

// Bed module
// FIX: bot.isSleeping can be stale; use a local isTryingToSleep guard to prevent double-sleep errors
// FIX: place-night was false in default settings - documentation note added
function bedModule(bot, mcData) {
  let isTryingToSleep = false;

  addInterval(async () => {
    if (!bot || !botState.connected) return;
    if (!config.beds["place-night"]) return; // FIX: check flag (was always skipping before)

    try {
      const isNight =
        bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500;

      // FIX: use local guard instead of stale bot.isSleeping
      if (isNight && !isTryingToSleep) {
        const bedBlock = bot.findBlock({
          matching: (block) => block.name.includes("bed"),
          maxDistance: 8,
        });

        if (bedBlock) {
          isTryingToSleep = true;
          try {
            await bot.sleep(bedBlock);
            addLog("[Bed] Sleeping...");
          } catch (e) {
            // Can't sleep - maybe not night enough or monsters nearby
          } finally {
            isTryingToSleep = false;
          }
        }
      }
    } catch (e) {
      isTryingToSleep = false;
      addLog("[Bed] Error:", e.message);
    }
  }, 10000);
}

// Chat module
// FIX: wire up discord.events.chat flag
function chatModule(bot) {
  bot.on("chat", (username, message) => {
    if (!bot || username === bot.username) return;

    try {
      // FIX: send chat events to Discord if enabled
      if (
        config.discord &&
        config.discord.enabled &&
        config.discord.events &&
        config.discord.events.chat
      ) {
        sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);
      }

      if (config.chat && config.chat.respond) {
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.includes("hello") || lowerMsg.includes("hi")) {
          bot.chat(`Hello, ${username}!`);
        }
        if (message.startsWith("!tp ")) {
          const target = message.split(" ")[1];
          if (target) bot.chat(`/tp ${target}`);
        }
      }
    } catch (e) {
      addLog("[Chat] Error:", e.message);
    }
  });
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================
const readline = require("readline");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  if (!bot || !botState.connected) {
    addLog("[Console] Bot not connected");
    return;
  }

  const trimmed = line.trim();
  if (trimmed.startsWith("say ")) {
    bot.chat(trimmed.slice(4));
  } else if (trimmed.startsWith("cmd ")) {
    bot.chat("/" + trimmed.slice(4));
  } else if (trimmed === "status") {
    addLog(
      `[Status] Bot: ${botState.connected ? "Connected" : "Disconnected"}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`,
    );
  } else {
    bot.chat(trimmed);
  }
});

// ============================================================
// DISCORD WEBHOOK INTEGRATION
// FIX: use Buffer.byteLength for Content-Length (handles non-ASCII usernames correctly)
// FIX: rate limiting to avoid spam when bot is flapping
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (
    !config.discord ||
    !config.discord.enabled ||
    !config.discord.webhookUrl ||
    config.discord.webhookUrl.includes("YOUR_DISCORD")
  )
    return;

  // FIX: Discord rate limiting - skip if sent too recently
  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) {
    addLog("[Discord] Rate limited - skipping webhook");
    return;
  }
  lastDiscordSend = now;

  const protocol = config.discord.webhookUrl.startsWith("https") ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);

  const payload = JSON.stringify({
    username: config.name,
    embeds: [
      {
        description: content,
        color: color,
        timestamp: new Date().toISOString(),
        footer: { text: "Slobos AFK Bot" },
      },
    ],
  });

  const options = {
    hostname: urlParts.hostname,
    port: 443,
    path: urlParts.pathname + urlParts.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // FIX: use Buffer.byteLength instead of payload.length - handles non-ASCII (e.g. usernames with accents/emoji)
      "Content-Length": Buffer.byteLength(payload, "utf8"),
    },
  };

  const req = protocol.request(options, (res) => {
    // Silent success
  });

  req.on("error", (e) => {
    addLog(`[Discord] Error sending webhook: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

// ============================================================
// CRASH RECOVERY - IMMORTAL MODE
// FIX: guard against uncaughtException stacking reconnects when isReconnecting is already true
// ============================================================
process.on("uncaughtException", (err) => {
  const msg = err.message || "Unknown";
  addLog(`[FATAL] Uncaught Exception: ${msg}`);
  botState.errors.push({ type: "uncaught", message: msg, time: Date.now() });

  // Cap errors array to prevent memory leak over long uptimes
  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  const isNetworkError =
    msg.includes("PartialReadError") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("timed out") ||
    msg.includes("write after end") ||
    msg.includes("This socket has been ended");

  if (isNetworkError) {
    addLog("[FATAL] Known network/protocol error - recovering gracefully...");
  }

  // ALWAYS recover — bot must never stay disconnected
  clearAllIntervals();
  botState.connected = false;
  isConnecting = false;

  // FIX: reset isReconnecting if it was stuck, then schedule reconnect
  if (isReconnecting) {
    addLog(
      "[FATAL] isReconnecting was stuck - resetting before crash recovery",
    );
    isReconnecting = false;
    // BUG FIX: was referencing non-existent 'reconnectTimeout' — correct name is 'reconnectTimeoutId'
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  }

  setTimeout(
    () => {
      scheduleReconnect();
    },
    isNetworkError ? 5000 : 10000,
  );
});

function isDetachedFrameError(reason) {
  const msg = String(reason && reason.message ? reason.message : reason);
  return (
    msg.includes("Attempted to use detached Frame") ||
    msg.includes("Execution context was destroyed") ||
    msg.includes("Cannot find context with specified id") ||
    msg.includes("Target closed") ||
    msg.includes("Page crashed")
  );
}

process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  if (isDetachedFrameError(reason)) {
    addLog("[FATAL] Detached frame rejection ignored.");
    return;
  }
  addLog(`[FATAL] Unhandled Rejection: ${reason}`);
  botState.errors.push({ type: "rejection", message: msg, time: Date.now() });
  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  const isNetworkError =
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("timed out") ||
    msg.includes("PartialReadError");

  if (isNetworkError && !isReconnecting) {
    // ONLY reconnect if this process is supposed to be running a bot directly
    if (IS_MINECRAFT_WORKER || !USE_SPLIT_MINECRAFT) {
      addLog("[FATAL] Network rejection — triggering reconnect...");
      clearAllIntervals();
      botState.connected = false;
      isConnecting = false;
      if (bot) {
        try { bot.end(); } catch (_) { }
        bot = null;
      }
      scheduleReconnect();
    } else {
      addLog("[FATAL] Network rejection in Master (Split mode) — ignoring bot reconnect logic.");
    }
  }
});

process.on("SIGTERM", () => {
  addLog("[System] SIGTERM received — ignoring, bot will stay alive.");
});

process.on("SIGINT", () => {
  addLog("[System] SIGINT received — ignoring, bot will stay alive.");
});

// =============================
//===============================
// START THE BOT
// ============================================================
if (!IS_MINECRAFT_WORKER) {
  addLog("=".repeat(50));
  addLog("  Minecraft AFK Bot v2.5 - Bug-Fixed Edition");
  addLog("=".repeat(50));
  addLog(`Server: ${config.server.ip}:${config.server.port}`);
  addLog(`Version: ${config.server.version}`);
  addLog(
    `Auto-Reconnect: ${config.utils["auto-reconnect"] ? "Enabled" : "Disabled"}`,
  );
  addLog(
    "Dashboard: Enabled",
  );
  addLog("=".repeat(50));
}

async function main() {
  console.log(`[System] Entering main() as ${IS_MINECRAFT_WORKER ? 'WORKER' : 'MASTER'}`);

  if (IS_MINECRAFT_WORKER) {
    addLog("[MinecraftWorker] Mineflayer system standby — waiting for start signal.");
    publishMinecraftState();
    return;
  }

  if (USE_SPLIT_MINECRAFT) {
    addLog("[System] Starting worker process...");
    startMinecraftWorker();
    botRunning = true;
    // No more hardcoded 5s delay here, master waits for "ready" message
  } else {
    botRunning = true;
    createBot();
  }
}

console.log("[System] Script fully loaded, calling main()...");
main().catch(err => {
  if (!IS_MINECRAFT_WORKER) {
    addLog(`[FATAL] Startup error: ${err.stack || err.message}`);
  }
});
