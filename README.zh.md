# dsh-better-push

**DeepSeek Harness 的 macOS 原生系统通知。** 你切出窗口之后，回合完成、需要审批、
agent 向你提问、出错、后台任务 / 子代理 / 工作流结束时，macOS 会用
**DeepSeek Harness** 的名字和图标弹出横幅；点一下横幅，窗口回到前台并跳到触发它的会话。

```
┌───────────────────────────────────────────────┐
│ 🔔 DeepSeek Harness                           │
│ 回合完成 · dsh-better-push                     │
│ Fixed the parser; tests pass. · 耗时 2m14s     │
└───────────────────────────────────────────────┘
```

> 第三方插件，不是 DeepSeek / DeepSeek Harness 官方组件。

## 会通知什么

| 时机 | 通知内容 | 默认 |
|---|---|---|
| 回合完成 | 会话名 + 回复摘要一行 + 耗时 | 开 |
| 工具调用等待审批 | 会话名 + 工具名；你做出决定后横幅自动收起 | 开 |
| agent 向你提问 | 会话名 + 问题内容 | 开 |
| 回合失败 / 中断 / 上下文耗尽 | 提供方或回合错误 | 开 |
| 后台任务结束 | 任务标签 + 状态（`run_in_background`、被转后台的命令） | 开 |
| 子代理回合结束 | 父会话名 + 预设；点击打开父会话 | 关 |
| 工作流运行结束 | 工作流名 + 结束原因 | 开 |
| 测试通知 | 设置页或 `POST /plugin/better-push/test` 触发 | — |

前台 Bash 命令虽然在内部也是 job，但**不会**通知：插件读取 job 事件里的
`awaited` 标志，只对真正被你丢到后台的工作提示。

## 安装

需要 **DeepSeek Harness 0.2.1-rc.3 及以上（低于 0.3.0）**、**macOS**，并且有
桌面端或 Web 界面。

目前**没有发布到 npm**，这个 GitHub 仓库就是分发渠道。DSH 支持下面三种安装方式，
任选其一。

**1. 插件市场（推荐，版本锁定到具体 commit）。** 在 设置 → 插件 → 发现（Discover）
里把这个索引地址添加为市场源，然后从列表里安装「Better Push — macOS 系统通知」：

```
https://raw.githubusercontent.com/ceasarXuu/dsh-better-push/main/market/index.json
```

`market/index.json` 是 DSH 插件市场 format 1 索引，条目是锁定到具体 commit 的
`git` 源，所以这个文件放到任何静态 HTTPS 托管上也能用。

**2. 插件管理器 → 添加。** 粘贴仓库地址或 pnpm 简写：

```
https://github.com/ceasarXuu/dsh-better-push
github:ceasarXuu/dsh-better-push
```

或直接粘贴 release 里的打包文件（就是 `npm pack` 的产物）：

```
https://github.com/ceasarXuu/dsh-better-push/releases/download/v0.1.0/ceasarxuu-dsh-better-push-0.1.0.tgz
```

**3. 命令行。** 先完全退出应用（运行期间 profile 会被锁定），然后：

```sh
dsh plugin --profile desktop add github:ceasarXuu/dsh-better-push
# 或从本地目录安装：
dsh plugin --profile desktop add /绝对路径/dsh-better-push
```

重启一次应用。配置保存在 profile 的 `cordis.patch.yml` 中，行 id 为 `better-push`。
升级用同样的方式安装新版本（只有市场索引锁定 commit，`github:` 方式跟随默认分支头）。
## 设置

全部在 **设置 → 通知** 里改（设置侧栏里独立的一节，和「通用设置」「内置插件」同级；
同一个表单也会出现在「设置 → 插件 → 本插件」的行配置里），写回 profile patch。
每个开关相互独立，改动立即生效：设置页写入 profile patch，loader 把 `volatile`
字段提交给正在运行的插件，浏览器半边下一次轮询就拿到新策略。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 系统通知总开关。 |
| `notifyInForeground` | `true` | 窗口在前台时也通知；关掉后只在 DSH 不在前台时通知。 |
| `sound` | `true` | 通知带提示音。 |
| `turnEnd` | `true` | 回合完成时通知。 |
| `approvals` | `true` | 工具调用等待审批时通知。 |
| `questions` | `true` | agent 提问时通知。 |
| `errors` | `true` | 回合失败、被中断、上下文耗尽时通知。 |
| `jobs` | `true` | 后台任务结束时通知。 |
| `subagents` | `false` | 子代理 / Agent Team teammate 回合结束时通知。默认关闭：团队并行跑时会每次子回合都弹。 |
| `workflows` | `true` | 工作流运行结束时通知。 |
| `preview` | `true` | 在回合完成通知里带一行回复摘要。 |
| `minTurnSeconds` | `0` | 短于该秒数的回合完成不通知（0 = 每个回合都通知）。 |
| `quietHours` | `""` | `HH:MM-HH:MM` 本地免打扰时段，支持跨夜。 |
| `fallbackWhenNoClient` | `true` | 没有窗口连接（窗口已关闭）时改用 `osascript` 兜底。 |
| `fallbackSoundName` | `Glass` | 兜底通知使用的声音。 |

## 工作原理

一个包，两个半边：

- **宿主半边（`index.js`）** 监听每个活动 Session 的 `session/event`
  （`turn/end`、`approval/asked`、`approval/decided`、`tool-workflow/*`、
  `session/title`）、`user-questions/request` waterfall（只观察，绝不代答）以及
  `jobs` 事件流。它负责分类、去重、免打扰判断，并在 `/plugin/better-push` 下提供
  极小 HTTP 接口：`GET /poll`（按游标取通知，同时是"窗口在不在"的心跳）、
  `GET /state`（诊断）、`GET /health`、`POST /test`。
- **浏览器半边（`client.js`）** 每秒轮询一次，把通知项变成 renderer
  `Notification`。在桌面端这意味着 **UNUserNotification** 横幅、归属
  *DeepSeek Harness*、使用应用图标、点击由 macOS 激活应用，再调用
  `uiWorkspace.openSession(sessionId)` 跳到正确的会话；审批被处理后会主动关闭
  对应横幅。

优先走 renderer。没有窗口连接时（比如你关掉窗口、后台任务才结束），宿主退回
`osascript display notification`，让你仍然能收到——代价是通知显示为 Script Editor，
点击也打不开 DSH。不想要这种兜底就把 `fallbackWhenNoClient` 关掉。

为什么用轮询而不是长连接：桌面 renderer 运行在 `dsh-app://app` 源上，Electron
外壳会把同源 fetch 转发给宿主；本机回环上每秒一个请求成本可以忽略，而且它同时
充当决定两种投递方式的在线心跳。

## 诊断

```sh
# 插件当前状态
curl -s http://127.0.0.1:61670/plugin/better-push/state | jq
# { "clients": 1, "clientIds": ["web-…:granted"], "cursor": 3, "fallback": 0, … }

# 走正常通道弹一条横幅
curl -s -X POST http://127.0.0.1:61670/plugin/better-push/test \
  -H 'content-type: application/json' -d '{"body":"你好"}'
```

`clients: 0` 表示窗口已关闭，正在走兜底通道；`clientIds` 里出现 `denied`
表示 renderer 无法弹通知，宿主已经为它兜底。

## 开发

```sh
pnpm install          # 只依赖 @deepseek-ai/schemastery
node --test test/*.test.mjs
```

浏览器半边的 bundle 在运行中的 GUI 里约 500ms 热替换（无需重启）；宿主代码改动
需要重启应用。想在不碰自己 profile 的前提下测宿主改动，可以另起一个 web 实例，
用仓库自带的 CDP 校验脚本驱动——见 [`dev/README.md`](dev/README.md)。

## 已知限制

- 目前只做 macOS：renderer 半边在 Windows/Linux 理论上可用，但兜底与文案未验证。
- renderer 通道不能自定义提示音（Web Notification 只有 `silent`），没有副标题，
  没有操作按钮。
- 没有 Dock 徽标、通知历史页、按会话静音。
- 点击回到前台是"尽力而为"：macOS 会在点击横幅时激活应用，但 `window.focus()`
  本身无法把最小化的窗口提上来。
- `osascript` 兜底横幅归属于 Script Editor，点击会打开 Script Editor——这是
  macOS 旧 `display notification` 通道的限制，不是插件 bug。

## 许可证

MIT，见 [LICENSE](LICENSE)。
