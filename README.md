# dsh-delete-turn

**DeepSeek Harness 消息删除插件 —— 把一条消息从模型上下文里真正拿掉，同时从当前转录里隐藏它。** 助手回复挂在官方 `conversation.chat.assistant-actions` 槽位；用户消息、注入上下文与工具调用卡由 DOM 增强补上入口。确认后经官方 surface-replace 契约追加替换事件：模型后续看到的历史里不再有这条内容，而原始会话日志一个字节都不改写。

[中文](#中文) · [English](#english)

---

## 中文

<div align="center">
  <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-turn/main/docs/screenshots/01-row-action.png" alt="用户消息行上的删除按钮" width="820" />
  <br>
  <sub>▲ 悬停消息行时出现的删除按钮（复制按钮右侧）</sub>
</div>

### 为什么需要它

DSH 的会话日志是 append-only 的：说错话、发错提示词、模型答偏了，这些内容会一直留在模型上下文里，污染后续每一轮。官方只提供了「压缩」（`/compact`）这种整段摘要机制，没有单条消息级别的删除。

这个插件把删除放回消息本身：

- 用户消息 → 删这一条；
- 思考卡 / 工具调用卡 → 删这一步（该步的 `assistant/message` 与它请求的 `tool/result` 一起走，工具配对永不悬空）；
- 助手回复（官方操作条）→ 删这条回复连同它的思考、工具调用与注入上下文（你的提问保留）；
- 用户消息行 → 还有第二个入口：**删掉这一整轮（含提问、注入上下文与全部回复）**；
- 注入上下文行、失败回合行 → 同样有删除入口。

### 特性

- **模型上下文级删除** —— 追加一条官方 `surfaceOp: { op: 'replace', startSeq, endSeq }` 替换事件，被遮蔽的内容不再进入 `deriveMessages()`；与宿主 `/compact` 同一套官方契约
- **整轮删除（新）** —— 删掉一轮（**含你的提问**、注入上下文、全部回复与工具结果）：一次普通的范围替换落地，后面的轮次原地保留、连编号都不变——不重放、不重编号、日志只多一条事件
- **转录级隐藏** —— 客户端按 `data-chat-flow-*` 锚点与官方 `useChat` 快照定位行，删除后折叠退场；刷新、重启 DSH、换标签页后依旧隐藏
- **日志即台账** —— 隐藏依据直接从日志里的替换事件重建（替换事件的消息 source 标记为本插件），不依赖 localStorage、不需要预检，也不会和其它插件（如压缩）的替换混淆
- **原生视觉** —— 复用官方 primitives 的 Modal / Button 与主题 token，明暗主题自动适配；图标与全部文案为原创
- **中英双语** —— 弹窗、提示、错误原因随系统语言即时切换
- **安全边界** —— 只接受回环地址且 Host 为本机的请求；目标必须是当前 surface 节点、不能碰系统提示词头、回合进行中拒绝、已被删除的目标拒绝并给出机器原因码

### 截图

<div align="center">
  <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-turn/main/docs/screenshots/02-confirm.png" alt="删除确认弹窗" width="560" />
  <br>
  <sub>▲ 删除前确认：说明影响范围，原始日志不改写</sub>
  <br><br>
  <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-turn/main/docs/screenshots/03-after-delete.png" alt="删除后该行消失" width="820" />
  <br>
  <sub>▲ 删除后：该行从转录中消失，后续内容自然上移</sub>
</div>

### 安装

```sh
# npm 安装（web profile）
dsh plugin --profile web add dsh-delete-turn

# 本地工作区（开发）
dsh plugin --profile web add link:/path/to/dsh-delete-turn
```

安装后需要**完全重启 DSH 进程**（宿主侧插件树只在启动时读取）。浏览器端 bundle 由宿主按请求动态 serve，重启后**硬刷新**页面即可生效。核实是否加载：

```sh
dsh --profile web --dump-config   # 应出现 "# == dsh-delete-turn" 段落
```

### 使用

1. 悬停任意消息行，点击行尾的垃圾桶按钮；助手回复的按钮在官方操作条（复制 / 分叉旁边）。
2. 确认弹窗会说明这次删除的影响范围，点「删除」。用户消息行上还有一个「删除这一轮」入口：它删的是**整轮**（含你的提问、注入上下文与全部回复），后面的轮次原地保留、直接接上。
3. 目标行折叠退场；模型上下文在**下一轮请求**重建时不再包含它。

### 工作原理

```
UI（官方槽按钮 / DOM 增强按钮）
  → 确认弹窗
  → POST /dsh-delete-turn/delete { sessionId, mode, seq? / messageId? / turn? }
宿主：
  sessionQuery.readSession() 读完整日志（live 优先）
  自实现 surface fold → 当前 surface 节点 + 历史替换遮蔽集
  校验（当前节点 / 区间干净 / 回合已闭合 / 不碰系统头）
  session.append('user/message', 短标记占位, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [被遮蔽的全部 seq],
  })
  等待官方 session/flush 持久化检查点
  → 返回 { hidden: [{ seq, mode }] }
客户端：
  useChat 快照把 data-chat-flow-key 映射到节点，按 hidden 集合折叠行
  GET /dsh-delete-turn/state 在每次打开会话时重建 hidden 集合

整轮删除（mode: 'turn'）：
  一次普通的 surface-replace：窗口 = 这一轮的全部表面节点
  （提问 + 注入上下文 + 每个 step 的 assistant/message 与 tool/result）
  落一条 turn-less 载体，后面的轮次原地保留、编号不变
  —— 不重放、不重编号、不碰代理循环，日志只多一条事件
```

设计要点：

- **为什么载体是 turn-less 的零宽空格 user 消息（绝不能开合成回合）**：删除的替换载体只能是**不带回合的 `user/message`**。开一个「合成 turn+step」来安放对模型隐身的空 `system/message` 会**损坏日志**：agent loop 只从它自己开的回合推进回合号，外部开掉的回合号会被它的下一个真实回合复用（冷读报 `turn/start does not open the expected turn`），而任何按回合号做隐藏的客户端都会把被复用的那个真实回合整轮吞掉——此故障已在真实会话里复现（消息「被吞掉」）。因此载体退回 turn-less 形状，内容用**单个零宽空格**（空内容数组会被网关 400 `user message must have content`，可读标记会被模型复述；零宽空格对校验器非空、对模型无字面文本）。代价：模型可能把这条载体读成一条空白 user 消息。历史日志里已经写入的簿记回合（旧版本产生）由客户端按 `/state` 的 `markerTurns` 隐藏。
- **为什么不读 React fiber / CSS 哈希类名**：行定位只用官方 `data-chat-flow-*` 锚点与官方 `useChat` 标准 hook，宿主 UI 重构不会静默失效。
- **为什么刷新后仍然隐藏**：隐藏台账不是浏览器本地状态，而是日志里替换事件的可重放推导；宿主 `/state` 路由在每次打开会话时重建它。
- **整轮删除不重放、不重编号**：只遮蔽这一轮自己的表面节点，后面的轮次一条不动——日志的轮号、后续轮的内容、它们对其他事件的引用都不受影响，也不需要任何跨轮操作。
- **广告即承诺**：`/state` 报出 `turnSeqs`（现在哪些行可以整轮删除），它由**路由规划用的同一个函数**算出（`turnableSeqs` 对每个候选调用 `planRange`），所以界面上的入口不会变成一次注定被拒的点击。

### 已知限制

- append-only 语义下没有「反删除」：被遮蔽的内容无法真正恢复，删除不可撤销（原始日志仍在，可用官方工具自行重建会话）。
- 回合进行中删除会**先停止当前生成**：走官方 `sessionController.cancel`（等价于你按停止键，且保留排队的输入），等这一轮真正收尾（`turn/end` 落地）后再删；停止超时（默认 15 秒）、停止被拒、或正在压缩（压缩没有"停止"语义）时仍会拒绝并给出原因。
- 系统提示词头（surface 节点 0）不可删除。
- 助手操作条的删除范围是**整条回复**；要只删某一步，请用思考卡 / 工具卡上的按钮。
- 过程行（「已思考」「用时 N 秒」）不单独提供删除入口：它的范围同样是整条回复，与操作条重复，因此只保留操作条那一个。
- 已经被官方压缩（`/compact`）移出模型上下文的内容不再显示删除入口：它已经不在上下文里，转录用意保留；入口只在内容仍可删时才出现。
- **整轮删除也删掉你的提问**：它删的是整轮（提示词 + 注入上下文 + 全部回复步骤）；只删回复请用助手操作条，只删提示词请用用户行上的垃圾桶。
- 这一轮的窗口里如果夹着**别的插件留下的、既不是本插件占位符也不是静默载体的节点**（例如某个可读的注入内容），**不会静默地一并删掉**：第一次请求只回报"还会多删 N 项"，客户端据此弹出**强制确认**（主按钮变成「一并删除」），你再确认一次才会带 `force` 真正执行。系统提示词头（surface 节点 0）本身不可删除；含它的那一轮**可以**整轮删除（头会被排除在窗口外、留在原位）。
- 宿主侧插件树仅在 DSH 启动时加载：安装、更新插件后必须完全重启 DSH。

### 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)（中文 / English）。

### 验证（怎么复现上面的结论）

```sh
cd dsh-delete-turn
npm test                                    # 62 例：纯逻辑 + 宿主路由 + 真实校验器契约 + 客户端 DOM
node tools/verify-real-session.mjs <session.v4.jsonl.zstd> [--turn N]
```

- `npm test` 里的 `test/contract.test.js` 与 `tools/verify-real-session.mjs` 需要**已安装的** `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-session-format-catalog`（插件本身不 import 它们）。解析顺序见 `tools/dsh-modules.mjs`：`DSH_SESSION_DIR` → 本仓库 / 父目录 / 兄弟仓库的 `node_modules` → `~/.npm/_npx/*/node_modules`（npx 安装的 DSH）→ 裸包名。解析不到时测试会**明确失败**（而不是静默跳过），因为那意味着契约没有被验证。
- `tools/verify-real-session.mjs` **不会写它拿到的文件**：它解码日志、跑一次严格冷读、用解出来的事件建一个真实 `Session`，然后对这个会话驱动插件的真实 HTTP 路由，最后再跑一次严格冷读并打印折叠前后的节点序列。拿真实会话试之前先 `cp` 到 `/tmp`（本仓库的验收就是这么做的）。

### 兼容性

- 实测 DSH `0.1.6-alpha.2`、`0.1.7-alpha.2` 与 `0.2.0-rc.1`（web 与 desktop profile，Safari / WebKit 与 Chromium 内核均验证）。
- 会话格式 v3 与 v4 都支持：v4 迁移会把插件 source 展平为 `plugin:dsh-delete-turn`，隐藏台账会同时识别 `{ kind: 'plugin', plugin: ... }` 与 `{ kind: 'plugin:...' }` 两代形状。
- 宿主半区零运行时依赖，全部服务经 cordis ctx 解析；缺少 `sessionQuery` 时回退到 live 会话快照。
- 不修改 DSH 官方源码，不写任何私有事件类型。

### License

MIT

---

## English

<div align="center">
  <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-turn/main/docs/screenshots/01-row-action.png" alt="Delete action on a user message row" width="820" />
  <br>
  <sub>▲ The delete action appears when a message row is hovered</sub>
</div>

### Why

A DSH session log is append-only: a wrong prompt or a bad answer stays in the model context and pollutes every later turn. The only official tool is whole-range compaction (`/compact`); there is no per-message delete.

This plugin puts deletion back on the message itself:

- user message → remove that one message;
- reasoning card / tool card → remove that step (the step's `assistant/message` and the `tool/result` it requested leave together, so tool pairs never dangle);
- assistant reply (official action strip) → remove the whole reply attempt with its reasoning, tool calls and injected context (your prompt stays);
- user message → a second entry: **delete this whole turn (prompt, injected context and every reply step included)**;
- injected-context rows and failed-turn rows get an entry too.

### Features

- **Context-level delete** — appends the official `surfaceOp: { op: 'replace', startSeq, endSeq }` intent; shadowed content no longer reaches `deriveMessages()`. Same contract as `/compact`.
- **Turn delete (new)** — remove one whole turn (**your prompt included**, plus its injected context and every reply step and tool result) as one ordinary range replace: the later turns stay exactly where they are, under their own numbers — no replay, no renumbering, one extra event.
- **Transcript-level hide** — rows are located through official `data-chat-flow-*` anchors and the official `useChat` snapshot, then collapse out. The hide survives a reload, a DSH restart and other tabs.
- **The log is the ledger** — hidden seqs are re-derived from the replacement events themselves (their message source is marked with this plugin), so there is no localStorage sidecar, no preflight, and no confusion with compaction replacements.
- **Native look** — official primitives (Modal / Button) and theme tokens; icon and all copy are original.
- **Bilingual** — zh/en dictionaries follow the active locale.
- **Safety boundary** — loopback-only routes; targets must be current surface nodes, the system-prompt head is protected, a running turn is refused, and already-deleted targets fail with a machine code.

### Screenshots

<div align="center">
  <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-turn/main/docs/screenshots/02-confirm.png" alt="Delete confirmation dialog" width="560" />
  <br>
  <sub>▲ Confirmation states the exact scope; the log is never rewritten</sub>
  <br><br>
  <img src="https://raw.githubusercontent.com/DDDMUC/dsh-delete-turn/main/docs/screenshots/03-after-delete.png" alt="The row is gone after deletion" width="820" />
  <br>
  <sub>▲ After deletion the row is gone from the transcript</sub>
</div>

### Install

```sh
# npm (web profile)
dsh plugin --profile web add dsh-delete-turn

# local workspace (development)
dsh plugin --profile web add link:/path/to/dsh-delete-turn
```

Then **fully restart the DSH process** (the host plugin tree is read at startup only). The browser bundle is served dynamically, so a hard refresh after the restart is enough. Verify:

```sh
dsh --profile web --dump-config   # expect a "# == dsh-delete-turn" section
```

### Usage

1. Hover a message row and click the trash action at its end; the assistant action sits in the official action strip next to copy/branch.
2. The dialog states the exact scope; click Delete. A user row also carries “Delete this turn and close the gap”, which removes the whole turn (prompt included) and replays the turns after it back into place.
3. The row collapses away; the model context stops containing it when the next request is rebuilt.

### How it works

```
UI (official slot action / DOM-enhanced action)
  → confirmation dialog
  → POST /dsh-delete-turn/delete { sessionId, mode, seq? / messageId? / turn? }
Host:
  sessionQuery.readSession() reads the complete log (live-preferred)
  local surface fold → current surface nodes + historical shadowed seqs
  validate (current node / clean window / closed turn / protected head)
  session.append('user/message', short marker placeholder, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [every shadowed seq],
  })
  await the official session/flush durability checkpoint
  → { hidden: [{ seq, mode }] }
Browser:
  useChat snapshot maps data-chat-flow-key to nodes; hidden seqs collapse rows
  GET /dsh-delete-turn/state rebuilds the hidden set on every session open

Turn delete (mode: 'turn'):
  ONE ordinary surface replace over this turn's own surface nodes
  (prompt + injected context + every step's assistant/message and tool/result)
  landing one turn-less carrier; later turns keep their place and their numbers
  - no replay, no renumbering, no loop state touched, one extra event
```

Design notes:

- **Why the carrier is a turn-less zero-width user message (never open a synthetic turn)**: the replacement carrier can only be a **`user/message` with no turn bracket**. Opening a synthetic turn+step to host a model-invisible empty `system/message` **corrupts the log**: the agent loop advances its turn counter only from the turns it opens itself, so its next real turn reuses the number this plugin burned (`turn/start does not open the expected turn` on the next cold read), and any turn-number-keyed client hiding then swallows that reused real turn — reproduced in production as messages “being eaten”. The carrier therefore stays turn-less, with a single **zero-width space**: truly empty content is refused by the gateway with 400 `user message must have content`, and a readable marker gets quoted back by the model; a zero-width space is non-empty for every validator and carries no literal text. The cost: the model may read it as one blank user message. Bookkeeping turns already written to historical logs (older versions) are hidden client-side via `markerTurns` from `/state`.
- **Why no React fiber or CSS-module hashing**: rows are addressed through official `data-chat-flow-*` anchors and the official `useChat` standard hook, so a host UI refactor cannot silently detach the actions.
- **Why a reload stays hidden**: the ledger is not browser state; it is a replay of the replacement events in the log, rebuilt by the host `/state` route.
- **A turn delete neither replays nor renumbers**: it shadows this turn's own surface nodes and nothing else, so the log's numbering, every later turn's content and their references to other events are untouched — and no cross-turn operation is needed.
- **Advertised = accepted**: `/state` publishes `turnSeqs` (the rows that can be turn-deleted right now), computed by the SAME function the route plans with (`turnableSeqs` tries `planRange` on each candidate), so an entry can never become a click that is bound to fail.

### Known limitations

- Append-only semantics offer no un-delete: shadowed content cannot truly be restored, and deletion is irreversible (the original log survives; official tooling can rebuild a session from it).
- Deleting during a running turn **stops the generation first**: it goes through the official `sessionController.cancel` (the same stop the UI's own button uses, keeping the queued inbox), waits for the turn to actually close (`turn/end` landed), and only then deletes. A stop that times out (15 s default), a refused stop, or a running compaction (which has no stop semantics) is still refused with a reason.
- The system-prompt head (surface node 0) is protected.
- The assistant action strip deletes the whole reply attempt; use the reasoning/tool card to remove a single step.
- The process/disclosure row (“Thinking”, “N s”) carries no entry of its own: its scope is the whole reply, which the action strip already covers, so the duplicate was removed.
- Content already removed from the model context by official compaction (`/compact`) no longer offers a delete action: it is not in the context any more and the transcript keeps it on purpose.
- **A turn delete also removes YOUR prompt**: it deletes the whole turn (prompt + injected context + every reply step). To remove only the reply use the assistant action strip; to remove only the prompt use the trash action on the user row.
- If the turn's window holds a node that is neither this plugin's placeholder nor a silent carrier (some readable injected content, say), it is **never retired silently**: the first request only reports how many unrelated nodes it would additionally remove, and the client turns that into a **forced confirmation** (the primary button becomes "Delete all of it"); only a second, `force`-carrying retry removes them. The system-prompt head (surface node 0) itself cannot be deleted; the turn that introduced it **can** be turn-deleted - the head is excluded from the window and stays in place.
- The host plugin tree loads at DSH startup only: fully restart DSH after installing or updating the plugin.

### Verification (how to reproduce the claims above)

```sh
cd dsh-delete-turn
npm test                                    # 62 cases: pure logic + host route + real-validator contract + client DOM
node tools/verify-real-session.mjs <session.v4.jsonl.zstd> [--turn N]
```

- `test/contract.test.js` and `tools/verify-real-session.mjs` need an **installed** `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-session-format-catalog` (the plugin itself never imports them). Lookup order lives in `tools/dsh-modules.mjs`: `DSH_SESSION_DIR` → the repo's / its parent's / the sibling repo's `node_modules` → `~/.npm/_npx/*/node_modules` (an npx-installed DSH) → the bare specifier. When nothing resolves the test **fails loudly** instead of skipping, because that would mean the contract is unverified.
- `tools/verify-real-session.mjs` **never writes the file it is given**: it decodes the log, runs one strict cold read, builds a real `Session` from the decoded events, drives the plugin's actual HTTP route against it, then cold-reads the result again and prints the folded surface before and after. `cp` a real session to `/tmp` first, exactly as this repository's own acceptance run did.

### Changelog

See [CHANGELOG.md](./CHANGELOG.md).

### Compatibility

- Verified against DSH `0.1.6-alpha.2`, `0.1.7-alpha.2` and `0.2.0-rc.1` (web and desktop profiles; WebKit and Chromium engines).
- Both session formats v3 and v4 are supported: the v4 migration flattens plugin sources to `plugin:dsh-delete-turn`, and the hidden ledger recognizes both `{ kind: 'plugin', plugin: ... }` and `{ kind: 'plugin:...' }` shapes.
- The host half has zero runtime dependencies and resolves every service through the cordis context; it falls back to the live session snapshot when `sessionQuery` is absent.
- No DSH source is modified and no private event type is written.

### License

MIT
