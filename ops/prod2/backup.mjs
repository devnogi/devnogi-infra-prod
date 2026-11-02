import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, copyFileSync, utimesSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const schemas = ['auth', 'dcs', 'open-api-batch'];
const services = ['auth', 'community', 'batch', 'gateway', 'react'];
const day = 24 * 60 * 60 * 1000;
const paths = {
  backup: '/var/backups/memonogi/mysql', logs: '/var/log/memonogi',
  state: '/var/lib/memonogi-backup', config: '/etc/memonogi-backup/rclone.conf',
  compose: '/opt/memonogi-backup/compose.backup.yml',
};

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.code})`);
  return result.stdout;
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function validateDump(file) {
  const found = new Set();
  let pending = '';
  let total = 0;
  const gunzip = createReadStream(file).pipe(createGunzip());
  for await (const chunk of gunzip) {
    total += chunk.length;
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const match = /^-- Current Database: `([^`]+)`/.exec(line);
      if (match) found.add(match[1]);
    }
    if (pending.length > 1024 * 1024) pending = pending.slice(-1024);
  }
  if (!total || found.size !== schemas.length || schemas.some((name) => !found.has(name))) throw new Error('Dump does not contain exactly the expected schema markers');
}

export async function dump(p = paths, now = new Date(), spawnProcess = spawn) {
  mkdirSync(p.backup, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const final = join(p.backup, `mysql-${stamp}.sql.gz`);
  const partial = `${final}.partial`;
  const sum = `${final}.sha256`;
  if (existsSync(final) || existsSync(partial) || existsSync(sum)) throw new Error('Backup name already exists');
  try {
    const args = ['compose', '-f', p.compose, 'run', '--rm', '-T', '--no-deps', 'mysqldump', '--host=devnogi-mysql', '--port=3316', '--single-transaction', '--quick', '--routines', '--events', '--triggers', '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF', '--databases', ...schemas];
    const child = spawnProcess('docker', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const exit = new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code) => code === 0 ? accept() : reject(new Error(`mysqldump failed (${code})`))); });
    const results = await Promise.allSettled([pipeline(child.stdout, createGzip(), createWriteStream(partial, { flags: 'wx', mode: 0o600 })), exit]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    await validateDump(partial);
    const digest = await hash(partial);
    writeFileSync(`${sum}.partial`, `${digest}  ${basename(final)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(`${sum}.partial`, sum);
    renameSync(partial, final);
    return final;
  } catch (error) {
    for (const file of [partial, `${sum}.partial`, sum]) if (existsSync(file)) unlinkSync(file);
    throw error;
  }
}

function filesIn(dir, accept) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && accept(entry.name)).map((entry) => join(dir, entry.name));
}

export function eligible(p = paths) {
  const files = [];
  for (const service of services) {
    for (const file of filesIn(join(p.logs, service), (name) => /^application\.log-\d{8}\.gz$/.test(name) || /^pre-transition-\d{8}T\d{6}Z\.log\.gz$/.test(name))) files.push({ file, relative: `logs/${service}/${basename(file)}` });
  }
  for (const file of filesIn(p.backup, (name) => /^mysql-\d{8}T\d{6}Z\.sql\.gz$/.test(name))) {
    if (!existsSync(`${file}.sha256`)) throw new Error(`Missing checksum for ${basename(file)}`);
    files.push({ file, relative: `mysql/${basename(file)}` }, { file: `${file}.sha256`, relative: `mysql/${basename(file)}.sha256` });
  }
  return files;
}

function verifyRemote(p) {
  const config = JSON.parse(run('rclone', ['--config', p.config, 'config', 'dump'], true));
  if (config.memonogi_crypt?.type !== 'crypt' || config.memonogi_crypt.remote !== 'gdrive:Memonogi-Backups/prod2' || config.memonogi_crypt.filename_encryption !== 'standard' || config.memonogi_crypt.directory_name_encryption !== 'true' || config.gdrive?.type !== 'drive' || config.gdrive.scope !== 'drive.file') throw new Error('Unexpected rclone remote configuration; refusing upload and deletion');
}

export async function upload(p = paths, now = Date.now(), runner = run) {
  mkdirSync(p.state, { recursive: true, mode: 0o700 });
  if (runner === run) verifyRemote(p);
  const entries = eligible(p);
  if (!entries.some((entry) => entry.relative.startsWith('mysql/'))) throw new Error('No completed MySQL backup available');
  for (const entry of entries.filter((item) => item.relative.endsWith('.sql.gz'))) {
    const expected = /^([a-f0-9]{64})  (.+)\n$/.exec(readFileSync(`${entry.file}.sha256`, 'utf8'));
    if (!expected || expected[2] !== basename(entry.file) || expected[1] !== await hash(entry.file)) throw new Error(`Invalid checksum for ${entry.relative}`);
    await validateDump(entry.file);
  }
  const stage = mkdtempSync(join(p.state, 'upload-'));
  try {
    for (const entry of entries) {
      const dest = join(stage, entry.relative);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      copyFileSync(entry.file, dest);
      const stats = statSync(entry.file);
      utimesSync(dest, stats.atime, stats.mtime);
      entry.digest = await hash(dest);
      if (entry.digest !== await hash(entry.file)) throw new Error(`Source changed during staging: ${entry.relative}`);
    }
    const base = ['--config', p.config];
    runner('rclone', [...base, 'copy', stage, 'memonogi_crypt:']);
    runner('rclone', [...base, 'cryptcheck', stage, 'memonogi_crypt:', '--one-way']);
    for (const entry of entries) if (entry.digest !== await hash(entry.file)) throw new Error(`Source changed during upload: ${entry.relative}`);
    const manifestPath = join(p.state, 'verified.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
    for (const entry of entries) manifest[entry.relative] = { sha256: entry.digest, verifiedAt: new Date(now).toISOString() };
    const tmp = `${manifestPath}.partial`;
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, manifestPath);
    // Fail closed: remote cleanup must succeed before any local source is removed.
    // Never immediately delete an old, newly uploaded file in the same run.
    if (entries.every((entry) => now - statSync(entry.file).mtimeMs <= 56 * day)) {
      runner('rclone', [...base, 'delete', 'memonogi_crypt:', '--min-age', '56d', '--drive-use-trash=false']);
    }
    for (const entry of entries) {
      if (now - statSync(entry.file).mtimeMs > 14 * day && manifest[entry.relative]?.sha256 === await hash(entry.file)) unlinkSync(entry.file);
    }
    return entries.length;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  try {
    if (process.argv.length !== 3 || !['dump', 'upload'].includes(action)) throw new Error('Usage: backup.mjs dump|upload');
    await (action === 'dump' ? dump() : upload());
    console.log(`${action} completed`);
  } catch (error) {
    console.error(`${action} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
