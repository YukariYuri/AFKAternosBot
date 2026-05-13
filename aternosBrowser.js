"use strict";

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const LOW_MEMORY_VIEWPORT = { width: 640, height: 480, deviceScaleFactor: 1 };
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BROWSER_RETRIES = 1;
const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "stylesheet", "media"]);
const DEFAULT_CHROME_HEAP_MB = 96;
const CRASH_WATCH_INTERVAL_MS = 5000;

class AternosBrowser {
  constructor(options) {
    this.addLog = options.addLog || console.log;
    this.browser = null;
    this.page = null;
    this.headless = options.headless !== false;
    this.baseUrl = "https://aternos.org";
    this.serverPage = "https://aternos.org/server/";
    this.serversPage = "https://aternos.org/servers/";
    this.serverName = this.normalizeServerName(options.serverName || options.serverIp);
    this.selectedServerHref = null;
    this.selectedServerCard = null;
    this.isInitialized = false;
    this.initializing = null;
    this.ajaxToken = null;
    this.configuredPages = new WeakSet();
    this.recoveringCrash = false;
  }

  normalizeServerName(value) {
    return String(value || "")
      .replace(/^https?:\/\//i, "")
      .replace(/\.aternos\.me(?::\d+)?$/i, "")
      .replace(/:\d+$/i, "")
      .trim()
      .toLowerCase();
  }

  touch() {
    this.lastActivityAt = Date.now();
    this.scheduleInactivityCleanup();
  }

  scheduleInactivityCleanup() {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    if (!this.browser) return;

    this.inactivityTimer = setTimeout(async () => {
      if (!this.browser || Date.now() - this.lastActivityAt < INACTIVITY_TIMEOUT_MS) return;
      this.addLog("[AternosBrowser] Closing inactive browser to free RAM.");
      await this.close();
    }, INACTIVITY_TIMEOUT_MS + 1000);

    if (typeof this.inactivityTimer.unref === "function") this.inactivityTimer.unref();
  }

  getLaunchArgs() {
    const requestedHeap = Number.parseInt(process.env.ATERNOS_CHROME_HEAP_MB || "", 10);
    const chromeHeapMb = Number.isFinite(requestedHeap) && requestedHeap >= 32 ? requestedHeap : DEFAULT_CHROME_HEAP_MB;
    const args = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",

      // 512MB RAM profile: prefer fewer renderer processes and no GPU/shared-memory pressure.
      "--renderer-process-limit=1",
      "--no-zygote",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",

      // Keep Chromium caches tiny; persistent profiles are intentionally not used.
      "--disk-cache-size=0",
      "--media-cache-size=0",
      "--aggressive-cache-discard",

      // Disable browser features that add background services or extra memory.
      "--disable-extensions",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-notifications",
      "--disable-prompt-on-repost",
      "--disable-hang-monitor",
      "--mute-audio",
      "--hide-scrollbars",
      "--metrics-recording-only",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,IsolateOrigins,site-per-process",

      // 96MB is the practical floor for Aternos; 48-64MB often crashes the renderer with Aw Snap/OOM.
      `--js-flags=--max-old-space-size=${chromeHeapMb}`,
    ];

    // --single-process is valuable on tiny Linux VPS containers, but modern Windows Chromium often exits immediately with it.
    if (process.platform !== "win32") args.push("--single-process");
    return args;
  }

  isRecoverableBrowserError(err) {
    const message = String(err && err.message || err || "").toLowerCase();
    return message.includes("target closed")
      || message.includes("session closed")
      || message.includes("detached frame")
      || message.includes("frame was detached")
      || message.includes("page crashed")
      || message.includes("out of memory")
      || message.includes("aw, snap");
  }

  async isAwSnapPage(page) {
    try {
      return await page.evaluate(() => {
        const text = `${document.title || ""}\n${document.body ? document.body.innerText : ""}`.toLowerCase();
        return text.includes("aw, snap") || text.includes("out of memory") || text.includes("error code");
      });
    } catch (err) {
      return this.isRecoverableBrowserError(err);
    }
  }

  async recoverBrowser(reason) {
    if (this.recoveringCrash) return this.getActivePage();
    this.recoveringCrash = true;
    this.addLog(`[AternosBrowser] Recycling browser after renderer failure: ${reason}`);
    try {
      await this.close();
      return await this.getActivePage();
    } finally {
      this.recoveringCrash = false;
    }
  }

  startCrashWatcher() {
    if (this.crashWatcher) clearInterval(this.crashWatcher);
    this.crashWatcher = setInterval(async () => {
      if (!this.browser || !this.page || this.page.isClosed() || this.recoveringCrash) return;
      try {
        if (!(await this.isAwSnapPage(this.page))) return;
        await this.recoverBrowser("Aw Snap / Out of Memory watchdog");
        this.page = this.selectedServerHref || this.serverName
          ? await this.ensureConfiguredServerPage()
          : await this.safeGoto(this.serverPage, { waitUntil: "domcontentloaded", timeout: 60000 });
      } catch (err) {
        this.addLog(`[AternosBrowser] Crash watchdog recovery failed: ${err.message}`);
      }
    }, CRASH_WATCH_INTERVAL_MS);

    if (typeof this.crashWatcher.unref === "function") this.crashWatcher.unref();
  }

  async safeGoto(url, options = {}, retry = true) {
    const page = await this.getActivePage();
    try {
      await page.goto(url, options);
      if (await this.isAwSnapPage(page)) throw new Error("Aw Snap / Out of Memory");
      return page;
    } catch (err) {
      if (!retry || !this.isRecoverableBrowserError(err)) throw err;
      const recoveredPage = await this.recoverBrowser(err.message);
      await recoveredPage.goto(url, options);
      if (await this.isAwSnapPage(recoveredPage)) throw new Error("Aternos page still crashes after browser recycle.");
      return recoveredPage;
    }
  }

  async waitForServerPageAfterCardClick(page) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await this.closeExtraPages().catch(() => {});
      const activePage = await this.getActivePage();
      const url = activePage.url();
      if (url.includes("aternos.org/server/") && !url.includes("aternos.org/servers/")) return activePage;
      await new Promise(r => setTimeout(r, 500));
    }
    return page;
  }

  async safeEvaluate(page, fn, ...args) {
    try {
      if (await this.isAwSnapPage(page)) throw new Error("Aw Snap / Out of Memory");
      return await page.evaluate(fn, ...args);
    } catch (err) {
      if (!this.isRecoverableBrowserError(err)) throw err;

      throw err;
    }
  }

  async safeEvaluateRecovering(page, fn, ...args) {
    try {
      return await this.safeEvaluate(page, fn, ...args);
    } catch (err) {
      if (!this.isRecoverableBrowserError(err)) throw err;
      const recoveredPage = await this.recoverBrowser(err.message);
      const activePage = this.selectedServerHref || this.serverName
        ? await this.ensureConfiguredServerPage()
        : recoveredPage;
      return this.safeEvaluate(activePage, fn, ...args);
    }
  }

  async ensureConfiguredServerPage() {
    let page = await this.getActivePage();
    const url = page.url();

    if (url.includes("/server/") && !url.includes("/servers/")) return page;

    // After the first successful selection with a real href, avoid reloading the heavy /servers/ listing.
    if (this.selectedServerHref) {
      page = await this.safeGoto(this.selectedServerHref, { waitUntil: "domcontentloaded", timeout: 60000 });
      await this.closeExtraPages();
      return page;
    }

    page = await this.safeGoto(this.serversPage, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 1500));

    const result = await this.safeEvaluate(page, (targetName) => {
      const normalize = (value) => String(value || "")
        .replace(/^https?:\/\//i, "")
        .replace(/\.aternos\.me(?::\d+)?/i, "")
        .replace(/:\d+/i, "")
        .trim()
        .toLowerCase();

      const serverLinks = Array.from(document.querySelectorAll("a.servercard, .servercard, [data-id][title], a[href]")).filter((link) => {
        const href = link.getAttribute("href") || "";
        return link.classList.contains("servercard") || link.hasAttribute("data-id") || href.includes("/server/");
      });

      const exact = serverLinks.find((link) => {
        const text = normalize(link.getAttribute("title") || link.innerText || link.textContent || "");
        const href = normalize(link.href || link.getAttribute("href") || "");
        const dataId = normalize(link.getAttribute("data-id") || "");
        return targetName && (text.includes(targetName) || href.includes(targetName) || dataId.includes(targetName));
      });

      const fallback = serverLinks.length === 1 ? serverLinks[0] : null;
      const selected = exact || fallback;
      if (!selected) {
        return {
          found: false,
          reason: targetName ? `Server not found: ${targetName}` : "No configured server name and multiple/no servers found.",
          candidates: serverLinks.map((link) => (
            link.getAttribute("title")
            || link.getAttribute("data-id")
            || link.innerText
            || link.textContent
            || link.href
            || ""
          ).trim()).filter(Boolean).slice(0, 5),
        };
      }

      return {
        found: true,
        label: (selected.getAttribute("title") || selected.innerText || selected.textContent || selected.href || "").trim(),
        href: selected.href || selected.getAttribute("href"),
        dataId: selected.getAttribute("data-id") || "",
        title: selected.getAttribute("title") || "",
      };
    }, this.serverName);

    if (!result.found) {
      this.addLog(`[AternosBrowser] ${result.reason}`);
      if (result.candidates && result.candidates.length) {
        this.addLog(`[AternosBrowser] Server candidates: ${result.candidates.join(" | ")}`);
      }
      return page;
    }

    this.selectedServerCard = { dataId: result.dataId, title: result.title, label: result.label };
    this.addLog(`[AternosBrowser] Selected configured server: ${result.label || this.serverName}`);
    if (result.href && result.href.includes("/server/")) {
      this.selectedServerHref = result.href;
      // Navigate the current tab directly instead of clicking when a real URL exists.
      page = await this.safeGoto(result.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    } else {
      // Aternos server cards often use href="" plus data-id/title. Click that card, then load /server/.
      await this.clickSelectedServerCard(page, this.selectedServerCard);
      page = await this.waitForServerPageAfterCardClick(page);
      if (!page.url().includes("/server/") || page.url().includes("/servers/")) {
        page = await this.safeGoto(this.serverPage, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((err) => {
          if (String(err.message || "").includes("net::ERR_ABORTED")) return this.getActivePage();
          throw err;
        });
      }
    }
    await this.closeExtraPages();
    await new Promise(r => setTimeout(r, 1000));
    if (page.url().includes("/servers/")) {
      this.addLog("[AternosBrowser] Server card selected, but Aternos stayed on /servers/. Will retry on next poll.");
    }
    return page;
  }

  async clickSelectedServerCard(page, card) {
    const clicked = await this.safeEvaluateRecovering(page, ({ dataId, title, serverName }) => {
      const normalize = (value) => String(value || "")
        .replace(/^https?:\/\//i, "")
        .replace(/\.aternos\.me(?::\d+)?/i, "")
        .replace(/:\d+/i, "")
        .trim()
        .toLowerCase();

      const cards = Array.from(document.querySelectorAll("a.servercard, .servercard, [data-id][title]"));
      const selected = cards.find((candidate) => {
        const candidateTitle = candidate.getAttribute("title") || "";
        return (dataId && candidate.getAttribute("data-id") === dataId)
          || (title && candidateTitle === title)
          || (serverName && normalize(candidateTitle).includes(serverName));
      });
      if (!selected) return false;
      const originalOpen = window.open;
      window.open = () => null;
      for (const link of Array.from(document.querySelectorAll("a[target]"))) {
        link.setAttribute("target", "_self");
      }
      selected.removeAttribute("target");
      selected.scrollIntoView({ block: "center" });
      selected.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      selected.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      selected.click();
      window.setTimeout(() => { window.open = originalOpen; }, 3000);
      return true;
    }, { ...(card || {}), serverName: this.serverName });

    if (!clicked) throw new Error(`Configured server card not found after relaunch: ${this.serverName || "unknown"}`);
  }

  async ensureSessionPage() {
    let page = await this.getActivePage();
    const url = page.url();
    if (url.includes("/server/") || url.includes("/servers/")) return page;
    page = await this.safeGoto(this.serversPage, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 1000));
    return page;
  }

  async configurePage(page) {
    this.page = page;
    if (this.configuredPages.has(page)) return;
    this.configuredPages.add(page);

    // 640x480 paints 3x fewer pixels than 1280x720, reducing raster/compositor memory.
    await page.setViewport(LOW_MEMORY_VIEWPORT);
    await page.setCacheEnabled(false);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    // Block high-memory resources. Aternos automation only needs documents, scripts, XHR/fetch, and cookies.
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });

    page.on("close", () => {
      if (this.page === page) {
        this.page = null;
        this.isInitialized = false;
      }
    });
    page.on("popup", async (popup) => {
      await popup.close().catch(() => {});
      await this.closeExtraPages().catch(() => {});
    });
    page.on("error", (err) => {
      this.addLog(`[AternosBrowser] Page crashed: ${err.message}`);
      if (this.page === page) {
        this.page = null;
        this.isInitialized = false;
      }
    });

    await this.installAntiAdblockBypass(page);
  }

  async installAntiAdblockBypass(page) {
    // Critical anti-adblock bypass only. No permanent setInterval: repeated DOM scans leak CPU and retain nodes.
    await page.evaluateOnNewDocument(() => {
      const findInShadows = (root, text, depth = 0) => {
        if (!root || depth > 3) return null;
        const selectors = 'a, button, [role="button"], .btn';
        for (const el of Array.from(root.querySelectorAll(selectors))) {
          const content = (el.textContent || el.innerText || "").toLowerCase();
          if (content.includes(text)) return el;
        }
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if (el.shadowRoot) {
            const found = findInShadows(el.shadowRoot, text, depth + 1);
            if (found) return found;
          }
        }
        return null;
      };

      const removeOverlays = (root) => {
        const selectors = [".adblock-error", ".fc-ab-root", ".modal-backdrop", "#adblock-warning", ".ad-block-overlay", '[class*="adblock"]'];
        for (const selector of selectors) {
          for (const el of Array.from(root.querySelectorAll(selector))) el.remove();
        }
      };

      const runBypass = () => {
        const candidates = ["continue with adblock", "continue anyway", "adblocker anyway"];
        for (const text of candidates) {
          const btn = findInShadows(document, text);
          if (btn && btn.getBoundingClientRect().width > 0) {
            btn.click();
            if (btn.tagName === "A" && btn.href && btn.href.includes("php")) window.location.href = btn.href;
          }
        }
        removeOverlays(document);
        if (document.body) document.body.style.setProperty("overflow", "auto", "important");
      };

      let attempts = 0;
      const maxAttempts = 5;
      const interval = window.setInterval(() => {
        attempts += 1;
        runBypass();
        if (attempts >= maxAttempts) window.clearInterval(interval);
      }, 2000);

      const observer = new MutationObserver(() => runBypass());
      window.addEventListener("DOMContentLoaded", () => {
        if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        window.setTimeout(() => observer.disconnect(), maxAttempts * 2000);
      }, { once: true });

      window.open = () => null;
    });
  }

  async closeExtraPages() {
    if (!this.browser) return;
    const pages = await this.browser.pages().catch(() => []);
    const serverPage = pages.find((page) => {
      try {
        const url = page.url();
        return url.includes("aternos.org/server/") && !url.includes("aternos.org/servers/");
      } catch (e) {
        return false;
      }
    });
    const active = serverPage || (this.page && !this.page.isClosed() ? this.page : pages[0]);
    this.page = active || await this.browser.newPage();

    for (const page of pages) {
      if (page !== this.page) await page.close().catch(() => {});
    }
  }

  async applyEnvironmentCookies() {
    const cleanVal = (val) => String(val || "").replace(/^["']|["']$/g, "").trim();
    const session = cleanVal(process.env.ATERNOS_SESSION);
    const ajaxToken = cleanVal(process.env.ATERNOS_AJAX_TOKEN);

    if (session) {
      await this.page.setCookie({
        name: "ATERNOS_SESSION", value: session, domain: ".aternos.org", path: "/", secure: true, httpOnly: true
      });
    }
    if (ajaxToken) {
      await this.page.setCookie({
        name: "ATERNOS_AJAX_TOKEN", value: ajaxToken, domain: ".aternos.org", path: "/", secure: true, httpOnly: false
      });
    }
  }

  async cleanupBrowserProcess() {
    if (!this.browser) return;
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.isInitialized = false;

    try {
      const pages = await browser.pages();
      for (const page of pages) await page.close().catch(() => {});
      await browser.close();
    } catch (e) {
      try {
        const process = browser.process();
        if (process) process.kill("SIGKILL");
      } catch (e2) {}
    }
  }

  async init() {
    if (this.isInitialized && this.page && !this.page.isClosed()) {
      try {
        await this.page.evaluate(() => 1);
        this.touch();
        return;
      } catch (e) {
        this.addLog("[AternosBrowser] Page state lost, recovering...");
        this.isInitialized = false;
      }
    }

    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        const launch = async (retryCount = 0) => {
          try {
            if (retryCount === 0) {
              this.addLog("[AternosBrowser] Launching low-memory browser...");
            }

            // No userDataDir: Puppeteer creates an ephemeral temp profile and removes profile state on close.
            this.browser = await puppeteer.launch({
              headless: this.headless,
              args: this.getLaunchArgs(),
            });

            this.browser.on("disconnected", () => {
              this.addLog("[AternosBrowser] Browser disconnected.");
              this.browser = null;
              this.page = null;
              this.isInitialized = false;
            });
            this.browser.on("targetcreated", async (target) => {
              if (target.type() !== "page") return;
              try {
                const newPage = await target.page();
                if (!newPage) return;
                await new Promise(r => setTimeout(r, 250));
                const url = newPage.url();
                const isServerPage = url.includes("aternos.org/server/") && !url.includes("aternos.org/servers/");
                if (isServerPage && (!this.page || this.page.isClosed() || this.page.url().includes("/servers/"))) {
                  this.page = newPage;
                  await this.configurePage(newPage).catch(() => {});
                } else if (newPage !== this.page) {
                  await newPage.close();
                }
                await this.closeExtraPages();
              } catch (e) {}
            });

            const pages = await this.browser.pages();
            this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
            await this.closeExtraPages();
            await this.configurePage(this.page);
            await this.applyEnvironmentCookies();

            if (!this.browser || !this.page || this.page.isClosed()) {
              throw new Error("Browser exited during initialization.");
            }

            this.isInitialized = true;
            this.initializing = null;
            this.launchTime = Date.now();
            this.touch();
            this.startCrashWatcher();
            this.addLog("[AternosBrowser] Launch successful.");
          } catch (err) {
            await this.cleanupBrowserProcess();
            if (retryCount < MAX_BROWSER_RETRIES) {
              this.addLog(`[AternosBrowser] Browser launch failed, retrying once: ${err.message}`);
              await new Promise(r => setTimeout(r, 1500));
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
        throw err;
      }
    })();

    return this.initializing;
  }

  async ensureLoggedIn() {
    let page = await this.getActivePage();
    this.touch();
    this.addLog("[AternosBrowser] Verifying session...");

    try {
      // Re-apply environment cookies before check
      const envSession = String(process.env.ATERNOS_SESSION || "").replace(/^["']|["']$/g, "").trim();
      if (envSession) {
        await page.setCookie({
          name: 'ATERNOS_SESSION', value: envSession, domain: '.aternos.org', path: '/', secure: true, httpOnly: true
        });
      }

      page = await this.safeGoto(this.serversPage, { waitUntil: "domcontentloaded", timeout: 60000 });
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      this.addLog(`[AternosBrowser] Navigation warning: ${err.message}`);
    }

    const activePage = await this.ensureSessionPage();
    const loginState = await this.safeEvaluateRecovering(activePage, () => {
      const bodyText = document.body ? document.body.innerText : "";
      const title = document.title;
      const isCloudflare = bodyText.includes("Cloudflare") || bodyText.includes("Verify you are human") || title.includes("Just a moment");
      const isError = title.includes("502") || title.includes("503") || title.includes("Bad Gateway") || bodyText.includes("Error 502") || bodyText.includes("Error 503");
      const userField = document.querySelector('input[name="user"], #user');
      const logoutBtn = document.querySelector('a[href*="/logout/"], .logout-button');
      
      return {
        isCloudflare,
        isError,
        isLoginPage: userField !== null || location.href.includes('/login/') || location.href.includes('/go/'),
        isLoggedIn: logoutBtn !== null || location.href.includes('/server/'),
        bodyLength: bodyText.length
      };
    });

    if (loginState.isError) {
      this.addLog("[AternosBrowser] Site unavailable (502/503). Waiting for recovery.");
      return;
    }

    if (loginState.isCloudflare) {
      this.addLog("[AternosBrowser] Cloudflare active. Please solve the challenge manually.");
      return;
    }

    if (loginState.isLoginPage || (loginState.bodyLength < 1000 && !loginState.isLoggedIn)) {
      this.addLog("[AternosBrowser] Redirected to login page. Checking credentials...");
      const username = (process.env.ATERNOS_USER || "").trim();
      const password = (process.env.ATERNOS_PASS || "");
      if (username && password) {
        try {
          const result = await this.loginWithCredentials(username, password);
          if (result.success) this.addLog("[AternosBrowser] Login successful.");
          else this.addLog(`[AternosBrowser] Login failed: ${result.error}`);
        } catch (e) {
          this.addLog(`[AternosBrowser] Login exception: ${e.message}`);
        }
      } else {
        this.addLog("[AternosBrowser] No credentials/valid session found. Update via dashboard.");
      }
    } else {
      this.addLog("[AternosBrowser] Session is valid.");
    }
  }

  async loginWithCredentials(username, password) {
    const page = await this.getActivePage();
    this.touch();
    const user = String(username || "").trim();
    const pass = String(password || "");
    if (!user || !pass) return { success: false, error: "Username and password are required." };

    this.addLog(`[AternosBrowser] Credential login: ${user}`);
    try {
      const loginPage = await this.safeGoto("https://aternos.org/go/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await loginPage.waitForSelector('input[name="user"], #user', { visible: true, timeout: 30000 });

      const userSelector = await loginPage.$('input[name="user"]') ? 'input[name="user"]' : '#user';
      const passwordSelector = await loginPage.$('input[name="password"]') ? 'input[name="password"]' : '#password';    

      await loginPage.click(userSelector, { clickCount: 3 });
      await loginPage.type(userSelector, user, { delay: 50 });
      await loginPage.click(passwordSelector, { clickCount: 3 });
      await loginPage.type(passwordSelector, pass, { delay: 50 });

      const clicked = await this.safeEvaluateRecovering(loginPage, () => {
        const candidates = [
          document.querySelector("#login"), document.querySelector('button[type="submit"]'),
          document.querySelector('input[type="submit"]'), document.querySelector('.login-button')
        ].filter(Boolean);
        const button = candidates.find((el) => el.offsetParent !== null) || candidates[0];
        if (!button) return false;
        button.click();
        return true;
      });

      if (!clicked) await loginPage.keyboard.press("Enter");
      await new Promise(r => setTimeout(r, 8000));

      const result = await this.safeEvaluateRecovering(loginPage, () => {
        const bodyText = (document.body ? document.body.innerText : "").toLowerCase();
        if (location.href.includes("/server/") || location.href.includes("/servers/")) return { success: true };        
        if (bodyText.includes("captcha") || bodyText.includes("verification")) return { success: false, manualRequired: true, error: "Captcha required." };
        if (document.querySelector('input[name="user"]')) return { success: false, error: "Incorrect credentials." };
        return { success: true };
      });

      if (result.success && !loginPage.url().includes("/server/")) {
        await this.safeGoto(this.serverPage, { waitUntil: "domcontentloaded", timeout: 60000 });
        await this.ensureConfiguredServerPage();
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async loginWithCookieString(cookieString) {
    await this.getActivePage();
    this.touch();
    const cookies = this.parseCookieString(cookieString);
    if (!cookies.length) return { success: false, error: "No valid cookies found." };
    this.addLog("[AternosBrowser] Force applying session cookies...");
    try {
      let page = await this.safeGoto(this.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.setCookie(...cookies);
      page = await this.safeGoto(this.serverPage, { waitUntil: "domcontentloaded", timeout: 60000 });
      await new Promise((r) => setTimeout(r, 3000));
      await this.ensureConfiguredServerPage();
      if ((await this.getActivePage()).url().includes("/server/")) return { success: true };
      return { success: false, error: "Cookie didn't trigger login. Check if it's expired." };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  parseCookieString(cookieString) {
    const raw = String(cookieString || "").trim();
    if (raw.includes("ATERNOS_SESSION=")) {
        return raw.split(";").map(part => {
          const eq = part.indexOf("=");
          if (eq === -1) return null;
          const name = part.slice(0, eq).trim();
          const value = part.slice(eq + 1).trim();
          return { name, value, domain: ".aternos.org", path: "/", secure: true, httpOnly: true };
        }).filter(Boolean);
    }
    // If just the ID is pasted
    if (raw.length > 20 && !raw.includes("=")) {
        return [{ name: "ATERNOS_SESSION", value: raw, domain: ".aternos.org", path: "/", secure: true, httpOnly: true }];
    }
    return [];
  }

  async setHeadless(headless) {
    if (this.headless === (headless !== false)) return;
    this.headless = headless !== false;
    await this.close();
  }

  async getActivePage() {
    await this.init();
    this.touch();
    if (!this.browser) throw new Error("Browser is not running.");
    if (this.page && !this.page.isClosed()) {
      await this.closeExtraPages();
      return this.page;
    }
    const pages = await this.browser.pages().catch(() => []);
    this.page = pages.find(p => !p.isClosed()) || await this.browser.newPage();
    await this.configurePage(this.page);
    await this.closeExtraPages();
    return this.page;
  }

  async getStatus() {
    if (this.isInitialized && this.launchTime && (Date.now() - this.launchTime > 15 * 60 * 1000)) {
      this.addLog("[AternosBrowser] Periodic browser recycle...");
      await this.close();
    }
    let page = await this.getActivePage();
    this.touch();
    try {
      const isLogin = await this.safeEvaluateRecovering(page, () => document.querySelector('input[name="user"]') !== null || location.href.includes('/login/'));
      if (isLogin) return { class: "unknown", label: "Needs Login" };

      if (!page.url().includes("/server/")) {
        page = await this.ensureConfiguredServerPage();
      }

      if (page.url().includes("/servers/") || !page.url().includes("/server/")) {
        return { class: "unknown", label: "Selecting Server", error: "Server page not selected yet." };
      }

      // BYPASS CHECK
      await this.safeEvaluateRecovering(page, () => {
          const findInShadows = (root, text) => {
            if (!root) return null;
            const selectors = 'a, button, div, span, [role="button"], .btn';
            const elements = Array.from(root.querySelectorAll(selectors));
            for (const el of elements) {
              if ((el.textContent || el.innerText || "").toLowerCase().includes(text.toLowerCase())) return el;
            }
            const all = root.querySelectorAll('*');
            for (const el of all) { if (el.shadowRoot) { const f = findInShadows(el.shadowRoot, text); if (f) return f; } }
            return null;
          };
          const btn = findInShadows(document, 'continue with adblock');
          if (btn && btn.getBoundingClientRect().width > 0) btn.click();
      });

      try { await page.waitForSelector(".statuslabel-label, .statuslabel, .server-status", { timeout: 5000 }); } catch (e) { }

      const status = await this.safeEvaluateRecovering(page, () => {
        try {
          if (!document.body) return { error: "Page not ready" };
          const txt = document.body.innerText || "";
          const title = document.title;
          const url = location.href;
          if (url.includes("/servers/") || !url.includes("/server/")) {
            return { error: "Not on selected server page", class: "unknown", label: "Selecting Server" };
          }
          if (title.includes("502") || title.includes("503") || title.includes("Bad Gateway") || txt.includes("Error 502")) {
             return { error: "Site Unavailable", label: "Aternos Offline", class: "offline" };
          }

          const selectors = [".statuslabel-label", ".statuslabel", "#status", ".status-label", ".server-status"];       
          let el = null;
          for (const s of selectors) { el = document.querySelector(s); if (el && el.innerText.trim().length > 0) break; }

          if (!el) return { error: "Status missing", class: "unknown", label: "Status Missing", bodyLength: txt.length, bodySnippet: txt.substring(0, 200) };

          const label = el.innerText.trim();
          let cls = "unknown";
          if (label.toLowerCase().includes("offline")) cls = "offline";
          else if (label.toLowerCase().includes("online")) cls = "online";
          else if (label.toLowerCase().includes("starting")) cls = "starting";
          else if (label.toLowerCase().includes("queue")) cls = "queue";
          else if (label.toLowerCase().includes("stopping")) cls = "stopping";
          else if (label.toLowerCase().includes("saving")) cls = "saving";
          else if (label.toLowerCase().includes("crashed")) cls = "offline";
          return { class: cls, label: label };
        } catch (e) { return { error: e.message }; }
      });

      if (status && status.error === "Site Unavailable") {
         this.addLog("[AternosBrowser] Aternos site is down. Retrying in 30s...");
         await new Promise(r => setTimeout(r, 30000));
         return status;
      }

      if (status && status.error) {
        this.statusFailCount = (this.statusFailCount || 0) + 1;
        if (this.statusFailCount >= 2) {
           this.statusFailCount = 0;
           await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        }
      } else {
        this.statusFailCount = 0;
      }

      if (status && status.class === "queue") await this.confirmQueue();
      return status;
    } catch (err) {
      this.isInitialized = false;
      if (this.isRecoverableBrowserError(err)) {
        await this.close().catch(() => {});
        return { error: "Browser renderer crashed/OOM. Browser recycled; retrying next poll." };
      }
      return { error: err.message };
    }
  }

  async startServer() {
    const page = await this.ensureConfiguredServerPage();
    this.touch();
    try {
      await this.handleNotificationPopup();
      const clicked = await this.safeEvaluateRecovering(page, () => {
        const btn = document.getElementById("start");
        if (btn && btn.offsetParent !== null) { btn.click(); return true; }
        return false;
      });
      if (clicked) {
        this.addLog("[AternosBrowser] Start button clicked.");
        await new Promise(r => setTimeout(r, 5000));
        await this.confirmQueue();
      }
    } catch (err) { }
  }

  async handleNotificationPopup() {
    try {
      const page = await this.getActivePage();
      await this.safeEvaluateRecovering(page, () => {
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
      const page = await this.getActivePage();
      const ok = await this.safeEvaluateRecovering(page, () => {
        const btns = Array.from(document.querySelectorAll('.btn-success, #confirm, .btn-primary'));
        for (const b of btns) {
          const t = b.innerText.toLowerCase();
          if (t.includes('confirm') || t.includes('start now') || b.id === 'confirm') {
            if (b.offsetParent !== null) { b.click(); return true; }
          }
        }
        return false;
      });
      if (ok) {
        this.addLog("[AternosBrowser] Queue confirmed.");
        // Aternos often becomes memory-heavy right after queue confirmation.
        // Close Chromium immediately; the next poll relaunches cleanly to read status.
        await new Promise(r => setTimeout(r, 1000));
        await this.close();
      }
    } catch (err) { }
  }

  async getTokens() {
    let page = await this.getActivePage();
    this.touch();
    try {
      // Cookies are browser-level state; do not load /server/ just to sync tokens.
      // Avoiding that extra navigation reduces the chance of renderer OOM on 512MB hosts.
      const cookies = await page.cookies();
      const session = cookies.find(c => c.name === 'ATERNOS_SESSION');
      const ajaxToken = page.isClosed() ? null : await this.safeEvaluateRecovering(page, () => window.ajaxToken || null).catch(() => null);
      return { session: session ? session.value : null, token: ajaxToken };
    } catch (err) { return null; }
  }

  async close() {
    if (this.initializing) try { await this.initializing; } catch (e) { }
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.crashWatcher) {
      clearInterval(this.crashWatcher);
      this.crashWatcher = null;
    }
    if (this.browser) {
      await this.cleanupBrowserProcess();
    }
    this.page = null;
    this.isInitialized = false;
    this.initializing = null;
  }
}

module.exports = AternosBrowser;
