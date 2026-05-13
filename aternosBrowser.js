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
    this.ajaxToken = null;
  }

  async init() {
    if (this.isInitialized && this.page && !this.page.isClosed()) {
      try {
        await this.page.evaluate(() => 1);
        return;
      } catch (e) {
        this.addLog("[AternosBrowser] Page detached or unresponsive, recovering...");
        this.isInitialized = false;
      }
    }

    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        if (!fs.existsSync(this.userDataDir)) {
          fs.mkdirSync(this.userDataDir, { recursive: true });
        }

        const launch = async (retryCount = 0) => {
          const cleanup = (dir) => {
            const items = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
            for (const item of items) {
              const p = path.join(dir, item);
              if (fs.existsSync(p)) {
                try { fs.unlinkSync(p); } catch (e) { }
              }
            }
          };
          cleanup(this.userDataDir);
          cleanup(path.join(this.userDataDir, 'Default'));

          try {
            if (retryCount === 0) {
              this.addLog("[AternosBrowser] Launching browser...");
            }

            if (process.platform === 'win32' && retryCount > 0) {
              try {
                const { execSync } = require('child_process');
                execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
              } catch (e) { }
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
                "--js-flags=--max-old-space-size=128 --expose-gc",
                "--disable-canvas-aa",
                "--disable-2d-canvas-clip-aa",
                "--disable-gl-drawing-for-tests",
                "--disable-hang-monitor",
                "--disable-ipc-flooding-protection",
                "--disable-popup-blocking",
                "--disable-prompt-on-repost",
                "--disable-renderer-backgrounding",
                "--metrics-recording-only",
                "--no-default-browser-check",
                "--disable-infobars",
                "--disable-notifications",
                "--disable-offer-store-unmasked-wallet-cards",
                "--disable-offer-upload-credit-cards",
                "--disable-software-rasterizer",
              ],
            });

            const pages = await this.browser.pages();
            this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

            if (pages.length > 1) {
              for (let i = 1; i < pages.length; i++) {
                try { await pages[i].close(); } catch (e) { }
              }
            }

            await this.page.setViewport({ width: 1280, height: 720 });

            await this.page.setRequestInterception(false);

            await this.page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

            await this.page.evaluateOnNewDocument(() => {
              const findInShadows = (root, text) => {
                if (!root) return null;
                const selectors = 'a, button, div, span, [role="button"], .btn';
                const elements = Array.from(root.querySelectorAll(selectors));
                for (const el of elements) {
                  const content = (el.textContent || el.innerText || "").toLowerCase();
                  if (content.includes(text.toLowerCase())) return el;
                }
                const all = root.querySelectorAll('*');
                for (const el of all) {
                  if (el.shadowRoot) {
                    const found = findInShadows(el.shadowRoot, text);
                    if (found) return found;
                  }
                }
                return null;
              };

              setInterval(() => {
                const candidates = ['continue with adblock', 'continue anyway', 'adblocker anyway'];
                for (const c of candidates) {
                  const btn = findInShadows(document, c);
                  if (btn && btn.getBoundingClientRect().width > 0) {
                    btn.click();
                    ['mousedown', 'mouseup', 'click'].forEach(t => btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
                    if (btn.tagName === 'A' && btn.href && btn.href.includes('php')) window.location.href = btn.href;
                  }
                }

                const removeAll = (root, selector) => {
                  root.querySelectorAll(selector).forEach(el => el.remove());
                  root.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) removeAll(el.shadowRoot, selector);
                  });
                };
                ['.adblock-error', '.fc-ab-root', '.modal-backdrop', '#adblock-warning', '.ad-block-overlay', '[class*="adblock"]'].forEach(s => removeAll(document, s));

                if (document.body) {
                  document.body.style.setProperty('overflow', 'auto', 'important');
                  document.body.style.setProperty('display', 'block', 'important');
                }
              }, 1000);
            });

            await this.page.addStyleTag({
              content: `
            .adblock-error, .fc-ab-root, .modal-backdrop, #adblock-warning, .ad-block-overlay { 
              display: none !important; 
              visibility: hidden !important; 
              pointer-events: none !important; 
            }
            .main-content, .server-page, #main {
              display: block !important;
              visibility: visible !important;
              opacity: 1 !important;
            }
            body { overflow: auto !important; }
          `});

            const cleanVal = (val) => String(val || "").replace(/^["']|["']$/g, "").trim();
            const session = cleanVal(process.env.ATERNOS_SESSION);
            const ajaxToken = cleanVal(process.env.ATERNOS_AJAX_TOKEN);

            if (session) {
              await this.page.setCookie({
                name: 'ATERNOS_SESSION', value: session, domain: '.aternos.org', path: '/', secure: true, httpOnly: true
              });
            }
            if (ajaxToken) {
              await this.page.setCookie({
                name: 'ATERNOS_AJAX_TOKEN', value: ajaxToken, domain: '.aternos.org', path: '/', secure: true, httpOnly: false
              });
            }

            this.isInitialized = true;
            this.initializing = null;
            this.launchTime = Date.now();
            this.addLog("Browser background process started.");
          } catch (err) {
            if (err.message.includes("already running") && retryCount < 5) {
              this.addLog(`[AternosBrowser] Profile locked, retrying... (Attempt ${retryCount + 1})`);
              await new Promise(r => setTimeout(r, 3000));
              return launch(retryCount + 1);
            }
            throw err;
          }
        };

        await launch();
      } catch (err) {
        this.addLog(`[AternosBrowser] FATAL ERROR: ${err.message}`);
        this.isInitialized = false;
        this.initializing = null;
      }
    })();

    return this.initializing;
  }

  async ensureLoggedIn() {
    await this.init();
    this.addLog("[AternosBrowser] Checking login status...");

    try {
      await this.page.goto(this.serverPage, { waitUntil: "networkidle2", timeout: 45000 });
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      this.addLog(`[AternosBrowser] Navigation error: ${err.message}`);
    }

    const loginState = await this.page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : "";
      const title = document.title;
      const isCloudflare = bodyText.includes("Cloudflare") || bodyText.includes("Verify you are human") || title.includes("Just a moment");
      const isError = title.includes("502") || title.includes("503") || title.includes("Bad Gateway") || title.includes("Service Unavailable") || bodyText.includes("Error 502") || bodyText.includes("Error 503");

      const userField = document.querySelector('input[name="user"], #user');
      const logoutBtn = document.querySelector('a[href*="/logout/"], .logout-button');
      const serversBtn = document.querySelector('a[href*="/servers/"], .servers-button');
      const serverStatus = document.querySelector('.statuslabel-label, .server-status');

      return {
        isCloudflare,
        isError,
        isLoginPage: userField !== null || location.href.includes('/login/') || location.href.includes('/go/'),
        isLoggedIn: logoutBtn !== null || serversBtn !== null || serverStatus !== null || location.href.includes('/server/'),
        bodyLength: bodyText.length
      };
    });

    if (loginState.isError) {
      this.addLog("[AternosBrowser] Aternos site is down or experiencing issues (502/503). Waiting...");
      return;
    }

    if (loginState.isCloudflare) {
      this.addLog("[AternosBrowser] Cloudflare challenge detected! Please login manually via dashboard.");
      return;
    }

    if (loginState.isLoginPage || (loginState.bodyLength < 1000 && !loginState.isLoggedIn)) {
      this.addLog("[AternosBrowser] Not logged in. Attempting automatic login...");
      const username = (process.env.ATERNOS_USER || "").trim();
      const password = (process.env.ATERNOS_PASS || "");
      if (username && password) {
        try {
          const result = await this.loginWithCredentials(username, password);
          if (result.success) {
            this.addLog("[AternosBrowser] Automatic login succeeded.");
            return;
          } else {
            this.addLog(`[AternosBrowser] Automatic login failed: ${result.error}`);
          }
        } catch (e) {
          this.addLog(`[AternosBrowser] Login attempt failed: ${e.message}`);
        }
      } else {
        this.addLog("[AternosBrowser] Credentials missing in .env.");
      }
    } else {
      this.addLog("[AternosBrowser] Already logged in successfully.");
    }
  }

  async loginWithCredentials(username, password) {
    await this.init();
    const user = String(username || "").trim();
    const pass = String(password || "");
    if (!user || !pass) return { success: false, error: "Username and password are required." };

    this.addLog(`[AternosBrowser] Logging in with username: ${user}`);
    try {
      await this.page.goto("https://aternos.org/go/", { waitUntil: "networkidle2", timeout: 60000 });
      await this.page.waitForSelector('input[name="user"], #user', { visible: true, timeout: 30000 });

      const userSelector = await this.page.$('input[name="user"]') ? 'input[name="user"]' : '#user';
      const passwordSelector = await this.page.$('input[name="password"]') ? 'input[name="password"]' : '#password';    

      await this.page.click(userSelector, { clickCount: 3 });
      await this.page.type(userSelector, user, { delay: 50 });
      await this.page.click(passwordSelector, { clickCount: 3 });
      await this.page.type(passwordSelector, pass, { delay: 50 });

      const clicked = await this.page.evaluate(() => {
        const candidates = [
          document.querySelector("#login"), document.querySelector('button[type="submit"]'),
          document.querySelector('input[type="submit"]'), document.querySelector('.login-button')
        ].filter(Boolean);
        const button = candidates.find((el) => el.offsetParent !== null) || candidates[0];
        if (!button) return false;
        button.click();
        return true;
      });

      if (!clicked) await this.page.keyboard.press("Enter");
      await new Promise(r => setTimeout(r, 5000));

      const result = await this.page.evaluate(() => {
        const bodyText = (document.body ? document.body.innerText : "").toLowerCase();
        const loginField = document.querySelector('input[name="user"], #user');
        if (location.href.includes("/server/") || location.href.includes("/servers/")) return { success: true };        
        if (loginField && (bodyText.includes("captcha") || bodyText.includes("verification"))) return { success: false, manualRequired: true, error: "Captcha required." };
        if (loginField) return { success: false, error: "Login failed." };
        return { success: true };
      });

      if (result.success && !this.page.url().includes("/server/")) {
        await this.page.goto(this.serverPage, { waitUntil: "networkidle2", timeout: 30000 });
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  async loginWithCookieString(cookieString) {
    await this.init();
    const cookies = this.parseCookieString(cookieString);
    if (!cookies.length) return { success: false, error: "No valid cookies found." };
    try {
      const page = await this.getActivePage();
      await page.goto(this.baseUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.setCookie(...cookies);
      await page.goto(this.serverPage, { waitUntil: "networkidle2", timeout: 20000 });
      await new Promise((r) => setTimeout(r, 2000));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  parseCookieString(cookieString) {
    return String(cookieString || "").split(";").map(part => {
      const eq = part.indexOf("=");
      if (eq === -1) return null;
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim(), domain: ".aternos.org", path: "/", secure: true, httpOnly: true };
    }).filter(Boolean);
  }

  async setHeadless(headless) {
    if (this.headless === (headless !== false)) return;
    this.headless = headless !== false;
    await this.close();
  }

  async getActivePage() {
    await this.init();
    if (this.page && !this.page.isClosed()) return this.page;
    const pages = await this.browser.pages().catch(() => []);
    this.page = pages.find(p => !p.isClosed()) || await this.browser.newPage();
    return this.page;
  }

  async getStatus() {
    if (this.isInitialized && this.launchTime && (Date.now() - this.launchTime > 15 * 60 * 1000)) {
      this.addLog("[AternosBrowser] Recycling browser...");
      await this.close();
    }
    await this.init();
    try {
      const isLogin = await this.page.evaluate(() => document.querySelector('input[name="user"]') !== null || location.href.includes('/login/'));
      if (isLogin) return { class: "unknown", label: "Please Log In" };

      if (!this.page.url().includes("/server/")) {
        await this.page.goto(this.serverPage, { waitUntil: "networkidle2", timeout: 20000 });
      }

      // EXPLICIT BYPASS CHECK
      const bypassResult = await this.page.evaluate(() => {
          const findInShadows = (root, text) => {
            if (!root) return null;
            const selectors = 'a, button, div, span, [role="button"], .btn';
            const elements = Array.from(root.querySelectorAll(selectors));
            for (const el of elements) {
              const content = (el.textContent || el.innerText || "").toLowerCase();
              if (content.includes(text.toLowerCase())) return el;
            }
            const all = root.querySelectorAll('*');
            for (const el of all) {
              if (el.shadowRoot) {
                const found = findInShadows(el.shadowRoot, text);
                if (found) return found;
              }
            }
            return null;
          };

          const candidates = ['continue with adblock', 'continue anyway', 'adblocker anyway'];
          for (const c of candidates) {
            const btn = findInShadows(document, c);
            if (btn) {
               const rect = btn.getBoundingClientRect();
               if (rect.width > 0 && rect.height > 0) {
                   btn.click();
                   return "clicked: " + c;
               }
               return "found but hidden: " + c;
            }
          }
          return "not found";
      });

      if (bypassResult.startsWith("clicked")) {
          this.addLog(`[AternosBrowser] Adblock bypass: ${bypassResult}`);
          await new Promise(r => setTimeout(r, 2000));
      }

      try {
        await this.page.waitForSelector(".statuslabel-label, .statuslabel, .server-status", { timeout: 3000 });
      } catch (e) { }

      const status = await this.page.evaluate(() => {
        try {
          if (!document.body) return { error: "document.body is null" };
          const selectors = [".statuslabel-label", ".statuslabel", "#status", ".status-label", ".server-status"];
          let el = null;
          for (const s of selectors) {
            el = document.querySelector(s);
            if (el && el.innerText.trim().length > 0) break;
          }

          if (!el) {
             const txt = document.body.innerText || "";
             const possible = ["offline", "online", "starting", "loading", "queue", "waiting", "stopping", "saving", "crashed"];
             for (const s of possible) {
               if (txt.toLowerCase().includes(s)) {
                 return { class: s === "crashed" ? "offline" : s, label: s.charAt(0).toUpperCase() + s.slice(1) };
               }
             }
             return { error: "Status element not found", bodyLength: txt.length, bodySnippet: txt.substring(0, 500) };
          }

          const label = el.innerText.trim();
          let cls = "unknown";
          if (label.toLowerCase().includes("offline")) cls = "offline";
          else if (label.toLowerCase().includes("online")) cls = "online";
          else if (label.toLowerCase().includes("starting")) cls = "starting";
          else if (label.toLowerCase().includes("queue")) cls = "queue";
          return { class: cls, label: label };
        } catch (e) { return { error: e.message }; }
      });

      if (status && status.error) {
        this.addLog(`[AternosBrowser] Status element missing (Body: ${status.bodyLength} chars)`);
        if (status.bodySnippet) this.addLog(`[AternosBrowser] Snippet: ${status.bodySnippet.substring(0, 100)}...`);
        this.statusFailCount = (this.statusFailCount || 0) + 1;
        if (this.statusFailCount >= 2) {
           this.statusFailCount = 0;
           await this.page.reload({ waitUntil: "networkidle2" });
        }
      } else {
        this.statusFailCount = 0;
      }

      if (status && status.class === "queue") await this.confirmQueue();
      return status;
    } catch (err) {
      this.isInitialized = false;
      return { error: err.message };
    }
  }

  async startServer() {
    await this.init();
    try {
      await this.handleNotificationPopup();
      const clicked = await this.page.evaluate(() => {
        const btn = document.getElementById("start");
        if (btn && btn.offsetParent !== null) { btn.click(); return true; }
        return false;
      });
      if (clicked) {
        this.addLog("[AternosBrowser] Start button clicked.");
        await new Promise(r => setTimeout(r, 3000));
        await this.confirmQueue();
      }
    } catch (err) { }
  }

  async handleNotificationPopup() {
    try {
      await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.btn-danger, .btn-secondary, button, .btn-close, [data-dismiss="modal"]'));
        for (const b of btns) {
          const t = b.innerText.toLowerCase();
          if (t.includes('allow') || t.includes('notify') || t.includes('okay') || t.includes('no') || b.classList.contains('btn-close')) {
            if (b.offsetParent !== null) b.click();
          }
        }
      });
    } catch (e) { }
  }

  async confirmQueue() {
    try {
      const ok = await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.btn-success, #confirm, .btn-primary'));
        for (const b of btns) {
          const t = b.innerText.toLowerCase();
          if (t.includes('confirm') || t.includes('start now') || b.id === 'confirm') {
            if (b.offsetParent !== null) { b.click(); return true; }
          }
        }
        return false;
      });
      if (ok) this.addLog("[AternosBrowser] Queue confirmed.");
    } catch (err) { }
  }

  async getTokens() {
    await this.init();
    try {
      if (!this.page.url().includes("/server/")) await this.page.goto(this.serverPage, { waitUntil: "networkidle2" });
      const cookies = await this.page.cookies();
      const session = cookies.find(c => c.name === 'ATERNOS_SESSION');
      const ajaxToken = await this.page.evaluate(() => window.ajaxToken || null);
      return { session: session ? session.value : null, token: ajaxToken };
    } catch (err) { return null; }
  }

  async close() {
    if (this.initializing) try { await this.initializing; } catch (e) { }
    if (this.browser) {
      try {
        const pages = await this.browser.pages();
        for (const p of pages) await p.close().catch(() => {});
        await this.browser.close();
      } catch (e) {
        try { const p = this.browser.process(); if (p) p.kill('SIGKILL'); } catch (e2) {}
      }
      this.browser = null;
    }
    this.page = null;
    this.isInitialized = false;
    this.initializing = null;
  }
}

module.exports = AternosBrowser;
