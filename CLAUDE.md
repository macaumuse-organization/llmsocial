# CLAUDE.md — 给在这个仓库里干活的 AI 助手

## 这是什么

本地社媒收件箱 + AI 回复助手，见 [README.md](README.md)。约 15000 行，无编译步骤，Node 直接跑 `.ts`。

## 运行环境的硬约束（踩过的坑）

Node 用的是**类型擦除**，不是 TypeScript 编译器。所以：

- ❌ 不能用 `enum`、`namespace`、构造函数参数属性（`constructor(private x: T)`）、实验性装饰器。
- ✅ 相对导入**必须带 `.ts` 后缀**（`./repos.ts`，不是 `./repos`）。
- ✅ 只导入类型时必须写 `import type`（`verbatimModuleSyntax` + `erasableSyntaxOnly` 都开着）。
- `node:sqlite` 的 `DatabaseSync` **不接受 boolean 和 undefined** 作为绑定参数。`Db.run/get/all` 已经统一转换，写新查询时别绕过它们。
- 前端的 `import './styles.css'` 靠 `src/web/env.d.ts` 里的 `declare module '*.css'`，别删。

## 调模型时

- 默认模型 `claude-opus-5`。**绝不要发 `temperature` 或 `top_p`** —— Opus 5 / Sonnet 5 / Fable 系列会直接 400。`Provider.temperature` 存了也只对 openai_compat 一类的老接口生效，`anthropic.ts` 里已经过滤。
- 思考预算用 `output_config.effort`，不是 `budget_tokens`。
- `stop_reason === 'refusal'` 要当成一次失败处理，走后备链，不要把拒绝当正文发出去。

## 命令

```bash
npm run check   # 提交前跑这个：tsc(server) + tsc(web) + 全部测试
npm test        # node --test --test-concurrency=1 "tests/**/*.test.ts"
npm run dev     # 本地起服务
```

测试用 `tests/helpers.ts` 的 `harness()`：假时钟 + 内存 SQLite + Mock 模型，不联网、结果确定。**多气泡发送之间有 3 秒间隔**，一次 `tick()` 送不完，要用 `h.settle()`。

## 不能改软的东西

改这些之前先问人。它们是这个项目能存在的前提，不是可配置项：

1. **连接器不能有「主动发起联系」的能力**。`Connector` 接口只有 `poll` / `receive` / `send`，`send` 必须针对已存在的会话。不要加 `addFriend`、`follow`、`sendToNewUser`。
2. **autopilot 的 AI 身份披露**。`pipeline.ts` 里第一条自动消息前插入披露，`isValidDisclosure()` 会验证文案真的说了「AI」。不要加「关闭披露」的选项。
3. **`checkOutbound` 的 `human_claim` 拦截**。AI 自称真人时必须拦下重写。
4. **硬风险标记停机**（`HARD_FLAGS = self_harm / minor / legal / harassment`）：命中就转人工，**在调用模型之前**。
5. **退订永久且跨账号**（`suppressions` 表按平台 + 用户 ID）。解除只能人工在联系人页面做。
6. **任务/技能的 `allowedPlatforms`**。`vpn-intro-overseas` 写死只在 x / instagram / youtube 上装载，这是合规要求不是偏好。
7. **发送前先标 `sending`**（`pipeline.send`）。崩溃后 `recoverInterrupted()` 把这类消息标成失败并要求人工确认，绝不自动重发——宁可漏发也不能重发。

## 目录

```
src/shared/     types(共用类型) platforms(平台参数表) chatText(粘贴文字解析，server 与 web 共用，不能反向 import server)
src/server/
  agent/        pipeline(核心状态机) guards(确定性护栏) prompt schema similarity simulator
  llm/          router(后备链+熔断+限额) anthropic openaiCompat gemini mock
  connectors/   平台接入；local.ts=沙盒/手动/webhook，其余是官方 API
  db/           migrations(只追加) repos(仓储层)
  api/          server(鉴权与安全头) chatRoutes configRoutes validators
  queue/        jobs(SQLite 任务队列) schedule(静默时段/节奏)
  secrets/      AES-256-GCM + 钥匙串引用
  ocr/          vision-ocr.swift(macOS 按需编译) windows-ocr.ps1(Windows 系统 OCR，纯 ASCII，别往里写中文) parseChat(左右分栏)
src/web/        React 19 + Vite，hash 路由，无路由库
skills/         内置技能 Markdown
tests/          全部测试
```

## 写代码的风格

- 注释写**为什么**，不写「这行做什么」。现有注释密度就是标准，别加水。
- 面向操作者的文案一律简体中文，口语，不要客服腔（不要「请输入您的……」）。
- 错误信息要能让人知道下一步做什么（「Host 不在允许列表内（LLMSOCIAL_ALLOWED_HOSTS）」而不是「Forbidden」）。
- 不打印密钥。日志、事件、错误信息都不能带 token；`tests/connectors.test.ts` 里有专门的用例盯着这件事。
