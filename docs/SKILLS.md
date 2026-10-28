# 技能管理

技能是全局定义，按已绑定终端安装轻量入口。所有初始上下文、参考资料、脚本和工具集中保存在应用数据目录的 `.ebisu/skills/<技能 UUID>/`；终端目录不复制业务文件，也不保存经验、配置或密钥。共享客户端位于 `.ebisu/tools/skills`。

## 包格式

创建技能包目录，包含 `ebisu.json` 和声明的文件：

```text
example-skill/
  ebisu.json
  SKILL.md
  scripts/check.sh
  references/guide.md
```

```json
{
  "version": 1,
  "name": "example-skill",
  "description": "具体用途和适用时机",
  "files": {
    "SKILL.md": {},
    "scripts/check.sh": { "executable": true },
    "references/guide.md": {}
  },
  "variables": [
    {
      "name": "CHECK_MODE",
      "description": "检查模式",
      "type": "string",
      "required": false,
      "sensitive": false,
      "scopes": ["skill", "terminal", "project"],
      "defaultValue": "normal"
    }
  ],
  "dependencies": ["bash"]
}
```

`SKILL.md` 必须有 YAML frontmatter，声明与清单一致的 `name` 和有效的 `description`。名称只能包含小写字母、数字和连字符，最多 63 字符；`ebisu-` 名称保留给管理技能。`files` 最多 256 项，文件内容合计最多 8 MiB。路径必须相对技能根目录，拒绝 `..`、绝对路径、反斜杠和符号链接。UTF-8 为默认编码；二进制素材在清单声明 `encoding:"base64"`，客户端会编码上传。

确有宿主工具差异时，`variants` 将终端 ID 映射到已声明的文本文件。普通技能共用 `SKILL.md`。元数据可使用 `agents/openai.yaml`，Codex 的隐式调用设置会随入口安装。

源文件创建后不可通过 API 或界面修改；经验和变量独立管理。外部手动修改源文件会在读取或执行时检测到并报错。创建不会自动安装，也不会执行安装脚本。

## 终端客户端

绑定终端后会获得 `ebisu-skill-create` 与 `ebisu-skill-discuss`。创建技能必须由用户显式声明使用创建技能；该边界通过技能说明及宿主支持的显式调用策略表达，不把接口参数当作用户授权证明。

在入口中找到客户端绝对路径，运行：

```sh
'/应用数据目录/.ebisu/tools/skills' --terminal codex protocol
'/应用数据目录/.ebisu/tools/skills' --terminal codex create --package /absolute/example-skill --request-id stable-creation-id
'/应用数据目录/.ebisu/tools/skills' --terminal codex install --skill example-skill
'/应用数据目录/.ebisu/tools/skills' --terminal codex context --skill example-skill --path "$PWD"
'/应用数据目录/.ebisu/tools/skills' --terminal codex run --skill example-skill --path "$PWD" --script scripts/check.sh -- argument
```

客户端 `targets` 列出可配置的终端与已有项目 ID。`context.missingVariables` 列出尚需填写的必填变量，不妨碍读取指导；执行脚本前必须配置完整。

创建重试复用同一 `request-id`；同标识、不同内容返回冲突。名称冲突不会覆盖已有技能。`--data -` 从 stdin 读取 JSON；不要把密钥直接放进命令参数或文档。

初始文本可使用 `${SKILL_DIR}`、`${SKILLS_DIR}`、`${HOST}`、`${HOST_KEY}`、`${INVOKE}`、`${EBISU_CLIENT}` 等运行占位符。客户端 `context` 和 `file` 按宿主渲染后返回文本，磁盘源文件保持不变。迁移包同时兼容宿主条件块；新技能优先使用独立的终端变体。

`run` 要求当前目录匹配已有项目，只允许运行清单中 `scripts/` 下的可执行资源，以项目根目录为 cwd。脚本从 `EBISU_PROJECT_ROOT`、`EBISU_SKILL_DIR`、`EBISU_TERMINAL` 获取上下文；不得从全局安装目录猜测项目。运行产物放项目运行目录或按项目隔离的临时目录，不写回技能源文件。操作权限仍取决于用户当前任务，技能安装不代表授权推送或发送消息。

## 共享经验

- 技能经验：归属技能，适用于所有项目。
- 项目经验：归属技能和一个已有项目，同项目的其他技能不自动读取。
- 两类经验均跨终端、跨模型共享。运行时匹配真实路径下最深的已注册项目。
- 记录必须包含 `content` 和依据 `evidence`；用户明确指定的长期规范可以用该用户指令作为依据，模型自行总结的规则必须有实际验证依据。不得记录推测、凭据或单纯任务流水账。
- 用户明确要求“记住”、以后遵循某项规范或偏好时，agent 必须先成功调用 `experience-add` 再确认已记住；写入失败不得只口头承诺。
- `experience-add` 默认使用当前工作目录解析项目作用域；未匹配已注册项目时返回错误，不静默降级为全局经验。只有用户明确要求跨项目通用时才使用 `--scope skill` 创建技能级经验。
- 模型修改保留 ID，并增加 revision；修改/删除需提交当前 revision，冲突返回 409。
- 界面只允许查看、复制 ID、选择多条、生成讨论指令和删除，不提供手工编辑正文。

`ebisu-skill-discuss ["id-1","id-2"] 用户意见` 先读取指定经验，再按用户要求解释、修改、新增或删除。复制讨论指令不会发送到其他会话。

移除项目时，项目经验和变量覆盖随数据库外键删除；技能经验、中央文件和其他项目数据保留。

## 分层变量与密钥

变量定义由 agent 新增/删除，声明名称、说明、string/number/boolean 类型、必填、敏感标记和允许层级。全局层始终存在；`scopes` 可自由组合为全局+项目、全局+终端或三者全开。终端层与项目层互相独立：项目配置对所有终端一致，终端配置不受项目影响。界面只能编辑值和清除单层配置；同一个变量会同时展示全局、已安装该技能的终端以及当前筛选项目的输入框。

生效优先级是项目 > 终端 > 全局，未开放的层级不参与。空字符串是显式取值，`null` 表示清除当前层。系统运行变量（包括 HOME、PATH、CODEX*HOME、NODE_OPTIONS 和 EBISU* 前缀）禁止由技能覆盖。

敏感值不接受包默认值，单独设置后由 Electron safeStorage 加密保存。系统密钥服务不可用时拒绝敏感值操作，不回退明文。普通快照、详情、变量列表和 `context` 不返回敏感值；界面的显示按钮或 `variable-reveal` 显式读取指定层。`run` 单独取得执行配置，只注入子进程，不将配置打印到 stdout 或写入项目文件。

## 内置迁移

内置九个技能来自清单中记录的 chimata Git 版本。`scripts/import-chimata.py [source-directory]` 可重现转换；运行时不依赖源仓库。Bunraku 不在迁移范围。

Push Code 保留会话内有超时的 CI/review 跟进，删除后台 monitor、注册映射、唤醒与通知。凭据、项目 ID、分支和认证参数使用统一变量表单。Reviewer 保留宿主变体；外部模式依赖 Codex CLI，模型未设置时使用 CLI 默认值。Vitest Safe 兼容现有共享队列配置，无配置时并发为 2；队列上限和锁目录只允许技能层配置。

源码运行时会登记 `resources/skills/` 中尚未创建的内置包，不自动安装业务技能。当前安装包排除此目录，新安装不附带默认业务技能；已有数据库中的技能继续保留。已有绑定终端只补齐管理技能；冲突保留原配置并在设置中显示需修复。卸载入口不删除中央技能；解绑终端移除全部受管入口，修改过的入口会阻止解绑，避免静默丢失改动。
