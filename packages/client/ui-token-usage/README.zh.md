---
description: "Web token 用量读数：composer 下方一行，把当前对话的持久用量分类为四个计费桶并计价；供会话花费显示的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-token-usage

[English](README.md) | 中文

## 概述

本包在 Web GUI 的 composer 下方渲染一行 token 用量读数：当前对话的用量拆成四个互不相交的计费桶——未缓存输入、缓存读、缓存写、输出——再加一个估算花费。计数来自持久的 `tokenUsage` 投影，因此分页与压缩都不会改变它；slot 的会话作用域让读数按对话独立。花费来自本插件的 `pricing` 配置，按会话最后使用的模型匹配；该模型没有配置价格时不显示金额。

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

把本插件与 `@deepseek-ai/dsh-token-meter`、会话控制器一起挂载；此后只要对话已经产生计费用量，读数就会出现在 composer 下方。第一个计费步骤之前不渲染；缓存桶为零时省略；长行保持紧凑计数（517 / 12.3K / 1.2M）。

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

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器半边在 `conversation.composer.dock` 上注册一个条目（`id: 'token-usage'`，排在 chat 统计药丸之后）。它只读框架 hook：`useProjection('tokenUsage')` 取四个桶，`useProjection('modelSelection')` 取产生这些用量的路由，优先 `lastUsed` 而非 `next`，因为计费用量来自最后实际使用的路由。本插件不持有状态、不发 RPC，也不增加任何模型可见内容。

花费估算把未缓存输入加缓存写按未命中价、缓存读按命中价、输出按输出价计费：`((uncached + cacheWrite) * inputMiss + cacheRead * inputHit + output * output) / 1e6`。不足一分的金额保留微精度，不会被舍成零。宿主半边把配置好的价目表注册为 `tokenPricing` 会话投影，因为浏览器插件行不带 `config`；浏览器组件与 `tokenUsage`、`modelSelection` 一起用 `useProjection('tokenPricing')` 读取它。

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

无，因为本包只为人类渲染已记录的会话投影，不注册任何模型可见内容。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定读数能有多准，本功能不是账单级计价。

- **花费是估算而不是账单**——提供方价格会变，以平台账单为准。默认价目是参考值，部署通过配置覆盖。
- **高峰与空闲价没有分开**——投影不带逐样本时间戳，所以整段对话按同一价目计价。用高峰价填表会把空闲时段的用量高估最多一个高峰期折扣。
- **多模型对话只按一个路由计价**——`modelSelection.lastUsed` 是最新被消费的路由，因此中途切换过模型（且两条路由都有价）的对话会按最后一条路由给全部 token 计价。路由感知的花费投影要等定价成为宿主拥有的 seam 后再做。
- **计数是紧凑值而不是精确值**——本行在 1,000 以上会取整；精确整数仍由 chat 统计药丸的弹层承担。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包只是把两个持久会话投影以只读方式投影为一个 composer-dock 条目；不发出 Cordis 事件，不持有跨插件可变状态，其唯一的 slot 注册通过 HMR（热模块替换）安全性规范验证了资源释放行为。
