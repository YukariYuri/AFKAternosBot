# 🤖 Slobos & Mr. Juice Aternos 24/7 Hosting Bot

A Minecraft bot that helps keep an Aternos server online 24/7 by automatically joining it using a Mineflayer-based bot. Perfect for SMPs or small multiplayer servers that shut down when no players are online.

---

## ✨ Features
*   ✅ **Auto-Connect**: Automatically joins your server.
*   ✅ **Infinite Uptime**: Prevents AFK kicks and server shutdowns.
*   ✅ **Smart Reconnect**: Automatically reconnects if the internet drops or server restarts.
*   ✅ **Render-Ready**: Includes "Self-Ping" to run 24/7 for FREE on Render.com.
*   ✅ **Plugin Support**: Compatible with Paper/Spigot/Bukkit (auto-auth included).

---

## 🛠️ Requirements
*   **GitHub Account**
*   **Aternos Server**
*   **Render Account** (for 24/7 hosting)
*   **Common Sense!** 🧠        

---

## 🚀 Setup Guide

We have made setup super easy! Check out the guide below:

[**Detailed Google Doc Guide**](https://docs.google.com/document/d/1Fl0dRzP6O30ehp5-QcaB11IobF8I1JJhKUipzCWiCYA/edit?tab=t.0).

---

## ⚙️ Usage
*   **Start**: Just turn on your Aternos server. The bot will join automatically.
*   **Status**: Visit the Render URL to see a status dashboard.
*   **Chat**: The bot logs chat to the console.

---

## Aternos Auto-Start (Browser Automation)

This project uses browser automation (Puppeteer) to interact with Aternos. It can automatically start the server when offline, handle the queue, and sync the Minecraft bot connection.

### How to set up:
1.  **Dependencies**: Ensure you have installed the required dependencies (`npm install`).
2.  **Enable Feature**: Set `settings.json` -> `aternos.auto-start.enabled` to `true`.
3.  **Initial Login**:
    - By default, `headless` is set to `false`. When you start the bot, a browser window will open.
    - **Log in to Aternos manually** in that window (Google login, etc., are supported).
    - Once logged in and on the server page, the bot will save your session in the `.aternos_browser_data` folder.
    - After the first successful login, you can set `headless: true` in `settings.json` to run it in the background.
4.  **Bot Sync**:
    - The bot will automatically disconnect when the server is offline or in queue.
    - The bot will automatically connect when the server is "Starting" (counting down) or "Online".

Console commands:
- `status` - show the current bot and Aternos monitor state.

Note: This system is designed to bypass Cloudflare and handle the complex Aternos queue flow automatically. Keep the browser window open or the session data folder intact.

---

## ⚠️ Disclaimer
This project is not affiliated with Aternos, Mojang, or Microsoft. Use at your own risk. Misuse may violate platform terms of service. This bot does not bypass Aternos queue limits; it only keeps the server active once it is online.

---

## ❤️ Credits
*   **Slobos (Discord: sloboscc)** — Original creator & idea. (The GOAT 🐐)
*   **Mr.Juice (Discord: Mr.Juice3046)** — Updates, Guide, & Maintenance.

**License**: MIT License
