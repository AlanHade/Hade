import { preview, apply, status } from './installer.mjs';

const usage = 'node cli.mjs preview|apply|status --scope project|global --target ABSOLUTE_DIRECTORY [--entry AGENTS.md|AGENTS.override.md] [--action install|update|refresh|rollback|uninstall] [--bundle ABSOLUTE_RELEASE_DIRECTORY] [--rollback-to 000001] [--max-entry-bytes 32768] [--approve PREVIEW_SHA256]';
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help') {
    process.stdout.write(usage + '\n');
  } else {
    if (!['preview', 'apply', 'status'].includes(command) || args.length % 2 !== 0) throw new Error(usage);
    const names = { '--scope': 'scope', '--target': 'target', '--entry': 'entry', '--action': 'action', '--bundle': 'bundle', '--rollback-to': 'rollbackTo', '--max-entry-bytes': 'maxEntryBytes', '--approve': 'approve' };
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const name = names[args[i]];
      if (!name || Object.hasOwn(options, name) || args[i + 1].startsWith('--')) throw new Error('invalid-or-duplicate-option');
      options[name] = name === 'maxEntryBytes' ? Number(args[i + 1]) : args[i + 1];
    }
    const { approve, ...operation } = options;
    if (command !== 'apply' && approve !== undefined) throw new Error('approval-only-for-apply');
    if (command === 'status' && ['action', 'bundle', 'rollbackTo'].some((key) => Object.hasOwn(operation, key))) throw new Error('status-options-conflict');
    const result = command === 'preview' ? preview(operation) : command === 'apply' ? apply(operation, approve) : status(operation);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
}
