# Agent Note: Web token 用量读数

Status: implemented

[English](2026-09-20-web-token-usage-readout.md) | 中文

## 问题

Web GUI 的 composer 统计行把一个对话的 token 用量报成一颗总量药丸加一个缓存命中占比；四个互不相交的计费桶只藏在那颗药丸的弹层里，想要分类读数的人必须点开。整个 harness 里没有任何金额数字，而终端前端早已在自己的 footer 里显示会话花费估算。一个 Web 读者想要回答「这段对话花了多少、由什么构成」，找不到能同时满足的地方。

## 决定

**独立的、可移除的插件。** `@deepseek-ai/dsh-client-ui-token-usage` 是一个纯 UI 插件——node 半边是空的 `apply()`，只为让该行出现在 Loader 里；浏览器半边在 `conversation.composer.dock` 上注册一个条目（`id: 'token-usage'`，order 10，排在 chat 统计药丸之后）。web-app bundle 用它自己的一行挂载它，因此删掉那一行就能移除读数，完全不必碰 `ui-chat`。

**按对话计数来自持久投影。** 该条目读取 `useProjection('tokenUsage')`，它的四个桶互不相交、折叠整条持久日志，所以分页与压缩都不会改变它们；slot 的 `scope: 'session'` 才是让计数按对话独立的原因。该行以会话合计开头，随后渲染未缓存输入、输出，以及任何非零的缓存桶，使用紧凑计数（517 / 12.3K / 1.2M），并在计量器同时给出分子与最新容量时以上下文占用（`projectedTokens` 优先于 `pressureTokens`）收尾；为零的缓存桶会被省略，因为它们不含信息、只会把行拉宽。无障碍标签会点名全部四个桶，包括为零的。

**花费是配置出来的估算，不是账单。** 该条目把会话的 `modelSelection` 投影（优先 `lastUsed`，即计费用量的来源路由，而非 `next`）与本插件的 `pricing` 配置做匹配：以「元/百万 tokens」计、按模型 id 前缀为键，最长匹配前缀胜出。估算把未缓存输入加缓存写按未命中价、缓存读按命中价、输出按输出价计费。没有价格的模型只显示计数、不显示金额，绝不给出猜来的数字；不足一分的金额保留微精度，不会被舍成零。默认值是 DeepSeek 官方高峰价参考表；部署通过行配置覆盖。

**定价经宿主注册的投影抵达浏览器。** 插件的 node 半边把配置好的价目表注册为 `tokenPricing` 会话投影；浏览器组件用 `useProjection('tokenPricing')` 读取它。浏览器插件行不带 `config`，所以客户端半边的 `Config` 只有默认值、行上的 `config:` 会静默失效；投影接缝是宿主拥有的、供浏览器渲染的值的既有投递路径，也让宿主行的 `config:` 保持权威。

**安装时把读数从未见过的金额补出来。** node 半边的第二个投影 `tokenCostBackfill` 折叠 `request/header` 事件，得出该会话是否用过有价路由、解析出的回填价目表漏掉了哪些路由、以及由 `SessionHeader.cwd` 推出的报告路径；浏览器组件在存在无价路由时于读数下方渲染一条 locale 拥有的提示。回填本身是 effect 拥有的异步副作用，绝不进入激活路径：它用 `ctx.get` 可选地解析 `ctx.sessionQuery`，用 `readSession` 读取每条存档日志，按结算事件折叠高峰与空闲用量——`assistant/message` 或失败的 `assistant/attempt`，用量来自事件自身的字段，或来自其内嵌流里最后一个 `usage` chunk——每个样本按自己的事件时间戳落在北京时间的哪个峰段分桶，对两个时段分别计价，并以「临时文件 + rename」写入 `<cwd>/TOKEN_COST.md`。同一 turn/step 内后一个结算替换前一个，唯一的例外是 `llm/retry-started` 会关闭这个替换槽，因此重试后的 attempt 与其之前那次累加。标记注释带着折叠语义版本、价目表哈希与全部会话水位，因此重启不重写任何文件，而版本号递增会让旧折叠写出的每份报告重写。目录里所有路由都无价时，写的是路由清单加一行可直接粘贴的 `backfill.pricing`，而不是猜出来的金额；没有 `cwd` 的会话只记日志并跳过，不会写进兜底路径。

**包能把自己装进 profile。** `package.json` 声明了指向随包发布的 `cordis.patch.yml` 的 `dsh.bundle.patch`，因此 `dsh plugin --profile <名字> add <tarball>` 会记下一条 profile 直接依赖，并从包自身挂载这一行，而不依赖 web-app bundle。两个载体插入同一个 `ui-token-usage` id，Loader 会解析成同一个条目。安装路径用 `scripts/pack-local.mjs`：它在工作区之外暂存一份副本，改写 workspace 范围并删除 `devDependencies`——工作区里 `pnpm pack` 会在 `devDependencies` 留下 `workspace:`，profile 安装会拒绝——而 `--name` 会同步改写构建时写死的 bundle id 与 style tag id，使个人 scope 的发布包以发布名加载。

**`/usage` 在两条通道上回答，两者都不调用提供方。** 行配置给出命令名（默认 `usage`）。会执行命令的客户端走注册：node 半边在 `ctx.inject(['commands'], …)` 里注册它，因此没有命令面的 profile 仍然保留读数与回填，而不会把插件拖成 pending；处理器把报告作为命令文本返回。只能发消息的客户端会到达 `llm/stream` 中间件：它按「最新一条人类消息的某个完整文本块整体相等」匹配——harness 的指令、上下文与技能目录消息都是带其它 `source.kind` 的 user 角色消息，注入内容不会误命中——然后用一个文本块加 `stop` 回答。该流**不带任何 usage 样本**：流没有上报 usage 时循环会省略该字段，而 token meter 的上下文占用分子取自最新一次结算，合成零值会被读成「上下文已空」。两条通道都用会话自己的 `tokenUsage`、`modelSelection`、`contextPressure` 与 `tokenPricing` 状态拼出报告；投影不可用的会话原样落回提供方（命令则直接失败），不改变任何已有行为。

## 备选方案

**扩展 `ui-chat` 的 `UsagePill`。** 那颗药丸已经拥有持久总量与缓存命中占比，它的弹层也已经列出四个桶。在那里加花费会让一个面向用户的价格表耦合进 chat 包，并且分类依旧只能点开看；需求是一个可独立挂载的读数，而多加一行 dock 条目能让既有药丸的读法保持不变。

**宿主侧的 `tokenCost` 投影。** 宿主折叠可以用产生该用量的路由给每个用量样本计价，并按事件所在的高峰/空闲时段分桶，这是客户端拿聚合桶做不到的。代价是它必须复制 `dsh-token-meter` 的「同一步骤替换样本」与重试折叠，而且定价不是宿主拥有的 seam：没有任何包发布 token 单价。等定价 seam 存在后再做；上文的**安装时回填**后来采用了它描述的 `request/header` 路由折叠与样本替换规则，但它产出的是报告而不是实时花费投影，而且仍然按会话最后一条路由计价。

**把读数并进 chat 统计行。** 把两个包的内容合成一个条目需要 feature 插件之间存在运行时值依赖，而客户端导出纪律禁止这种做法；slot 才是交叉点，同级的兄弟条目是被认可的形式。

## 后果

分类对整条持久日志是精确的，而花费数字取决于配置的表：投影不带逐样本时间戳，所以整段对话按单一价目计价；`modelSelection.lastUsed` 是最新被消费的路由，所以整段对话按单一路由计价。两条限制都写在包 README 里。读数以分类形式重复了药丸的总量；这种重复正是需求本身，而精确整数仍由药丸承担。回填报告带有读数做不到的按样本时段拆分，但它继承同一条单一路由限制，并且只统计提供方上报过用量的结算；又因为它自己折叠存储的日志而不复用投影缓存，每次启动都会重读整个存档，这项成本写在 README 里。`pnpm --filter @deepseek-ai/dsh-client-ui-token-usage test` 覆盖计价算术（最长前缀解析、未命中/命中/输出公式、未收录模型规则）、渲染出的分类与花费显示规则（包括 `tokenPricing` 投影缺席时）、宿主投影单元与其注册、峰段分桶、样本替换规则及其重试与流内嵌用量两种情形、跑在临时工作目录上的完整回填（金额表格、补价格说明、标记幂等与折叠版本失效、缺 `cwd`、会话不可读、回填被中止、写入失败），以及浏览器半边的注册、字典配对与 fiber 拆除后的资源释放。
