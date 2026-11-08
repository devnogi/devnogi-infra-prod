import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const templatePath = resolve(root, 'ops', 'prod2', 'nginx', 'memonogi.conf.template');
const marker = '# MEMONOGI_MANAGED_OUTFIT_UPLOAD_BOUNDARY';
const managedInclude = 'include /etc/nginx/snippets/memonogi-outfit-upload.conf;';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function blockStackAt(source) {
  const stack = [];
  let statement = [];
  let token = '';
  let quote = null;
  let comment = false;
  const flush = () => {
    if (token) statement.push(token);
    token = '';
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (comment) {
      if (character === '\n') comment = false;
      continue;
    }
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '#') {
      flush();
      comment = true;
    } else if (character === '"' || character === "'") {
      flush();
      quote = character;
    } else if (/\s/.test(character)) {
      flush();
    } else if (character === ';') {
      flush();
      statement = [];
    } else if (character === '{') {
      flush();
      stack.push(statement[0] ?? '');
      statement = [];
    } else if (character === '}') {
      flush();
      if (stack.length === 0) throw new Error('Current vhost has an unmatched closing brace before the marker');
      stack.pop();
      statement = [];
    } else {
      token += character;
    }
  }
  if (quote) throw new Error('Current vhost has an unterminated quoted string before the marker');
  return stack;
}

export function render(markedCurrent, sourceCurrent, template = readFileSync(templatePath, 'utf8')) {
  if (markedCurrent.includes(managedInclude)) throw new Error('Current vhost already contains the managed upload include');
  const matches = [...markedCurrent.matchAll(new RegExp(`^([ \\t]*)${marker}[^\\S\\r\\n]*(\\r?\\n|$)`, 'gm'))];
  if (matches.length !== 1) throw new Error(`Current vhost must contain exactly one ${marker} marker`);

  const match = matches[0];
  const before = markedCurrent.slice(0, match.index);
  const after = markedCurrent.slice(match.index + match[0].length);
  if (`${before}${after}` !== sourceCurrent) {
    throw new Error('Marked vhost must equal the untouched source plus exactly one marker line');
  }
  const stack = blockStackAt(before);
  if (stack.at(-1) !== 'server') throw new Error('Upload boundary marker must be a direct child of an actual server block');

  const include = `${match[1]}${managedInclude}${match[2] || '\n'}`;
  const tokens = {
    '@@CURRENT_VHOST_BEFORE_OUTFIT_BOUNDARY@@': before,
    '@@OUTFIT_UPLOAD_BOUNDARY_INCLUDE@@': include,
    '@@CURRENT_VHOST_AFTER_OUTFIT_BOUNDARY@@': after,
  };
  let output = template;
  for (const [token, value] of Object.entries(tokens)) {
    if (output.split(token).length !== 2) throw new Error(`Managed template must contain exactly one ${token}`);
    output = output.replace(token, value);
  }
  if (/@@[A-Z0-9_]+@@/.test(output)) throw new Error('Managed template contains an unresolved token');
  return {
    output,
    manifest: `version 1\nsource_sha256 ${sha256(sourceCurrent)}\ncandidate_sha256 ${sha256(output)}\n`,
  };
}

export function run(args = process.argv.slice(2), { stderr = process.stderr } = {}) {
  if (args.length !== 6 || args[0] !== '--source' || args[2] !== '--input' || args[4] !== '--output') {
    stderr.write('Usage: node scripts/render-memonogi-vhost.mjs --source <untouched-current-vhost> --input <marked-current-vhost> --output <candidate-vhost>\n');
    return 2;
  }
  try {
    const sourceCurrent = readFileSync(resolve(args[1]), 'utf8');
    const { output, manifest } = render(readFileSync(resolve(args[3]), 'utf8'), sourceCurrent);
    const outputPath = resolve(args[5]);
    writeFileSync(outputPath, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      writeFileSync(`${outputPath}.manifest`, manifest, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      unlinkSync(outputPath);
      throw new Error(`Manifest creation failed; candidate was removed: ${error.message}`);
    }
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
