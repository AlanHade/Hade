import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical, digest, openFeedbackStore } from './feedback.mjs';
import { syntheticFixture, syntheticInstallerFixture } from './synthetic.mjs';

if (process.argv.length !== 3 || !['--run-synthetic', '--run-synthetic-installer'].includes(process.argv[2])) throw new Error('EXPLICIT_SYNTHETIC_FLAG_REQUIRED');
const home = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(home, 'synthetic-runs', crypto.randomUUID());
fs.mkdirSync(root, { recursive: true });
const fixture = process.argv[2] === '--run-synthetic-installer' ? syntheticInstallerFixture() : syntheticFixture();
const policyFile = path.join(root, 'policy-input.json');
fs.writeFileSync(policyFile, canonical(fixture.policy) + '\n', { flag: 'wx' });
const storePath = path.join(root, 'store');
const events = [];
function run(operation, input, subject) {
  const args = [path.join(home, 'cli.mjs'), operation, '--store', storePath, '--policy', policyFile];
  if (input !== undefined) {
    const inputFile = path.join(root, `${events.length}-${operation}-input.json`);
    fs.writeFileSync(inputFile, canonical(input) + '\n', { flag: 'wx' });
    args.push('--input', inputFile);
  }
  if (subject !== undefined) {
    const authFile = path.join(root, `${events.length}-${operation}-authorization.json`);
    fs.writeFileSync(authFile, canonical(fixture.authorize(subject)) + '\n', { flag: 'wx' });
    args.push('--authorization', authFile);
  }
  const receipt = spawnSync(process.execPath, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 });
  events.push({ operation, exitCode: receipt.status, stderr: receipt.stderr, stdout: receipt.stdout });
  fs.writeFileSync(path.join(root, `event-${events.length}.json`), canonical(events.at(-1)) + '\n', { flag: 'wx' });
  assert.equal(receipt.status, 0, receipt.stderr);
  return JSON.parse(receipt.stdout);
}
const feedbackRef = run('receive', fixture.feedback, fixture.feedback);
const candidateInput = { feedbackRef, input: fixture.proposal };
const candidateRef = run('propose', candidateInput, candidateInput);
const planInput = { candidateRef, input: fixture.plan };
const planRef = run('plan', planInput, planInput);
const decisionRef = run('evaluate', { planRef, id: 'decision-two' });
const store = openFeedbackStore(storePath, fixture.policy);
assert.equal(store.verify(decisionRef).payload.result.status, 'ACCEPT');
assert.equal(store.status().head, null);
const applySubject = { action: 'apply', source: decisionRef, expectedHead: null };
const applied = run('apply', { source: decisionRef, expectedHead: null }, applySubject);
assert.equal(fs.readFileSync(path.join(applied.activeDirectory, 'files', fixture.proposal.candidate.files[0].path), 'utf8'), fixture.proposal.candidate.files[0].text);
const revokeSubject = { action: 'revoke', source: applied.reference, expectedHead: applied.reference };
const revoked = run('revoke', { source: applied.reference, expectedHead: applied.reference }, revokeSubject);
assert.equal(fs.readFileSync(path.join(revoked.activeDirectory, 'files', fixture.policy.baseline.files[0].path), 'utf8'), fixture.policy.baseline.files[0].text);
const restoreSubject = { action: 'restore', source: revoked.reference, expectedHead: revoked.reference };
const restored = run('restore', { source: revoked.reference, expectedHead: revoked.reference }, restoreSubject);
assert.equal(restored.activeSha256, digest(fixture.proposal.candidate));
const summary = run('export-summary', decisionRef, { decisionRef });
const current = run('status');
run('verify', restored.reference);
const receipt = { schema: 'hade-feedback-synthetic-demo/1', root, provenance: 'synthetic-fixture', operations: events.length,
  decision: 'ACCEPT', decisionScope: 'DECLARED_LOCAL_CONTENT_CONSTRAINTS_ONLY', applyReadback: true, revokeReadback: true,
  restoreReadback: true, reopenGeneration: current.generation, summary, installerDirectory: restored.installerDirectory,
  installerReadiness: restored.installerReadiness, realUserFeedback: false, independentSemanticReview: false, hostInstalled: false };
fs.writeFileSync(path.join(root, 'receipt.json'), canonical(receipt) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
