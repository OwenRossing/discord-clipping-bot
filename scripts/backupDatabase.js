const fs = require('fs');
const path = require('path');
const db = require('../api/db');

const destinationRoot = path.resolve(process.cwd(), process.env.BACKUP_DIR || './backups');
fs.mkdirSync(destinationRoot, { recursive:true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.join(destinationRoot, `clip-vault-${stamp}.db`);

db.backup(destination).then(() => {
  const retention = Math.max(1, Number(process.env.BACKUP_RETENTION) || 14);
  const backups = fs.readdirSync(destinationRoot).filter(name => /^clip-vault-.*\.db$/.test(name)).sort().reverse();
  for (const expired of backups.slice(retention)) fs.unlinkSync(path.join(destinationRoot, expired));
  console.log(JSON.stringify({ event:'database_backup_complete', destination, bytes:fs.statSync(destination).size }));
  db.close();
}).catch(error => {
  console.error(JSON.stringify({ event:'database_backup_failed', error:error.message }));
  process.exitCode = 1; db.close();
});
