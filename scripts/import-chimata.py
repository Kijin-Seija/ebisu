#!/usr/bin/env python3
"""将经审阅的 chimata 源转换为独立内置技能包；只用于维护，不参与运行时。"""
from pathlib import Path
import json, re, subprocess, sys

repo = Path(__file__).resolve().parent.parent
source = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo.parent / 'chimata'
revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
out = repo / 'resources' / 'skills'
templates = source / 'workflow-templates'

def variable(name, description, default=None, kind='string', sensitive=False, scopes=None, required=False):
    item = dict(name=name, description=description, type=kind, required=required, sensitive=sensitive, scopes=scopes or ['skill','terminal','project'])
    if default is not None: item['defaultValue'] = default
    return item

def normalize(text, name):
    text = text.replace('${SKILL_NAME}', name).replace('${FRONTMATTER_EXTRA}\n', '')
    text = text.replace('${SKILLS_DIR}/'+name+'/bin/', '${SKILL_DIR}/scripts/')
    text = text.replace('${SKILL_DIR}/bin/', '${SKILL_DIR}/scripts/')
    text = text.replace('bin/push-code-run.sh', 'scripts/push-code-run.sh').replace('bin/push_code_webhook.py','scripts/push_code_webhook.py')
    text = text.replace('${HOST_SHORT}', '${HOST}').replace('${HOST_BRANCH_PREFIX}', '${HOST_KEY}').replace('${HOST_MR_PREFIX}', '[Ebisu]')
    text = re.sub(r'\$\{HOST\.grok\.(?:SKILLS_DIR|SKILL_DIR)\}', '~/.grok/skills/'+name, text)
    text = text.replace('${HOST.grok.INVOKE_PREFIX}', '/').replace('${HOST.grok.INVOKE}', '/'+name).replace('${INSTRUCTIONS_PEER_LINES}', '')
    # 全局技能路径不承载业务状态；脚本统一经客户端注入运行上下文。
    marker = re.search(r'\n---\s*\n', text[4:])
    if marker:
        position = marker.end()+4
        text = text[:position] + '\n## Ebisu 运行方式\n\n先读取入口返回的经验与变量。运行工具必须通过 `${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill '+name+' --path "$PWD" --script scripts/脚本名 -- 参数`，不从安装目录推导项目、不直接改写中央文件。\n\n' + text[position:]
    return text

def package(name, template, entry='skill/SKILL.md', extras=None, variables=None, variants=None):
    target = out/name; target.mkdir(parents=True, exist_ok=True)
    files = {}
    def put(relative, content, executable=False):
        p=target/relative; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(content)
        files[relative] = {'executable':True} if executable else {}
    text = normalize((templates/template/entry).read_text(), name)
    put('SKILL.md', text)
    for relative, origin in (extras or {}).items():
        content = (templates/template/origin).read_text()
        put(relative, normalize(content,name) if relative.endswith('.md') else content, relative.startswith('scripts/'))
    if variants:
        for host, origin in variants.items(): put('references/variants/'+host+'.md',normalize((templates/template/origin).read_text(),name))
    description = re.search(r'^description:\s*(.*)$',text,re.M).group(1)
    description = description.replace('${INVOKE}', name).replace('${HOST}', '当前终端')
    description = re.sub(r'\$\{[^}]+\}', '', description).strip()
    manifest = dict(version=1,name=name,description=description,source='chimata@'+revision+':workflow-templates/'+template,files=files,variables=variables or [],dependencies=[])
    if variants: manifest['variants']={host:'references/variants/'+host+'.md' for host in variants}
    def save(): (target/'ebisu.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    save()
    return target,manifest,put,save

package('explain-code','explain-code',extras={'agents/openai.yaml':'codex/agents/openai.yaml'})
package('grill-with-docs','grill-with-docs',extras={'references/CONTEXT-FORMAT.md':'skill/CONTEXT-FORMAT.md','references/ADR-FORMAT.md':'skill/ADR-FORMAT.md','assets/LICENSE':'skill/LICENSE'})
package('karpathy','karpathy',extras={'references/reference.md':'skill/reference.md'})
for name in ['debug-auto','debug-steps','debug-manual']:
    extras={}
    if name=='debug-auto': extras={'scripts/cdp-browser.sh':'common/bin/cdp-browser.sh','scripts/cdp_browser.py':'common/bin/cdp_browser.py'}
    if name=='debug-steps': extras={'references/reference.md':'skill/reference.md','scripts/debug-session.sh':'common/bin/debug-session.sh','scripts/debug_log_server.py':'common/bin/debug_log_server.py'}
    target,manifest,put,save=package(name,'debug','skill/'+name+'/SKILL.md',extras)
    manifest['dependencies']=['python3 >= 3.10'] if extras else []
    if name == 'debug-auto': manifest['variables'] = [variable('CDP_BROWSER','浏览器可执行程序路径（不设置时自动探测）'),variable('CDP_ENDPOINT','已有本机浏览器的 CDP 地址'),variable('CHROME_CDP_PORT','优先探测的 CDP 端口',kind='number')]
    if name == 'debug-steps': manifest['variables'] = [variable('DEBUG_LOG_PORT','本机调试日志监听端口','47821',kind='number')]
    for relative in list(manifest['files']):
        p=target/relative; text=p.read_text()
        text=text.replace('${SKILL_DIR}/reference.md','${SKILL_DIR}/references/reference.md')
        if relative.endswith('.py'):
            text=re.sub(r'def detect_context\([^\n]*\n[\s\S]*?(?=\n\nAGENT_KIND)', '', text)
            text=text.replace('DEFAULT_PORT = 47821', 'DEFAULT_PORT = int(os.environ.get("DEBUG_LOG_PORT", "47821"))')
            text=re.sub(r'AGENT_KIND, PROJECT_ROOT(, SCRIPT_PATH)? = detect_context\(\)',lambda m: 'AGENT_KIND = os.environ.get("EBISU_TERMINAL", "ebisu")\nPROJECT_ROOT = str(Path(os.environ.get("EBISU_PROJECT_ROOT", os.getcwd())).resolve())'+ ('\nSCRIPT_PATH = str(Path(__file__).resolve())' if m.group(1) else ''),text)
        p.write_text(text)
    save()

# Reviewer 的原生能力各不相同，保留对应的文档与真实工具依赖。
extras={'references/reference.md':'skill/reference.md','scripts/reviewer-run.sh':'common/bin/reviewer-run.sh'}
for folder in ['schemas','prompts']:
    for p in (templates/'reviewer/common'/folder).iterdir(): extras[folder+'/'+p.name]=str(p.relative_to(templates/'reviewer'))
variants={host:'skill/variants/'+host+'/SKILL.md' for host in ['codex','claude','grok','workbuddy']}
target,manifest,put,save=package('reviewer','reviewer','skill/variants/codex/SKILL.md',extras,
    [variable('REVIEWER_CODEX_BIN','外部审查用 Codex CLI 路径','codex'),variable('REVIEWER_CODEX_REVIEW_MODEL','外部审查模型；未设置时使用 CLI 默认模型')],variants)
# 默认上下文面向所有终端；Codex 专属流程只保留在 codex 变体里。
base=(target/'SKILL.md').read_text()
base=base.replace('让 Codex 审查任务结果','让独立 reviewer 审查任务结果')
base=base.replace('使用 `spawn_agent(..., fork_turns="none")` 启动全新只读 reviewer subagent。','优先使用宿主提供的全新上下文只读子代理；宿主没有此类工具时，通过 launcher 启动外部独立盲审会话。')
base=base.replace('不要通过 shell 运行 `codex exec` 代替原生 subagent；launcher 只用于兼容和回归测试。','不要用 shell 命令拼一个外部审查者来代替原生子代理；launcher 只用于宿主缺少子代理能力时的兼容模式。')
base=base.replace('使用 `spawn_agent(..., fork_turns="none")` 创建全新 reviewer，并要求其忽略工作流目录、只读检查真实工作区。','使用宿主提供的全新上下文只读子代理（或 launcher 启动的外部盲审会话）检查真实工作区。')
base=base.replace('并通过 `followup_task` 发给同一个 reviewer。','并发送给同一个 reviewer。')
base=base.replace('.codex/plans/','${PLANS_DIR}/')
put('SKILL.md', base)
manifest['description']=manifest['description'].replace('让 Codex 审查任务结果','让独立 reviewer 审查任务结果')
save()
qoder=(target/'references/variants/claude.md').read_text().replace('Claude','Qoder').replace('.claude/', '.qoder/').replace('/reviewer','/reviewer')
qoder=qoder.replace('通过 launcher 执行上下文隔离的独立盲审','优先使用宿主可用的独立只读子代理；宿主不提供此工具时，通过 launcher 执行上下文隔离的独立盲审')
qoder=qoder.replace('通过 launcher 启动全新的外部 Codex 盲审会话。','优先使用宿主提供的全新上下文只读子代理；没有此能力时通过 launcher 启动外部 Codex 盲审会话。外部模式缺少 Codex CLI 时明确报告阻塞。')
put('references/variants/qoder.md', qoder)
manifest['variants']['qoder']='references/variants/qoder.md'
manifest['dependencies']=['python3','外部审查模式需要 Codex CLI；原生子代理模式不需要']
p=target/'scripts/reviewer-run.sh'; text=p.read_text()
text=text.replace('SKILL_CONTAINER_DIR="$(cd "${SKILL_DIR}/../.." && pwd)"\nPLANS_ROOT_NAME="$(basename "${SKILL_CONTAINER_DIR}")"','PLANS_ROOT_NAME=".${EBISU_TERMINAL:?请通过 Ebisu 客户端 run 执行}"')
text=text.replace('${IMPLEMENTATION_LOOP_CODEX_MODEL:-gpt-5.4}', '${IMPLEMENTATION_LOOP_CODEX_MODEL:-}')
# 模型参数缺省时让外部 CLI 决定，不发送空的 --model。
text=text.replace('--model "${CODEX_REVIEW_MODEL}"', '${CODEX_REVIEW_MODEL:+--model "${CODEX_REVIEW_MODEL}"}')
text=text.replace(' -m "${CODEX_REVIEW_MODEL}" -)', ' -)\n  if [[ -n "${CODEX_REVIEW_MODEL}" ]]; then args=("${args[@]:0:${#args[@]}-1}" -m "${CODEX_REVIEW_MODEL}" -); fi')
text=text.replace('local workdir=""','local workdir="${EBISU_PROJECT_ROOT:?缺少项目目录}"')
p.write_text(text); save()

# Push Code：删除后台巡检；保留有界的当前会话 review 闭环。
config=json.loads((templates/'push-code/skill/config-keys.json').read_text())
defaults={'PUSH_CODE_GIT_REMOTE':'origin','PUSH_CODE_TARGET_BRANCH':'main','PUSH_CODE_MR_TITLE_PREFIX':'[Ebisu]','PUSH_CODE_POLL_INTERVAL_SECONDS':'30','PUSH_CODE_REVIEW_TIMEOUT_SECONDS':'3600','PUSH_CODE_GITLAB_INITIAL_REVIEW_GRACE_SECONDS':'60','PUSH_CODE_GITLAB_TOKEN_HEADER_NAME':'PRIVATE-TOKEN','PUSH_CODE_GITLAB_TOKEN_SCHEME':'','PUSH_CODE_GITLAB_SKIP_TLS_VERIFY':'false','PUSH_CODE_REVIEW_APPROVED_STATES':'approved,pass','PUSH_CODE_REVIEW_CHANGES_REQUESTED_STATES':'changes_requested,fail,blocked','PUSH_CODE_REVIEW_PENDING_STATES':'pending,running,queued,waiting'}
labels={'PUSH_CODE_GIT_REMOTE':'Git 远端名称','PUSH_CODE_TARGET_BRANCH':'MR 目标分支','PUSH_CODE_PROJECT_ID':'GitLab 项目 ID 或编码路径','PUSH_CODE_MR_TITLE_PREFIX':'MR 标题前缀','PUSH_CODE_GITLAB_BASE_URL':'GitLab 基础地址','PUSH_CODE_GITLAB_API_TOKEN':'GitLab API token','PUSH_CODE_POLL_INTERVAL_SECONDS':'当前会话 review 查询间隔（秒）','PUSH_CODE_REVIEW_TIMEOUT_SECONDS':'当前会话 review 等待超时（秒）','PUSH_CODE_GITLAB_INITIAL_REVIEW_GRACE_SECONDS':'初始 review 宽限期（秒）','PUSH_CODE_GITLAB_TOKEN_HEADER_NAME':'Token 请求头名称','PUSH_CODE_GITLAB_TOKEN_SCHEME':'Token 认证 scheme','PUSH_CODE_GITLAB_CA_BUNDLE':'自定义 CA 文件路径','PUSH_CODE_GITLAB_SKIP_TLS_VERIFY':'跳过 TLS 验证','PUSH_CODE_GITLAB_EXTRA_HEADER_NAME':'额外认证请求头名称','PUSH_CODE_GITLAB_EXTRA_HEADER_VALUE':'额外认证请求头值','PUSH_CODE_REVIEW_APPROVED_STATES':'通过状态列表，逗号分隔','PUSH_CODE_REVIEW_CHANGES_REQUESTED_STATES':'需修改状态列表，逗号分隔','PUSH_CODE_REVIEW_PENDING_STATES':'等待状态列表，逗号分隔'}
keys=[key for key in config['shared']+config['host_only'] if 'MONITOR' not in key and 'WEBHOOK' not in key and key!='PUSH_CODE_SHARED_CONFIG_PATH']
variables=[variable(key,labels.get(key,key),defaults.get(key),kind='number' if key.endswith('_SECONDS') else 'boolean' if key.endswith('SKIP_TLS_VERIFY') else 'string',sensitive=key.endswith(('API_TOKEN','HEADER_VALUE')),required=key in ['PUSH_CODE_GITLAB_BASE_URL','PUSH_CODE_PROJECT_ID','PUSH_CODE_GITLAB_API_TOKEN']) for key in keys]
for item in variables:
    if item['name'] == 'PUSH_CODE_GITLAB_API_TOKEN': item['scopes']=['skill','project']
target,manifest,put,save=package('push-code','push-code',extras={'references/reference.md':'skill/reference.md','scripts/push-code-run.sh':'common/bin/push-code-run.sh','scripts/push_code_webhook.py':'common/bin/push_code_webhook.py'},variables=variables)
manifest['dependencies']=['git','python3']
p=target/'scripts/push-code-run.sh'; text=p.read_text()
start=text.index('PROJECT_ROOT='); end=text.index('usage()')
text=text[:start]+'''PROJECT_ROOT="${EBISU_PROJECT_ROOT:?请通过 Ebisu 客户端 run 执行}"
cd "${PROJECT_ROOT}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
GITLAB_HELPER="${SCRIPT_DIR}/push_code_webhook.py"

'''+text[end:]
start=text.index('require_config_file()'); end=text.index('require_git_repo()')
text=text[:start]+'''# 变量由 Ebisu 按项目 > 终端 > 技能解析，不读取或执行 env 配置文件。
load_config() {
  : "${PUSH_CODE_GIT_REMOTE:=origin}"
  : "${PUSH_CODE_TARGET_BRANCH:=main}"
  : "${PUSH_CODE_MR_TITLE_PREFIX:=[Ebisu]}"
  : "${PUSH_CODE_POLL_INTERVAL_SECONDS:=30}"
  : "${PUSH_CODE_REVIEW_TIMEOUT_SECONDS:=3600}"
}

'''+text[end:]
start=text.index('monitor_enabled()'); end=text.index('default_title()')
text=text[:start]+text[end:]
text=re.sub(r'^  register_mr_monitor_mapping.*\n','',text,flags=re.M)
text=text.replace('project_root="$(cd "${SKILL_DIR}/../../.." && pwd -P)"','project_root="${PROJECT_ROOT}"')
text=text.replace('${PUSH_CODE_POST_REBASE_STATE_FILE:-${SKILL_DIR}/.post-rebase-required}', '${PUSH_CODE_POST_REBASE_STATE_FILE:-${PROJECT_ROOT}/.git/push-code-post-rebase-required}')
start=text.index('cmd_config()'); end=text.index('main()',start)
text=text[:start]+'''cmd_config() {
  echo '配置由 Ebisu 变量界面管理；敏感值不会打印到配置诊断输出。'
}

'''+text[end:]
p.write_text(text)
for relative in ['SKILL.md','references/reference.md']:
    p=target/relative; text=p.read_text()
    text=text.split('## 可选 monitor 命令')[0]
    # 保留业务指导，剔除已废弃的配置文件/后台功能段落与示例块。
    paragraphs=re.split(r'(\n\s*\n)',text)
    text=''.join(part for part in paragraphs if not re.search(r'monitor|MR_MONITOR|SHARED_CONFIG|config\.env|共享层|宿主层|安装器|init\.sh|MONITOR_',part,re.I))
    text=text.replace('`${SKILL_DIR}/reference.md`','`${SKILL_DIR}/references/reference.md`')
    if relative == 'references/reference.md': text = '# Push Code 参考\n\n运行依赖 Git 与 Python 3。GitLab 认证、分支和项目设置统一由 Ebisu 变量管理。\n\n' + text[text.index('## launcher 命令'):]
    text = re.sub(r'\n{3,}', '\n\n', text)
    if relative == 'SKILL.md':
        text = text.replace('开始前必须检查：\n\n', '开始前必须检查：Git/Python 依赖可用，当前目录为已有项目，Git 工作树干净且不在目标分支，GitLab 必填变量已配置。\n\n')
        text = text.replace('进入该 workflow 后，优先复用安装后的 launcher 和 helper，而不是在对话里手写 `curl`：\n\n', '进入该 workflow 后，使用 scripts/push-code-run.sh 和 scripts/push_code_webhook.py；详细参数参见 references/reference.md。不要在对话里重写 GitLab 客户端。\n\n')
    text+='\n\n## Ebisu 配置与运行\n\nGitLab 地址、token、项目 ID、分支、认证及有界轮询参数由技能变量界面管理，项目覆盖终端，终端覆盖技能。凭据不写入包或项目。使用客户端 run 注入配置后运行 scripts/push-code-run.sh；项目根目录由 EBISU_PROJECT_ROOT 显式传入。保留当前会话有超时上限的 review 跟进，不创建后台进程、定时唤醒或自动通知。\n'
    p.write_text(text)
save()

# Vitest 全局队列与旧 chimata 包共用锁协议；两个控制参数仅允许技能层。
target,manifest,put,save=package('vitest-safe','vitest-safe',extras={'scripts/vitest-safe':'common/bin/vitest-safe'},variables=[variable('VITEST_SAFE_MAX_CONCURRENT','全局测试最大并发；不设置时沿用现有配置，无配置时为 2',kind='number',scopes=['skill']),variable('VITEST_SAFE_LOCK_DIR','全局锁目录；不设置时沿用现有配置',scopes=['skill'])])
manifest['dependencies']=['python3']
p=target/'scripts/vitest-safe'; text=p.read_text()
text=text.replace('''        raise RuntimeError(
            f"未找到配置文件: {path}\\n"
            "请先运行 workflow-templates/vitest-safe/init.sh 安装全局 skill。"
        ) from None''','''        config = {"max_concurrent": 2, "lock_dir": str(path.parent / "locks")}''')
text=text.replace('max_concurrent = int(config["max_concurrent"])','max_concurrent = int(os.environ.get("VITEST_SAFE_MAX_CONCURRENT", config["max_concurrent"]))')
text=text.replace('raw_lock_dir = config.get("lock_dir")','raw_lock_dir = os.environ.get("VITEST_SAFE_LOCK_DIR") or config.get("lock_dir")')
p.write_text(text)
p=target/'SKILL.md'; text=p.read_text(); start=text.index('## 强制执行方式')
text=text[:start]+'''## 强制执行方式

所有项目测试均通过客户端运行中央队列包装器：

```sh
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill vitest-safe --path "$PWD" --script scripts/vitest-safe -- -- pnpm test
```

不要直接执行测试命令，不要为绕过队列额外启动完整套件。等待 slot 时继续等待已有进程。包装器采用内核文件锁，进程结束或崩溃时自动释放。

共享队列兼容已有 chimata-vitest-safe 配置与锁目录；没有配置时最大并发为 2。全局并发上限与锁目录通过技能层变量设置，不允许终端或项目覆盖。若依赖或配置不可用，明确报告，不退回直接测试。
'''; p.write_text(text); save()

# 引用归一化，保留原始内容与许可证，但不残留旧安装结构。
for name in ['karpathy','grill-with-docs','explain-code','reviewer']:
    for p in (out/name).rglob('*.md'):
        text=p.read_text()
        for filename in ['reference.md','CONTEXT-FORMAT.md','ADR-FORMAT.md']:
            text=text.replace('${SKILL_DIR}/'+filename,'${SKILL_DIR}/references/'+filename)
            text=text.replace('('+filename+')','(references/'+filename+')')
            text=text.replace('`'+filename+'`', '`references/'+filename+'`')
        p.write_text(text)
print('Imported 9 self-contained packages from chimata@'+revision)

for name in ['push-code','debug-auto','debug-steps','reviewer']:
    for p in (out/name).rglob('*.md'):
        text=p.read_text()
        text=re.sub(r'\$\{SKILL_DIR\}/scripts/([a-zA-Z0-9_.-]+)(?= (?:preflight|push|rebase-target|create-mr|status|threads|wait-review|post-rebase-check|comment|note|resolve-thread|reopen-thread|detect|launch|start|stop|reset|show|cleanup|blind|followup|dispute|resume)\b)',lambda m: '${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill '+name+' --path "$PWD" --script scripts/'+m.group(1)+' --',text)
        p.write_text(text)
