const logs = [];

function addLog(message) {
  const cleanMessage = message.replace(/^\[(AternosBrowser|Aternos|Bot|Stats|Server|System|Control)\]\s*/, "");
  const categoryMatch = message.match(/^\[(AternosBrowser|Aternos|Bot|Stats|Server|System|Control)\]/);
  const category = categoryMatch ? categoryMatch[1] : "System";

  const MAX_LEN = 500;
  const truncatedMessage = cleanMessage.length > MAX_LEN ? cleanMessage.substring(0, MAX_LEN) + "..." : cleanMessage;
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  // Store as a single compact string to save memory: "time|category|message"
  const logStr = `${time}|${category}|${truncatedMessage}`;
  
  console.log(logStr);
  logs.push(logStr);
  
  // Increase history to 100 entries so they don't disappear too fast
  if (logs.length > 100) logs.shift();
}

function getLogs() {
  return logs;
}

module.exports = { addLog, getLogs };