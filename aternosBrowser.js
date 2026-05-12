"use strict";

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const path = require("path");
const fs = require("fs");

puppeteer.use(StealthPlugin());

class AternosBrowser {
  constructor(options) {
    this.addLog = options.addLog || console.log;
    this.userDataDir = path.join(process.cwd(), ".aternos_browser_data");
    this.browser = null;
    this.page = null;
    this.headless = options.headless !== false;
    this.baseUrl = "https://aternos.org";
    this.serverPage = "https://aternos.org/server/";
    this.isInitialized = false;
    this.initializing = null;
  }

  async init() {
    if (this.isInitialized && this.page && !this.page.isClosed()) {
      try {
        // Simple check to see if frame is still attached
        await this.page.evaluate(() => 1);
        return;
      } catch (e) {
        this.addLog("[AternosBrowser] Page detached or unresponsive, recovering...");
        this.isInitialized = false;
      }
    }
    
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      if (!fs.existsSync(this.userDataDir)) {
        fs.mkdirSync(this.userDataDir, { recursive: true });
      }

      const launch = async (retryCount = 0) => {
        try {
          if (retryCount === 0) {
            this.addLog("[AternosBrowser] Launching browser...");
          }
          
          this.browser = await puppeteer.launch({
            headless: this.headless,
            userDataDir: this.userDataDir,
            args: [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-blink-features=AutomationControlled",
              "--no-first-run",
              "--disable-dev-shm-usage",
              "--disable-accelerated-2d-canvas",
              "--disable-gpu",
              "--no-zygote",
              "--disable-extensions",
              "--disable-component-update",
              "--disable-default-apps",
              "--disable-sync",
              "--mute-audio",
              "--hide-scrollbars",
              "--disable-background-networking",
              "--disable-background-timer-throttling",
              "--disable-backgrounding-occluded-windows",
              "--disable-breakpad",
              "--disable-client-side-phishing-detection",
              "--disable-features=Translate",
              "--disable-hang-monitor",
              "--disable-ipc-flooding-protection",
              "--disable-popup-blocking",
              "--disable-prompt-on-repost",
              "--disable-renderer-backgrounding",
              "--metrics-recording-only",
              "--no-default-browser-check",
            ],
          });

          const pages = await this.browser.pages();
          this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

          // MINIMIZE VIEWPORT TO SAVE RAM
          await this.page.setViewport({ width: 10, height: 10 });
          await this.page.setCacheEnabled(false);

          // BLOCK IMAGES BUT ALLOW CSS FOR STABILITY
          await this.page.setRequestInterception(true);
          this.page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'font', 'media'].includes(type)) {
              req.abort();
            } else {
              req.continue();
            }
          });

          await this.page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
          );

          this.isInitialized = true;
          this.initializing = null;
          this.addLog("Browser monitor started (Low Memory Mode)");
        } catch (err) {
          if (err.message.includes("already running") && retryCount < 3) {
            this.addLog(`[AternosBrowser] Profile locked, retrying in 2s... (Attempt ${retryCount + 1})`);
            await new Promise(r => setTimeout(r, 2000));
            return launch(retryCount + 1);
          }
          
          this.initializing = null;
          this.addLog(`[AternosBrowser] Failed to launch browser: ${err.message}`);
          throw err;
        }
      };

      await launch();
    })();

    return this.initializing;
  }

  async ensureLoggedIn() {
    await this.init();
    this.addLog("[AternosBrowser] Checking login status...");
    
    try {
      await this.page.goto(this.serverPage, { waitUntil: "domcontentloaded", timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      this.addLog(`[AternosBrowser] Navigation error: ${err.message}`);
    }

    // Check if we are on the login page
    const isLoginPage = await this.page.evaluate(() => {
      const userField = document.querySelector('input[name="user"]');
      const loginForm = document.querySelector('form[action*="/login/"]');
      return userField !== null || loginForm !== null || location.href.includes('/login/');
    });

    if (isLoginPage) {
      this.addLog("[AternosBrowser] Not logged in. Please log in manually in the browser window or use credentials.");
      if (this.headless) {
        this.addLog("[AternosBrowser] HEADLESS MODE: Cannot log in manually. Please run with headless: false once to log in.");
      }
    } else {
      this.addLog("[AternosBrowser] Logged in successfully.");
    }
  }

  async getStatus() {
    await this.init();
    try {
      if (!this.page.url().includes("/server/")) {
        await this.page.goto(this.serverPage, { waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 2000));
      }

      // Scrape status directly from the DOM (more reliable than fetch which can get 503)
      const status = await this.page.evaluate(() => {
        try {
          const labelElement = document.querySelector(".statuslabel-label");
          if (!labelElement) return { error: "Status element not found" };

          const label = labelElement.innerText.trim();
          let statusClass = "unknown";
          
          const lowerLabel = label.toLowerCase();
          if (lowerLabel.includes("offline")) statusClass = "offline";
          else if (lowerLabel.includes("online")) statusClass = "online";
          else if (lowerLabel.includes("starting") || lowerLabel.includes("loading")) statusClass = "starting";
          else if (lowerLabel.includes("queue") || lowerLabel.includes("waiting")) statusClass = "queue";
          else if (lowerLabel.includes("stopping") || lowerLabel.includes("saving")) statusClass = "stopping";
          else if (lowerLabel.includes("crashed")) statusClass = "offline";

          // Try to find countdown
          let countdown = null;
          const countdownElement = document.querySelector(".statuslabel-time");
          if (countdownElement) {
            const timeMatch = countdownElement.innerText.match(/(\d+)/);
            if (timeMatch) countdown = parseInt(timeMatch[1]);
          }

          return {
            class: statusClass,
            label: label,
            countdown: countdown
          };
        } catch (e) {
          return { error: e.message };
        }
      });

      // If we are in queue, immediately try to confirm without waiting
      if (status && status.class === "queue") {
        this.confirmQueue();
      }

      return status;
    } catch (err) {
      if (err.message.includes("detached") || err.message.includes("closed")) {
        this.isInitialized = false; // Force re-init on next call
      }
      this.addLog(`[AternosBrowser] Error getting status: ${err.message}`);
      return null;
    }
  }

  async startServer() {
    await this.init();
    this.addLog("[AternosBrowser] Attempting to start server...");
    try {
      await this.page.bringToFront();
      
      // Close any annoying notification popups first
      await this.handleNotificationPopup();

      // Click the start button
      const clicked = await this.page.evaluate(() => {
        const btn = document.getElementById("start");
        if (btn && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
        return false;
      });

      if (clicked) {
        this.addLog("[AternosBrowser] Start button clicked.");
        // Wait a bit for potential queue/confirm
        await new Promise(r => setTimeout(r, 3000));
        await this.confirmQueue();
      } else {
        this.addLog("[AternosBrowser] Start button not found or not visible.");
      }
    } catch (err) {
      this.addLog(`[AternosBrowser] Error starting server: ${err.message}`);
    }
  }

  async handleNotificationPopup() {
    try {
      await this.page.evaluate(() => {
        // Try to find and click "No" on the notification popup
        const buttons = Array.from(document.querySelectorAll('.btn-danger, .btn-secondary, button'));
        for (const btn of buttons) {
          const text = btn.innerText.toLowerCase();
          if (text.includes('allow') || text.includes('notify') || text.includes('okay') || text.includes('no')) {
             if (btn.offsetParent !== null) {
               btn.click();
             }
          }
        }
        // Also close any visible modals if they look like notifications
        const closeBtns = document.querySelectorAll('.close, .btn-close, [data-dismiss="modal"]');
        closeBtns.forEach(b => b.click());
      });
    } catch (e) {
      // ignore errors here
    }
  }

  async confirmQueue() {
    this.addLog("[AternosBrowser] Checking for queue confirmation...");
    try {
      const confirmed = await this.page.evaluate(() => {
        // Specific logic for queue confirmation
        const buttons = Array.from(document.querySelectorAll('.btn-success, #confirm, .btn.btn-success, .btn-primary'));
        for (const btn of buttons) {
          const text = btn.innerText.toLowerCase();
          // Prioritize queue-related words
          if (text.includes('confirm') || 
              text.includes('start now') ||
              btn.id === 'confirm' ||
              (text.includes('okay') && document.body.innerText.toLowerCase().includes('queue'))) {
            if (btn.offsetParent !== null) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      });

      if (confirmed) {
        this.addLog("[AternosBrowser] Queue/Confirm button clicked.");
      }
    } catch (err) {
      this.addLog(`[AternosBrowser] Error confirming queue: ${err.message}`);
    }
  }

  async getTokens() {
    await this.init();
    try {
      if (!this.page.url().includes("/server/")) {
        await this.page.goto(this.serverPage, { waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 2000));
      }

      const cookies = await this.page.cookies();
      const sessionCookie = cookies.find(c => c.name === 'ATERNOS_SESSION');
      
      const ajaxToken = await this.page.evaluate(() => {
        return typeof ajaxToken !== 'undefined' ? ajaxToken : (window.ajaxToken || null);
      });

      return {
        session: sessionCookie ? sessionCookie.value : null,
        token: ajaxToken
      };
    } catch (err) {
      return null;
    }
  }

  async close() {
    // If a launch is currently in progress, wait for it to finish so we don't leave a zombie
    if (this.initializing) {
      try {
        await this.initializing;
      } catch (e) {}
    }

    if (this.browser) {
      try {
        // Force kill the Chrome process to guarantee no zombie processes are left behind
        const proc = this.browser.process();
        if (proc) {
          proc.kill('SIGKILL');
        }
      } catch (e) {}

      try {
        await this.browser.close();
      } catch (e) {}
      
      this.browser = null;
    }
    
    this.page = null;
    this.isInitialized = false;
    this.initializing = null;
  }
}

module.exports = AternosBrowser;
