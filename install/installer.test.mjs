import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { preview, apply, status, createReleaseManifest, START, END } from './installer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = fs.mkdtempSync(path.join(HERE, 'synthetic-tests-'));
let serial = 0;
const put = (file, value) => fs.writeFileSync(file, value, { flag: 'wx' });
function fixture({ scope = 'project', existing = '' } = {}) {
  const root = path.join(RUN, String(++serial));
  fs.mkdirSync(root);
  const target = path.join(root, 'recipient-project');
  fs.mkdirSync(target);
  if (existing) put(path.join(target, 'AGENTS.md'), existing);
  const makeBundle = (version, core = `# Synthetic core ${version}\nPreserve user data.\n`) => {
    const bundle = path.join(root, `bundle-${version}-${fs.readdirSync(root).length}`);
    fs.mkdirSync(bundle);
    const host = '# Synthetic host\nUse native instructions; do not claim behavioral proof.\n';
    const recipientExample = '# Synthetic recipient\nLanguage: recipient choice.\n';
    put(path.join(bundle, 'CORE.md'), core);
    put(path.join(bundle, 'HOST-CODEX.md'), host);
    put(path.join(bundle, 'RECIPIENT.example.md'), recipientExample);
    put(path.join(bundle, 'release.json'), JSON.stringify(createReleaseManifest({ version, core, host, recipientExample })));
    return bundle;
  };
  const bundle = makeBundle('1.0.0');
  const base = { scope, target };
  const options = { ...base, action: 'install', bundle };
  const run = (op) => apply(op, preview(op).planSha256);
  const install = () => run(options);
  const entry = path.join(target, 'AGENTS.md');
  const state = path.join(target, '.hade-public');
  return { root, target, bundle, base, options, run, install, entry, state, makeBundle };
}

test('preview is read-only; missing approval refuses; both scopes require explicit targets', () => {
  for (const scope of ['project', 'global']) {
    const f = fixture({ scope });
    const plan = preview(f.options);
    assert.equal(plan.scope, scope);
    assert.equal(fs.existsSync(f.state), false);
    assert.equal(fs.existsSync(f.entry), false);
    assert.throws(() => apply(f.options), /preview-approval-required/);
    assert.equal(f.install().status.installed, true);
    assert.equal(status(f.base).hostInputVerified, false);
    assert.equal(status(f.base).behaviorVerified, false);
  }
  const f = fixture();
  assert.throws(() => preview({ ...f.options, scope: undefined }), /explicit-scope/);
  assert.throws(() => preview({ ...f.options, target: '.' }), /absolute-path/);
});

test('first install preserves exact BOM, CRLF and no trailing newline; reinstall creates no receipt', () => {
  const original = '\ufeff# Recipient rules\r\nDo not remove: <tag> 中文';
  const f = fixture({ existing: original });
  f.install();
  const installed = fs.readFileSync(f.entry, 'utf8');
  assert.ok(installed.startsWith(original + START));
  assert.equal(f.install().noOp, true);
  assert.deepEqual(fs.readdirSync(path.join(f.state, 'history')), ['000001']);
  assert.deepEqual(fs.readFileSync(path.join(f.state, 'history/000001/before.bin')), Buffer.from(original));
  f.run({ ...f.base, action: 'uninstall' });
  assert.deepEqual(fs.readFileSync(f.entry), Buffer.from(original));
});

test('update, refresh, rollback, uninstall retain additions and current editable configuration', () => {
  const f = fixture({ existing: '# Before install\n' });
  f.install();
  const config = path.join(f.state, 'RECIPIENT.md');
  fs.appendFileSync(config, '\nRecipient addition one.\n');
  fs.appendFileSync(f.entry, '\nUser addition after install.\n');
  const bundle2 = f.makeBundle('2.0.0');
  f.run({ ...f.base, action: 'update', bundle: bundle2 });
  assert.equal(status(f.base).version, '2.0.0');
  fs.appendFileSync(config, 'Recipient addition after upgrade.\n');
  fs.appendFileSync(f.entry, 'User addition after upgrade.\n');
  assert.equal(status(f.base).recipientChanged, true);
  f.run({ ...f.base, action: 'refresh' });
  assert.equal(status(f.base).recipientChanged, false);
  f.run({ ...f.base, action: 'rollback', rollbackTo: '000001' });
  const rolled = fs.readFileSync(f.entry, 'utf8');
  assert.ok(rolled.includes('Synthetic core 1.0.0'));
  assert.ok(!rolled.includes('Synthetic core 2.0.0'));
  assert.ok(rolled.includes('Recipient addition after upgrade.'));
  const retainedConfig = fs.readFileSync(config);
  f.run({ ...f.base, action: 'uninstall' });
  assert.equal(fs.readFileSync(f.entry, 'utf8'), '# Before install\n\nUser addition after install.\nUser addition after upgrade.\n');
  assert.deepEqual(fs.readFileSync(config), retainedConfig);
  assert.equal(status(f.base).installed, false);
  assert.equal(f.run({ ...f.base, action: 'uninstall' }).noOp, true);
  f.install();
  assert.ok(fs.readFileSync(f.entry, 'utf8').includes('Recipient addition after upgrade.'));
  assert.equal(status(f.base).installed, true);
});

test('modified, removed and duplicate managed sections refuse every mutation without changing user bytes', () => {
  for (const mutate of [
    (text) => text.replace('Synthetic core', 'Recipient edited core'),
    (text) => text.slice(0, text.indexOf(START)),
    (text) => text + START + 'duplicate\n' + END,
    (text) => text.replace(START, '\n<!-- HADE-PUBLIC:BEGIN broken -->\n'),
  ]) {
    const f = fixture({ existing: '# User\n' });
    f.install();
    fs.writeFileSync(f.entry, mutate(fs.readFileSync(f.entry, 'utf8')));
    const before = fs.readFileSync(f.entry);
    for (const operation of [f.options, { ...f.base, action: 'refresh' }, { ...f.base, action: 'uninstall' }, { ...f.base, action: 'rollback', rollbackTo: '000001' }]) {
      assert.throws(() => preview(operation), /managed-content-drift|malformed-owned-marker/);
      assert.deepEqual(fs.readFileSync(f.entry), before);
    }
  }
});

test('stale preview refuses new outside edits, recipient changes and package changes', () => {
  const f = fixture({ existing: '# User\n' });
  let plan = preview(f.options);
  fs.appendFileSync(f.entry, 'New user line.\n');
  assert.throws(() => apply(f.options, plan.planSha256), /preview-stale/);
  f.install();
  const operation = { ...f.base, action: 'refresh' };
  plan = preview(operation);
  fs.appendFileSync(path.join(f.state, 'RECIPIENT.md'), 'New config.\n');
  assert.throws(() => apply(operation, plan.planSha256), /preview-stale/);
  const fresh = fixture();
  plan = preview(fresh.options);
  fs.appendFileSync(path.join(fresh.bundle, 'CORE.md'), 'Changed.\n');
  assert.throws(() => apply(fresh.options, plan.planSha256), /release-hash-mismatch/);
  assert.equal(fs.existsSync(fresh.entry), false);
});

test('version reuse cannot relabel different bytes; update is required for a different release', () => {
  const f = fixture();
  f.install();
  const changed = f.makeBundle('1.0.0', '# Changed core\n');
  assert.throws(() => preview({ ...f.base, action: 'update', bundle: changed }), /version-content-conflict/);
  const next = f.makeBundle('2.0.0');
  assert.throws(() => preview({ ...f.options, bundle: next }), /already-installed-use-update/);
});

test('active override blocks base install; creating override never hides nonempty base', () => {
  const f = fixture({ existing: '# Preserve base\n' });
  const override = path.join(f.target, 'AGENTS.override.md');
  put(override, '# Existing override\n');
  assert.throws(() => preview(f.options), /shadowed-by-override/);
  const options = { ...f.options, entry: 'AGENTS.override.md' };
  f.run(options);
  assert.equal(fs.readFileSync(f.entry, 'utf8'), '# Preserve base\n');
  assert.ok(fs.readFileSync(override, 'utf8').startsWith('# Existing override\n'));
  f.run({ ...f.base, entry: 'AGENTS.override.md', action: 'uninstall' });
  assert.equal(fs.readFileSync(override, 'utf8'), '# Existing override\n');
  const fresh = fixture({ existing: '# Base only\n' });
  assert.throws(() => preview({ ...fresh.options, entry: 'AGENTS.override.md' }), /would-shadow-existing-base/);
});

test('empty override falls through; shadow introduced later blocks update but not scoped removal', () => {
  const f = fixture();
  put(path.join(f.target, 'AGENTS.override.md'), '  \r\n');
  f.install();
  fs.writeFileSync(path.join(f.target, 'AGENTS.override.md'), '# Later override\n');
  assert.equal(status(f.base).issue, 'shadowed-by-override');
  assert.throws(() => preview({ ...f.base, action: 'refresh' }), /shadowed-by-override/);
  f.run({ ...f.base, action: 'uninstall' });
  assert.equal(fs.readFileSync(path.join(f.target, 'AGENTS.override.md'), 'utf8'), '# Later override\n');
});

test('uninstall fresh state is no-op; invalid action combinations and foreign ownership refuse', () => {
  const f = fixture();
  assert.equal(f.run({ ...f.base, action: 'uninstall' }).noOp, true);
  assert.equal(fs.existsSync(f.state), false);
  for (const action of ['refresh', 'update', 'rollback']) {
    const op = { ...f.base, action, ...(action === 'update' ? { bundle: f.bundle } : {}), ...(action === 'rollback' ? { rollbackTo: '000001' } : {}) };
    assert.throws(() => preview(op), /not-installed/);
  }
  assert.throws(() => preview({ ...f.options, extra: true }), /invalid-options/);
  assert.throws(() => preview({ ...f.options, rollbackTo: '000001' }), /rollback-receipt/);
  fs.mkdirSync(f.state);
  assert.throws(() => preview(f.options), /unowned-state-directory/);
});

test('missing config, cross-scope and cross-entry state use fail closed', () => {
  const f = fixture();
  f.install();
  assert.throws(() => status({ ...f.base, scope: 'global' }), /owner-scope-or-entry/);
  assert.throws(() => status({ ...f.base, entry: 'AGENTS.override.md' }), /owner-scope-or-entry/);
  fs.renameSync(path.join(f.state, 'RECIPIENT.md'), path.join(f.state, 'RECIPIENT.user-moved.md'));
  assert.throws(() => preview({ ...f.base, action: 'refresh' }), /recipient-source-missing/);
});

test('backup corruption, receipt corruption and incomplete transaction prevent writes', () => {
  for (const filename of ['before.bin', 'after.bin', 'receipt.json', 'committed.json']) {
    const f = fixture();
    f.install();
    const before = fs.readFileSync(f.entry);
    fs.appendFileSync(path.join(f.state, 'history/000001', filename), 'X');
    assert.throws(() => preview({ ...f.base, action: 'refresh' }));
    assert.deepEqual(fs.readFileSync(f.entry), before);
  }
  const f = fixture();
  f.install();
  fs.mkdirSync(path.join(f.state, 'history/000002'));
  assert.throws(() => preview({ ...f.base, action: 'refresh' }), /incomplete-transaction:000002/);
});

test('entry limit, invalid UTF-8, marker injection and release-size limits refuse before write', () => {
  const f = fixture();
  assert.throws(() => preview({ ...f.options, maxEntryBytes: 20 }), /entry-exceeds/);
  put(f.entry, Buffer.from([0xff, 0xfe]));
  assert.throws(() => preview(f.options), /invalid-utf8/);
  assert.throws(() => createReleaseManifest({ version: 'a', core: START, host: 'x', recipientExample: '' }), /reserved-marker/);
  assert.throws(() => createReleaseManifest({ version: '../bad', core: 'x', host: 'y', recipientExample: '' }), /invalid-release-version/);
  assert.throws(() => createReleaseManifest({ version: 'a', core: '', host: 'y', recipientExample: '' }), /invalid-release-size/);
  assert.throws(() => createReleaseManifest({ version: 'a', core: 'x'.repeat(131073), host: 'y', recipientExample: '' }), /invalid-release-size/);
  assert.throws(() => createReleaseManifest({ version: 'a', core: 'x', host: 'y', recipientExample: 'z'.repeat(65537) }), /invalid-release-size/);
  assert.equal(fs.existsSync(f.state), false);
});

test('initial creation never overwrites a file introduced immediately before its exclusive create', () => {
  const f = fixture();
  const plan = preview(f.options);
  const realOpen = fs.openSync;
  let injected = false;
  fs.openSync = (file, flags, ...rest) => {
    if (!injected && file === f.entry && flags === 'wx') {
      injected = true;
      const fd = realOpen(file, 'wx');
      fs.writeFileSync(fd, '# Concurrent recipient creation\n');
      fs.closeSync(fd);
    }
    return realOpen(file, flags, ...rest);
  };
  try { assert.throws(() => apply(f.options, plan.planSha256), /EEXIST/); }
  finally { fs.openSync = realOpen; }
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(f.entry, 'utf8'), '# Concurrent recipient creation\n');
  assert.throws(() => preview(f.options), /incomplete-transaction:000001/);
  assert.equal(fs.existsSync(path.join(f.state, '.lock')), false);
});

test('existing installer lock refuses writes and is not removed by the refused process', () => {
  const f = fixture();
  f.install();
  fs.appendFileSync(path.join(f.state, 'RECIPIENT.md'), 'New recipient configuration.\n');
  const op = { ...f.base, action: 'refresh' };
  const plan = preview(op);
  const lock = path.join(f.state, '.lock');
  put(lock, 'Synthetic other installer lock\n');
  const bytes = fs.readFileSync(f.entry);
  assert.throws(() => apply(op, plan.planSha256), /EEXIST/);
  assert.deepEqual(fs.readFileSync(f.entry), bytes);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'Synthetic other installer lock\n');
  assert.deepEqual(fs.readdirSync(path.join(f.state, 'history')), ['000001']);
});

test('existing instruction file identity and mode remain unchanged through all lifecycle writes', () => {
  const f = fixture({ existing: '# Keep this file object\n' });
  const identity = fs.statSync(f.entry);
  const check = () => {
    const actual = fs.statSync(f.entry);
    assert.equal(actual.ino, identity.ino);
    assert.equal(actual.dev, identity.dev);
    assert.equal(actual.mode, identity.mode);
  };
  f.install();
  check();
  f.run({ ...f.base, action: 'update', bundle: f.makeBundle('2.0.0') });
  check();
  f.run({ ...f.base, action: 'rollback', rollbackTo: '000001' });
  check();
  f.run({ ...f.base, action: 'uninstall' });
  check();
  assert.equal(fs.readFileSync(f.entry, 'utf8'), '# Keep this file object\n');
});

test('partial existing-file write keeps verified recovery bytes and prevents automatic retry', () => {
  const f = fixture({ existing: '# Original recipient text\n' });
  const original = fs.readFileSync(f.entry);
  const plan = preview(f.options);
  const realOpen = fs.openSync;
  const realWrite = fs.writeSync;
  let targetFd;
  let injected = false;
  fs.openSync = (file, flags, ...rest) => {
    const fd = realOpen(file, flags, ...rest);
    if (file === f.entry && flags === 'r+') targetFd = fd;
    return fd;
  };
  fs.writeSync = (fd, buffer, offset, length, position) => {
    if (!injected && fd === targetFd) {
      injected = true;
      realWrite(fd, buffer, offset, Math.min(length, original.length + 8), position);
      throw new Error('synthetic-interrupted-write');
    }
    return realWrite(fd, buffer, offset, length, position);
  };
  try { assert.throws(() => apply(f.options, plan.planSha256), /synthetic-interrupted-write/); }
  finally { fs.openSync = realOpen; fs.writeSync = realWrite; }
  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(path.join(f.state, 'history/000001/before.bin')), original);
  assert.equal(fs.readFileSync(path.join(f.state, 'history/000001/after.bin'), 'utf8'), plan.afterText);
  const current = fs.readFileSync(f.entry);
  assert.throws(() => preview(f.options), /incomplete-transaction/);
  assert.deepEqual(fs.readFileSync(f.entry), current);
  assert.equal(fs.existsSync(path.join(f.state, 'history/000001/committed.json')), false);
});

test('hardlinked entry and junction target are rejected', (t) => {
  const f = fixture({ existing: '# Synthetic linked file\n' });
  fs.linkSync(f.entry, path.join(f.root, 'same-file.md'));
  assert.throws(() => preview(f.options), /unsafe-file/);
  const g = fixture();
  const linked = path.join(g.root, 'linked-project');
  try { fs.symlinkSync(g.target, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Directory link creation unavailable; junction subcase unverified.'); return; } throw error; }
  assert.throws(() => preview({ ...g.options, target: linked }), /linked-path/);
});

test('plain text resembling commands stays inert and snapshots remain create-only', () => {
  const f = fixture();
  const bundle = f.makeBundle('inert', '# Synthetic data\nrequire("node:fs").writeFileSync("unexpected", "x");\n');
  f.run({ ...f.options, bundle });
  assert.equal(fs.existsSync(path.join(f.target, 'unexpected')), false);
  assert.ok(fs.readFileSync(f.entry, 'utf8').includes('writeFileSync'));
  const historyBefore = fs.readFileSync(path.join(f.state, 'history/000001/receipt.json'));
  f.run({ ...f.base, action: 'refresh' });
  assert.deepEqual(fs.readFileSync(path.join(f.state, 'history/000001/receipt.json')), historyBefore);
});

test('CLI preview/apply/status and argument errors use the real command path', () => {
  const f = fixture();
  const invoke = (args) => spawnSync(process.execPath, [path.join(HERE, 'cli.mjs'), ...args], { encoding: 'utf8', cwd: f.root });
  const options = ['--scope', 'project', '--target', f.target, '--action', 'install', '--bundle', f.bundle];
  const planning = invoke(['preview', ...options]);
  assert.equal(planning.status, 0, planning.stderr);
  const plan = JSON.parse(planning.stdout);
  const applied = invoke(['apply', ...options, '--approve', plan.planSha256]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status.installed, true);
  const checked = invoke(['status', '--scope', 'project', '--target', f.target]);
  assert.equal(checked.status, 0);
  assert.equal(JSON.parse(checked.stdout).version, '1.0.0');
  assert.equal(invoke(['preview', ...options, '--target', f.target]).status, 1);
  assert.equal(invoke(['apply', ...options]).status, 1);
  assert.equal(invoke(['status', '--scope', 'project', '--target', f.target, '--action', 'install']).status, 1);
  assert.equal(invoke(['--help']).status, 0);
});

test('test fixture provenance is synthetic-only', (t) => {
  t.diagnostic(`Synthetic-only files retained at ${RUN}`);
  assert.ok(RUN.startsWith(HERE + path.sep));
});
