# 创建 Ebisu 通用技能

只在用户显式声明使用 ebisu-skill-create 时创建技能。普通编码、解释代码、遇到重复工作或讨论如何创建技能，不构成创建请求。

1. 先运行入口给出的客户端 `protocol`，读取当前技能规范和参数；用 `list` 检查名称冲突。
2. 创建小写字母/数字/连字符命名的独立技能包。`SKILL.md` frontmatter 必须包含匹配的 name 和简洁准确的 description；正文保存必要的非显然指导，细节按需放入 references，工具放入 scripts，输出素材放入 assets。
3. `ebisu.json` 声明 version:1、name、description、files，以及所需的 variables、dependencies、variants。files 的键是包内相对路径，值是 `{executable?:boolean,encoding?:"utf8"|"base64"}`。不允许路径越界、符号链接或 ebisu- 保留名称。
4. 环境变量定义包含 name、description、type、required、sensitive、scopes；scopes 为 skill/terminal/project 的组合，skill 表示全局层且必须存在，终端层与项目层互相独立。仅按项目变化的凭据用 skill+project，仅按宿主环境变化的配置用 skill+terminal。默认值只放非敏感值；密钥用 variable-set 单独配置。生效顺序为项目 > 终端 > 全局。
5. 脚本从 EBISU_PROJECT_ROOT 读取项目目录，从 EBISU_SKILL_DIR 读取中央技能目录。不要从全局安装目录猜测项目，不要把项目运行状态写回不可变技能目录。配置经客户端 run 注入子进程，不 source 未验证的配置文件。
6. 为本次创建生成一次稳定 request-id，重试复用。执行 `create --package /绝对技能包目录 --request-id 本次唯一标识`。创建只进入技能库；需要安装时明确执行 install，目标只能是已绑定终端。
7. 返回技能 ID、用途、依赖和验证结果。不要修改已创建的初始文件。使用后的真实经验单独通过 experience-add 沉淀，并提供 evidence。项目专属经验带 folderId，通用经验不带。

最小清单示例：
```json
{"version":1,"name":"example-skill","description":"具体用途与适用时机","files":{"SKILL.md":{},"scripts/check.sh":{"executable":true}},"variables":[],"dependencies":[]}
```
