---
name: debug-steps
description: 当用户显式调用 ${INVOKE}，或要求使用 "debug steps"、"debug-steps"、"我手动操作你看日志"、"按步骤排查前端 bug" 时使用。适用于用户手动操作页面并反馈现象，agent 启动本地微型日志服务器自动收集浏览器日志，随后基于最新日志建立证据链并分析问题的场景。
---


## Ebisu 运行方式

先读取入口返回的经验与变量。运行工具必须通过 `${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/脚本名 -- 参数`，不从安装目录推导项目、不直接改写中央文件。

# Debug Steps

## 触发条件

只在用户明确要求时启用，例如：

- `使用 debug steps`
- `${INVOKE}`
- `请走 debug-steps，我来手动操作`
- `你开日志，我按步骤复现给你看`

如果用户没有显式要求，不要默认启用。

## 目标

该 skill 用于让用户手动完成页面操作，但由 agent 自动管理同一轮调试证据：

- 启动本地日志服务器
- 直接把临时调试上报代码加到项目里，让浏览器把调试信息写入同一个临时 log 文件
- 每次新一轮复现前清空旧日志
- 先读取本轮最新日志，再进入代码定位与修复

## 核心原则

### 日志优先

一旦进入 `debug-steps`，日志不是可选参考，而是默认的一手证据来源。

这意味着：

- 在读取当前最新日志前，不要直接根据代码逻辑下结论
- 在日志证据不足时，先补采日志或补打点，再继续分析
- 代码阅读的作用是解释日志、定位实现位置、验证修复，不是替代日志猜测根因

### 用户负责操作，agent 负责取证

在这个模式里：

- 用户负责按说明手动复现、补充操作步骤和主观现象
- agent 负责把临时调试代码接入项目、清理旧日志、收集新日志、读取证据并建立判断

不要把“用户说大概点了几下页面”直接当成充分证据；仍然要以本轮新日志为准。

### 优先直接改项目，不要让用户手动粘贴调试代码

进入 `debug-steps` 后，默认做法是由 agent 直接修改项目，把本轮需要的调试上报代码接到真实页面路径里。

这意味着：

- 不要把“请打开控制台粘贴这段脚本”当成默认方案
- 优先在项目代码里加入临时 `fetch(endpoint)`、事件打点、请求结果记录或状态快照上报
- 只有在当前环境明确不适合改代码时，才退回到让用户临时粘贴控制台代码，并且要说明原因

### 临时调试代码必须回收

`debug-steps` 中加到项目里的调试代码默认都是临时证据采集代码。

因此：

- 打点范围应尽量收敛，只覆盖当前怀疑路径
- 日志前缀和字段应清晰，便于 agent 读取
- 用户确认问题修复后，要移除本轮临时调试代码，再执行会话清理

### 修复前必须完成证据闭环

进入修复之前，必须已经拿到能够证明判断成立的打印信息或日志数据。

如果当前证据还不足，允许做的下一步是补日志、补打点、要求重新复现；不允许把代码修改当成“验证猜想”的第一手段。

## 标准流程

### 1. 启动会话

首次进入该 workflow 时，优先执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- start
```

如需显式命名会话，可加：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- start --session <topic-slug>
```

读取返回 JSON 中的：

- `endpoint`
- `clear_url`
- `log_file`
- `server_log`

随后把 `endpoint` 提供给用户，指导浏览器或页面脚本把调试信息写进去。

拿到 `endpoint` 后，优先由 agent 直接修改项目，把日志上报逻辑接到当前真实代码路径中，而不是让用户手动在控制台粘贴一段上报脚本。

### 2. 先获取一份新的可用日志

启动会话后，如果当前还没有围绕该问题的新日志，先把最小必要的临时调试代码加进项目，再要求用户复现并写日志，然后继续分析。

至少应确认以下信息已经进入日志：

- 复现动作或触发路径
- 关键报错 / warning / failed request / 状态异常
- 能帮助定位上下文的必要字段，例如页面 URL、接口名、参数、返回值、堆栈、关键状态

### 3. 新一轮提问前清空旧日志

如果用户在同一个排障线程里追加问题、补充复现条件、或要求“重新看一下”，先执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- reset
```

然后再让用户重新操作页面、重新写日志。

不要把上一轮遗留日志和本轮新问题混在一起分析。

### 4. 读取日志并排查

优先使用以下命令读取当前日志：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- show
```

如果需要更多元信息，再执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- status
```

必要时直接读取 `status` 返回中的 `log_file`。

读取日志后，先完成这两个动作，再进入代码定位：

1. 提炼 `日志证据`
2. 基于证据决定下一步

如果日志还不够，先补充日志字段或补充复现，再继续。

### 5. 用户确认修复后清理

当用户明确表示问题已修复、无需继续保留日志时，执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- cleanup
```

这一步之前，先移除本轮加到项目里的临时调试代码。

随后再删除 log 文件、状态文件和后台微型服务器，避免残留临时调试数据。

## 资源

- launcher: `${SKILL_DIR}/scripts/debug-session.sh`
- server: `${SKILL_DIR}/scripts/debug_log_server.py`
- 参考说明: `${SKILL_DIR}/references/reference.md`

除非 launcher 无法使用，否则不要手工改写成另一套临时服务器方案。

## 行为约束

1. 不能把“我看了代码，感觉这里像有问题”当作首轮排查结果。
2. 不能在没有读取最新日志的情况下直接给出根因判断。
3. 不要默认要求用户去控制台粘贴调试代码；优先由 agent 直接修改项目接入日志上报。
4. 如果最新日志信息不足，下一步优先是继续补项目内的临时打点或指导补充复现，而不是继续扩大代码阅读范围。
5. 用户确认修复后，要移除本轮临时调试代码，再清理日志会话。
6. 在打印信息或日志数据尚未证明判断正确之前，不能开始正式修复。
7. 修复方案必须能回扣到日志中的异常现象。

## 推荐输出骨架

在 `debug-steps` 中，尽量按这个顺序对用户汇报：

1. `我先看了这轮最新日志`
2. `日志里已经确认的现象`
3. `基于这些现象，我准备去看的代码路径`
4. `这些打印信息为什么足以支持当前判断`
5. `如果证据还不够，需要补什么日志`
