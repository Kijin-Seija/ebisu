# Debug Steps 参考

## 生命周期约定

该工作流围绕“一个调试会话对应一个临时 log 文件”展开。

控制器必须遵循以下规则：

1. 首次进入 `debug-steps` 会话时，执行安装后的 launcher，例如 `${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- start`。
2. 启动会话后，如果当前还没有本轮问题的新日志，先把最小必要的临时调试上报代码加到项目里，再要求用户复现并重新写日志；不要在没有读取最新日志的情况下直接基于代码猜根因。
3. 在同一个会话中，每次新的用户追加提问前，如果用户补充了新的复现条件、追加了新的问题，或要求“重新看一下”，先执行安装后的 launcher `reset`，再让用户重新上报日志。
4. 需要查看日志内容时，优先执行安装后的 launcher `show`，必要时直接读取 `status` 返回中的 `log_file`。
5. 读取日志后，先提炼“日志证据”，再决定是否去读代码；代码阅读应服务于解释日志与验证修复，而不是绕过日志直接下结论。
6. 在打印信息或日志数据尚未证明当前判断正确之前，不要开始正式修复；先补日志、补打点或补复现。
7. 只要问题还未确认修复，就持续复用同一个会话和同一个 log 文件路径。
8. 用户确认问题已解决后，先移除本轮加到项目里的临时调试代码，再执行安装后的 launcher `cleanup`，删除 log 文件、状态文件和后台服务。

不要在普通任务中默认启动该服务器；只有用户显式要求使用 `debug steps` / `debug-steps` / “我手动操作你看日志” 时才触发。

## 排查约束

进入该工作流后，默认采用“日志优先，代码随后”的顺序：

1. 先确认已经拿到本轮问题的最新日志。
2. 先默认由 agent 直接把调试上报代码加到项目中，不要把“去控制台粘贴这段脚本”当成默认交互方式。
3. 如果确实无法安全改项目代码，才退回到让用户临时粘贴控制台代码，并明确说明原因。
4. 先总结日志中已经发生的事实，例如：
   - 哪个动作触发问题
   - 哪个请求失败
   - 哪个状态值异常
   - 哪段报错或堆栈最关键
5. 再把这些事实映射到代码路径、数据流或状态机。
6. 再确认这些打印信息是否已经足以证明当前判断，而不只是“看起来合理”。
7. 如果事实还不够，优先继续补项目内临时日志字段或补复现，而不是继续扩大代码阅读范围，更不能直接开始修复。

如果 agent 当前没有拿到有效日志，只能把后续内容表述为“待验证假设”，不能当作已经定位完成的结论。
如果 agent 当前还没有拿到能够证明判断成立的打印数据，也不能把代码修改作为正式修复动作。

## Launcher 命令

### `start`

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- start
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- start --session login-bug
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- start --host 127.0.0.1 --port 47821
```

返回 JSON，包含：

- `status`: `ready`
- `endpoint`: 浏览器写日志地址，形如 `http://127.0.0.1:47821/log`
- `clear_url`: 清空日志地址
- `log_file`: 当前会话临时日志文件
- `server_log`: 服务自身日志
- `state_dir`: 会话状态目录
- `healthy`: 当前服务是否可达

如果同一会话已经存在且服务仍健康，`start` 不会重复启动新进程，而是直接返回当前状态。

如果启动失败，runtime 目录不会被立即删除；返回 JSON 会保留：

- `server_log`
- `state_dir`
- `server_log_tail`（若有）

### `status`

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- status
```

返回与 `start` 类似的 JSON；如果会话不存在，则返回：

```json
{"status": "missing"}
```

### `reset`

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- reset
```

清空当前会话的 log 文件，但保留服务进程和 log 文件路径，便于同一次调试线程继续复用。

### `show`

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- show
```

直接输出当前 log 文件内容，便于 agent 读取与分析。

agent 读取 `show` 后，建议至少显式产出以下两类信息：

- `日志证据`：当前已经确认的现象
- `证据结论`：这些打印信息是否已经足以支撑当前判断
- `下一步动作`：去看哪段代码，或要求补什么日志

### `cleanup`

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill debug-steps --path "$PWD" --script scripts/debug-session.sh -- cleanup
```

停止后台服务并删除当前会话目录下的：

- `debug.log`
- `session.json`
- `server.pid`
- `server.log`

## HTTP 接口

### `GET /health`

返回健康状态与当前会话元信息。

### `GET /session`

返回当前会话元信息，便于浏览器侧确认端口和目标文件。

### `POST /log`

支持两种 body 形式：

1. `application/json`
2. `text/plain`

JSON body 支持字段：

- `content`: 要写入日志的正文
- `mode`: `append` 或 `replace`，默认 `append`

示例：

```json
{
  "mode": "append",
  "content": "[click] checkout failed"
}
```

如果 JSON body 没有 `content`，服务会把整个 JSON 对象序列化后写入日志，方便直接上报结构化调试信息。

### `POST /clear`

清空日志文件内容。

### CORS

服务默认返回：

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`

## 浏览器接入建议

推荐由 agent 直接在项目里封装一个轻量 helper，把关键事件、接口响应、报错堆栈、上下文参数写到同一 log 文件，而不是默认让用户去控制台临时粘贴。例如：

```js
async function pushDebugLog(payload) {
  await fetch(window.__DEBUG_ENDPOINT__, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "append",
      content: JSON.stringify(payload, null, 2),
    }),
  });
}
```

在用户重新描述问题或切换排查方向后，控制器应先调用 `reset`，再让用户重新复现，以免旧日志干扰判断。

这些调试上报代码默认属于临时证据采集代码。问题确认修复后，应从项目中移除，不要残留到最终提交。

推荐把日志内容组织成“可用于定位”的结构，而不只是零散文本。例如尽量包含：

- 页面或路由
- 用户动作
- 关键状态快照
- 请求 URL / method / payload / response
- 报错 message / stack

这样 agent 更容易先从日志建立证据链，再去代码里验证。
