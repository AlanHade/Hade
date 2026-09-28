import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SCHEMA = 'hade-public-installer/v1';
export const RELEASE_SCHEMA = 'hade-public-release/v1';
export const START = '\n<!-- HADE-PUBLIC:BEGIN v1 -->\n';
export const END = '<!-- HADE-PUBLIC:END v1 -->\n';
const RESERVED = '<!-- HADE-PUBLIC:';
const LIMIT = 1024 * 1024;
const FILES = ['CORE.md', 'HOST-CODEX.md', 'RECIPIENT.example.md'];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const encoded = (value) => Buffer.from(value, 'utf8');
const jsonBytes = (value) => encoded(JSON.stringify(value, null, 2) + '\n');
const fail = (code) => { throw new Error(code); };

function exact(value, names, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...names].sort().join('|')) fail(`invalid-${label}-fields`);
}

function cleanText(bytes, label, reserve = true) {
  let value;
  try { value = decoder.decode(bytes); } catch { fail(`invalid-utf8:${label}`); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(`control-character:${label}`);
  if (reserve && value.includes(RESERVED)) fail(`reserved-marker:${label}`);
  return value;
}

function checkedPath(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('absolute-path-required');
  const target = path.resolve(input);
  let cursor = target;
  while (true) {
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) fail(`linked-path:${cursor}`);
      if (cursor !== target && !stat.isDirectory()) fail('non-directory-ancestor');
    } else {
      try { fs.lstatSync(cursor); fail('dangling-link'); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return target;
}

function readFile(file, optional = false, limit = LIMIT) {
  checkedPath(file);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) fail(`unsafe-file:${path.basename(file)}`);
  const bytes = fs.readFileSync(file);
  if (bytes.length > limit) fail('file-too-large');
  return bytes;
}

function readJson(file, optional = false) {
  const bytes = readFile(file, optional);
  return bytes === null ? null : JSON.parse(cleanText(bytes, 'json', false));
}

function validateManifest(manifest) {
  exact(manifest, ['schema', 'version', 'files'], 'release');
  if (manifest.schema !== RELEASE_SCHEMA || typeof manifest.version !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(manifest.version)) fail('invalid-release-version');
  exact(manifest.files, FILES, 'release-files');
  for (const file of FILES) if (!/^[a-f0-9]{64}$/u.test(manifest.files[file])) fail('invalid-release-hash');
}

export function createReleaseManifest({ version, core, host, recipientExample }) {
  const strings = [core, host, recipientExample];
  strings.forEach((value, i) => {
    if (typeof value !== 'string' || encoded(value).length > LIMIT) fail('invalid-release-text');
    cleanText(encoded(value), FILES[i]);
  });
  if (!core.trim() || !host.trim() || encoded(recipientExample).length > 65536 ||
      strings.reduce((sum, value) => sum + encoded(value).length, 0) > 131072) fail('invalid-release-size');
  const manifest = { schema: RELEASE_SCHEMA, version, files: Object.fromEntries(FILES.map((file, i) => [file, sha(encoded(strings[i]))])) };
  validateManifest(manifest);
  return manifest;
}

function validateRelease(release) {
  exact(release, ['manifest', 'core', 'host', 'recipientExample'], 'release-payload');
  const expected = createReleaseManifest({ version: release.manifest?.version, ...release });
  validateManifest(release.manifest);
  if (JSON.stringify(expected) !== JSON.stringify(release.manifest)) fail('release-hash-mismatch');
  return release;
}

function readRelease(dir) {
  checkedPath(dir);
  const values = FILES.map((file) => cleanText(readFile(path.join(dir, file)), file));
  const raw = readJson(path.join(dir, 'release.json'));
  validateManifest(raw);
  const manifest = { schema: raw.schema, version: raw.version, files: Object.fromEntries(FILES.map((file) => [file, raw.files[file]])) };
  return validateRelease({ manifest, core: values[0], host: values[1], recipientExample: values[2] });
}

function releaseId(release) { return sha(jsonBytes(release.manifest)); }

function fragment(release, recipient) {
  cleanText(encoded(recipient), 'recipient');
  return START + `# Public collaboration · ${release.manifest.version}\n\n` +
    '<!-- HADE-PUBLIC:CORE -->\n' + release.core + '\n\n' +
    '<!-- HADE-PUBLIC:HOST -->\n' + release.host + '\n\n' +
    '<!-- HADE-PUBLIC:RECIPIENT -->\n' + recipient + '\n' + END;
}

function splitEntry(text) {
  const begin = text.indexOf(START);
  const finish = text.indexOf(END);
  if (begin === -1 && finish === -1) {
    if (text.includes(RESERVED)) fail('malformed-owned-marker');
    return { before: text, block: '', after: '' };
  }
  if (begin === -1 || finish < begin || text.indexOf(START, begin + 1) !== -1 ||
      text.indexOf(END, finish + 1) !== -1) fail('malformed-owned-marker');
  const before = text.slice(0, begin);
  const after = text.slice(finish + END.length);
  if ((before + after).includes(RESERVED)) fail('malformed-owned-marker');
  return { before, block: text.slice(begin, finish + END.length), after };
}

function context(options) {
  if (!options || Object.keys(options).some((key) => !['action', 'scope', 'target', 'entry', 'bundle', 'rollbackTo', 'maxEntryBytes'].includes(key))) fail('invalid-options');
  if (!['global', 'project'].includes(options.scope)) fail('explicit-scope-required');
  const target = checkedPath(options.target);
  if (target === path.parse(target).root || !fs.statSync(target).isDirectory()) fail('existing-non-root-target-required');
  const entry = options.entry ?? 'AGENTS.md';
  if (!['AGENTS.md', 'AGENTS.override.md'].includes(entry)) fail('invalid-entry');
  const max = options.maxEntryBytes ?? 32768;
  if (!Number.isSafeInteger(max) || max < 1 || max > LIMIT) fail('invalid-entry-ceiling');
  const stateDir = path.join(target, '.hade-public');
  checkedPath(stateDir);
  const owner = readJson(path.join(stateDir, 'OWNER.json'), true);
  if (fs.existsSync(stateDir) && !owner) fail('unowned-state-directory');
  if (owner) {
    exact(owner, ['schema', 'scope', 'entry'], 'owner');
    if (owner.schema !== SCHEMA || owner.scope !== options.scope || owner.entry !== entry) fail('owner-scope-or-entry-conflict');
  }
  return { target, entry, entryPath: path.join(target, entry), stateDir, max, scope: options.scope, owner };
}

function history(ctx) {
  const dir = path.join(ctx.stateDir, 'history');
  checkedPath(dir);
  if (!fs.existsSync(dir)) return [];
  if (!fs.statSync(dir).isDirectory()) fail('invalid-history-directory');
  const names = fs.readdirSync(dir).sort();
  if (names.length > 10000) fail('history-limit');
  const receipts = [];
  for (const [index, name] of names.entries()) {
    if (name !== String(index + 1).padStart(6, '0')) fail('history-sequence-conflict');
    const tx = path.join(dir, name);
    checkedPath(tx);
    const committed = readJson(path.join(tx, 'committed.json'), true);
    if (!committed) fail(`incomplete-transaction:${name}`);
    exact(committed, ['receiptSha256'], 'commit');
    const bytes = readFile(path.join(tx, 'receipt.json'));
    if (sha(bytes) !== committed.receiptSha256) fail('receipt-hash-mismatch');
    const receipt = JSON.parse(cleanText(bytes, 'receipt', false));
    exact(receipt, ['schema', 'sequence', 'scope', 'entry', 'action', 'observedAt', 'previousReceiptSha256', 'planSha256', 'beforeExists', 'beforeSha256', 'afterSha256', 'ownedBlockSha256', 'recipientSha256', 'release'], 'receipt');
    if (receipt.schema !== SCHEMA || receipt.sequence !== name || receipt.scope !== ctx.scope || receipt.entry !== ctx.entry ||
        receipt.previousReceiptSha256 !== (receipts.at(-1)?.hash ?? null) ||
        !['install', 'update', 'refresh', 'rollback', 'uninstall'].includes(receipt.action) || typeof receipt.beforeExists !== 'boolean') fail('receipt-chain-conflict');
    const before = readFile(path.join(tx, 'before.bin'));
    const after = readFile(path.join(tx, 'after.bin'));
    if (sha(before) !== receipt.beforeSha256 || sha(after) !== receipt.afterSha256 || (!receipt.beforeExists && before.length)) fail('backup-hash-mismatch');
    const owned = splitEntry(cleanText(after, 'after', false)).block;
    if ((owned ? sha(encoded(owned)) : null) !== receipt.ownedBlockSha256) fail('snapshot-block-mismatch');
    if (receipt.release !== null) validateRelease(receipt.release);
    if ((receipt.release === null) !== (receipt.action === 'uninstall') || Boolean(owned) !== Boolean(receipt.release)) fail('receipt-state-mismatch');
    receipts.push({ ...receipt, hash: committed.receiptSha256 });
  }
  return receipts;
}

function precedence(ctx, action) {
  const override = readFile(path.join(ctx.target, 'AGENTS.override.md'), true);
  const base = readFile(path.join(ctx.target, 'AGENTS.md'), true);
  const active = override && cleanText(override, 'override', false).trim() ? 'AGENTS.override.md' :
    base && cleanText(base, 'base', false).trim() ? 'AGENTS.md' : null;
  const issue = ctx.entry === 'AGENTS.md' && active === 'AGENTS.override.md' ? 'shadowed-by-override' :
    ctx.entry === 'AGENTS.override.md' && active === 'AGENTS.md' ? 'would-shadow-existing-base' : null;
  if (issue && action !== 'uninstall' && action !== 'status') fail(issue);
  return { activeAtTarget: active, issue };
}

export function status(options) {
  const ctx = context(options);
  const receipts = history(ctx);
  const last = receipts.at(-1);
  const bytes = readFile(ctx.entryPath, true);
  const parts = splitEntry(cleanText(bytes ?? Buffer.alloc(0), 'entry', false));
  const drift = (parts.block ? sha(encoded(parts.block)) : null) !== (last?.ownedBlockSha256 ?? null);
  const config = readFile(path.join(ctx.stateDir, 'RECIPIENT.md'), true);
  return { schema: SCHEMA, evidenceClass: 'engineering-only', scope: ctx.scope, target: ctx.target, entry: ctx.entry,
    installed: Boolean(last?.release), drift, recipientChanged: Boolean(last?.release) && (config === null || sha(config) !== last.recipientSha256),
    version: last?.release?.manifest.version ?? null, lastReceipt: last?.sequence ?? null,
    entrySha256: bytes === null ? null : sha(bytes), ...precedence(ctx, 'status'),
    hostInputVerified: false, behaviorVerified: false };
}

export function preview(options) {
  const ctx = context(options);
  const action = options.action;
  if (!['install', 'update', 'refresh', 'rollback', 'uninstall'].includes(action)) fail('invalid-action');
  if (['install', 'update'].includes(action) !== Boolean(options.bundle)) fail('bundle-only-required-for-install-update');
  if ((action === 'rollback') !== Boolean(options.rollbackTo)) fail('rollback-receipt-only-required-for-rollback');
  const receipts = history(ctx);
  const last = receipts.at(-1);
  const installed = Boolean(last?.release);
  const beforeBytes = readFile(ctx.entryPath, true);
  const before = cleanText(beforeBytes ?? Buffer.alloc(0), 'entry', false);
  const parts = splitEntry(before);
  if ((parts.block ? sha(encoded(parts.block)) : null) !== (last?.ownedBlockSha256 ?? null)) fail('managed-content-drift');
  const discovery = precedence(ctx, action);
  if (!installed && !['install', 'uninstall'].includes(action)) fail('not-installed');
  let release = null;
  if (options.bundle) release = readRelease(options.bundle);
  if (action === 'refresh') release = last.release;
  if (action === 'rollback') {
    release = receipts.find((receipt) => receipt.sequence === options.rollbackTo)?.release;
    if (!release) fail('invalid-rollback-receipt');
  }
  if (release) {
    for (const receipt of receipts) {
      if (receipt.release?.manifest.version === release.manifest.version && releaseId(receipt.release) !== releaseId(release)) fail('version-content-conflict');
    }
    if (action === 'install' && installed && releaseId(last.release) !== releaseId(release)) fail('already-installed-use-update');
  }
  const configPath = path.join(ctx.stateDir, 'RECIPIENT.md');
  const configBytes = readFile(configPath, true, 65536);
  if (installed && configBytes === null) fail('recipient-source-missing');
  const recipient = configBytes === null ? release?.recipientExample ?? '' : cleanText(configBytes, 'recipient');
  const block = release ? fragment(release, recipient) : '';
  const after = parts.before + block + parts.after;
  if (action !== 'uninstall' && encoded(after).length > ctx.max) fail('entry-exceeds-approved-ceiling');
  const noOp = before === after && !(release && configBytes === null);
  const plan = { schema: SCHEMA, evidenceClass: 'engineering-only', action, scope: ctx.scope, target: ctx.target, entry: ctx.entry,
    maxEntryBytes: ctx.max, previousReceiptSha256: last?.hash ?? null, beforeExists: beforeBytes !== null,
    beforeSha256: sha(encoded(before)), afterSha256: sha(encoded(after)), beforeBytes: encoded(before).length, afterBytes: encoded(after).length,
    ownedBlockSha256: block ? sha(encoded(block)) : null, recipientSha256: release ? sha(encoded(recipient)) : null,
    recipientExists: configBytes !== null, recipientPath: configPath, release, noOp, ...discovery,
    beforeText: before, afterText: after,
    warnings: ['Preview contains your local instructions; do not share it without review.',
      'The byte ceiling is caller-approved, not a verified host configuration. Project/ancestor guidance may also consume capacity or override this content.',
      'No Codex process, model, credentials, settings, permission or network operation is performed. Native input and behavior remain unverified.'] };
  return { ...plan, planSha256: sha(jsonBytes(plan)) };
}

function writeNew(file, bytes) {
  checkedPath(file);
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeExisting(file, bytes, beforeSha256) {
  checkedPath(file);
  const fd = fs.openSync(file, 'r+');
  try {
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() ||
        opened.dev !== current.dev || opened.ino !== current.ino || sha(fs.readFileSync(fd)) !== beforeSha256) fail('entry-changed-during-apply');
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail('entry-short-write');
      offset += count;
    }
    fs.ftruncateSync(fd, bytes.length);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export function apply(options, approvedPlanSha256) {
  if (!/^[a-f0-9]{64}$/u.test(approvedPlanSha256 ?? '')) fail('preview-approval-required');
  const planned = preview(options);
  if (planned.planSha256 !== approvedPlanSha256) fail('preview-stale');
  if (planned.noOp) return { schema: SCHEMA, noOp: true, status: status(options) };
  const ctx = context(options);
  if (!ctx.owner) {
    fs.mkdirSync(ctx.stateDir);
    writeNew(path.join(ctx.stateDir, 'OWNER.json'), jsonBytes({ schema: SCHEMA, scope: ctx.scope, entry: ctx.entry }));
  }
  const lockPath = path.join(ctx.stateDir, '.lock');
  const lockFd = fs.openSync(lockPath, 'wx');
  const lockStat = fs.fstatSync(lockFd);
  try {
    const current = preview(options);
    if (current.planSha256 !== approvedPlanSha256) fail('preview-stale');
    const receipts = history(ctx);
    const sequence = String(receipts.length + 1).padStart(6, '0');
    const historyDir = path.join(ctx.stateDir, 'history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir);
    const tx = path.join(historyDir, sequence);
    fs.mkdirSync(tx);
    const receipt = { schema: SCHEMA, sequence, scope: ctx.scope, entry: ctx.entry, action: current.action,
      observedAt: new Date().toISOString(), previousReceiptSha256: current.previousReceiptSha256, planSha256: current.planSha256,
      beforeExists: current.beforeExists, beforeSha256: current.beforeSha256, afterSha256: current.afterSha256,
      ownedBlockSha256: current.ownedBlockSha256, recipientSha256: current.recipientSha256, release: current.release };
    writeNew(path.join(tx, 'before.bin'), encoded(current.beforeText));
    writeNew(path.join(tx, 'after.bin'), encoded(current.afterText));
    const receiptBytes = jsonBytes(receipt);
    writeNew(path.join(tx, 'receipt.json'), receiptBytes);
    if (!current.recipientExists && current.release) writeNew(current.recipientPath, encoded(current.release.recipientExample));
    const latest = readFile(ctx.entryPath, true);
    if ((latest !== null) !== current.beforeExists || sha(latest ?? Buffer.alloc(0)) !== current.beforeSha256) fail('entry-changed-during-apply');
    const config = readFile(current.recipientPath, true);
    if (current.release && (config === null || sha(config) !== current.recipientSha256)) fail('recipient-changed-during-apply');
    precedence(ctx, current.action);
    if (current.beforeExists) writeExisting(ctx.entryPath, encoded(current.afterText), current.beforeSha256);
    else writeNew(ctx.entryPath, encoded(current.afterText));
    if (sha(readFile(ctx.entryPath)) !== current.afterSha256) fail('entry-postwrite-mismatch');
    writeNew(path.join(tx, 'committed.json'), jsonBytes({ receiptSha256: sha(receiptBytes) }));
    return { schema: SCHEMA, noOp: false, receipt: sequence, receiptSha256: sha(receiptBytes), status: status(options) };
  } finally {
    fs.closeSync(lockFd);
    const lockNow = fs.lstatSync(lockPath);
    if (lockNow.dev === lockStat.dev && lockNow.ino === lockStat.ino && lockNow.nlink === 1) fs.unlinkSync(lockPath);
  }
}
