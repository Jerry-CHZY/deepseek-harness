---
description: "Web token 用量读数：composer 下方一行，把当前对话的持久用量分类为四个计费桶并计价；供会话花费显示的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-token-usage

[English](README.md) | 中文

## 概述

本包在 Web GUI 的 composer 下方渲染一行 token 用量读数：当前对话的用量拆成四个互不相交的计费桶——未缓存输入、缓存读、缓存写、输出——再加一个估算花费。计数来自持久的 `tokenUsage` 投影，因此分页与压缩都不会改变它；slot 的会话作用域让读数按对话独立。花费来自本插件的 `pricing` 配置，按会话最后使用的模型匹配；该模型没有配置价格时不显示金额。宿主半边还会把 Web 从未显示的金额补出来：对存档语料跑一趟，给每个会话工作目录写一个 `TOKEN_COST.md`；当某条路由没有价格时，读数会指向该文件。

## `/usage` 速查

在任意对话里发送 `/usage`。会执行命令的客户端（`dsh` CLI、Web composer）按注册命令执行；只能发消息的客户端（手机端、远端页面、APP 页面）由 node 半边在模型边界回答。两种方式都不调用提供方、不产生 usage 结算，上下文占用读数保持不变。

```text
合计 264M · 输入 2.6M · 缓存读 261M · 输出 608K · ≈¥20.40 · 上下文 440K/1M
```

通过行配置改命令名并汉化文案：

```yaml
- id: ui-token-usage
  name: '@deepseek-ai/dsh-client-ui-token-usage'
  config:
    command:
      name: usage
      labels:
        total: 合计
        input: 输入
        cacheRead: 缓存读
        cacheWrite: 缓存写
        output: 输出
        context: 上下文
```

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件与 `@deepseek-ai/dsh-token-meter`、会话控制器一起挂载；此后只要对话已经产生计费用量，读数就会出现在 composer 下方。该行以会话合计开头，接着是非零桶的分类与估算花费，最后在计量器同时给出分子与路由容量时补上上下文占用。第一个计费步骤之前不渲染；缓存桶为零时省略；长行保持紧凑计数（517 / 12.3K / 1.2M）。

### 安装到 profile

把本包装成 profile 的直接依赖后，它会出现在 Web GUI 的已安装插件列表里，可以就地启用或卸载：

```powershell
node packages/client/ui-token-usage/scripts/pack-local.mjs
dsh plugin --profile <名字> add <脚本打印出的 .tgz 路径>
```

脚本会暂存一份副本，把清单里所有 `workspace:` 范围改写为工作区版本并删掉 `devDependencies`——因为工作区里直接 `pnpm pack` 会在 `devDependencies` 里留下 `workspace:`，profile 安装时就会报 `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`。包声明了 `dsh.bundle.patch`，因此 profile 会从包自带的 `cordis.patch.yml` 挂载读数行，不需要手工插入。`desktop` profile 归 Electron 应用所有，按设计拒绝 `dsh plugin`；在那里请走应用自己的插件界面。

已发布版本可以直接从 npm 安装，不需要打包：

```powershell
dsh plugin --profile web add @jerry_chzy/dsh-token-usage@0.1.1 --registry=https://registry.npmjs.org
```

通过本插件的行配置设置价格。`pricing` 把模型 id 前缀映射到「元/百万 tokens」，最长的匹配前缀胜出，因此带日期的快照或 vision 路由可以共用或覆盖基础模型的价目：

```yaml
- id: ui-token-usage
  name: '@deepseek-ai/dsh-client-ui-token-usage'
  config:
    currencySymbol: '¥'
    pricing:
      deepseek-v4-pro: { inputMiss: 9, inputHit: 0.3, output: 27 }
```

默认值是 DeepSeek 官方价目的参考表（高峰价）。解析后的表里没有的模型只显示 token 计数、不显示金额，绝不会给出猜来的数字。

### 历史回填

宿主半边还会遍历存档会话，在每个会话自己的工作目录里写一个 `TOKEN_COST.md`：每个记录在该目录的对话一行，含四个计费桶、高峰与空闲金额、以及合计。`backfill.pricing` 用「元/百万 tokens」的 `[空闲, 高峰]` 价对给它计价，`backfill.peakHours` 替换北京时间的峰段（默认：工作日 09:00–12:00 与 14:00–18:00）。`backfill.enabled: false` 会同时关掉这次回填与它的浏览器提示。

```yaml
- id: ui-token-usage
  name: '@deepseek-ai/dsh-client-ui-token-usage'
  config:
    backfill:
      pricing:
        deepseek-v4-pro:
          inputMiss: [4.5, 9]
          inputHit: [0.15, 0.3]
          output: [13.5, 27]
```

当没有任何已记录路由命中价目时，同一个文件改为列出表里缺价格的路由以及可给它们定价的 YAML 行，composer 读数下方也会出现指向该文件的提示。回填每次进程启动跑一次，若目录里已有的标记注释仍带着当前折叠语义版本、价目表与全部会话水位，就直接跳过，因此重启不会重写任何文件；没有记录工作目录的会话会被跳过，而不会写进猜出来的路径。

### `/usage` 指令

`/usage` 报告会话的四个桶、估算花费与上下文占用，且不调用提供方。它通过两条通道抵达所有客户端：

- **会执行命令的客户端**（`dsh` CLI、Web composer）走注册命令：不创建模型消息，也不产生任何结算。
- **只能发消息的客户端**（手机客户端、只转发会话消息的远端页面）会到达模型边界，由 node 半边用一个**不携带 usage** 的流回答。提供方从不被调用；由于没有写入任何结算，上下文占用读数保持原值。

```yaml
- id: ui-token-usage
  name: '@deepseek-ai/dsh-client-ui-token-usage'
  config:
    command:
      name: usage
      labels:
        total: 合计
        input: 输入
        cacheRead: 缓存读
        cacheWrite: 缓存写
        output: 输出
        context: 上下文
```

消息回退按「最新一条人类消息的某个完整文本块整体相等」匹配；harness 注入的指令、上下文与技能目录消息带着其它 source kind，永远不会误命中。拿不到 `tokenUsage` 投影的会话会落回模型，而命令则返回一条简短诊断而不是猜数字。`command.enabled: false` 会同时移除两条通道，`command.name` 会同时改名命令与其 `/名字` 触发。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器半边在 `conversation.composer.dock` 上注册一个条目（`id: 'token-usage'`，排在 chat 统计药丸之后）。它只读框架 hook：`useProjection('tokenUsage')` 取四个桶，`useProjection('modelSelection')` 取产生这些用量的路由（优先 `lastUsed` 而非 `next`，因为计费用量来自最后实际使用的路由），`useProjection('contextPressure')` 取上下文占用格——其中 `projectedTokens` 优先于 `pressureTokens`，与会话计量器的读法完全一致。本插件不持有状态、不发 RPC，也不增加任何模型可见内容。

花费估算把未缓存输入加缓存写按未命中价、缓存读按命中价、输出按输出价计费：`((uncached + cacheWrite) * inputMiss + cacheRead * inputHit + output * output) / 1e6`。不足一分的金额保留微精度，不会被舍成零。宿主半边把配置好的价目表注册为 `tokenPricing` 会话投影，因为浏览器插件行不带 `config`；浏览器组件与 `tokenUsage`、`modelSelection` 一起用 `useProjection('tokenPricing')` 读取它。

宿主半边还注册 `tokenCostBackfill`：它折叠 `request/header` 事件，报告该会话是否用了有价路由、价目表漏掉了哪些路由、以及由会话 header 的工作目录推出的报告路径。组件用 `useProjection('tokenCostBackfill')` 读取它，并在存在无价路由时于读数下方渲染一条 locale 拥有的提示。回填本身是插件 fiber 上独立的 effect：它以可选方式解析 `ctx.sessionQuery`，用 `readSession` 读取每条存档日志，并以「临时文件 + rename」写盘。它按结算事件折叠高峰与空闲用量——`assistant/message` 或失败的 `assistant/attempt`，用量来自事件自身的字段，或来自其内嵌流里最后一个 `usage` chunk。同一 turn/step 内后一个结算会替换前一个，唯一的例外是 `llm/retry-started` 会关闭这个替换槽，因此重试后的 attempt 与其之前那次累加。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当读数本身不够用时，请阅读以下页面。它们拥有测量与读数所在的 composer 界面。

- [dsh-token-meter](../../llm/token-meter/README.zh.md)——本包读取的 `tokenUsage` 与 `contextPressure` 投影。
- [ui-chat](../ui-chat/README.zh.md)——composer 统计药丸，包括本行所补充的总量用量弹层。
- [会话控制器](../../api/session-controller/README.zh.md)——拥有 `modelSelection` 投影与投影读取座位。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

消息回退是本包唯一的模型可见输出：一条由已记录投影拼出的 assistant 消息，不携带 usage 样本，也从不发给提供方。命令面与浏览器读数都留在模型历史之外。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定读数能有多准，本功能不是账单级计价。

- **花费是估算而不是账单**——提供方价格会变，以平台账单为准。默认价目是参考值，部署通过配置覆盖。
- **高峰与空闲价没有分开**——投影不带逐样本时间戳，所以整段对话按同一价目计价。用高峰价填表会把空闲时段的用量高估最多一个高峰期折扣。
- **多模型对话只按一个路由计价**——`modelSelection.lastUsed` 是最新被消费的路由，因此中途切换过模型（且两条路由都有价）的对话会按最后一条路由给全部 token 计价。路由感知的花费投影要等定价成为宿主拥有的 seam 后再做。
- **计数是紧凑值而不是精确值**——本行在 1,000 以上会取整；精确整数仍由 chat 统计药丸的弹层承担。
- **报告是快照**——两条通道都反映执行时刻的会话状态，仍在进行的步骤不计入，两者也都不产生任何结算。
- **回填只统计日志里记录的用量**——没有提供方上报 `usage` 的结算不贡献任何数字，所以 `TOKEN_COST.md` 可能低估那些提供方从未上报用量的对话。
- **无价路由得到的是说明而不是金额**——当没有任何已记录路由命中 `backfill.pricing` 时，报告给出缺价格的路由与可直接粘贴的 YAML 行，composer 提示也如此说明；不猜价格，也不写出部分金额。
- **没有工作目录的会话会被跳过**——回填只记日志、不写文件，不会退回到进程工作目录或用户主目录。
- **回填按样本区分高峰与空闲**——每个用量样本按自己的事件时间戳（北京时间）计价，这正是上面那条单一费率读数做不到的。
- **每次启动都会重读整个存档语料**——回填自己折叠存储的日志，而不复用投影缓存，因此读取成本随存档会话数线性增长；标记只省下写入，省不下读取。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包只是把两个持久会话投影以只读方式投影为一个 composer-dock 条目；不发出 Cordis 事件，不持有跨插件可变状态，其唯一的 slot 注册通过 HMR（热模块替换）安全性规范验证了资源释放行为。
