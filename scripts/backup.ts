import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/server/config.ts';
import { backupDir, createBackup } from '../src/server/maintenance.ts';

// A plain file copy of a WAL database can be torn; VACUUM INTO writes a consistent snapshot.
const config = loadConfig();
if (!fs.existsSync(config.dbPath)) {
  process.stderr.write(`找不到数据库：${config.dbPath}\n`);
  process.exit(1);
}

const db = new DatabaseSync(config.dbPath, { readOnly: true });
const backup = createBackup(db, config.dataDir, new Date());
db.close();
const target = path.join(backupDir(config.dataDir), backup.name);

process.stdout.write(`已备份到 ${target}\n`);
process.stdout.write('⚠️  备份里含加密后的密钥，但解密用的主密钥在 macOS 钥匙串（llmsocial.master-key）或 data/master.key。换机器恢复时两样都要带上。\n');
