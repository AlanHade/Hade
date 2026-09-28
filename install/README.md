# Public Codex instruction installer

Local, dependency-free Node.js installer. It composes a reviewed public release and recipient-owned configuration into one complete native instruction section. It does not invoke Codex, models, a shell, a network client, or credential/configuration APIs. It is not a Skill loader.

Status: implementation with synthetic engineering tests. Native input, a clean receiving environment, real release lifecycle and natural task behavior must be verified separately. No research admission or independent semantic result is changed by this tool.

The current public package's observed native receiving scope is Windows Codex CLI project-level AGENTS. The `global` API has synthetic filesystem tests, not a completed native-global receiving acceptance. Do not infer global, Desktop-specific, cross-model or other-platform support from the option name. Consult the package-level evidence for the exact tested bytes and remaining limitations.

## Preconditions and scope

- Node.js 24 is the tested runtime; Windows was tested. No npm installation or compilation is required. Other Node/OS combinations are not claimed as tested.
- Every command requires an explicit `--scope project|global` and an existing absolute `--target` directory. Nothing defaults to the current home or current directory.
- For `global`, the operator must select the actual Codex home used by their launch configuration. For `project`, select the directory whose instruction file the intended project run discovers. A scope label does not prove either fact.
- Stop concurrent editors and installers during apply. Preview and repeated hash checks detect observed changes, but this is not an adversarial filesystem lock or OS security boundary. An unrelated writer can still race the final write to an existing file.
- Do not use real personal or business data for lifecycle tests. Preview output and local backups include the recipient's instruction text; do not upload them by default.

At a given discovery level, Codex uses a nonempty `AGENTS.override.md` before `AGENTS.md`; lower project guidance can take precedence over broader guidance. The installer checks the selected directory, not the entire launch-specific instruction chain. These mechanisms are documented in [OpenAI's AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md); they do not prove successful loading here.

The default entry is `AGENTS.md`. A nonempty override blocks installing/updating that base file. Explicit `--entry AGENTS.override.md` can integrate with an existing override; creating an override that would hide a nonempty base is refused. An override introduced after installation is reported, and removal of only this installer's unchanged section remains possible. Nothing renames or disables either user instruction file.

## Release input

The release directory contains four fixed files:

- `CORE.md`: reviewed public core, not a private canonical export.
- `HOST-CODEX.md`: reviewed public host adaptation.
- `RECIPIENT.example.md`: a nonprivate starter configuration.
- `release.json`: schema `hade-public-release/v1`, an opaque fixed `version`, and `files` mapping the three exact filenames above to lowercase SHA-256 digests.

Use the exported `createReleaseManifest({ version, core, host, recipientExample })` to construct the manifest from UTF-8 strings. It returns data; it does not write files. The publisher must review and freeze the release separately. No release content is bundled into this installer source directory.

CORE and HOST must be nonempty. Their combined bytes with the template must be at most 128 KiB; the template and recipient configuration each have a 64 KiB ceiling. Instruction files and snapshots have a 1 MiB hard read ceiling. The default proposed entry ceiling is 32 KiB. `--max-entry-bytes` explicitly changes this local ceiling, not any Codex setting; the actual combined input capacity and complete delivery still need verification. Invalid UTF-8, control characters, reserved installer markers, linked files, linked ancestors and hardlinked input files are refused.

## Preview, then apply

Example paths below are placeholders, not an instruction to install into any real profile. Choose and inspect your own target and release directory first.

```text
node cli.mjs preview --scope project --target "C:/recipient-demo" --action install --bundle "C:/reviewed-release"
node cli.mjs apply --scope project --target "C:/recipient-demo" --action install --bundle "C:/reviewed-release" --approve PREVIEW_SHA256
node cli.mjs status --scope project --target "C:/recipient-demo"
```

Review `beforeText`, `afterText`, both SHA-256 values, byte count, target, scope and release in the preview. Apply requires that preview's `planSha256`, recomputes the plan from the current inputs, and rejects stale approval. Append order is CORE, HOST, then recipient configuration; existing text remains in place. Review instruction conflicts yourself: preserving bytes does not establish semantic compatibility.

Module exports are `preview(options)`, `apply(options, approvedPlanSha256)`, `status(options)` and `createReleaseManifest(...)`. The options are `scope`, `target`, optional `entry`, and for mutations `action`, optional `bundle`, `rollbackTo`, `maxEntryBytes`. Unknown fields/options are rejected. CLI output is JSON; errors have exit code 1. There is no implicit apply, force switch or automatic drift repair.

## Lifecycle and ownership

`install` requires `bundle`; it appends a marked section and creates `.hade-public/RECIPIENT.md` only if absent in an installer-owned directory. Edit that file as the recipient-owned source, not the rendered section in AGENTS. Identical reinstalls are no-ops. A different installed release requires `update`.

`update` requires the new reviewed `bundle`. It changes only the owned section and retains the current recipient configuration. A previously recorded version cannot be reused for different release bytes.

`refresh` recompiles the current CORE/HOST with the recipient's edited configuration. Neither update nor refresh rewrites the configuration source.

`rollback --rollback-to 000001` selects a retained committed receipt containing a release. It restores that release's CORE/HOST, composed with the **current** recipient configuration. It never restores the whole old instruction snapshot. User edits outside the section remain byte-identical, including additions made after upgrade.

`uninstall` removes only the unchanged owned section. Recipient configuration, history, old snapshots and all text outside the section remain. An initially absent instruction file is left as an empty file instead of deleting it; Codex ignores empty guidance. Repeated uninstall is a no-op. Reinstall can reuse the retained recipient source. Missing recipient source or modified owned content blocks mutation for manual reconciliation; there is no silent reset.

For any lifecycle action, use the same `preview` then `apply --approve` pattern with identical options. Supply `bundle` only for install/update and `rollbackTo` only for rollback. Project/global scope and entry are fixed in the state ownership record and cannot be silently switched.

## Records and interrupted operations

`.hade-public/OWNER.json` binds scope and entry. `.hade-public/history/000001/` and later directories retain create-only `before.bin`, `after.bin`, `receipt.json` and `committed.json`. Each commit checksums its receipt; each receipt links to the previous receipt and hashes both snapshots and the owned section. The chain detects ordinary corruption, not an attacker able to rewrite all local records. Snapshots contain local instructions and are not distributable public examples.

Apply takes a cooperative exclusive installer lock. Before writing an existing file it rechecks observed entry/configuration bytes and precedence. Initial creation uses create-only access, so a concurrently created file is not overwritten. An existing file is opened read/write without truncation, its handle identity and prior bytes are checked, then the new bytes are written and synced on the same file object. This avoids replacing the file object or explicitly changing its permissions. The complete previous and proposed bytes are saved before writing. A write failure or power loss can leave a partial entry; it is not an atomic-update or hostile-writer guarantee.

An interrupted transaction without `committed.json` fails closed as `incomplete-transaction:<sequence>`. A stale lock also refuses further writes. This first version deliberately has no automatic recovery command: preserve the folder, inspect the retained snapshots and current user text, and reconcile explicitly. Never copy a whole old snapshot over newer user content. The only normal deletion is the process's own temporary lock, verified by file identity; user files and backups are not deleted.

## Tests and release boundaries

```text
node --test installer.test.mjs
```

Tests create new `synthetic-tests-*` directories beside the test file and retain them. They exercise the real CLI as well as the module; no model or external service is called. They do not install into a real Codex home. The fixtures use invented short text only.

Distribute an explicit allowlist: `installer.mjs`, `cli.mjs`, this README, `SOURCE-REVIEW.md` and `LICENSE`; optionally `installer.test.mjs` for source users. Do not package `synthetic-tests-*`, verification logs, or any receiver's `.hade-public` directory. No tests or disk simulation should be described as native host/behavior acceptance or independent evaluation.

See `SOURCE-REVIEW.md` for per-file origin. The public original installer is MIT licensed; the license does not relicense recipient configuration or arbitrary input bundles.
