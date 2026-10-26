<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  NAnchor,
  NAnchorLink,
  NButton,
  NCode,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NEmpty,
  NInput,
  NInputNumber,
  NSelect,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  NTooltip,
  useDialog,
  useMessage
} from 'naive-ui'
import {
  BookOpen,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  MoreHorizontal,
  PackageMinus,
  Trash2,
  X
} from 'lucide-vue-next'
import gitIcon from '../assets/badges/git.svg'
import pythonIcon from '../assets/badges/python.svg'
import nodeIcon from '../assets/badges/node.svg'
import dockerIcon from '../assets/badges/docker.svg'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import { useDashboard } from '../store'
import type { TerminalId } from '../../../shared/types'
import type {
  SkillDetail,
  SkillExperience,
  VariableLayerValue,
  VariableTarget,
  VariableView
} from '../../../shared/skills'

for (const [name, language] of Object.entries({
  bash,
  python,
  javascript,
  typescript,
  json,
  yaml,
  markdown
}))
  hljs.registerLanguage(name, language)
const dashboard = useDashboard()
const api = window.ebisu
defineProps<{ trayMode?: boolean }>()
const message = useMessage()
const dialog = useDialog()
const names: Record<TerminalId, string> = {
  codex: 'Codex',
  workbuddy: 'WorkBuddy',
  claude: 'Claude Code',
  grok: 'Grok',
  qoder: 'Qoder'
}
const scopeNames = { skill: '全局', terminal: '终端', project: '项目' }
const search = ref('')
const selected = ref<string | null>(null)
const detail = ref<SkillDetail | null>(null)
const loading = ref(false)
const pending = ref(false)
const switchingProject = ref(false)
const tab = ref('install')
const project = ref<string | null>(null)
const file = ref('SKILL.md')
const fileOpen = ref(false)
const variableContent = ref<HTMLElement | null>(null)
const selectedIds = ref<string[]>([])
const variables = ref<VariableView[]>([])
const drafts = ref<Record<string, string>>({})
const persisted = ref<Record<string, string | undefined>>({})
const revealed = ref<Record<string, string | null>>({})
const edited = ref<Record<string, boolean>>({})
const saveState = ref<Record<string, 'saving' | 'saved'>>({})
const clearRequested = new Set<string>()
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const saveTriggers = new Map<string, () => void>()
const saveChains = new Map<string, Promise<void>>()
const savedTimers = new Map<string, ReturnType<typeof setTimeout>>()
let detailRequest = 0
let variableRequest = 0
/** 项目切换期间保留滚动快照；后续刷新接管请求时也沿用，避免迟到响应恢复旧位置。 */
let variableScroll: { target: HTMLElement; top: number } | null = null
const bound = computed(
  () => dashboard.snapshot?.integrations.filter((item) => item.installed) ?? []
)
const projectOptions = computed(
  () =>
    dashboard.snapshot?.folders.map((folder) => ({
      label: folder.name,
      value: folder.id
    })) ?? []
)
const skills = computed(
  () =>
    dashboard.snapshot?.skills.filter((skill) =>
      `${skill.name} ${skill.description}`.toLowerCase().includes(search.value.toLowerCase())
    ) ?? []
)
const experiences = computed(
  () => detail.value?.experiences.filter((item) => item.folderId === project.value) ?? []
)
const currentFile = computed(() => detail.value?.package.files[file.value])
const fileMenu = computed(() => [
  { label: '复制路径', key: 'copy-path' },
  {
    label: '复制内容',
    key: 'copy-content',
    disabled: !currentFile.value || currentFile.value.encoding === 'base64'
  },
  { label: '另存为', key: 'save' },
  { label: '在 Finder 中显示', key: 'reveal' }
])
const fileEntries = computed(() =>
  Object.entries(detail.value?.package.files ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relative, entry]) => ({
      path: relative,
      executable: !!entry.executable,
      binary: entry.encoding === 'base64'
    }))
)
interface DependencyBadge {
  key: string
  label: string
  version?: string
  color?: string
  icon?: string
}
const dependencyStyles: { pattern: RegExp; color: string; icon: string }[] = [
  { pattern: /^python\d*$/i, color: '#3776ab', icon: pythonIcon },
  { pattern: /^git$/i, color: '#f05032', icon: gitIcon },
  { pattern: /^(node|nodejs|nodedotjs)$/i, color: '#339933', icon: nodeIcon },
  { pattern: /^docker$/i, color: '#2496ed', icon: dockerIcon }
]
/** 依赖是自由文本，只在能明确拆出工具名和版本时渲染 shields 式双段徽章。 */
function dependencyBadge(value: string, index: number): DependencyBadge {
  const matched = /^([^\s]+)\s*(>=|<=|>|<|==|=|\^|~)\s*(\S.*)$/.exec(value.trim())
  const label = (matched?.[1] ?? value).trim()
  const style = dependencyStyles.find((item) => item.pattern.test(label))
  const operator = matched?.[2] === '>=' ? '≥' : matched?.[2] === '<=' ? '≤' : (matched?.[2] ?? '')
  return {
    key: `${index}:${value}`,
    label,
    version: matched ? `${/^[=]$/.test(operator) ? '' : operator}${matched[3].trim()}` : undefined,
    color: style?.color,
    icon: style?.icon
  }
}
const dependencies = computed(() => (detail.value?.package.dependencies ?? []).map(dependencyBadge))
const language = computed(() => {
  const extension = file.value.split('.').pop()?.toLowerCase()
  const mapped: Record<string, string> = {
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    py: 'python',
    js: 'javascript',
    cjs: 'javascript',
    mjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown'
  }
  if (extension && mapped[extension]) return mapped[extension]
  const first = currentFile.value?.content.split('\n')[0] ?? ''
  return /python/.test(first)
    ? 'python'
    : /(?:bash|sh|zsh)/.test(first)
      ? 'bash'
      : /node/.test(first)
        ? 'javascript'
        : undefined
})
interface VariableLayer {
  key: string
  label: string
  target: VariableTarget
  value: VariableLayerValue
}
const projectLabel = computed(
  () => projectOptions.value.find((item) => item.value === project.value)?.label ?? ''
)

/** 每个变量同时呈现全局、已安装终端和当前项目三层，缺失层不占位。 */
function layers(item: VariableView): VariableLayer[] {
  const result: VariableLayer[] = [
    {
      key: 'skill',
      label: '全局',
      target: { scope: 'skill' },
      value: item.global
    }
  ]
  if (item.scopes.includes('terminal'))
    for (const entry of item.terminals)
      result.push({
        key: `terminal:${entry.terminal}`,
        label: `终端 · ${names[entry.terminal]}`,
        target: { scope: 'terminal', terminal: entry.terminal },
        value: entry
      })
  if (project.value && item.project)
    result.push({
      key: `project:${project.value}`,
      label: `项目 · ${projectLabel.value}`,
      target: { scope: 'project', folderId: project.value },
      value: item.project
    })
  return result
}
const draftKey = (name: string, layer: string): string => `${name}:${layer}`

/** 切换技能或层级时丢弃迟到响应，避免把上一目标的取值带入当前表单。 */
async function refreshDetail(): Promise<void> {
  const id = selected.value
  const request = ++detailRequest
  if (!id) {
    detail.value = null
    return
  }
  loading.value = !detail.value
  try {
    const result = await api.skillDetail(id)
    if (request === detailRequest) {
      detail.value = result
      selectedIds.value = selectedIds.value.filter((entry) =>
        result.experiences.some((item) => item.id === entry)
      )
    }
  } catch (error) {
    if (request === detailRequest) message.error(String(error))
  } finally {
    if (request === detailRequest) loading.value = false
  }
}
async function refreshVariables(preserveEdits = false): Promise<void> {
  const request = ++variableRequest
  if (!preserveEdits) {
    flushPendingSaves()
    // 保留旧列表的高度，避免异步加载期间内容塌陷把滚动条拉回顶部。
    if (!switchingProject.value) variables.value = []
    drafts.value = {}
    persisted.value = {}
    revealed.value = {}
    edited.value = {}
    saveState.value = {}
    clearRequested.clear()
  }
  if (!selected.value) return
  try {
    const result = await api.skillVariables(selected.value, project.value)
    if (request !== variableRequest) return
    // 必填项排在最前，先补齐阻塞运行的配置；其余保持后端顺序。
    const ordered = [...result].sort(
      (left, right) => Number(right.required) - Number(left.required)
    )
    variables.value = ordered
    const next: Record<string, string> = {}
    const values: Record<string, string | undefined> = {}
    for (const item of ordered)
      for (const layer of layers(item)) {
        const key = draftKey(item.name, layer.key)
        // 敏感值不会从后端回传；保留已有草稿，避免保存后刷新把输入框清空。
        const keepDraft =
          preserveEdits &&
          (edited.value[key] || (item.sensitive && drafts.value[key] !== undefined))
        next[key] = keepDraft ? drafts.value[key] : (layer.value.value ?? '')
        // 敏感值未解密，用 undefined 表示“存在但未知”，避免误判为未变化。
        values[key] = item.sensitive && layer.value.hasValue ? undefined : (layer.value.value ?? '')
      }
    drafts.value = next
    persisted.value = values
  } catch (error) {
    if (request === variableRequest) {
      if (switchingProject.value) variables.value = []
      message.error(String(error))
    }
  } finally {
    if (request === variableRequest) {
      await nextTick()
      // 等项目层增删渲染完再恢复偏移；内容变短时由浏览器限制到可滚动的末尾。
      if (request === variableRequest) {
        if (variableScroll) variableScroll.target.scrollTop = variableScroll.top
        variableScroll = null
        switchingProject.value = false
      }
    }
  }
}
watch(selected, () => {
  variableScroll = null
  switchingProject.value = false
  detail.value = null
  file.value = 'SKILL.md'
  fileOpen.value = false
  selectedIds.value = []
  void refreshDetail()
  void refreshVariables()
})
watch(project, () => {
  if (!selected.value) return
  if (tab.value === 'variables') {
    cancelAnimationFrame(scrollFrame)
    const target = anchorTarget()
    if (target !== document.body) variableScroll = { target, top: target.scrollTop }
  }
  switchingProject.value = true
  void refreshVariables()
})
watch(
  () => dashboard.revision,
  () => {
    if (selected.value) {
      void refreshDetail()
      void refreshVariables(true)
    }
  }
)
watch(projectOptions, (items) => {
  if (project.value && !items.some((item) => item.value === project.value)) project.value = null
})
async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    message.success('已复制')
  } catch {
    message.error('复制失败，请手动选择文本复制')
  }
}
async function run(operation: () => Promise<unknown>, success: string): Promise<void> {
  pending.value = true
  try {
    await operation()
    message.success(success)
    await dashboard.refresh()
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  } finally {
    pending.value = false
  }
}
function removeExperience(item: SkillExperience): void {
  dialog.warning({
    title: '删除经验',
    content: '删除后所有终端和模型均不再读取此经验，初始上下文保留。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => run(() => api.deleteExperience(item.id, item.revision), '经验已删除')
  })
}
function toggleId(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}
function resetProject(value: string | null): void {
  project.value = value
  selectedIds.value = []
}
const variableKey = (item: VariableView, layer: VariableLayer): string =>
  draftKey(item.name, layer.key)
function cancelSave(key: string): void {
  const timer = saveTimers.get(key)
  if (timer) clearTimeout(timer)
  saveTimers.delete(key)
  saveTriggers.delete(key)
}
function markSaved(key: string): void {
  saveState.value[key] = 'saved'
  const timer = savedTimers.get(key)
  if (timer) clearTimeout(timer)
  savedTimers.set(
    key,
    setTimeout(() => {
      savedTimers.delete(key)
      if (saveState.value[key] === 'saved') delete saveState.value[key]
    }, 2000)
  )
}
/** 同一变量层的写入串行执行，避免逐字保存与失焦保存乱序覆盖。 */
function persistVariable(
  item: VariableView,
  layer: VariableLayer,
  skillId: string,
  raw: string,
  clear = false
): void {
  const key = variableKey(item, layer)
  if (!edited.value[key]) return
  if (!clear && persisted.value[key] === raw) {
    delete edited.value[key]
    return
  }
  const value = clear ? null : raw
  const chainKey = `${skillId}:${key}`
  saveState.value[key] = 'saving'
  const previous = saveChains.get(chainKey) ?? Promise.resolve()
  const chain = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await api.setSkillVariable(skillId, item.name, layer.target, value)
        if (detail.value?.id !== skillId) return
        const current = variables.value.find((entry) => entry.name === item.name)
        const target = current
          ? layers(current).find((entry) => entry.key === layer.key)
          : undefined
        if (target) {
          target.value.hasValue = value !== null
          target.value.value = item.sensitive ? null : value
        }
        if (drafts.value[key] === raw) {
          persisted.value[key] = raw
          delete edited.value[key]
          markSaved(key)
        }
      } catch (error) {
        if (detail.value?.id === skillId) {
          delete saveState.value[key]
          message.error(String(error), { duration: 6000 })
        }
      }
    })
  saveChains.set(chainKey, chain)
  void chain.finally(() => {
    if (saveChains.get(chainKey) === chain) saveChains.delete(chainKey)
  })
}
function scheduleSave(item: VariableView, layer: VariableLayer): void {
  const key = variableKey(item, layer)
  const skillId = detail.value?.id
  if (!skillId || !edited.value[key]) return
  cancelSave(key)
  saveTriggers.set(key, () => persistVariable(item, layer, skillId, drafts.value[key] ?? '', false))
  saveTimers.set(
    key,
    setTimeout(() => {
      const trigger = saveTriggers.get(key)
      cancelSave(key)
      trigger?.()
    }, 500)
  )
}
function flushVariable(item: VariableView, layer: VariableLayer): void {
  const key = variableKey(item, layer)
  const trigger = saveTriggers.get(key)
  if (!trigger) return
  cancelSave(key)
  trigger()
}
/** 切换技能或项目前先写出待保存输入，再丢弃旧表单。 */
function flushPendingSaves(): void {
  const triggers = [...saveTriggers.values()]
  for (const key of [...saveTimers.keys()]) cancelSave(key)
  for (const trigger of triggers) trigger()
}
function markClear(item: VariableView, layer: VariableLayer): void {
  clearRequested.add(variableKey(item, layer))
}
function editVariable(
  item: VariableView,
  layer: VariableLayer,
  value: string,
  clear = false
): void {
  const key = variableKey(item, layer)
  const shouldClear = clear || clearRequested.delete(key)
  drafts.value[key] = value
  edited.value[key] = true
  delete saveState.value[key]
  const skillId = detail.value?.id
  if (!skillId) return
  if (shouldClear) {
    cancelSave(key)
    persistVariable(item, layer, skillId, value, true)
  } else {
    scheduleSave(item, layer)
  }
}
/** 敏感值只在点击眼睛时解密；输入框为空才回填，避免覆盖用户正在输入的新值。 */
async function toggleSecret(item: VariableView, layer: VariableLayer): Promise<void> {
  if (!detail.value) return
  const key = variableKey(item, layer)
  if (revealed.value[key] !== undefined) {
    delete revealed.value[key]
    return
  }
  try {
    const value = await api.revealSkillVariable(detail.value.id, item.name, layer.target)
    revealed.value[key] = value
    if (!drafts.value[key]) {
      drafts.value[key] = value ?? ''
      if (value !== null) persisted.value[key] = value
    }
  } catch (error) {
    message.error(String(error))
  }
}
/** Anchor 以抽屉自身的滚动容器为基准，跳转后高亮才能与可视区顶部对齐。 */
const anchorTarget = (): HTMLElement => {
  let node = variableContent.value?.parentElement ?? null
  while (node && node !== document.body) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
    node = node.parentElement
  }
  return document.body
}
/** 高亮用容器中线判断，点击跳转另按导航顶部对齐，两者不共用偏移。 */
const anchorBound = ref(12)
let anchorTimer: ReturnType<typeof setTimeout> | undefined
let anchorResizeObserver: ResizeObserver | undefined
let scrollFrame = 0
/** 锚点默认瞬时跳转，这里用短动画滚动，点击后能看清路径且高亮不会中途丢失。 */
function animateScroll(target: HTMLElement, top: number): void {
  cancelAnimationFrame(scrollFrame)
  const start = target.scrollTop
  const distance = Math.max(0, top) - start
  if (!distance) return
  const startedAt = performance.now()
  const step = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / 220)
    target.scrollTop = start + distance * (1 - (1 - progress) ** 3)
    if (progress < 1) scrollFrame = requestAnimationFrame(step)
  }
  scrollFrame = requestAnimationFrame(step)
}
/** 捕获阶段拦截锚点点击，阻止浏览器和 NAnchor 自带的瞬时跳转，改由短动画滚动。 */
function jumpToVariable(event: MouseEvent): void {
  const link = (event.target as HTMLElement | null)?.closest('a[href^="#skill-variable-"]')
  const name = link?.getAttribute('href')?.slice('#skill-variable-'.length)
  if (!link || !name) return
  const target = anchorTarget()
  const section = document.getElementById(`skill-variable-${name}`)?.closest('.skill-variable')
  const nav =
    variableContent.value?.parentElement?.querySelector<HTMLElement>('.skill-variable-nav')
  if (!section || !nav || target === document.body) return
  event.preventDefault()
  event.stopPropagation()
  // sticky 的参考点包含滚动容器内边距；即使导航尚未吸顶，也按吸顶后的位置对齐卡片。
  const navTop =
    target.getBoundingClientRect().top +
    (parseFloat(getComputedStyle(target).paddingTop) || 0) +
    (parseFloat(getComputedStyle(nav).top) || 0)
  const top = target.scrollTop + section.getBoundingClientRect().top - navTop
  animateScroll(target, top)
}
/** 环境变量页总是从开头展示；抽屉关闭时内容随 NDrawer 销毁，滚动位置不会带到下次。 */
watch(tab, (value) => {
  if (value !== 'variables') return
  cancelAnimationFrame(scrollFrame)
  void nextTick(() => {
    const target = anchorTarget()
    if (target !== document.body) target.scrollTo({ top: 0 })
  })
})
function updateAnchorBound(): void {
  const target = anchorTarget()
  if (target === document.body) return
  anchorBound.value = target.clientHeight / 2
  // bound 更新后再通知 Anchor，确保首次显示、项目层增删和窗口缩放都按新中线计算。
  void nextTick(() => target.dispatchEvent(new Event('scroll')))
}
function syncAnchor(): void {
  clearTimeout(anchorTimer)
  anchorResizeObserver?.disconnect()
  if (tab.value !== 'variables' || !selected.value) return
  void nextTick(() => {
    if (tab.value !== 'variables' || !selected.value) return
    const target = anchorTarget()
    if (target === document.body) return
    anchorResizeObserver ??= new ResizeObserver(updateAnchorBound)
    anchorResizeObserver.disconnect()
    anchorResizeObserver.observe(target)
    updateAnchorBound()
    // Tabs 切换动画结束后再计算一次，避免动画期间的临时高度影响初始高亮。
    anchorTimer = setTimeout(updateAnchorBound, 350)
  })
}
watch([tab, variables, selected], syncAnchor)
function openFile(relative: string): void {
  file.value = relative
  fileOpen.value = true
}
/** 复制技能源目录中的绝对路径，便于在终端或编辑器中继续处理。 */
async function copyFilePath(): Promise<void> {
  if (!detail.value) return
  try {
    await copy(await api.skillFilePath(detail.value.id, file.value))
  } catch (error) {
    message.error(String(error))
  }
}
async function saveFile(): Promise<void> {
  if (!detail.value) return
  try {
    const saved = await api.saveSkillFile(detail.value.id, file.value)
    if (saved) message.success(`已保存到 ${saved}`, { duration: 5000 })
  } catch (error) {
    message.error(String(error))
  }
}
async function fileMenuAction(key: string): Promise<void> {
  if (!detail.value) return
  if (key === 'copy-path') await copyFilePath()
  else if (key === 'copy-content') {
    // 二进制资源不作为文本复制，避免把编码内容误当作原文件内容。
    if (currentFile.value && currentFile.value.encoding !== 'base64')
      await copy(currentFile.value.content)
  } else if (key === 'save') await saveFile()
  else if (key === 'reveal') {
    try {
      await api.revealSkillFile(detail.value.id, file.value)
    } catch (error) {
      message.error(String(error))
    }
  }
}
onBeforeUnmount(() => {
  clearTimeout(anchorTimer)
  anchorResizeObserver?.disconnect()
  cancelAnimationFrame(scrollFrame)
  flushPendingSaves()
  for (const timer of savedTimers.values()) clearTimeout(timer)
  savedTimers.clear()
})
</script>

<template>
  <div v-if="!trayMode" class="page-heading skills-heading">
    <h1>技能列表<span class="title-period">.</span></h1>
    <n-input
      v-model:value="search"
      class="skills-search"
      placeholder="搜索技能名称或简介"
      clearable
      aria-label="搜索技能"
    />
  </div>
  <div v-if="skills.length" class="skill-grid">
    <button
      v-for="skill in skills"
      :key="skill.id"
      class="skill-card"
      :data-skill="skill.name"
      @click="selected = skill.id"
    >
      <div class="skill-card-heading">
        <BookOpen :size="21" /><strong>{{ skill.name }}</strong>
      </div>
      <p>{{ skill.description }}</p>
      <div class="skill-terminal-tags">
        <n-tooltip
          v-for="installation in skill.installations"
          :key="installation.terminal"
          :delay="300"
        >
          <template #trigger>
            <img
              :src="`ebisu-asset://avatar/terminal/${installation.terminal}?v=${dashboard.revision}`"
              :alt="names[installation.terminal]"
              class="skill-terminal-icon"
            />
          </template>
          {{ names[installation.terminal] }}
        </n-tooltip>
        <span v-if="!skill.installations.length" class="section-meta">尚未安装到终端</span>
      </div>
    </button>
  </div>
  <n-empty
    v-else
    description="暂无匹配技能。请在已绑定终端显式使用 ebisu-skill-create 创建。"
    style="margin-top: 80px"
  />
  <n-drawer
    :show="!!selected"
    width="min(920px, 96vw)"
    data-skill-drawer
    @update:show="
      (show: boolean) => {
        if (!show) selected = null
      }
    "
  >
    <n-drawer-content :title="detail?.name ?? '技能详情'" closable>
      <n-spin :show="loading">
        <template v-if="detail">
          <p class="skill-description">{{ detail.description }}</p>
          <dl class="skill-meta-list">
            <div class="skill-meta-row">
              <dt>技能 ID</dt>
              <dd>
                <code>{{ detail.id }}</code>
                <n-button text size="small" title="复制技能 ID" @click="copy(detail.id)"
                  ><Copy :size="14"
                /></n-button>
              </dd>
            </div>
            <div class="skill-meta-row">
              <dt>创建于</dt>
              <dd>{{ new Date(detail.createdAt).toLocaleString() }}</dd>
            </div>
            <div v-if="dependencies.length" class="skill-meta-row">
              <dt>依赖</dt>
              <dd class="skill-dependencies">
                <span
                  v-for="dependency in dependencies"
                  :key="dependency.key"
                  class="dependency-badge"
                  :class="{ 'dependency-badge--single': !dependency.version }"
                  :style="dependency.color ? { '--dependency-color': dependency.color } : undefined"
                >
                  <span class="dependency-badge-name">
                    <img
                      v-if="dependency.icon"
                      :src="dependency.icon"
                      class="dependency-badge-icon"
                      alt=""
                      aria-hidden="true"
                    />{{ dependency.label }}</span
                  >
                  <span v-if="dependency.version" class="dependency-badge-version">{{
                    dependency.version
                  }}</span>
                </span>
              </dd>
            </div>
          </dl>
          <n-tabs v-model:value="tab" type="line" animated>
            <n-tab-pane
              name="install"
              tab="安装管理"
              :tab-props="{ role: 'tab', 'aria-selected': tab === 'install' }"
            >
              <n-empty
                v-if="!bound.length"
                description="请先在设置中绑定终端"
                style="margin: 40px 0"
              />
              <div
                v-for="host in bound"
                :key="host.id"
                class="skill-install-row"
                :data-skill-terminal="host.id"
              >
                <img
                  :src="`ebisu-asset://avatar/terminal/${host.id}?v=${dashboard.revision}`"
                  :alt="host.name"
                  class="skill-install-icon"
                />
                <strong>{{ host.name }}</strong>
                <span>{{
                  detail.installations.some((item) => item.terminal === host.id)
                    ? '已安装'
                    : '未安装'
                }}</span>
                <n-button
                  v-if="detail.installations.some((item) => item.terminal === host.id)"
                  :disabled="pending"
                  @click="
                    run(
                      () => api.uninstallSkill(detail!.id, host.id),
                      '技能入口已卸载，共享数据保留'
                    )
                  "
                  ><template #icon><PackageMinus :size="14" /></template>卸载</n-button
                >
                <n-button
                  v-else
                  type="primary"
                  :disabled="pending"
                  @click="
                    run(
                      () => api.installSkill(detail!.id, host.id),
                      '入口已安装，请重启终端已有会话'
                    )
                  "
                  ><template #icon><Download :size="14" /></template>安装</n-button
                >
              </div>
            </n-tab-pane>
            <n-tab-pane
              name="experience"
              tab="经验"
              :tab-props="{
                role: 'tab',
                'aria-selected': tab === 'experience'
              }"
            >
              <div class="skill-toolbar">
                <n-select
                  class="skill-project-select"
                  :value="project ?? 'all'"
                  :options="[{ label: '技能经验 · 所有项目通用', value: 'all' }, ...projectOptions]"
                  placeholder="技能经验"
                  @update:value="(value: string) => resetProject(value === 'all' ? null : value)"
                />
                <n-button :disabled="!selectedIds.length" @click="copy(JSON.stringify(selectedIds))"
                  >复制 ID 列表</n-button
                >
                <n-button
                  :disabled="!selectedIds.length"
                  @click="
                    copy(
                      `ebisu-skill-discuss ${JSON.stringify(selectedIds)} 请解释这些经验，并根据我的意见处理。`
                    )
                  "
                  >复制讨论指令</n-button
                >
              </div>
              <n-empty
                v-if="!experiences.length"
                description="暂无经验。模型可在实际验证后主动沉淀。"
                style="margin: 40px 0"
              />
              <article
                v-for="item in experiences"
                :key="item.id"
                class="experience-item"
                :data-experience="item.id"
              >
                <div class="experience-heading">
                  <label
                    ><input
                      type="checkbox"
                      :checked="selectedIds.includes(item.id)"
                      @change="toggleId(item.id)"
                    /><code>{{ item.id }}</code></label
                  ><n-button text size="small" title="复制经验 ID" @click="copy(item.id)"
                    ><Copy :size="14" /></n-button
                  ><n-button
                    text
                    size="small"
                    type="error"
                    :disabled="pending"
                    title="删除经验"
                    @click="removeExperience(item)"
                    ><Trash2 :size="14"
                  /></n-button>
                </div>
                <pre class="skill-context">{{ item.content }}</pre>
                <p class="experience-evidence">验证依据：{{ item.evidence }}</p>
                <p class="section-meta">
                  修订 {{ item.revision }} · 创建 {{ new Date(item.createdAt).toLocaleString() }} ·
                  更新
                  {{ new Date(item.updatedAt).toLocaleString() }}
                </p>
              </article>
            </n-tab-pane>
            <n-tab-pane
              name="files"
              tab="脚本与文件"
              :tab-props="{ role: 'tab', 'aria-selected': tab === 'files' }"
            >
              <div class="skill-file-list">
                <button
                  v-for="entry in fileEntries"
                  :key="entry.path"
                  type="button"
                  class="skill-file-row"
                  :data-file="entry.path"
                  @click="openFile(entry.path)"
                >
                  <FileText :size="16" />
                  <span class="skill-file-path">{{ entry.path }}</span>
                  <n-tag v-if="entry.binary" size="small" :bordered="false">二进制</n-tag>
                  <ChevronRight :size="15" class="skill-file-arrow" />
                </button>
              </div>
              <p v-if="!fileEntries.length" class="section-meta">此技能没有可读取的文件。</p>
            </n-tab-pane>
            <n-tab-pane
              name="variables"
              tab="环境变量"
              :tab-props="{ role: 'tab', 'aria-selected': tab === 'variables' }"
            >
              <p class="section-meta skill-variable-note">
                全局层始终存在；终端层和项目层由变量定义决定是否开放。生效顺序：项目 ＞ 终端 ＞
                全局。修改后自动保存，清空文本会保存空值，点击输入框内的清除图标会删除该层配置。新增或删除变量定义请通过
                agent。
              </p>
              <div class="skill-variable-project">
                <n-select
                  class="skill-project-select"
                  :value="project ?? 'all'"
                  :options="[{ label: '所有项目', value: 'all' }, ...projectOptions]"
                  placeholder="所有项目"
                  aria-label="变量项目"
                  @update:value="(value: string) => resetProject(value === 'all' ? null : value)"
                />
              </div>
              <n-empty
                v-if="!variables.length"
                description="本技能尚未定义变量"
                style="margin: 40px 0"
              />
              <div v-else class="skill-variable-layout">
                <aside class="skill-variable-nav" @click.capture="jumpToVariable">
                  <n-anchor
                    class="skill-variable-anchor"
                    type="block"
                    ignore-gap
                    :bound="anchorBound"
                    :offset-target="anchorTarget"
                  >
                    <n-anchor-link
                      v-for="item in variables"
                      :key="item.name"
                      :title="item.description || item.name"
                      :href="`#skill-variable-${item.name}`"
                    />
                  </n-anchor>
                </aside>
                <div ref="variableContent" class="skill-variable-content">
                  <div
                    v-for="item in variables"
                    :key="item.name"
                    class="skill-variable"
                    :data-variable="item.name"
                  >
                    <div :id="`skill-variable-${item.name}`" class="skill-variable-heading">
                      <span class="skill-variable-meaning">{{ item.description }}</span>
                      <n-tag v-if="item.required" size="small" type="error">必填</n-tag>
                    </div>
                    <code class="skill-variable-name">{{ item.name }}</code>
                    <div class="skill-variable-scopes">
                      <span class="section-meta">可配置层级</span>
                      <n-tag v-for="scope in item.scopes" :key="scope" size="small" type="info">{{
                        scopeNames[scope]
                      }}</n-tag>
                    </div>
                    <div
                      v-for="layer in layers(item)"
                      :key="layer.key"
                      class="skill-variable-layer"
                      :data-variable-layer="layer.key"
                    >
                      <div class="skill-variable-layer-heading">
                        <strong>{{ layer.label }}</strong>
                        <n-tag v-if="layer.value.hasValue" size="small" type="success"
                          >已设置</n-tag
                        >
                        <n-tag v-else size="small">未设置</n-tag>
                        <span
                          v-if="saveState[draftKey(item.name, layer.key)] === 'saving'"
                          class="section-meta"
                          >保存中…</span
                        >
                        <span
                          v-else-if="saveState[draftKey(item.name, layer.key)] === 'saved'"
                          class="section-meta"
                          >已保存</span
                        >
                      </div>
                      <n-select
                        v-if="item.type === 'boolean'"
                        :value="drafts[draftKey(item.name, layer.key)] || null"
                        :options="[
                          { label: '开启', value: 'true' },
                          { label: '关闭', value: 'false' }
                        ]"
                        clearable
                        placeholder="未设置"
                        :disabled="pending || switchingProject"
                        :aria-label="`${item.name} ${layer.label}`"
                        @update:value="
                          (value: string | null) => editVariable(item, layer, value ?? '')
                        "
                        @clear="markClear(item, layer)"
                        @blur="flushVariable(item, layer)"
                      />
                      <n-input-number
                        v-else-if="item.type === 'number'"
                        :value="
                          drafts[draftKey(item.name, layer.key)] === ''
                            ? null
                            : Number(drafts[draftKey(item.name, layer.key)])
                        "
                        clearable
                        placeholder="未设置"
                        :disabled="pending || switchingProject"
                        :aria-label="`${item.name} ${layer.label}`"
                        @update:value="
                          (value: number | null) =>
                            editVariable(item, layer, value === null ? '' : String(value))
                        "
                        @clear="markClear(item, layer)"
                        @blur="flushVariable(item, layer)"
                      />
                      <n-input
                        v-else
                        :value="drafts[draftKey(item.name, layer.key)]"
                        @update:value="(value: string) => editVariable(item, layer, value)"
                        :type="
                          item.sensitive && revealed[draftKey(item.name, layer.key)] === undefined
                            ? 'password'
                            : 'text'
                        "
                        :clearable="!item.sensitive"
                        :disabled="pending || switchingProject"
                        :placeholder="
                          item.sensitive
                            ? layer.value.hasValue
                              ? '已设置；输入新值以替换'
                              : '未设置'
                            : '未设置'
                        "
                        :aria-label="`${item.name} ${layer.label}`"
                        @clear="markClear(item, layer)"
                        @blur="flushVariable(item, layer)"
                      >
                        <template v-if="item.sensitive" #suffix>
                          <button
                            v-if="
                              layer.value.hasValue || drafts[draftKey(item.name, layer.key)] !== ''
                            "
                            type="button"
                            class="skill-variable-icon-button"
                            :aria-label="`${revealed[draftKey(item.name, layer.key)] === undefined ? '显示' : '隐藏'} ${item.name} ${layer.label}`"
                            :disabled="pending || switchingProject"
                            @mousedown.prevent
                            @click="toggleSecret(item, layer)"
                          >
                            <EyeOff
                              v-if="revealed[draftKey(item.name, layer.key)] !== undefined"
                              :size="14"
                            />
                            <Eye v-else :size="14" />
                          </button>
                          <button
                            v-if="
                              layer.value.hasValue || drafts[draftKey(item.name, layer.key)] !== ''
                            "
                            type="button"
                            class="skill-variable-icon-button"
                            data-clear
                            :aria-label="`清除 ${item.name} ${layer.label}`"
                            :disabled="pending || switchingProject"
                            @mousedown.prevent
                            @click="editVariable(item, layer, '', true)"
                          >
                            <X :size="14" />
                          </button>
                        </template>
                      </n-input>
                    </div>
                    <p
                      v-if="item.scopes.includes('terminal') && !item.terminals.length"
                      class="section-meta"
                    >
                      安装到已绑定终端后可配置终端层。
                    </p>
                  </div>
                </div>
              </div>
            </n-tab-pane>
          </n-tabs>
        </template>
      </n-spin>
    </n-drawer-content>
  </n-drawer>
  <n-drawer v-model:show="fileOpen" width="min(820px, 92vw)" data-file-drawer>
    <n-drawer-content :title="file" closable>
      <div class="skill-file-detail-heading">
        <p class="section-meta">
          {{ currentFile?.executable ? '可执行工具' : '只读文件'
          }}<span v-if="language"> · {{ language }}</span>
        </p>
        <div class="skill-file-actions">
          <n-dropdown
            :options="fileMenu"
            trigger="click"
            placement="bottom-end"
            @select="fileMenuAction"
          >
            <button type="button" class="icon-button" aria-label="文件操作" aria-haspopup="menu">
              <MoreHorizontal :size="18" />
            </button>
          </n-dropdown>
        </div>
      </div>
      <p v-if="currentFile?.encoding === 'base64'">
        二进制资源 · {{ currentFile.content.length }} 个 base64 字符
      </p>
      <div v-else class="skill-code">
        <n-code :code="currentFile?.content ?? ''" :language="language" :hljs="hljs" />
      </div>
    </n-drawer-content>
  </n-drawer>
</template>
