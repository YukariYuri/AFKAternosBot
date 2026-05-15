"use strict";

const http = require("http");
const https = require("https");

/**
 * ระบบ Self-ping เพื่อป้องกันไม่ให้ Render เข้าสู่โหมด Sleep
 * @param {Function} addLog - ฟังก์ชันสำหรับบันทึก Log
 */
function startKeepAlive(addLog) {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  const interval = 10 * 60 * 1000; // ทำงานทุกๆ 10 นาที

  if (!renderUrl) {
    if (addLog) addLog("[KeepAlive] No RENDER_EXTERNAL_URL set - running locally.");
    return;
  }

  setInterval(() => {
    const protocol = renderUrl.startsWith("https") ? https : http;
    protocol.get(`${renderUrl}/ping`, (res) => {
      // Ping สำเร็จ
    }).on("error", (err) => {
      if (addLog) addLog(`[KeepAlive] Self-ping failed: ${err.message}`);
    });
  }, interval);

  if (addLog) addLog(`[KeepAlive] Self-ping system started for: ${renderUrl}`);
}

module.exports = startKeepAlive;