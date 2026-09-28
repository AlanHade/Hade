import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { types } from 'node:util';

const LIMIT = 1024 * 1024;
const operations = ['receive', 'propose', 'plan', 'apply', 'revoke', 'restore', 'export-summary'];
const kinds = ['feedback', 'candidate', 'plan', 'decision', 'transition'];
const fail = (condition, code) => { if (!condition) throw new Error(code); };
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function data(value, limit = LIMIT) {
  const seen = new Set();
  let nodes = 0;
  function visit(item, depth) {
    fail(++nodes <= 8192 && depth <= 20, 'DATA_STRUCTURE_LIMIT');
    fail(!types.isProxy(item), 'DATA_ONLY');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      fail(Buffer.byteLength(item) <= limit && Buffer.from(item).toString() === item, 'INVALID_TEXT');
      return;
    }
    if (typeof item === 'number') { fail(Number.isFinite(item), 'FINITE_NUMBER_REQUIRED'); return; }
    fail(item && typeof item === 'object', 'DATA_ONLY');
    const array = Array.isArray(item);
    fail(Object.getPrototypeOf(item) === (array ? Array.prototype : Object.prototype), 'DATA_ONLY');
    fail(!seen.has(item) && Object.getOwnPropertySymbols(item).length === 0, 'DATA_ONLY');
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array) fail(item.length <= 128 && Object.keys(descriptors).length === item.length + 1, 'DENSE_BOUNDED_ARRAY');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      fail(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'DATA_ONLY');
      if (array) fail(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < item.length, 'DENSE_BOUNDED_ARRAY');
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);
  fail(Buffer.byteLength(JSON.stringify(value)) <= limit, 'DATA_SIZE_LIMIT');
}

export function canonical(value) {
  data(value);
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export const digest = value => sha256(canonical(value));
const same = (a, b) => canonical(a) === canonical(b);
function keys(value, expected) {
  fail(value && Object.getPrototypeOf(value) === Object.prototype, 'OBJECT_REQUIRED');
  fail(Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)), 'FIELDS_MISMATCH');
}
function text(value, max = 4096) {
  fail(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max, 'TEXT_REQUIRED');
  fail(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), 'CONTROL_CHARACTER');
}
function identifier(value) { fail(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value), 'INVALID_ID'); }
function hash(value) { fail(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_SHA256'); }
function relativeName(value) {
  fail(typeof value === 'string' && value.length <= 200, 'INVALID_PAYLOAD_PATH');
  for (const segment of value.split('/')) {
    fail(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) && !segment.endsWith('.'), 'INVALID_PAYLOAD_PATH');
    fail(!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment), 'RESERVED_PAYLOAD_PATH');
  }
}
function bundle(value) {
  keys(value, ['id', 'version', 'files']);
  identifier(value.id); text(value.version, 80);
  fail(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(value.version), 'INVALID_VERSION');
  fail(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 32, 'FILE_COUNT');
  const names = [];
  let size = 0;
  for (const file of value.files) {
    keys(file, ['path', 'text']); relativeName(file.path);
    fail(typeof file.text === 'string' && Buffer.byteLength(file.text) <= 65536, 'PAYLOAD_TEXT_LIMIT');
    fail(!file.text.includes('\0'), 'PAYLOAD_NUL');
    names.push(file.path.toLowerCase()); size += Buffer.byteLength(file.text);
  }
  fail(size <= 256 * 1024 && new Set(names).size === names.length, 'BUNDLE_LIMIT_OR_COLLISION');
  fail(!names.some(name => names.some(other => other.startsWith(name + '/'))), 'FILE_DIRECTORY_COLLISION');
}
function reference(value, expected) {
  data(value, 1024); keys(value, ['kind', 'id', 'sha256']);
  fail(kinds.includes(value.kind) && (!expected || value.kind === expected), 'REFERENCE_KIND');
  identifier(value.id); hash(value.sha256);
}

function safeDirectory(directory, mustExist = true) {
  fail(typeof directory === 'string' && path.isAbsolute(directory), 'ABSOLUTE_DIRECTORY_REQUIRED');
  let current = path.resolve(directory);
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      fail(stat.isDirectory() && !stat.isSymbolicLink(), 'DIRECTORY_LINK_OR_NON_DIRECTORY');
    } catch (error) {
      if (error.code !== 'ENOENT' || (mustExist && current === path.resolve(directory))) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function readBytes(file, limit = LIMIT) {
  safeDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  fail(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'FILE_LINK_OR_NON_REGULAR');
  fail(stat.size <= limit, 'FILE_TOO_LARGE');
  const fd = fs.openSync(file, 'r');
  try {
    const actual = fs.fstatSync(fd);
    fail(actual.isFile() && actual.nlink === 1 && actual.dev === stat.dev && actual.ino === stat.ino, 'FILE_DRIFT');
    const bytes = fs.readFileSync(fd);
    fail(bytes.length <= limit && Buffer.from(bytes.toString('utf8')).equals(bytes), 'INVALID_FILE_BYTES');
    const after = fs.lstatSync(file);
    fail(after.dev === actual.dev && after.ino === actual.ino && after.size === bytes.length, 'FILE_DRIFT');
    return bytes;
  } finally { fs.closeSync(fd); }
}
export function readJson(file) { const value = JSON.parse(readBytes(file)); data(value); return value; }
function createOnly(file, bytes) {
  safeDirectory(path.dirname(file));
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fail(readBytes(file).equals(bytes), 'WRITE_READBACK_MISMATCH');
}
function jsonBytes(value) { return Buffer.from(canonical(value) + '\n'); }

function installerProjection(artifact) {
  const names = ['CORE.md', 'HOST-CODEX.md', 'RECIPIENT.example.md'];
  if (!same(artifact.files.map(file => file.path).sort(), [...names].sort())) return { status: 'NOT_READY', reason: 'INSTALLER_REQUIRES_EXACT_THREE_DOCUMENTS' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(artifact.version)) return { status: 'NOT_READY', reason: 'INSTALLER_VERSION_FORMAT' };
  const texts = names.map(name => artifact.files.find(file => file.path === name).text);
  if (!texts[0].trim() || !texts[1].trim() || texts.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 131072) return { status: 'NOT_READY', reason: 'INSTALLER_DOCUMENT_SIZE' };
  if (texts.some(value => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || value.includes('<!-- HADE-PUBLIC:'))) return { status: 'NOT_READY', reason: 'INSTALLER_DOCUMENT_RESERVED_CONTENT' };
  const manifest = { schema: 'hade-public-release/v1', version: artifact.version, files: Object.fromEntries(names.map((name, index) => [name, sha256(texts[index])])) };
  return { status: 'READY', manifest };
}

function validateCheck(check) {
  keys(check, ['id', 'role', 'type', 'path', 'expected']);
  identifier(check.id); relativeName(check.path);
  fail(['improvement', 'regression'].includes(check.role), 'CHECK_ROLE');
  fail(['contains', 'not-contains', 'file-sha256', 'max-bytes', 'json-value', 'semantic'].includes(check.type), 'CHECK_TYPE');
  if (['contains', 'not-contains', 'semantic'].includes(check.type)) text(check.expected, 4096);
  if (check.type === 'file-sha256') { hash(check.expected); fail(check.role === 'regression', 'HASH_IS_NOT_IMPROVEMENT'); }
  if (check.type === 'max-bytes') fail(Number.isSafeInteger(check.expected) && check.expected >= 0 && check.expected <= 65536, 'CHECK_SIZE');
  if (check.type === 'json-value') {
    keys(check.expected, ['keys', 'value']);
    fail(Array.isArray(check.expected.keys) && check.expected.keys.length <= 8, 'JSON_KEY_PATH');
    for (const key of check.expected.keys) { text(key, 100); fail(!['__proto__', 'constructor', 'prototype'].includes(key), 'JSON_KEY_PATH'); }
    fail(check.expected.value === null || ['string', 'number', 'boolean'].includes(typeof check.expected.value), 'JSON_PRIMITIVE_EXPECTED');
  }
}

function observe(check, artifact) {
  const file = artifact.files.find(item => item.path === check.path);
  if (check.type === 'semantic') return { state: 'UNKNOWN', reason: 'SEMANTIC_EVIDENCE_NOT_AVAILABLE', fileSha256: file ? sha256(file.text) : null };
  if (!file) return { state: 'FAIL', reason: 'FILE_ABSENT', fileSha256: null };
  let matches;
  let reason = 'CONTENT_CONSTRAINT';
  if (check.type === 'contains') matches = file.text.includes(check.expected);
  if (check.type === 'not-contains') matches = !file.text.includes(check.expected);
  if (check.type === 'file-sha256') matches = sha256(file.text) === check.expected;
  if (check.type === 'max-bytes') matches = Buffer.byteLength(file.text) <= check.expected;
  if (check.type === 'json-value') {
    try {
      let current = JSON.parse(file.text);
      for (const key of check.expected.keys) {
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return { state: 'FAIL', reason: 'JSON_KEY_ABSENT', fileSha256: sha256(file.text) };
        current = current[key];
      }
      matches = same(current, check.expected.value);
    } catch { matches = false; reason = 'INVALID_JSON'; }
  }
  return { state: matches ? 'PASS' : 'FAIL', reason, fileSha256: sha256(file.text) };
}

function validatePlan(plan) {
  keys(plan, ['checks']);
  fail(Array.isArray(plan.checks) && plan.checks.length > 1 && plan.checks.length <= 32, 'CHECK_COUNT');
  plan.checks.forEach(validateCheck);
  fail(new Set(plan.checks.map(item => item.id)).size === plan.checks.length, 'DUPLICATE_CHECK');
  fail(plan.checks.some(item => item.role === 'improvement') && plan.checks.some(item => item.role === 'regression'), 'IMPROVEMENT_AND_REGRESSION_REQUIRED');
}

export function checkCandidate(plan, baseline, candidate) {
  data({ plan, baseline, candidate }); bundle(baseline); bundle(candidate); validatePlan(plan);
  const observations = plan.checks.map(check => ({ id: check.id, role: check.role, type: check.type, baseline: observe(check, baseline), candidate: observe(check, candidate) }));
  const failures = observations.filter(item => item.candidate.state === 'FAIL').map(item => item.id);
  const missing = observations.filter(item => item.candidate.state === 'UNKNOWN' || (item.role === 'regression' && item.baseline.state !== 'PASS')).map(item => item.id);
  const improvements = observations.filter(item => item.role === 'improvement' && item.baseline.state === 'FAIL' && item.candidate.state === 'PASS').map(item => item.id);
  const status = failures.length ? 'REJECT' : missing.length || !improvements.length ? 'INSUFFICIENT' : 'ACCEPT';
  return { status, observations, failures, missing, improvements, scope: 'DECLARED_LOCAL_CONTENT_CONSTRAINTS_ONLY', independentSemanticReview: false, naturalBehaviorImprovement: false, publicationAuthorized: false, automaticApplication: false };
}

export function openFeedbackStore(root, suppliedPolicy) {
  data(suppliedPolicy);
  keys(suppliedPolicy, ['schema', 'scopeId', 'provenance', 'baseline', 'authorizationSha256']);
  fail(suppliedPolicy.schema === 'hade-engineering-feedback-policy/1', 'POLICY_SCHEMA');
  identifier(suppliedPolicy.scopeId); bundle(suppliedPolicy.baseline); hash(suppliedPolicy.authorizationSha256);
  fail(['synthetic-fixture', 'maintainer-local'].includes(suppliedPolicy.provenance), 'PROVENANCE');
  fail(typeof root === 'string' && path.isAbsolute(root), 'ABSOLUTE_DIRECTORY_REQUIRED');
  const directory = path.resolve(root);
  fail(directory !== path.parse(directory).root, 'DEDICATED_DIRECTORY_REQUIRED');
  const policy = structuredClone(suppliedPolicy);
  const policyHash = digest(policy);
  const policyBytes = jsonBytes(policy);
  safeDirectory(directory, false);
  fs.mkdirSync(directory, { recursive: true });
  safeDirectory(directory);
  const policyPath = path.join(directory, 'policy.json');
  if (fs.existsSync(policyPath)) fail(readBytes(policyPath).equals(policyBytes), 'POLICY_MISMATCH');
  else {
    fail(fs.readdirSync(directory).length === 0, 'NEW_STORE_MUST_BE_EMPTY');
    createOnly(policyPath, policyBytes);
  }

  function guard() { safeDirectory(directory); fail(readBytes(policyPath).equals(policyBytes), 'POLICY_DRIFT'); }
  function authorize(operation, subject, authorization) {
    data(authorization, 16384); keys(authorization, ['document', 'subjectSha256']);
    hash(authorization.subjectSha256);
    fail(authorization.subjectSha256 === digest(subject), 'AUTHORIZATION_SUBJECT');
    const document = authorization.document;
    keys(document, ['schema', 'id', 'scopeId', 'provenance', 'basis', 'operations']);
    fail(document.schema === 'hade-local-authorization/1', 'AUTHORIZATION_SCHEMA');
    identifier(document.id);
    fail(document.scopeId === policy.scopeId && document.provenance === policy.provenance && document.basis === 'explicit-local-user', 'AUTHORIZATION_SCOPE');
    fail(Array.isArray(document.operations) && new Set(document.operations).size === document.operations.length && document.operations.every(item => operations.includes(item)), 'AUTHORIZATION_OPERATIONS');
    fail(document.operations.includes(operation) && digest(document) === policy.authorizationSha256, 'AUTHORIZATION_DENIED');
    return { purpose: operation, documentSha256: policy.authorizationSha256, subjectSha256: authorization.subjectSha256, identityCryptographicallyVerified: false };
  }
  function save(kind, id, links, payload) {
    guard(); identifier(id);
    const record = { schema: 'hade-engineering-feedback-record/1', kind, id, policySha256: policyHash, links, payload };
    const bytes = jsonBytes(record);
    fail(bytes.length <= LIMIT, 'RECORD_TOO_LARGE');
    createOnly(path.join(directory, `${kind}-${id}.json`), bytes);
    return { kind, id, sha256: sha256(bytes) };
  }
  function assertVersionAvailable(candidate) {
    const existing = [policy.baseline];
    for (const name of fs.readdirSync(directory).filter(name => name.startsWith('candidate-'))) {
      const match = /^candidate-([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$/.exec(name);
      fail(match, 'CANDIDATE_FILENAME');
      const ref = { kind: 'candidate', id: match[1], sha256: sha256(readBytes(path.join(directory, name))) };
      const record = load(ref); bundle(record.payload.candidate);
      existing.push(record.payload.candidate);
    }
    fail(!existing.some(value => value.id === candidate.id && value.version === candidate.version && digest(value) !== digest(candidate)), 'VERSION_CONTENT_CONFLICT');
  }
  function load(ref, visited = new Set(), verified = new Map()) {
    reference(ref); guard();
    const key = `${ref.kind}-${ref.id}`;
    const cacheKey = `${key}-${ref.sha256}`;
    if (verified.has(cacheKey)) return verified.get(cacheKey);
    fail(!visited.has(key) && visited.size < 256, 'REFERENCE_CYCLE_OR_DEPTH');
    const next = new Set(visited); next.add(key);
    const bytes = readBytes(path.join(directory, `${key}.json`));
    fail(sha256(bytes) === ref.sha256, 'RECORD_HASH_MISMATCH');
    const record = JSON.parse(bytes); data(record);
    keys(record, ['schema', 'kind', 'id', 'policySha256', 'links', 'payload']);
    fail(record.schema === 'hade-engineering-feedback-record/1' && record.kind === ref.kind && record.id === ref.id && record.policySha256 === policyHash, 'RECORD_BINDING');
    fail(Array.isArray(record.links) && record.links.length <= 4, 'LINK_COUNT');
    for (const link of record.links) load(link, next, verified);
    verified.set(cacheKey, record);
    return record;
  }
  function verifiedDecision(ref) {
    reference(ref, 'decision');
    const record = load(ref);
    fail(record.links.length === 1 && record.links[0].kind === 'plan', 'DECISION_CHAIN');
    const planRecord = load(record.links[0]);
    fail(planRecord.links.length === 1 && planRecord.links[0].kind === 'candidate' && planRecord.payload.fixedBeforeEvaluation === true, 'PLAN_CHAIN');
    const candidateRecord = load(planRecord.links[0]);
    const decision = record.payload;
    keys(decision, ['result', 'planSha256', 'baselineSha256', 'candidateSha256', 'provenance']);
    fail(decision.planSha256 === record.links[0].sha256 && decision.baselineSha256 === digest(candidateRecord.payload.baseline) &&
      decision.candidateSha256 === digest(candidateRecord.payload.candidate) && decision.provenance === policy.provenance, 'DECISION_VERSION_BINDING');
    const actual = checkCandidate(planRecord.payload.plan, candidateRecord.payload.baseline, candidateRecord.payload.candidate);
    fail(same(decision.result, actual), 'DECISION_RECOMPUTE_MISMATCH');
    return { record, candidateRecord, actual };
  }
  function locked(action) {
    guard();
    const lockPath = path.join(directory, 'operation.lock');
    const token = Buffer.from(crypto.randomUUID());
    createOnly(lockPath, token);
    try { return action(); }
    finally {
      fail(readBytes(lockPath).equals(token), 'LOCK_DRIFT_PRESERVED');
      fs.unlinkSync(lockPath);
    }
  }
  function payloadManifest(artifact, trace) {
    const projection = installerProjection(artifact);
    return { schema: 'hade-feedback-payload/1', id: artifact.id, version: artifact.version, bundleSha256: digest(artifact), provenance: policy.provenance,
      files: artifact.files.map(file => ({ path: file.path, sha256: sha256(file.text), bytes: Buffer.byteLength(file.text) })), trace,
      installer: projection.status === 'READY' ? { status: 'READY', releaseSha256: sha256(JSON.stringify(projection.manifest, null, 2) + '\n') } : projection };
  }
  function materialize(artifact, trace) {
    const name = `artifact-${crypto.randomUUID()}`;
    const destination = path.join(directory, name);
    fs.mkdirSync(destination);
    fs.mkdirSync(path.join(destination, 'files'));
    for (const file of artifact.files) {
      const target = path.join(destination, 'files', ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      safeDirectory(path.dirname(target));
      createOnly(target, Buffer.from(file.text));
    }
    const projection = installerProjection(artifact);
    if (projection.status === 'READY') createOnly(path.join(destination, 'files', 'release.json'), Buffer.from(JSON.stringify(projection.manifest, null, 2) + '\n'));
    const manifest = payloadManifest(artifact, trace);
    const bytes = jsonBytes(manifest);
    createOnly(path.join(destination, 'payload-manifest.json'), bytes);
    return { directory: name, manifestSha256: sha256(bytes) };
  }
  function verifyArtifact(location, artifact, trace) {
    keys(location, ['directory', 'manifestSha256']);
    fail(/^artifact-[a-f0-9-]{36}$/.test(location.directory), 'ARTIFACT_DIRECTORY'); hash(location.manifestSha256);
    const destination = path.join(directory, location.directory);
    safeDirectory(destination);
    fail(same(fs.readdirSync(destination).sort(), ['files', 'payload-manifest.json']), 'ARTIFACT_EXTRA_ENTRIES');
    const bytes = readBytes(path.join(destination, 'payload-manifest.json'));
    fail(sha256(bytes) === location.manifestSha256, 'ARTIFACT_MANIFEST_DRIFT');
    const expected = payloadManifest(artifact, trace);
    fail(bytes.equals(jsonBytes(expected)), 'ARTIFACT_MANIFEST_MISMATCH');
    const actualNames = [];
    function walk(folder, prefix = '') {
      safeDirectory(folder);
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        fail(!item.isSymbolicLink(), 'ARTIFACT_LINK');
        if (item.isDirectory()) walk(path.join(folder, item.name), prefix + item.name + '/');
        else { fail(item.isFile(), 'ARTIFACT_NON_FILE'); actualNames.push(prefix + item.name); }
      }
    }
    walk(path.join(destination, 'files'));
    const projection = installerProjection(artifact);
    const names = artifact.files.map(file => file.path);
    if (projection.status === 'READY') {
      names.push('release.json');
      fail(readBytes(path.join(destination, 'files', 'release.json')).equals(Buffer.from(JSON.stringify(projection.manifest, null, 2) + '\n')), 'INSTALLER_MANIFEST_DRIFT');
    }
    fail(same(actualNames.sort(), names.sort()), 'ARTIFACT_FILE_SET');
    for (const file of artifact.files) fail(readBytes(path.join(destination, 'files', ...file.path.split('/'))).equals(Buffer.from(file.text)), 'ARTIFACT_PAYLOAD_DRIFT');
    return destination;
  }
  function status() {
    guard();
    const directoryEntries = fs.readdirSync(directory);
    const entries = directoryEntries.filter(name => name.startsWith('transition-')).sort();
    fail(entries.length <= 128, 'TRANSITION_LIMIT');
    let head = null;
    let active = structuredClone(policy.baseline);
    let activeDirectory = null;
    const committedArtifacts = new Set();
    for (let index = 0; index < entries.length; index++) {
      const id = String(index + 1).padStart(6, '0');
      fail(entries[index] === `transition-${id}.json`, 'TRANSITION_SEQUENCE_GAP');
      const ref = { kind: 'transition', id, sha256: sha256(readBytes(path.join(directory, entries[index]))) };
      const record = load(ref);
      const p = record.payload;
      keys(p, ['action', 'previousHead', 'previousBundle', 'activeBundle', 'artifact', 'source', 'authorization']);
      fail(['apply', 'revoke', 'restore'].includes(p.action), 'TRANSITION_ACTION');
      fail(same(p.previousHead, head) && same(p.previousBundle, active), 'TRANSITION_PARENT_DRIFT');
      bundle(p.activeBundle);
      fail(same(record.links, [...(head ? [head] : []), p.source]), 'TRANSITION_LINKS');
      activeDirectory = verifyArtifact(p.artifact, p.activeBundle, { policySha256: policyHash, action: p.action, source: p.source, previousHead: p.previousHead });
      committedArtifacts.add(p.artifact.directory);
      active = p.activeBundle; head = ref;
    }
    const projection = installerProjection(active);
    const installerReadiness = activeDirectory ? projection.status === 'READY' ? { status: 'READY' } : projection : { status: 'NOT_READY', reason: 'NOT_MATERIALIZED' };
    return { head, generation: entries.length, active: structuredClone(active), activeSha256: digest(active), activeDirectory,
      installerDirectory: activeDirectory && projection.status === 'READY' ? path.join(activeDirectory, 'files') : null,
      installerReadiness, operationLockPresent: directoryEntries.includes('operation.lock'),
      uncommittedArtifacts: directoryEntries.filter(name => name.startsWith('artifact-') && !committedArtifacts.has(name)),
      provenance: policy.provenance, independentSemanticReview: false, publicationAuthorized: false };
  }
  function transition(action, source, expectedHead, authorization) {
    reference(source, action === 'apply' ? 'decision' : 'transition');
    if (expectedHead !== null) reference(expectedHead, 'transition');
    const subject = { action, source, expectedHead };
    const permission = authorize(action, subject, authorization);
    return locked(() => {
      const before = status();
      fail(same(before.head, expectedHead), 'HEAD_DRIFT');
      fail(before.generation < 128, 'TRANSITION_LIMIT');
      const record = load(source);
      let active;
      if (action === 'apply') {
        const { candidateRecord, actual } = verifiedDecision(source);
        fail(actual.status === 'ACCEPT', 'DECISION_NOT_ACCEPTED');
        fail(digest(candidateRecord.payload.baseline) === before.activeSha256, 'BASELINE_DRIFT');
        active = candidateRecord.payload.candidate;
      } else {
        fail(same(source, before.head), 'REVERSAL_REQUIRES_CURRENT_HEAD');
        if (action === 'revoke') {
          fail(['apply', 'restore'].includes(record.payload.action), 'NOT_REVOCABLE');
          active = record.payload.previousBundle;
        } else {
          fail(record.payload.action === 'revoke', 'NOT_RESTORABLE');
          active = record.payload.previousBundle;
        }
      }
      bundle(active);
      const trace = { policySha256: policyHash, action, source, previousHead: before.head };
      const artifact = materialize(active, trace);
      verifyArtifact(artifact, active, trace);
      fail(same(status().head, before.head), 'HEAD_DRIFT');
      const id = String(before.generation + 1).padStart(6, '0');
      const ref = save('transition', id, [...(before.head ? [before.head] : []), source], {
        action, previousHead: before.head, previousBundle: before.active, activeBundle: active,
        artifact, source, authorization: permission
      });
      const after = status();
      fail(same(after.head, ref), 'TRANSITION_READBACK');
      return { reference: ref, activeDirectory: after.activeDirectory, manifest: path.join(after.activeDirectory, 'payload-manifest.json'), activeSha256: after.activeSha256,
        installerDirectory: after.installerDirectory, installerReadiness: after.installerReadiness };
    });
  }

  return Object.freeze({
    receive(input, authorization) {
      data(input, 24 * 1024); keys(input, ['id', 'subject', 'text', 'deidentified']); identifier(input.id); text(input.text, 16 * 1024);
      keys(input.subject, ['id', 'version', 'bundleSha256']); identifier(input.subject.id); text(input.subject.version, 80); hash(input.subject.bundleSha256);
      fail(input.deidentified === true, 'MINIMIZED_FEEDBACK_REQUIRED');
      const permission = authorize('receive', input, authorization);
      const current = status();
      fail(same(input.subject, { id: current.active.id, version: current.active.version, bundleSha256: current.activeSha256 }), 'FEEDBACK_VERSION_MISMATCH');
      return save('feedback', input.id, [], { input, authorization: permission, disposition: 'QUARANTINED_DATA_ONLY', executionAuthorized: false, privacyIndependentlyVerified: false, defaultPublic: false });
    },
    propose(feedbackRef, input, authorization) {
      reference(feedbackRef, 'feedback'); const feedback = load(feedbackRef);
      data(input); keys(input, ['id', 'baselineSha256', 'candidate', 'summary']); identifier(input.id); hash(input.baselineSha256); bundle(input.candidate); text(input.summary);
      const permission = authorize('propose', { feedbackRef, input }, authorization);
      const current = status();
      fail(current.activeSha256 === input.baselineSha256, 'BASELINE_DRIFT');
      fail(feedback.payload.input.subject.bundleSha256 === input.baselineSha256, 'FEEDBACK_BASELINE_MISMATCH');
      fail(current.active.id === input.candidate.id && current.active.version !== input.candidate.version, 'DISTINCT_CANDIDATE_VERSION_REQUIRED');
      fail(!same(current.active.files, input.candidate.files), 'NO_CANDIDATE_CONTENT_CHANGE');
      return locked(() => {
        fail(status().activeSha256 === input.baselineSha256, 'BASELINE_DRIFT');
        assertVersionAvailable(input.candidate);
        return save('candidate', input.id, [feedbackRef], { baseline: current.active, candidate: input.candidate, summary: input.summary, authorization: permission, generatedAutomatically: false });
      });
    },
    plan(candidateRef, input, authorization) {
      reference(candidateRef, 'candidate'); const candidateRecord = load(candidateRef);
      data(input); keys(input, ['id', 'checks']); identifier(input.id);
      const plan = { checks: input.checks };
      validatePlan(plan);
      const permission = authorize('plan', { candidateRef, input }, authorization);
      return save('plan', input.id, [candidateRef], { plan, authorization: permission, fixedBeforeEvaluation: true, executionMode: 'BUILTIN_CONTENT_CHECKS_NO_PROCESS_OR_NETWORK', timeIndependentlyVerified: false });
    },
    evaluate(planRef, id) {
      reference(planRef, 'plan'); identifier(id);
      const plan = load(planRef); const candidateRecord = load(plan.links[0]);
      fail(plan.links[0].kind === 'candidate' && plan.payload.fixedBeforeEvaluation === true, 'PLAN_CHAIN');
      const result = checkCandidate(plan.payload.plan, candidateRecord.payload.baseline, candidateRecord.payload.candidate);
      return save('decision', id, [planRef], { result, planSha256: planRef.sha256, baselineSha256: digest(candidateRecord.payload.baseline), candidateSha256: digest(candidateRecord.payload.candidate), provenance: policy.provenance });
    },
    apply: (ref, head, auth) => transition('apply', ref, head, auth),
    revoke: (ref, head, auth) => transition('revoke', ref, head, auth),
    restore: (ref, head, auth) => transition('restore', ref, head, auth),
    exportSummary(decisionRef, authorization) {
      reference(decisionRef, 'decision');
      authorize('export-summary', { decisionRef }, authorization);
      const { actual: result } = verifiedDecision(decisionRef);
      return { schema: 'hade-feedback-public-summary/1', provenance: policy.provenance, status: result.status, scope: result.scope,
        checkTypes: [...new Set(result.observations.map(item => item.type))].sort(),
        counts: { checks: result.observations.length, failed: result.failures.length, insufficient: result.missing.length, improved: result.improvements.length },
        containsRawFeedback: false, containsLocalPaths: false, containsUserIdentifiers: false,
        independentSemanticReview: false, naturalBehaviorImprovement: false, uploaded: false };
    },
    status, verify: ref => ref?.kind === 'decision' ? verifiedDecision(ref).record : load(ref)
  });
}
