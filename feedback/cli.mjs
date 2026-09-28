import path from 'node:path';
import { openFeedbackStore, readJson } from './feedback.mjs';

try {
  const [operation, ...args] = process.argv.slice(2);
  const accepted = ['receive', 'propose', 'plan', 'evaluate', 'apply', 'revoke', 'restore', 'status', 'verify', 'export-summary'];
  if (!accepted.includes(operation)) throw new Error('OPERATION_REQUIRED');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--store', '--policy', '--input', '--authorization'].includes(key) || !args[index + 1] || Object.hasOwn(options, key)) throw new Error('INVALID_ARGUMENTS');
    options[key] = args[index + 1];
  }
  const authorized = ['receive', 'propose', 'plan', 'apply', 'revoke', 'restore', 'export-summary'].includes(operation);
  const needed = ['--store', '--policy', ...(operation !== 'status' ? ['--input'] : []), ...(authorized ? ['--authorization'] : [])];
  if (Object.keys(options).length !== needed.length || !needed.every(key => options[key] && path.isAbsolute(options[key]))) throw new Error('EXPLICIT_ABSOLUTE_PATHS_REQUIRED');
  const policy = readJson(options['--policy']);
  const input = options['--input'] ? readJson(options['--input']) : null;
  const auth = options['--authorization'] ? readJson(options['--authorization']) : null;
  const store = openFeedbackStore(options['--store'], policy);
  let result;
  if (operation === 'receive') result = store.receive(input, auth);
  if (operation === 'propose') result = store.propose(input.feedbackRef, input.input, auth);
  if (operation === 'plan') result = store.plan(input.candidateRef, input.input, auth);
  if (operation === 'evaluate') result = store.evaluate(input.planRef, input.id);
  if (['apply', 'revoke', 'restore'].includes(operation)) result = store[operation](input.source, input.expectedHead, auth);
  if (operation === 'export-summary') result = store.exportSummary(input, auth);
  if (operation === 'verify') { store.verify(input); result = { verified: true, reference: input }; }
  if (operation === 'status') {
    const current = store.status();
    result = { ...current, active: { id: current.active.id, version: current.active.version } };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'INVALID', error: error.code || error.message }) + '\n');
  process.exitCode = 1;
}
