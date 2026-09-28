# 本地受控反馈 · 工程模块

这是可独立复制的 Node.js ESM 模块，只使用 Node 内置库。它接收获准的最小化反馈、固定候选版本与检查计划、实际检查内容、生成独立应用产物，并允许明确撤销和恢复。它不调用模型，不联网、不上传，不执行反馈中的指令，不修改宿主配置。

`ACCEPT` 仅表示预先声明的本地内容约束满足，至少一项目标约束由基线 FAIL 变为候选 PASS，且候选全部必需项通过、回归项在基线也通过。它不表示自然协作改善、语义正确、独立研究通过、安装成功或发布许可。示例中的设置变化和句子出现均只是内容约束。

## 分发与启动

可分发文件：`feedback.mjs`、`cli.mjs`、`synthetic.mjs`、`demo.mjs`、`feedback.test.mjs`、本 README、`SOURCE-REVIEW.md`、`LICENSE`。没有包外评测核心或 npm 依赖；无需安装依赖。本模块已在 Windows 与 Node.js 24.14.0 上验证；其他运行时组合尚未实测。下面的测试与演练可在新的本地副本复验，但不代替实际宿主接入或自然行为验收。

不要分发运行时目录 `test-runs/`、`synthetic-runs/`，或实际反馈库。它们是本地证据，不是公开载荷。所有反馈原文默认不公开。

- `node --test feedback.test.mjs`：只在本模块新建 UUID 合成目录，保留结果，不清理历史。
- `node demo.mjs --run-synthetic`：通过实际 CLI 演练通用文本载荷。
- `node demo.mjs --run-synthetic-installer`：通过实际 CLI 演练三份合成文档，输出安装器可消费目录。

两个 demo 均执行接收、候选、计划、判定、应用、撤销、恢复、摘要导出、状态与引用验证十步。只启动固定的本地 Node CLI，不接收 shell 命令。未给显式合成参数时拒绝运行。真实反馈及真实宿主验收不是 demo 的产出。

## API

从 `feedback.mjs` 导入 `openFeedbackStore`、`digest`、`sha256`、`checkCandidate`。`synthetic.mjs` 提供完整合成输入示例。

`openFeedbackStore(absoluteDirectory, policy)` 只接受专用绝对目录；新目录必须为空。policy 包含：

- `schema: hade-engineering-feedback-policy/1`；
- `scopeId` 与来源标记 `provenance`（`synthetic-fixture` 或 `maintainer-local`）；
- `baseline: { id, version, files: [{ path, text }] }`；
- 来自另一可信授权输入的 `authorizationSha256`。

每次重开必须由可信调用方再次提供相同 policy，而不是把库里的自报记录当信任根。`digest` 对严格 JSON 数据排序编码后算 SHA-256；文件哈希则对实际 UTF-8 字节计算，二者不可混用。

授权文档字段为 `schema: hade-local-authorization/1`、`id`、`scopeId`、`provenance`、`basis: explicit-local-user`、`operations`。每次受权操作另传 `{ document, subjectSha256: digest(subject) }`，校验文档固定哈希、用途及本次输入绑定。反馈正文没有授权效力。此机制记录可信本地调用方提供的许可事实，**不验证现实身份、签名、知情同意或去标识充分性**。

返回的 store 提供以下接口（ref 均为 `{ kind, id, sha256 }`）：

- `receive(input, authorization)`：输入 `{ id, subject: { id, version, bundleSha256 }, text, deidentified: true }`；subject 必须对应当前版本。授权 subject 就是 input。原文以 `QUARANTINED_DATA_ONLY` 保存，不解析其中路径或指令。
- `propose(feedbackRef, input, authorization)`：输入 `{ id, baselineSha256, candidate, summary }`；candidate 格式同 baseline，必须是同一载荷身份的不同版本且实际内容改变。授权 subject 为 `{ feedbackRef, input }`。不自动生成候选，也不应用。
- `plan(candidateRef, input, authorization)`：输入 `{ id, checks }`；授权 subject 为 `{ candidateRef, input }`。先以 create-only 固定计划，再允许 evaluate。计划固定的是本次检查前的标准，不是独立盲测或事前因果设计的证明。
- `evaluate(planRef, id)`：重新读哈希绑定的候选/基线，执行内置检查，保存实际观察与 `ACCEPT / REJECT / INSUFFICIENT`；不接收自报 PASS，也不应用。权限来自该固定计划的独立授权。
- `apply(decisionRef, expectedHead, authorization)`：仅接受实际重新计算仍为 ACCEPT、基线仍匹配当前版本的决定。
- `revoke(currentTransitionRef, expectedHead, authorization)`：只撤销当前 apply/restore，回到其前一载荷。
- `restore(currentRevocationRef, expectedHead, authorization)`：只恢复当前撤销前的载荷。不能越过后来新增的版本。
- 三种状态变更的授权 subject 统一为 `{ action, source, expectedHead }`。首次 head 为 `null`。它们生成新代次的完整文件，旧代次和证据均保留。
- `status()`：返回当前 head、版本、实际有效目录、安装适配状态、操作锁存在状态与未提交的产物目录；没有已提交代次时有效目录为空。
- `verify(ref)`：检查固定 policy、记录字节、引用链的内容绑定；不是对记录语义或现实身份的认证。
- `exportSummary(decisionRef, authorization)`：授权 subject 为 `{ decisionRef }`。仅返回固定字段的来源标记、机械结论、检查类型和计数；排除正文、自由摘要、路径、人员/任务标识、版本与哈希。不写外部文件、不上传。调用者自行选择保存或分享。

授权 operations 只允许 `receive/propose/plan/apply/revoke/restore/export-summary`，可以更窄。许可缺失或与主体、版本、用途不符时拒绝。工程来源标记不是独立来源证明；维护者若同时重造 policy 和所有哈希，本模块不能识别其不真实陈述。

## 检查与判定

每条检查固定 `{ id, role, type, path, expected }`。role 为 `improvement` 或 `regression`，两类至少各一条。

- `contains / not-contains`：expected 为非空字串。
- `file-sha256`：expected 为文件 SHA，只允许作回归，不允许单靠候选自带哈希称改善。
- `max-bytes`：expected 为最大 UTF-8 字节数。
- `json-value`：expected 为 `{ keys: [逐级键名], value: JSON基本值 }`，按实际解析值比较。
- `semantic`：expected 描述待判断事项；始终给 UNKNOWN，本模块不提供独立语义验证。

候选任一必需项 FAIL → REJECT；否则存在 UNKNOWN、基线回归未通过或没有实际 FAIL→PASS 的目标差量 → INSUFFICIENT；其余才为限定内容范围的 ACCEPT。数据结构、来源/版本/哈希、未知字段或未知检查类型不合法时抛错；CLI 输出 INVALID 并以非零退出，不混为证据不足。

内容检查只证明字节或 JSON 条件。本模块不运行候选代码，也不能证明加入一句规则真的改变模型行为。机械目标是否足以支持产品结论，仍由可信维护者用实际行为证据判断。

## CLI

所有路径参数必须显式为绝对路径。基本形式为 `node cli.mjs <operation> --store <dir> --policy <json>`；除 status 外还需 `--input <json>`，受权操作还需 `--authorization <json>`。

operation 与 API 对应；CLI input 格式：receive 为原输入，propose 为 `{ feedbackRef, input }`，plan 为 `{ candidateRef, input }`，evaluate 为 `{ planRef, id }`，apply/revoke/restore 为 `{ source, expectedHead }`，verify/export-summary 为 ref。结果只输出 stdout；verify 不回显原始反馈。

## 与原生安装器衔接

应用产物为 `artifact-<UUID>/files/` 和外层 `payload-manifest.json`。外层清单绑定载荷身份、版本、逐文件哈希/大小、来源、policy 哈希、操作来源引用和前一 head；完整证据链仍保留在本地反馈库。

当且仅当载荷文件**恰为** `CORE.md`、`HOST-CODEX.md`、`RECIPIENT.example.md`，且满足安装器版本、UTF-8 文本、保留标记和总大小限制时，files 目录额外生成确定性的 `release.json`：

- `schema: hade-public-release/v1`；
- `version`；
- `files` 为上述三个文件名到实际 UTF-8 SHA-256 的对象。

这与安装器 `createReleaseManifest({ version, core, host, recipientExample })` 的结构及编码一致。返回 `installerDirectory` 可直接作为安装器 preview 的 bundle 参数；主控再独立预览和明确应用。反馈模块不导入、不调用安装器，也不写宿主入口或接收者配置。示例配置不是接收者私人配置。

通用文本载荷、额外文件、非法版本或保留标记仍可作为本地反馈产物，但会返回 `installerDirectory: null` 及明确的 NOT_READY 原因；不默默忽略额外文件。公开四文档包应由主控明确选择这三份安装输入，README 不在安装器载荷契约内。

READY 仅表示格式适配；不表示目标已安装、许可已验证、真实宿主已完整读取或行为通过。撤销本地反馈代次也不会自动撤销已另行安装/发布的副本；宿主撤销须走安装器自己的生命周期。

## 保存与恢复边界

记录、实际产物及代次均 create-only，写入 fsync 并读回；同一版本不能重新绑定不同内容。应用先生成完整文件，再提交代次记录；预期 head 漂移、原产物被修改、额外文件、链接、非普通文件、多硬链接与路径逃逸均拒绝。

不覆盖或删除用户文件；只在正常返回时移除本次进程自己创建且内容仍匹配的短期操作锁。崩溃可能留下锁、未提交产物或不完整记录：status 如实呈现未提交目录/锁，记录损坏时拒绝；不会自动删除锁、清理目录或猜测恢复。保留原件后由维护者查证并另行授权恢复。

限制：这是可信单用户本地文件系统中的内容绑定与并发误操作防护，不是操作系统隔离、签名系统或对抗同用户篡改的安全边界。路径检查与文件打开仍存在同用户竞争窗口，不能向不可信进程开放库写权限；断电时不承诺跨文件原子性。当前每库最多 128 个状态代次，超过明确拒绝；不自动丢弃历史。
