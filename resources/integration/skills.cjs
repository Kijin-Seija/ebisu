#!/usr/bin/env node
/* 终端客户端仅连接本机已认证服务；脚本在调用方进程中运行，不向 renderer 开放执行。 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const PROTOCOL = `Ebisu skills protocol v1
Usage: skills --terminal <codex|workbuddy|claude|grok|qoder|qodercn|dsh|antigravity> <command> [options]
  protocol
  list
  targets   (bound terminals and existing projects with IDs)
  detail --skill <id|name>
  create --package <directory> --request-id <stable-id>
  install|uninstall --skill <id|name>
  context --skill <id|name> --path <current-directory>
  file --skill <id|name> --file <relative-text-file>
  run --skill <id|name> --path <current-directory> --script scripts/file -- [args...]
  experiences --ids '<JSON id[]>'
  experience-add [--path <current-directory>] [--scope skill] --data <JSON file|->
    {skillId,folderId?:existing-project-id,content,evidence}; defaults to process.cwd() project scope; --scope skill creates a global experience
  experience-update --id <id> --revision <n> --data <JSON file|->
    {content,evidence}; ID remains unchanged, stale revision returns 409.
  experience-delete --id <id> --revision <n>
  variables --skill <id|name> --data <JSON file|->
    {folderId?:existing-project-id}; each variable returns global, installed-terminal and project layers.
  variable-reveal --skill <id|name> --name <NAME> --data <target JSON file|->
  variable-add --skill <id|name> --data <JSON file|->
    {name,description,type:string|number|boolean,required,sensitive,scopes,defaultValue?}
  variable-delete --skill <id|name> --name <NAME>
  variable-set --skill <id|name> --name <NAME> --data <JSON file|->
    {target:{scope,terminal?,folderId?},value:string|null}; null clears only that layer.

Creation: ONLY when the user explicitly invokes ebisu-skill-create.
Directory contains ebisu.json {version:1,name,description,files:{relative:{executable?,encoding?}},variables?,variants?,dependencies?} and SKILL.md with matching YAML name/description.
Never modify initial files. Variables: global(skill) always exists; scopes may combine global+project, global+terminal, or all three. Resolution is project > terminal > global. Empty string is a value.
Only agents add/delete definitions; users and agents edit values. Secrets are set separately, never in package defaults.
Use evidence-backed experience only. Skill experience omits folderId; project experience uses context.folder.id.
Every response is JSON except file/protocol. IDs and revisions come from the server. HTTP failures are nonzero; never ignore them.
The runtime flag is supplied by the installed launcher; do not expose runtime.json or tokens.
`
function fail(message) {
  throw new Error(message)
}
function safe(base, relative) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail('Unsafe relative path')
  let current = base
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      fail('Symlink resources are not allowed')
  }
  return current
}
async function main() {
  const argv = process.argv.slice(2)
  const separator = argv.indexOf('--')
  const scriptArgs = separator < 0 ? [] : argv.splice(separator).slice(1)
  const opts = {}
  let command
  while (argv.length) {
    const arg = argv.shift()
    if (arg.startsWith('--')) {
      if (!argv.length) fail(`Missing value: ${arg}`)
      opts[arg.slice(2)] = argv.shift()
    } else if (!command) command = arg
    else fail(`Unexpected argument: ${arg}`)
  }
  if (command === 'protocol') {
    process.stdout.write(PROTOCOL)
    return
  }
  if (!opts.runtime || !opts.terminal) fail('Use the installed skills launcher with --terminal')
  const runtime = JSON.parse(fs.readFileSync(opts.runtime, 'utf8'))
  if (
    !Number.isInteger(runtime.port) ||
    runtime.port < 1 ||
    runtime.port > 65535 ||
    typeof runtime.token !== 'string'
  )
    fail('Invalid service discovery file')
  const request = async (action, data = {}) => {
    let response
    try {
      response = await fetch(`http://127.0.0.1:${runtime.port}/v1/skills/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, terminal: opts.terminal }),
        signal: AbortSignal.timeout(15000)
      })
    } catch {
      fail('Ebisu service unavailable; start Ebisu and retry. No cached context was used.')
    }
    const result = await response.json()
    if (!response.ok) fail(`${response.status}: ${result.error || 'Skill request failed'}`)
    return result
  }
  const data = () => {
    if (!opts.data) fail('--data JSON file or - is required')
    return JSON.parse(fs.readFileSync(opts.data === '-' ? 0 : opts.data, 'utf8'))
  }
  let result
  switch (command) {
    case 'create': {
      if (!opts.package || !opts['request-id'])
        fail('--package and stable --request-id are required')
      const directory = fs.realpathSync(opts.package)
      const pkg = JSON.parse(fs.readFileSync(safe(directory, 'ebisu.json'), 'utf8'))
      pkg.files = Object.fromEntries(
        Object.entries(pkg.files || {}).map(([relative, file]) => [
          relative,
          {
            ...file,
            content: fs.readFileSync(safe(directory, relative)).toString(file.encoding || 'utf8')
          }
        ])
      )
      result = await request('create', { package: pkg, requestId: opts['request-id'] })
      break
    }
    case 'targets':
      result = await request('targets')
      break
    case 'list':
      result = await request('list')
      break
    case 'detail':
      result = await request('detail', { skillId: opts.skill })
      break
    case 'install':
    case 'uninstall':
      result = await request(command, { skillId: opts.skill })
      break
    case 'context':
      result = await request('context', { skillId: opts.skill, path: opts.path || process.cwd() })
      break
    case 'file':
      result = await request('file', { skillId: opts.skill, file: opts.file })
      process.stdout.write(result.content)
      return
    case 'experiences':
      result = await request('experiences', { ids: JSON.parse(opts.ids || '[]') })
      break
    case 'experience-add': {
      const payload = data()
      if (payload.folderId === undefined && opts.scope !== 'skill')
        payload.path = opts.path || process.cwd()
      result = await request('experience-add', payload)
      break
    }
    case 'experience-update':
      result = await request('experience-update', {
        ...data(),
        id: opts.id,
        revision: Number(opts.revision)
      })
      break
    case 'experience-delete':
      result = await request('experience-delete', { id: opts.id, revision: Number(opts.revision) })
      break
    case 'variables':
      result = await request('variables', { skillId: opts.skill, target: data() })
      break
    case 'variable-reveal':
      result = await request('variable-reveal', {
        skillId: opts.skill,
        name: opts.name,
        target: data()
      })
      break
    case 'variable-add':
      result = await request('variable-add', { skillId: opts.skill, variable: data() })
      break
    case 'variable-delete':
      result = await request('variable-delete', { skillId: opts.skill, name: opts.name })
      break
    case 'variable-set':
      result = await request('variable-set', { ...data(), skillId: opts.skill, name: opts.name })
      break
    case 'run': {
      const context = await request('run-context', {
        skillId: opts.skill,
        path: opts.path || process.cwd()
      })
      if (!context.folder)
        fail('Scripts require an existing registered project. Add the project in Ebisu first.')
      if (!context.scripts.includes(opts.script))
        fail('Script is not a declared executable resource')
      const script = safe(context.directory, opts.script)
      const env = {
        ...process.env,
        ...context.variables,
        EBISU_PROJECT_ROOT: context.folder.path,
        EBISU_SKILL_DIR: context.directory,
        EBISU_TERMINAL: opts.terminal
      }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawnSync(script, scriptArgs, {
        cwd: context.folder.path,
        env,
        stdio: 'inherit'
      })
      if (child.error) fail(child.error.message)
      process.exitCode = child.status ?? 1
      return
    }
    default:
      fail(PROTOCOL)
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}
main().catch((error) => {
  process.stderr.write(`Ebisu skills: ${error.message}\n`)
  process.exitCode = 1
})
