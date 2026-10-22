# 更新日志 / Changelog

本文档按语言分节；每条对应一个版本号。

## 中文

**0.1.14** —— 修复：轮次导航不再被误删，空槽会被补上。

- **静默载体按会话判适配器**：删除载体原来在加载时只看 `dsh-llm-pi-ai` 是否打了 `dsh-delete-turn:skip-empty-user`，所以用 DeepSeek 适配器的宿主也一直写零宽空格 —— 模型能看到它。现在按会话日志里的 `model/selection` 取 provider，再查 `ctx.llm.adapters` 里该 provider 的适配器是否原生丢弃空 user/assistant 消息（DeepSeek 适配器有 `prepareExtensions`，pi-ai 没有），是就用空载体，判不出来仍旧用零宽兜底。
- **误删**：官方「轮次导航」的标记按**它在导轨里的位置**编号（`跳转到第 N 轮` 的 N 是位置，不是日志回合号）。在只加载了后段回合的会话里，「第 1 轮」可能是第 114 回合；旧逻辑把 N 当回合号去匹配 `data-chat-turn`，于是把**存活的**标记当成空回合隐藏 —— 实测出现过「对话视图 10 轮、导航只剩 2 轮」以及长会话导航整条空掉。
- **与对话视图对齐**：导轨给会话里每一轮留一个标记，`跳转到第 N 轮` 的 N 就是真实轮号（之前误当成位置序号，所以会误隐藏）。现在按**行是否可见**判断一轮会不会出现在对话视图：有行且全部隐藏 → 隐藏它的标记；其余标记按序重排并在宿主自己的梯子里居中；**容器高度保持宿主原值**（宿主虚拟化按它测量窗口，改小会让后面的标记被卸载）；完全没有行的轮次（只是没加载）保持不动。
- **测试**：73 全绿。

**0.1.13** —— 两处行为变更：生成中删除会先停止该回合；窗口里夹着别的内容时改为强制确认。

- **生成中删除 = 先停止，再删除。** 以前回合进行中只回一句"请等回复结束"。现在点删除会走官方 `sessionController.cancel`（与你按停止键同一条路，**保留排队的输入**），等这一轮真正收尾（`turn/end` 落地）后再删；默认等待上限 15 秒，超时返回 `stop-timeout` 并提示稍后再试。正在压缩（没有"停止"语义）或停止被拒时仍拒绝并说明原因。
- **窗口里夹着别的内容不再直接拒绝，改为强制询问。** 整轮/回复删除的窗口若还覆盖到"别的插件留下的、**有可读内容**"的节点，第一次请求只回报会多删 N 项（`range-not-clean` + `details.foreign`），客户端据此把确认框切成强制询问（主按钮「一并删除」），你确认后才带 `force` 真正执行。自有占位符与其他插件的静默载体仍免费骑过，不打扰。
- **文档**：更新日志拆到独立的 `CHANGELOG.md`（中英分节），README 保留链接；该文件已加入 `files`，随包发布。
- **测试**：64 → 72 全绿。

**0.1.12** —— 两处修复：整轮删除后失败卡不再残留；系统提示词头的保护规则改为按窗口判断。

- **修复：整轮删除后，回合级的披露行（「处理失败」「已思考」「重试」等）不再留在屏幕上。** 这些行是按「回合」画的、不挂在被遮蔽的节点上，所以删光一轮的内容后它们会变成孤儿。现在：某一回合只要没有可见的内容行，它的披露行（`turn-error` / `model-retry` / `turn-tail` / `turn-process`）一并隐藏。
- **修复：系统提示词头的保护规则改为「窗口不得覆盖 surface 节点 0」。** 宿主每轮都会重写系统提示词头，重写后的头带的是「当前轮号」；旧的「头所在轮不可删」判据会**误拒当前轮**（真实会话上复现：该轮的提问不在 `turnSeqs` 里）。现在头本身仍不可删，但引入它的那一轮可以正常整轮删除（头被排除在窗口外、留在原位）。
- 顺带：README 里测试用的真实会话 id 隐去。

**0.1.11** —— 整轮删除改为单次范围替换（移除 `mode: 'splice'` 的重放实现）。三种原 mode 一个字节未改。

- 入口不变（用户消息行上第二个按钮，文案改为「删除这一轮」），删除只做一次普通的 `replace`：窗口 = 这一轮自己的全部表面节点，后面的轮次原地保留，**不重放、不重编号、不碰代理循环**。
- 「接上后面」过去靠重放后续轮次；现在后续轮本就不动，所以对话视图与模型上下文的结果一致，而日志更小、轮号不再被抬高。
- 移除 `buildSpliceReplayWrites`、`planSplice`、`spliceableSeqs`、`syncLoopTurn` 与响应里的 `spliceId`/`replayTurns`/`sync`；`/state` 的 `spliceSeqs` 更名为 `turnSeqs`（由 `turnableSeqs` 广告，逻辑不变：广告即承诺）。
- 兼容性不变：载体仍是 `plugin:dsh-delete-turn` + 无可读内容，dsh-rerun-turn 仍把它认作「已退役的提问」。

**0.1.9** —— 新动作：整轮删除并接上后面（`mode: 'splice'`）。现有三种 mode 的行为一个字节未改。

- **新动作**：用户消息行上多一个入口（路由新增 `mode: 'splice'`），一次写两类事件：① 一条 turn-less 的替换载体，遮蔽**被删轮的第一个节点 → 当前面最后一个节点**；② 把它之后的每一轮**逐事件重放**成新轮次（新轮号 = 日志的 `nextTurn`、新消息 id、`sourceEventSeqs` 重映射到副本、丢弃 `usage`/内嵌 stream、工具调用只成对复制、`TOOL_NOT_STARTED` 修复保持精确形状、系统消息与纯记账事件不复制）。重放实现与 `dsh-rerun-turn` 的 `buildReplayWrites` 等价（本仓库独立：是抄写，不是跨包 import），另加「丢掉只装系统消息的空步骤、保留步骤重新连续编号」。
- **循环计数器**：重放写完的同一 tick 里把代理循环的空闲轮号计数器同步到日志的真实最大轮号（与 `dsh-rerun-turn` 的 `syncLoopTurn` 等价）。不做这一步，循环的下一次提问会复用重放占用的号，日志随后冷读失败。
- **对话视图的验收**：用平台自己的折叠算（`session.surface.nodes` + `deriveEventMessage`）—— 折叠后是 A + 载体 + C′ + D′，载体是折叠里唯一多出来的空节点（客户端按 `hiddenVia` 隐藏它那一行），所以画出来就是 A、C′、D′。真实会话（11 072 事件 / 180 轮，会话 id 从略）上实测：删除第 178 轮 → 原 179/180 的节点全部退场、重放成 181/182，`session.surface.nodes` 437 → 436，节点的可见文本多重集**只少了被删那一轮的 2 行**（290 行逐一比对，无重复、无缺口）。
- **只用真实校验器验收**：新增 `test/contract.test.js`（3 例，需要已安装的 `@deepseek-ai/dsh-session` / `-format-catalog`，解析见 `tools/dsh-modules.mjs`）与 `tools/verify-real-session.mjs`（对真实会话跑一次，可重复）。两者都用平台的 `sessionFormatCatalog.createRestore` **严格冷读**证明整份日志（含重放、以及之后循环自己开的新轮）仍然合法；两条负向控制：只遮蔽被删的那一轮 → 折叠后 C、D 各出现两次（校验器看不出来，由断言抓住）；重放沿用原轮号 → 冷读拒绝 `turn/start does not open the expected turn`。
- **广告即承诺**：`/state` 新增 `spliceSeqs`，客户端只在被广告的行上显示入口；真实会话上 62 条广告 100% 可规划。
- **测试**：38 → 62 全绿（纯逻辑 11、宿主路由 4、真实校验器 3、客户端 DOM 6）。

**0.1.7** —— 重新 apply 时清理自己的注入节点（互操作契约 I3）。只修 Bug，交互语义不变。

- **修复：插件被重新 apply（HMR / 插件开关 / bundle 组重载）时不再堆出幽灵按钮**。每次 apply 都是新的模块实例、新的 `WeakMap`，而上一次 apply 注入的宿主还留在行里，于是同一条行上叠出多个删除按钮——真机 CDP 只读探针曾在同一行数到 3 个 `.dshdt-action-host`。现在：①注入前先按命名空间属性 `[data-dshdt-action-host="1"]` 查一次已有宿主，找到就**复用同一个节点**（不 remove + re-insert），上一版留下、还没有属性的旧节点按 `.dshdt-action-host` 兜底认领并补上属性；②行内宿主与思考卡宿主分别用 `data-dshdt-action-host` / `data-dshdt-think-action` 认领，行不会把思考卡里的步骤按钮抢走；③`ctx.effect` 的清理函数里按命名空间属性**全局扫掉**本插件注入的宿主（槽根节点也带上了命名空间标记），只删自己的节点，宿主的按钮与兄弟插件的节点一律不动。新增 4 条 `test/client.test.js` 用例覆盖「apply → dispose → 再 apply」与两个实例同时在场的时序。

**0.1.6** —— 隐藏归因（互操作契约 I4）。只修 Bug，交互语义不变。

- **修复：兄弟插件隐藏的行，本插件不再替它显示出来**。旧的「恢复可见」分支无条件把 `row.style.display` 清成 `''`——那一行若正被 **dsh-edit-turn**（`data-dshet-hidden`）或 **dsh-rerun-turn**（`data-dsrr-hidden`）按归属属性隐藏着，本插件一恢复就把别人的隐藏一并抹掉（行「复活」）。现在按契约 §4 在本地拷入 `foreignHideOn(row,'dshdt')`：交还自己那份归属属性与折叠样式之前先确认没有别的归属属性，有则**保持 `display:none`**，等对方自己解除；轮次导航标记同理，别人声明隐藏的回合不再留下跳转点。新增 `test/client.test.js`（用 DOM stub 加载真实 client bundle，8 例）。

## English

**0.1.14** — fix: the turn-navigation marks are no longer removed by mistake.

- **The bug**: the official rail numbers its marks by **position** in the rail (`跳转到第 N 轮`), not by the log's turn number. In a session whose loaded window starts later, "第 1 轮" can be turn 114; the old logic matched that number against `data-chat-turn` and hid **live** marks as if their turn were empty - observed as a ten-turn transcript left with two marks, and a long session with a blank rail.
- **Now**: the mapping is positional (k-th mark <-> k-th loaded turn), and only applied when the rail and the loaded rows cover the same number of turns; otherwise the rail is handed back to the host untouched.
- **Tests**: 72 -> 73 green.

**0.1.14** — fix: rail marks are no longer removed by mistake, and empty slots are closed.

- **The wrong hiding**: the rail numbers its marks by **position** (`跳转到第 N 轮`), not by the log's turn number; in a windowed session "第 1 轮" can be turn 114. The old logic matched that number against `data-chat-turn` and hid **live** marks - observed as a ten-turn transcript left with two marks, and a blank rail in long sessions.
- **Aligned with the view**: the rail keeps one mark per turn and the number in `跳转到第 N 轮` is the real turn (the old code read it as a position, which hid live marks). A turn is "in the view" when it has at least one visible row: turns whose rows are all hidden lose their mark and the remaining marks are re-spaced, centred inside the host's own ladder; the container keeps the host's height (its virtualisation measures that height, so shrinking it unmounts the marks past the new window); a turn with no row at all is merely unloaded and keeps its mark.
- **Tests**: 72 green.

**0.1.13** — two behaviour changes: deleting during a running turn now stops that turn first; a window that covers someone else's content now asks for a forced confirmation instead of refusing.

- **Deleting during a running turn stops it first.** It goes through the official `sessionController.cancel` (the same path the UI's own stop button uses, **queued inbox preserved**), waits for the turn to actually close (`turn/end` landed), and only then deletes. The wait is bounded (15 s default) and reports `stop-timeout`; a running compaction (which has no stop semantics) or a refused stop is still reported with a reason.
- **A window that also covers someone else's readable content is no longer refused outright - it asks.** The first request only reports how many extra nodes it would remove (`range-not-clean` + `details.foreign`); the client turns that into a forced confirmation (primary button "Delete all of it") that re-submits with `force`. Own placeholders and other plugins' silent carriers still ride along for free.
- **Docs**: the changelog moved to its own `CHANGELOG.md` (zh/en sections), linked from the README and shipped in the package (`files`).
- **Tests**: 64 → 72.

**0.1.12** — two fixes — (1) turn-level disclosure rows (failure card, process disclosure, retry notice, turn tail) are now hidden once their turn has no visible content row left; they are drawn per turn, not per surface node, so a whole-turn delete used to leave them orphaned; (2) the system-prompt-head guard is now window-based ("the window may never cover surface node 0") — the host rewrites the head every turn and the rewritten head carries the current turn number, so the old "the head's turn cannot be deleted" test falsely refused that turn on real sessions. The head itself stays undeletable; the turn that introduced it is deletable. Also: the real session id in the README is withheld.

**0.1.11** — the whole-turn delete is now a single ordinary range replace (`mode: 'turn'`): window = the turn's own surface nodes, one turn-less carrier, later turns untouched — no replay, no renumbering, no loop counter. `buildSpliceReplayWrites` / `planSplice` / `spliceableSeqs` / `syncLoopTurn` are gone; `/state` advertises `turnSeqs`. Carrier interop with dsh-rerun-turn is unchanged.

**0.1.9** — a new action, `mode: 'splice'` — delete one whole turn (prompt included) and replay every later turn back as fresh events under new consecutive turn numbers. Two writes: one turn-less replacement carrier over the window "the deleted turn's first node → the last surface node", then event-by-event replays of the tail (fresh turn numbers from the log's `nextTurn`, fresh ids, `sourceEventSeqs` remapped onto the copies, `usage`/streams dropped, tool calls copied only as complete pairs, `TOOL_NOT_STARTED` repairs kept exact, system messages and log-only records skipped). The replay is a copy of dsh-rerun-turn's `buildReplayWrites` (the repos are independent), plus dropping steps that held nothing but a system message and renumbering the rest. In the same tick as the last write the agent loop's idle turn counter is re-pointed at the log's true last turn (`syncLoopTurn`, equivalent to the sibling's), without which the loop's next prompt would collide and the log would stop passing its cold read. Acceptance is measured on the platform's OWN fold (`session.surface.nodes` + `deriveEventMessage`): A + carrier + C′ + D′, where the carrier is the one extra node the fold adds and the client hides its row via `hiddenVia` — so the transcript draws A, C′, D′. Verified on a real session (11 072 events / 180 turns; the id is withheld): deleting turn 178 retires the old 179/180 nodes, replays them as 181/182, and moves `session.surface.nodes` from 437 to 436 while the visible-text multiset loses exactly the deleted turn's two rows (290 rows compared, no duplicate and no gap). The strict cold read (`sessionFormatCatalog.createRestore`) accepts the whole log plus the loop's next turn, and two negative controls are asserted: shadowing only the deleted turn duplicates C and D (the validator cannot see it — the assertion catches it), while a replay that reuses the original turn numbers is refused with `turn/start does not open the expected turn`. `/state` now advertises `spliceSeqs`, computed by the same window check the route plans with, so the UI entry cannot become a doomed click (62 advertised rows on the real session, 0 unplannable). The three original modes are untouched; 38 → 62 tests.

**0.1.7** — re-applying the bundle (HMR, plugin toggle, group reload) no longer stacks ghost buttons — every injected host carries `data-dshdt-action-host="1"` (a reasoning host additionally `data-dshdt-think-action="1"`), an injection adopts the host a previous apply left in the row instead of adding a second one, and the `ctx.effect` teardown sweeps every node this plugin injected, matched by its own namespace, while host and sibling nodes are left alone. 4 new `test/client.test.js` cases cover apply → dispose → apply.

**0.1.6** — rows another plugin is keeping hidden are no longer revealed by this plugin's restore pass — a local `foreignHideOn(row, 'dshdt')` (contract §4) leaves `display:none` in force while `data-dshet-hidden` / `data-dsrr-hidden` is present, so a sibling's hide survives until the sibling lifts it; the turn-navigation rail no longer keeps a jump mark for a turn another plugin declared hidden. New `test/client.test.js` loads the real client bundle against a DOM stub (8 cases).
