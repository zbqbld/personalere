/**
 * 批量生成卡密 SQL（卡密次数制计费）
 *
 * 用法：
 *   npx tsx scripts/gen-cards.ts --count 20 --credits 50 --batch first
 * 输出：
 *   data/cards-<batch>-<时间戳>.sql   ← wrangler d1 execute --remote --file=该文件 入库
 *   data/cards-<batch>-<时间戳>.txt   ← 卡密明文清单（自己保存，发给买家）
 *
 * 卡密格式 ZW-XXXX-XXXX-XXXX，去掉了易混淆的 0/O/1/I。
 * 注意：.sql 与 .txt 都落在 data/（已被 .gitignore 忽略），不会进仓库。
 */
import { randomInt } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const count = Math.max(1, Math.min(500, parseInt(arg('count', '20'), 10) || 20));
const credits = Math.max(1, Math.min(100000, parseInt(arg('credits', '50'), 10) || 50));
const batch = arg('batch', 'batch').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'batch';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(): string {
  const seg = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `ZW-${seg()}-${seg()}-${seg()}`;
}

const now = Date.now();
const codes = new Set<string>();
while (codes.size < count) codes.add(newCode());

const createdAt = now;
const values = [...codes].map((code) =>
  `('${code}', ${credits}, 'unused', '${batch}', ${createdAt})`,
);
const sql = `-- batch=${batch} credits=${credits} count=${count} generatedAt=${new Date(now).toISOString()}\n` +
  `INSERT OR IGNORE INTO billing_cards (code, credits, status, batch, created_at) VALUES\n  ${values.join(',\n  ')};\n`;

const outDir = join(process.cwd(), 'data');
mkdirSync(outDir, { recursive: true });
const base = join(outDir, `cards-${batch}-${now}`);
writeFileSync(`${base}.sql`, sql, 'utf8');
writeFileSync(`${base}.txt`, [...codes].map((c) => `${c}\t${credits}次`).join('\n') + '\n', 'utf8');

console.log(`已生成 ${count} 张卡（每张 ${credits} 次）`);
console.log(`SQL：${base}.sql`);
console.log(`清单：${base}.txt`);
console.log('入库：npx wrangler d1 execute ziwei-doushu --remote --file="' + `${base}.sql` + '"');
