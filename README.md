# clawd-on-desk-omp

让 [Clawd on Desk](https://clawd-on-desk) 识别并驱动 **OMP**（oh-my-pi）会话：桌面宠物状态、会话 HUD、完成提示音、"跳回终端"全部可用。

Clawd on Desk 内置了 Claude Code、Codex、Gemini CLI、Pi、Hermes 等一批 agent 的适配，**没有** OMP 适配。但它开放了「自定义应用（custom application）」通道：用户按可执行文件路径注册一个 agent，之后任何本地进程只要向它的回环 HTTP 端点 `POST /state` 上报生命周期，就能获得与内置 agent 同等会话级 UI。本仓库就是 OMP 那一侧的实现。

```
┌──────────────┐   extension events   ┌───────────────────────┐   POST /state   ┌──────────────────┐
│  OMP (TUI)   │ ───────────────────▶ │ clawd-on-desk-omp.ts  │ ──────────────▶ │ Clawd on Desk    │
│  会话/工具    │  session_start       │  · agent_id 解析       │  127.0.0.1:23333 │  · 宠物状态       │
│  压缩/结束    │  tool_call/result    │  · 终端 pid 链解析      │  (runtime.json)  │  · 会话 HUD       │
│              │  session_stop        │  · 事件 → 状态映射      │                  │  · 完成提示音     │
└──────────────┘                      └───────────────────────┘                  │  · 跳回终端       │
                                                                                 └──────────────────┘
```

## 当前方案的两个组成部分

适配不在 Clawd 内部做任何改造，而是两侧各一处：

1. **Clawd 侧：注册一个自定义应用（一次性，手工）**
   设置 → Agents → 未识别/自定义工具区域 → 选择 omp 可执行文件路径。
   Clawd 会分配 id `custom-<slug>-<sha256(路径)[0..12]>`，写入 `clawd-prefs.json` 的 `customApplications`。
   本机实测：路径 `/Users/crosery/.bun/bin/omp` → id `custom-omp-f83ec4ad2e8a`，Clawd 侧会话键形如 `custom-omp-f83ec4ad2e8a:omp:<session-uuid>`。
   id 与**注册时的路径**绑定（符号链接与真实路径结果不同），换路径要重新注册。

2. **OMP 侧：一个扩展（本仓库）**
   `clawd-on-desk-omp.ts` 放进 `~/.omp/agent/extensions/`，订阅 OMP 的扩展事件，把每个事件换算成 Clawd 的 `state` + `event`，POST 到本地端点。
   无 UI 的 headless worker（子 agent、后台任务）不上报；只有交互式会话在 Clawd 里各占一行。

关键映射（细节与理由见源码注释、协议全貌见 [`docs/protocol.md`](docs/protocol.md)）：

| OMP 事件 | Clawd event | state | 说明 |
| --- | --- | --- | --- |
| `session_start` / `session_switch` / `session_branch` | `SessionStart` | `idle` | 会话建立或切换 |
| `before_agent_start` | `UserPromptSubmit` | `thinking` | 用户提交了输入 |
| `tool_call` | `PreToolUse` | `working` | 工具开始执行 |
| `tool_result` | `PostToolUse` / `PostToolUseFailure` | `working` / `error` | 失败走 error 动画 |
| `session_stop` | `Stop` | `attention` | **唯一**的"完成"信号：回合已结算 |
| `session_before_compact` | `PreCompact` | `sweeping` | 压缩中扫地动画 |
| `session_compact` | `PostCompact` | `attention` | 压缩完成 |
| `session_shutdown` | `SessionEnd` | `sleeping` | 会话结束 / 进入休眠 |

两个容易踩的点：

- **完成事件必须用 `session_stop`，不能用 `agent_end`。** `agent_end` 在调度暂停时也会触发（后台任务还在跑、有排队的后续回合），用它会让 Clawd 在会话仍在工作时宣布"完成"。`session_stop` 表示回合真正结算，且不会为子 agent 会话触发。
- **会话标题优先用 OMP 的会话名。** 多个交互会话常共用同一个 cwd，若都用 `OMP · <目录>` 命名，Clawd 列表与跳转目标无法区分。

## 安装

```sh
git clone <this repo> && cd clawd-on-desk-omp
sh scripts/install.sh          # 复制扩展到 ~/.omp/agent/extensions/ 并打印 agent id
node scripts/agent-id.mjs      # 查看/确认 Clawd 会接受的 agent id
```

然后在 Clawd 设置里注册 omp 可执行文件（见上），重启 OMP 会话。若 OMP 不是从注册路径启动的（wrapper 脚本、`bun link`、Windows shim），用环境变量显式指定：

```sh
export CLAWD_OMP_AGENT_ID=custom-omp-f83ec4ad2e8a
```

自检：

```sh
bun scripts/selftest.ts         # id 推导、端口发现、Clawd health 端点（只读，不建会话）
curl -s http://127.0.0.1:23333/state   # {"ok":true,"app":"clawd-on-desk","port":23333}
```

## 能力边界

- **没有审批气泡。** 自定义应用在 Clawd 里是 "state-only"：`permissionsEnabled` 不被支持，权限审批仍是 Clawd 内置 hook（Claude Code / Codex / Kimi 等）的能力，OMP 不在其中。
- **跳转依赖终端。** Clawd 通过上报的 `source_pid` + `pid_chain` 找到终端（Ghostty、cmux、iTerm2、Terminal、WezTerm、kitty、Warp…）再定位 pane/tab。没有终端祖先 pid 的会话只能显示、不能跳。
- **上报失败必须静默。** 端点 250ms 超时，`POST` 吞掉所有错误——桌面监控绝不能阻塞或改变 OMP 的工具结果。
- **协议是逆向整理的。** Clawd on Desk 是闭源第三方应用，端点与字段可能在版本间变化；本桥的失败模式是"什么都不发生"，不会影响 OMP 本身。

## 仓库结构

```
clawd-on-desk-omp.ts     OMP 扩展本体（安装时复制到 ~/.omp/agent/extensions/）
scripts/install.sh       安装/更新扩展
scripts/agent-id.mjs     推导并校验 Clawd 侧 agent id
scripts/selftest.ts      端到端自检（id、端口、端点连通性）
scripts/typecheck.sh     用本地 OMP 的类型定义做类型检查
docs/protocol.md         Clawd 自定义应用状态协议（逆向整理）
```

## 许可

MIT。非 Clawd on Desk 官方项目；协议文档为观察所得，与 Clawd on Desk 无隶属关系。
