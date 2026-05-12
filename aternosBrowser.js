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
    this.latestFrame = null;
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
      try {
        if (!fs.existsSync(this.userDataDir)) {
          fs.mkdirSync(this.userDataDir, { recursive: true });
        }

        const launch = async (retryCount = 0) => {
          // ROBUST LOCK CLEANUP (Especially for Windows/Linux profile locks)
          const cleanup = (dir) => {
            const items = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
            for (const item of items) {
              const p = path.join(dir, item);
              if (fs.existsSync(p)) {
                try { fs.unlinkSync(p); } catch (e) {}
              }
            }
          };
          cleanup(this.userDataDir);
          cleanup(path.join(this.userDataDir, 'Default'));

          try {
            if (retryCount === 0) {
              this.addLog("[AternosBrowser] Launching browser...");
            }
            
            // On Windows, sometimes orphan processes keep the lock even after unlink.
            // If we are retrying, try to kill any leftover chrome processes.
            if (process.platform === 'win32' && retryCount > 0) {
              try {
                const { execSync } = require('child_process');
                execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
              } catch (e) {}
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
                "--js-flags=--max-old-space-size=128", // Limit V8 heap memory
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
              ],
            });

            const pages = await this.browser.pages();
            this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

            // CLOSE EXTRA TABS (Chrome sometimes restores previous crashed sessions)
            if (pages.length > 1) {
              for (let i = 1; i < pages.length; i++) {
                try { await pages[i].close(); } catch (e) {}
              }
            }

            await this.page.setViewport({ width: 1280, height: 720 });
            
            // START SCREENCAST: This is much more efficient than taking screenshots.
            const client = await this.page.target().createCDPSession();
            await client.send('Page.startScreencast', { format: 'webp', quality: 25, maxWidth: 800, maxHeight: 450 });
            client.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
              this.latestFrame = Buffer.from(data, 'base64');
              client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
            });

            // Block ads and trackers to save RAM
            await this.page.setRequestInterception(true);
            this.page.on('request', (req) => {
              const url = req.url().toLowerCase();
              const type = req.resourceType();
              if (
                ['font', 'media'].includes(type) ||
                url.includes('popup')
              ) {
                req.abort();
              } else {
                req.continue();
              }
            });

            await this.page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

          // PERSISTENT ADBLOCKER BYPASS (Background script)
          await this.page.evaluateOnNewDocument(() => {
            setInterval(() => {
              // 1. Recursive function to find elements even in Shadow DOM
              const findInShadows = (root, text) => {
                // Look for common button-like elements
                const selectors = 'a, button, div, span, [role="button"]';
                const elements = Array.from(root.querySelectorAll(selectors));
                for (const el of elements) {
                  const content = (el.textContent || el.innerText || "").toLowerCase();
                  if (content.includes(text.toLowerCase())) {
                    // Check if it's the actual button or a wrapper (prefer smaller elements)
                    if (el.children.length < 5) return el;
                  }
                }
                // Check shadow roots
                const all = root.querySelectorAll('*');
                for (const el of all) {
                  if (el.shadowRoot) {
                    const found = findInShadows(el.shadowRoot, text);
                    if (found) return found;
                  }
                }
                return null;
              };

              const adblockBtn = findInShadows(document, 'continue with adblocker anyway') || 
                                findInShadows(document, 'continue anyway');
              
              if (adblockBtn) {
                // Ensure it's visible and not a huge container
                adblockBtn.click();
                adblockBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                adblockBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                adblockBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              }

              // 2. Remove common adblock elements from everywhere
              const removeAll = (root, selector) => {
                root.querySelectorAll(selector).forEach(el => el.remove());
                root.querySelectorAll('*').forEach(el => {
                  if (el.shadowRoot) removeAll(el.shadowRoot, selector);
                });
              };
              ['.adblock-error', '.fc-ab-root', '.modal-backdrop', '#adblock-warning'].forEach(s => {
                removeAll(document, s);
              });

              // 3. Unlock scrolling
              document.body.style.setProperty('overflow', 'auto', 'important');
              document.documentElement.style.setProperty('overflow', 'auto', 'important');
              document.body.classList.remove('modal-open');
            }, 1000); // Check every 1s
          });

          // Force CSS to hide adblocker elements
          await this.page.addStyleTag({ content: `
            .adblock-error, .fc-ab-root, .modal-backdrop, #adblock-warning { 
              display: none !important; 
              visibility: hidden !important; 
              pointer-events: none !important; 
            }
            body { overflow: auto !important; }
          `});

            if (process.env.ATERNOS_SESSION) {
              await this.page.setCookie({
                name: 'ATERNOS_SESSION',
                value: process.env.ATERNOS_SESSION,
                domain: '.aternos.org',
                path: '/',
                secure: true,
                httpOnly: true
              });
            }

            this.isInitialized = true;
            this.initializing = null;
            this.launchTime = Date.now();
            this.addLog("Browser monitor started (Screencast Mode)");
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
      await this.page.goto(this.serverPage, { waitUntil: "domcontentloaded", timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      this.addLog(`[AternosBrowser] Navigation error: ${err.message}`);
    }

    // Check if we are on the login page
    const isLoginPage = await this.page.evaluate(() => {
      const userField = document.querySelector('input[name="user"]');
      const loginForm = document.querySelector('form[action*="/login/"]');
      return userField !== null || loginForm !== null || location.href.includes('/login/') || location.href.includes('/go/');
    });

    if (isLoginPage) {
      this.addLog("[AternosBrowser] Not logged in. Attempting automatic login...");
      
      const username = process.env.ATERNOS_USER || "";
      const password = process.env.ATERNOS_PASS || "";
      
      if (username && password) {
        try {
          await this.page.type('input[name="user"]', username);
          await this.page.type('input[name="password"]', password);
          await this.page.click('#login');
          await new Promise(r => setTimeout(r, 5000));
          
          if (this.page.url().includes('/server/')) {
            this.addLog("[AternosBrowser] Logged in successfully via credentials.");
            return;
          }
        } catch (e) {
          this.addLog(`[AternosBrowser] Login attempt failed: ${e.message}`);
        }
      }

      this.addLog("[AternosBrowser] Automatic login failed or credentials missing.");
      if (this.headless) {
        this.addLog("[AternosBrowser] HEADLESS MODE: Cannot log in manually. Please ensure ATERNOS_SESSION is set in .env or provide ATERNOS_USER/PASS.");
      }
    } else {
      this.addLog("[AternosBrowser] Logged in successfully.");
    }
  }

  async getStatus() {
    // MEMORY OPTIMIZATION: Recycle browser every 15 minutes to clear ad-related memory leaks
    if (this.isInitialized && this.launchTime && (Date.now() - this.launchTime > 15 * 60 * 1000)) {
      this.addLog("[AternosBrowser] Recycling browser to clear memory leaks...");
      await this.close();
    }
    
    await this.init();
    try {
      // Check if the user is currently on the login page by looking for the login form
      const isLoginScreen = await this.page.evaluate(() => {
        return document.querySelector('input[name="user"]') !== null || 
               document.querySelector('.login-form') !== null ||
               location.href.includes('/go/') || 
               location.href.includes('/login/') ||
               location.href.includes('accounts.google.com');
      });

      if (isLoginScreen) {
        return { class: "unknown", label: "Please Log In", error: null };
      }

      // ROBUST ADBLOCKER & POPUP CLEANER (Run again just before scraping)
      await this.page.evaluate(() => {
        const findInShadows = (root, text) => {
          if (!root) return null;
          const buttons = Array.from(root.querySelectorAll('a, button, div, span, .btn, [role="button"]'));
          for (const el of buttons) {
            if ((el.textContent || el.innerText || "").toLowerCase().includes(text.toLowerCase())) return el;
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

        const adblockBtn = findInShadows(document, 'continue with adblocker anyway') || findInShadows(document, 'continue anyway');
        if (adblockBtn) {
          adblockBtn.click();
          adblockBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }

        const removeAll = (root, selector) => {
          if (!root) return;
          root.querySelectorAll(selector).forEach(el => el.remove());
          root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) removeAll(el.shadowRoot, selector);
          });
        };

        // Remove blocking overlays and Google-related iframes/ins
        ['.adblock-error', '.fc-ab-root', '.modal-backdrop', '#adblock-warning', 'iframe[src*="google"]', 'ins.adsbygoogle'].forEach(s => removeAll(document, s));
        
        // Force unlock scrolling on body and html
        [document.body, document.documentElement].forEach(el => {
          if (el) {
            el.style.setProperty('overflow', 'auto', 'important');
            el.style.setProperty('position', 'static', 'important');
          }
        });
        document.body.classList.remove('modal-open');
      });

      const currentUrl = this.page.url();
      
      // If we are on the 'go' page or 'servers' selection page, try to go to the server page
      if (currentUrl.includes("/go/") || currentUrl.includes("/servers/")) {
        this.addLog("[AternosBrowser] On selection page, selecting first server...");
        
        // Try to click the first server body if present
        const clicked = await this.page.evaluate(() => {
          const card = document.querySelector('.server-body, .server-name');
          if (card) {
            card.click();
            return true;
          }
          return false;
        });

        if (!clicked) {
          await this.page.goto(this.serverPage, { waitUntil: "domcontentloaded", timeout: 60000 });
        }
        await new Promise(r => setTimeout(r, 5000));
      } else if (!currentUrl.includes("/server/")) {
        // If we are logged in but elsewhere, just try to go to the server page
        await this.page.goto(this.serverPage, { waitUntil: "domcontentloaded", timeout: 60000 });
        await new Promise(r => setTimeout(r, 5000)); // Wait longer
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
        if (err.message.includes("detached") || err.message.includes("closed") || err.message.includes("unresponsive") || err.message.includes("destroyed")) {
          this.addLog(`[AternosBrowser] Page state lost, resetting...`);
          this.isInitialized = false;
          this.initializing = null;
        }
        return { error: err.message };
      }
  }

  async getScreenshot() {
    try {
      await this.init();
      return this.latestFrame;
    } catch (e) {
      return null;
    }
  }

  async click(x, y) {
    try {
      await this.init();
      await this.page.mouse.click(x, y);
      return true;
    } catch (err) {
      if (err.message.includes("detached") || err.message.includes("closed")) {
        this.isInitialized = false;
        this.initializing = null;
      }
      return false;
    }
  }

  async type(text) {
    try {
      await this.init();
      await this.page.keyboard.type(text);
      return true;
    } catch (err) {
      if (err.message.includes("detached") || err.message.includes("closed")) {
        this.isInitialized = false;
        this.initializing = null;
      }
      return false;
    }
  }

  async navigate(url) {
    try {
      await this.init();
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return true;
    } catch (err) {
      if (err.message.includes("detached") || err.message.includes("closed")) {
        this.isInitialized = false;
        this.initializing = null;
      }
      return false;
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
