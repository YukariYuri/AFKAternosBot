"use strict";

const AternosBrowser = require("./aternosBrowser");

const DEFAULTS = {
  enabled: false,
  useBrowser: true,
  headless: true,
  pollInterval: 30000,
  offlineStartDelay: 10000,
  connectAfterOnlineDelay: 15000,
  readyStatuses: ["online"], // Bot will only connect when fully online
  confirmStatuses: ["queue", "confirm", "confirming"],
};

function mergeDefaults(input) {
  return {
    ...DEFAULTS,
    ...(input || {}),
  };
}

class AternosController {
  constructor(options) {
    this.config = mergeDefaults(options.config);
    this.addLog = options.addLog || console.log;
    this.getBotState = options.getBotState;
    this.disconnectBot = options.disconnectBot;
    this.connectBot = options.connectBot;

    this.browser = new AternosBrowser({
      addLog: this.addLog,
      headless: this.config.headless,
    });

    this.timer = null;
    this.lastStatus = null;
    this.lastStartAt = 0;
    this.lastConnectAt = 0;
    this.lastError = null;
    this.running = false;
  }

  isEnabled() {
    return Boolean(this.config.enabled);
  }

  isReadyForMinecraft() {
    if (!this.isEnabled()) return true;
    return this.config.readyStatuses.includes(this.lastStatus?.class);
  }

  getPublicState() {
    return {
      enabled: Boolean(this.config.enabled),
      running: this.running,
      status: this.lastStatus,
      lastStartAt: this.lastStartAt,
      lastError: this.lastError,
      useBrowser: this.config.useBrowser,
    };
  }

  async start() {
    if (!this.config.enabled) {
      this.addLog("[Aternos] Auto-start disabled in settings.");
      return;
    }

    if (this.timer) clearInterval(this.timer);
    this.running = true;
    this.addLog("[Aternos] Auto-start monitor enabled (Browser-based).");

    try {
      await this.browser.ensureLoggedIn();
      await this.syncTokens();
    } catch (err) {
      this.handleError(err);
    }

    const poll = async () => {
      try {
        await this.tick("poll");
      } catch (err) {
        this.handleError(err);
      }
      
      // Dynamic interval: 60s if hibernating/connected, otherwise use config (10s)
      const state = this.getBotState ? this.getBotState() : null;
      const interval = (state && state.connected && this.lastStatus?.class === "online") 
                       ? 60000 
                       : (this.config.pollInterval || 10000);
                       
      this.timer = setTimeout(poll, interval);
    };

    this.tick("startup").catch((err) => this.handleError(err));
    this.timer = setTimeout(poll, this.config.pollInterval);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.browser.close();
  }

  async ensureStarted(reason) {
    if (!this.isEnabled()) return;
    await this.tick(reason || "ensure-started");
  }

  async tick(reason) {
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      // MEMORY OPTIMIZATION: If the Minecraft bot is actively connected to the server,
    // AND we already confirmed the server is fully "online", we can skip waking up Puppeteer!
    const state = this.getBotState ? this.getBotState() : null;
    if (state && state.connected && reason === "poll" && this.lastStatus && this.lastStatus.class === "online") {
      return;
    }

    const status = await this.browser.getStatus();
    if (!status) {
      this.addLog("[Aternos] Failed to fetch status from browser.");
      return;
    }

    if (status.error) {
      this.handleError(new Error(status.error));
      return;
    }

    this.lastStatus = status;
    this.lastError = null;

    const statusClass = status.class || "unknown";
    const label = status.label || statusClass;
    const countdown =
      status.countdown === null || status.countdown === undefined
        ? ""
        : `, countdown=${status.countdown}s`;
    
    // this.addLog(`[Aternos] Status: ${label} (${statusClass}${countdown})`); // Removed to keep logs clean as it's now in stat-card

    // logic for bot connection
    if (statusClass === "offline") {
      this.disconnectMinecraftBot("Aternos server is offline");
      await this.startServer(reason);
      return;
    }

    if (this.config.confirmStatuses.includes(statusClass)) {
      this.disconnectMinecraftBot("Aternos server is in queue");
      await this.browser.confirmQueue();
      return;
    }

    if (this.config.readyStatuses.includes(statusClass)) {
      this.connectMinecraftBot();
      
      // MEMORY OPTIMIZATION: If online and bot is connected, we can close the browser
      // It will reopen automatically on the next tick if needed
      const state = this.getBotState ? this.getBotState() : null;
      if (state && state.connected && statusClass === "online") {
        this.addLog("[Aternos] Server stable & bot connected. Hibernating browser to save RAM.");
        await this.browser.close();
      }
      return;
    }

    // Default: if it's some other state like 'stopping', 'loading', etc.
    this.disconnectMinecraftBot(`Aternos server is ${statusClass}`);
  } finally {
    this.isTicking = false;
  }
}

  async startServer(reason) {
    const now = Date.now();
    if (now - this.lastStartAt < this.config.offlineStartDelay) return;

    this.lastStartAt = now;
    this.addLog(`[Aternos] Sending start request via browser (${reason || "offline"}).`);
    await this.browser.startServer();
  }

  disconnectMinecraftBot(reason) {
    if (!this.getBotState || !this.disconnectBot) return;
    const state = this.getBotState();
    if (!state || (!state.connected && !state.bot)) return;
    this.addLog(`[Aternos] Disconnecting bot: ${reason}.`);
    this.disconnectBot(reason);
  }

  connectMinecraftBot() {
    if (!this.getBotState || !this.connectBot) return;
    const state = this.getBotState();
    
    // Don't connect if already connected or reconnecting
    if (!state || state.connected || state.bot || state.reconnecting) return;

    const now = Date.now();
    if (now - this.lastConnectAt < this.config.connectAfterOnlineDelay) return;

    this.lastConnectAt = now;
    this.addLog("[Aternos] Server status ready - connecting Minecraft bot.");
    this.connectBot();
  }

  async syncTokens() {
    const tokens = await this.browser.getTokens();
    if (!tokens || !tokens.session) return tokens;

    const fs = require("fs");
    const path = require("path");
    const envPath = path.join(process.cwd(), ".env");

    let envContent = "";
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, "utf8");
    }

    const updateOrAdd = (key, value) => {
      const regex = new RegExp(`^${key}=.*`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    };

    updateOrAdd("ATERNOS_SESSION", tokens.session);
    if (tokens.token) {
      updateOrAdd("ATERNOS_AJAX_TOKEN", tokens.token);
    }

    fs.writeFileSync(envPath, envContent.trim() + "\n");
    this.addLog("[Aternos] .env tokens updated automatically.");
    return tokens;
  }

  handleError(err) {
    this.lastError = err.message || String(err);
    this.addLog(`[Aternos] ${this.lastError}`);
  }
}

module.exports = AternosController;
