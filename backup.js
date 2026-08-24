const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const src = path.join(root, "data", "dispensa.db");
const destDir = process.env.BACKUP_DIR || path.join(root, "backups");

if (!fs.existsSync(src)) {
  console.log("Nessun database da salvare.");
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.join(destDir, `dispensa-${stamp}.db`);

const db = new Database(src, { readonly: true });
db.backup(dest)
  .then(() => {
    console.log(`Backup creato: ${dest}`);
    db.close();
  })
  .catch((err) => {
    console.error("Backup fallito:", err);
    process.exit(1);
  });

const files = fs
  .readdirSync(destDir)
  .filter((f) => f.endsWith(".db"))
  .sort();
while (files.length > 30) {
  fs.unlinkSync(path.join(destDir, files.shift()));
}
