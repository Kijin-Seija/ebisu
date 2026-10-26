---
name: debug-auto
description: 当用户显式调用 ${INVOKE}，或要求使用 "debug auto"、"debug-auto"、"自动化 debug"、"全自动排查前端 bug"、"用真实浏览器排查" 时使用。适用于可以由 agent 自行启动项目、优先接管真实浏览器（Chrome DevTools Protocol）、自动操作页面、监听 console/pageerror/network 日志并基于证据分析问题的场景。
---


## Ebisu 运行方式

先读取入口返回的经验与变量。运行工具必须通过 `${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-auto --path "$PWD" --script scripts/脚本名 -- 参数`，不从安装目录推导项目、不直接改写中央文件。

# Debug Auto

## 触发条件

只在用户明确要求时启用，例如：

- `使用 debug auto`
- `${INVOKE}`
- `请用 debug-auto 自动排查这个问题`
- `走自动化 debug，你直接操作页面并看日志`
- `用真实浏览器跑一遍，把 console 报错捞出来`

如果用户没有显式要求，不要默认启用。

## 目标

该 skill 用于让 agent 尽量独立完成整轮前端排障：

1. 启动或连接本地项目
2. 按「浏览器能力阶梯」取证据：优先真实浏览器（Chrome CDP），其次 Playwright
3. 自动监听 console、page error、request failed、关键响应
4. 先基于运行证据定位，再进入代码修复
5. 修复后再次自动验证

## 核心原则

### 真实浏览器优先

用户日常在用的那个浏览器才是问题真正发生的地方：真实登录态、真实扩展、真实网络与渲染条件。Playwright 自带的干净 Chromium 经常复现不出用户报的问题，所以它是兜底而不是默认。

但「真实浏览器」不等于「随便接管用户正在用的窗口」：Chrome 136 起，`--remote-debugging-port` 对**默认 profile 目录**已经不再生效，必须搭配非默认的 `--user-data-dir`。所以阶梯分两级——先复用已经开着调试端口的实例（真 profile、真登录态），再考虑用真实内核配独立 profile 另起一个。

### 自动化优先

进入 `debug-auto` 后，默认目标是让 agent 自己完成启动、操作、取证和复测。

除非遇到明显阻塞，例如：

- 必须真人扫码、验证码或硬件操作
- 复现依赖外部账号权限且当前环境不可用
- 问题只在用户私有数据或本机特定环境中出现

否则不要过早把操作步骤转交给用户。

### 证据优先

自动化执行拿到的运行证据是一手依据，至少包括：

- `console` 输出
- `pageerror`
- 失败请求与关键响应
- 复现步骤中的页面状态变化

在还没拿到这些证据前，不要仅凭代码直觉下根因结论。

### 无法自动化时及时降级

如果问题无法在当前环境被 agent 稳定自动复现，不要勉强继续“半自动”排查。

应明确说明阻塞原因，并建议切换到更合适的模式：

- 用户可以自己操作页面时，切到 `debug-steps`
- 只能通过代码打点取证时，切到 `debug-manual`

## 浏览器能力阶梯

按顺序尝试，不要跳档；确实要跳档，必须在汇报里说明原因。

| 档位 | 手段 | 判据 | 代价 |
| --- | --- | --- | --- |
| 1 复用真实实例 | 连接本机已开着调试端口的浏览器 | `detect` 退出码 0 | 最真实：真 profile、真登录态、真扩展 |
| 2 启动真实内核 | 用本机 Chrome 系浏览器配独立 profile 起一个可调试实例 | `detect` 未命中，但本机装了 Chrome 系浏览器 | 真渲染引擎，但 profile 是干净的，可能要在里面重新登录 |
| 3 Playwright | 项目自带 Playwright，或宿主提供的浏览器自动化能力 | 档 1、2 都不可用，或需要可重复的干净环境 | 与用户真实环境有差异，可能复现不出 |
| 4 非浏览器 | 静态取证（`curl` / WebFetch），或切 `debug-steps` / `debug-manual` | 问题依赖真实交互或私有数据，浏览器起不来 | 证据最弱 |

探测、启动与收尾：

```bash
# 档 1：探测本机是否已有可复用的调试实例（0 命中，1 未命中）
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-auto --path "$PWD" --script scripts/cdp-browser.sh -- detect

# 档 2：用真实 Chrome 内核起一个独立 profile 的实例，返回 CDP endpoint
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-auto --path "$PWD" --script scripts/cdp-browser.sh -- launch --url http://127.0.0.1:5173

# 每轮复现前确认通道还在；显示 stale 说明实例已被回收，重新 launch
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-auto --path "$PWD" --script scripts/cdp-browser.sh -- status

# 收尾：关闭本脚本启动的实例；--purge 会连独立 profile 一起删掉
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-auto --path "$PWD" --script scripts/cdp-browser.sh -- stop
```

`launch` 返回的 `endpoint` 形如 `http://127.0.0.1:9222`。另外三个环境变量可用来自定义探测目标：`CDP_ENDPOINT` 或 `CHROME_CDP_PORT` 指向用户自己开好的实例，`CDP_BROWSER` 指定浏览器可执行文件路径。

运行时状态按**项目 + 宿主**隔离，所以 `detect`/`launch`/`status`/`stop` 必须在**同一个工作目录**下执行：换目录意味着换作用域，`status` 会看不到刚起的那一个、`stop` 也会停在另一个作用域的实例上（看起来像"没停掉"，实际是读错了状态文件）。

拿到 `endpoint` 之后按这个顺序挑驱动方式：

- 项目里有 Playwright 时，用 `chromium.connectOverCDP(endpoint)` 连上去操作。它同时提供 `page.on("console" | "pageerror" | "requestfailed" | "response")`，是最省事的取证方式。
- 没有 Playwright 时，优先用宿主已有的浏览器自动化能力（CLI、skill 或 MCP），把 `endpoint` 交给它。
- 两者都没有，才手写 CDP：先 `GET <endpoint>/json/version` 确认通道，再 `GET <endpoint>/json/list` 找到目标页，向它的 `webSocketDebuggerUrl` 发 `Runtime.enable`、`Network.enable`、`Log.enable`，然后才导航。

接管已有实例时，只操作与本次复现相关的 target，不要去关别人的标签页或改动用户其他的会话状态。

### 受限环境里的启动失败

在 CI、容器或 agent 自带沙箱这类受限环境里，Chrome 的子进程可能起不了自己的沙箱，表现就是「Chrome 一闪就没」。特征是日志里的：

```text
Failed to initialize sandbox. sandbox initialization failed: Operation not permitted
ERROR:content/browser/gpu/gpu_process_host.cc] GPU process exited unexpectedly: exit_code=6
FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc] GPU process isn't usable. Goodbye.
```

崩溃报告只会写 `EXC_BREAKPOINT`，看不出真正原因，所以：

- `launch` 会把 Chrome 自己的 stdout / stderr 落到 JSON 里的 `chrome_log` 路径；启动失败时 `hint` 会直接带上日志尾部，**先读日志再下结论**，不要凭进程退出码猜。
- 只有当日志确实证明是这类沙箱问题时，`launch` 才会用 `--no-sandbox` 自动重试一次，并在返回里标 `sandbox: "relaxed"`。这是环境限制，不是浏览器坏了。
- `sandbox` 为 `relaxed` 时必须在对用户的汇报里说明：本次为了在受限环境里跑起来放宽了浏览器沙箱，且用的是独立 profile。
- 环境需要别的补救参数时走 `CDP_BROWSER_ARGS`（例如容器里 `--disable-dev-shm-usage`），不要改脚本。

## 标准流程

### 1. 确认启动方式并拉起项目

先查看项目已有的启动脚本、开发说明或测试命令，确定最小可运行路径。

优先：

- 使用已有 `dev` / `start` / `preview` / `test:e2e` 脚本
- 记录实际访问地址、账号前提和必要环境变量

如果项目已在运行，可直接复用，不要重复启动多个实例。

### 2. 按能力阶梯建立证据通道

先探测，再决定用哪个档位；打开页面前就把监听挂上，不要等到失败后再补采：

- `console`
- `pageerror`
- `requestfailed`
- 关键 `response`

必要时补充：

- 截图
- DOM 快照
- URL / local storage / cookie / 关键状态值

实例不稳定的环境里，每轮复现前先用 `status` 确认通道仍然可用；返回 `stale` 就重新 `launch`，不要对着已经消失的端口空转。

## 3. 自动复现问题

根据用户描述自行操作页面，尽量把复现路径结构化记录出来：

- 访问哪个页面
- 点击或输入了什么
- 在哪一步出现异常
- 异常发生前后收到了哪些日志或请求结果

如果首次复现失败，应先调整自动化步骤或补充观测点，而不是立刻转去改代码。

### 4. 先总结证据，再读代码

在查看实现前，先把自动化运行中已经确认的事实讲清楚，例如：

- 哪一步稳定触发问题
- 哪条报错最关键
- 哪个请求失败或返回异常
- 哪个组件状态和预期不一致

然后再根据这些事实去定位代码路径与修复点。

### 5. 修复后自动回归

完成修改后，必须重新运行自动化步骤验证：

- 原问题不再出现
- 关键日志恢复正常
- 没有引入新的明显报错

如果修复后仍无法用自动化复测通过，不要直接把问题标记为解决。

## 行为约束

1. 不要启动 `debug-steps` 用的本地日志服务器。
2. 不要把“我看代码觉得这里像有问题”当成首轮定位结果。
3. 不要在没有自动化证据的情况下直接开始正式修复。
4. 如果自动化路径被真实阻塞，要明确停止原因，并建议切换 skill，而不是继续模糊推进。
5. 不要跳过档 1 的探测直接上 Playwright；确实要跳档时，写清楚为什么。
6. 不要读写、清空或删除用户的默认浏览器 profile；档 2 只用独立目录。
7. 档 2 起的实例在排障结束时用 `stop` 收尾，不要留下常驻的调试端口。
8. 启动失败时先读 `chrome_log` 再判断原因；`sandbox` 为 `relaxed` 时必须在汇报里说明放宽了浏览器沙箱。

## 推荐输出骨架

在 `debug-auto` 中，尽量按这个顺序对用户汇报：

1. `我已经拉起了项目，本次走的是第 N 档浏览器通道`
2. `自动化运行里确认到的现象`
3. `这些现象对应的代码路径`
4. `我准备修改或已经修改的点`
5. `自动回归验证结果`
