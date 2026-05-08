const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dataRoot = path.join(
  root,
  "node_modules",
  "minecraft-data",
  "minecraft-data",
  "data",
);

const keepPcVersions = new Set([
  "common",
  "latest",
  "1.16.1",
  "1.20",
  "1.20.2",
  "1.20.3",
  "1.21",
  "1.21.1",
  "1.21.3",
  "1.21.4",
  "1.21.5",
  "1.21.6",
  "1.21.8",
  "1.21.9",
  "1.21.10",
  "1.21.11",
]);

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function pruneVersionDirs(baseDir, keep) {
  if (!fs.existsSync(baseDir)) return 0;

  let removed = 0;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (keep.has(entry.name)) continue;

    removeDir(path.join(baseDir, entry.name));
    removed++;
  }
  return removed;
}

if (!fs.existsSync(dataRoot)) {
  console.log("[postinstall] minecraft-data not installed, skipping prune.");
  process.exit(0);
}

const pcRemoved = pruneVersionDirs(path.join(dataRoot, "pc"), keepPcVersions);
const bedrockRemoved = pruneVersionDirs(
  path.join(dataRoot, "bedrock"),
  new Set(["common"]),
);

for (const extra of [".github", "doc", "tools"]) {
  removeDir(path.join(root, "node_modules", "minecraft-data", "minecraft-data", extra));
}

for (const extra of [".github", "doc", "test", "example.js", "tsconfig.json"]) {
  removeDir(path.join(root, "node_modules", "minecraft-data", extra));
}

console.log(
  `[postinstall] Pruned minecraft-data: removed ${pcRemoved} PC dirs and ${bedrockRemoved} Bedrock dirs.`,
);
