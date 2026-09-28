# Installer source review

Scope: this new installer directory only. No private body, credentials, raw conversations, existing research code, evaluation answers or old test paths were copied. Existing public CORE/HOST/template drafts and project §1.20 were read to understand the contract; the implementation and its synthetic fixtures were written anew.

- `installer.mjs`: original Node built-in implementation; MIT eligible under the delegated public-original release decision. No third-party library or borrowed implementation.
- `cli.mjs`: original argument/JSON CLI; MIT eligible. Imports only the adjacent installer.
- `installer.test.mjs`: original synthetic tests and fixture generator; MIT eligible. Uses Node built-ins and invokes only the adjacent CLI with Node. Generated directory paths are local test output, not published source fixtures.
- `README.md`: original operation and limitation documentation; MIT eligible. The AGENTS discovery explanation paraphrases and links official OpenAI documentation; it is not a copied manual.
- `SOURCE-REVIEW.md`: original provenance and distribution-boundary record; MIT eligible.
- `LICENSE`: standard MIT license text. The copyright notice applies only to the reviewed original public files above, not third-party sources, receiver data, or arbitrary input bundles.
- `RESULT.md`: original synthetic verification summary; MIT eligible, but optional internal release evidence rather than a required runtime file.

Generated `synthetic-tests-*` folders and `verification-*.tap` are engineering evidence, not runtime dependencies. They contain invented test instructions; keep them out of the minimal distribution by allowlist. Receiving installations create local configuration and backups which belong to that receiver and must never be swept into a future release.

There is no package-manager dependency. Node.js is an external runtime prerequisite, not bundled or relicensed here. Existing public candidate files are supplied separately by the publisher with their own file-level review and immutable release manifest. This source review does not grant rights to unknown input content.
