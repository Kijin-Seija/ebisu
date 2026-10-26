<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NButton,
  NDropdown,
  NInput,
  NModal,
  NPopover,
  NTag,
  useDialog,
  useMessage,
  useThemeVars
} from 'naive-ui'
import { Folder, FolderPlus, GitBranch, MoreHorizontal, CircleCheck } from 'lucide-vue-next'
import { useDashboard } from '../store'
import { backgroundUrl, modelFamily, trayBackgroundUrl } from '../avatars'
import type { FolderView, SessionActivity } from '../../../shared/types'
import SessionAvatars from './SessionAvatars.vue'
import DeviceFilter from './DeviceFilter.vue'
import type { ProjectView } from '../device-views'

const props = defineProps<{ trayMode?: boolean; dark?: boolean }>()
const dashboard = useDashboard()
const api = window.ebisu
const message = useMessage()
const dialog = useDialog()
// 直接使用当前 Naive UI 主题色，卡片提示与头像 badge 在明暗主题中保持一致。
const themeVars = useThemeVars()
/** 深色 badge 使用补充色；边框与状态点取同一来源，保证与 Naive UI 原始语义色一致。 */
const activityColors = computed(() => ({
  offline: themeVars.value.textColorDisabled,
  idle: props.dark ? themeVars.value.successColorSuppl : themeVars.value.successColor,
  executing: props.dark ? themeVars.value.infoColorSuppl : themeVars.value.infoColor,
  waiting: props.dark ? themeVars.value.warningColorSuppl : themeVars.value.warningColor,
  error: props.dark ? themeVars.value.errorColorSuppl : themeVars.value.errorColor
}))
const activityLabels = {
  offline: '设备离线',
  idle: '空闲可用',
  executing: '正在协作',
  waiting: '需要处理',
  error: '出现故障'
}
const filter = ref<'all' | 'busy' | 'idle'>('all')
const renaming = ref<FolderView | null>(null)
const newName = ref('')
const saving = ref(false)
const allFolders = computed(() => dashboard.views.folders)
const busyCount = computed(
  () => allFolders.value.filter((folder) => folder.online && folder.sessions.length > 0).length
)
/** 每个 tab 的数量始终基于完整项目列表，不随当前筛选消失。 */
const tabs = computed(
  () =>
    [
      { key: 'all', label: '全部项目', count: allFolders.value.length },
      { key: 'busy', label: '正在协作', count: busyCount.value },
      {
        key: 'idle',
        label: '空闲可用',
        count: allFolders.value.filter((folder) => folder.online && !folder.sessions.length).length
      }
    ] as const
)
/** 同一终端会话可以占用多个项目；右侧会话总数按终端和 ID 去重。 */
const sessionCount = computed(
  () =>
    new Set(
      allFolders.value
        .filter((folder) => folder.online)
        .flatMap((folder) =>
          folder.sessions.map(
            (session) => `${folder.deviceId}:${session.terminal}:${session.sessionId}`
          )
        )
    ).size
)
/** 聚合全部会话（包含 +x 内的会话）；故障优先于等待，等待优先于执行。 */
function activityState(
  folder: ProjectView
): 'offline' | 'idle' | 'executing' | 'waiting' | 'error' {
  if (!folder.online) return 'offline'
  if (!folder.sessions.length) return 'idle'
  if (folder.sessions.some((session) => session.phase === 'error')) return 'error'
  return folder.sessions.some((session) => session.phase === 'waiting') ? 'waiting' : 'executing'
}

const folders = computed(() => {
  const filtered = allFolders.value
    .filter(
      (folder) =>
        filter.value === 'all' ||
        (folder.online &&
          (filter.value === 'busy' ? folder.sessions.length > 0 : folder.sessions.length === 0))
    )
    .map((folder) => ({
      ...folder,
      activityState: activityState(folder),
      // 背景只展示有角色形象的模型；未知模型的会话不参与背景堆叠。
      backgroundSessions: folder.sessions.filter((session) => modelFamily(session.model))
    }))
  // 全部项目中优先展示协作目录（含等待输入）；稳定排序保留同组原有顺序，不修改快照。
  return filter.value === 'all'
    ? filtered.sort(
        (a, b) =>
          Number(b.online && b.sessions.length > 0) - Number(a.online && a.sessions.length > 0)
      )
    : filtered
})

/** 托盘与主窗口共用卡片结构，只在这里切换背景素材版本。 */
function cardBackgroundUrl(session: SessionActivity): string | undefined {
  return props.trayMode
    ? trayBackgroundUrl(session, dashboard.revision)
    : backgroundUrl(session, dashboard.revision)
}

/**
 * 水平线以下部分占托盘素材高度的比例，用于把各模型的搁板统一对齐卡片底端。
 * 数值必须与 scripts/make-tray-avatars.py 中的 LINE_RATIOS 保持一致。
 */
const trayLineDrops: Record<string, number> = {
  gpt: 0.078125,
  claude: 0.078125,
  deepseek: 0.06640625,
  kimi: 0.076171875,
  qwen: 0.134765625,
  gemini: 0.06640625,
  grok: 0.07421875
}

function trayBackgroundDrop(session: SessionActivity): number | undefined {
  const family = modelFamily(session.model)
  if (!family) return undefined
  // 自选图片没有默认素材的搁板线，直接贴底，避免套用默认裁切比例。
  return dashboard.snapshot?.settings.avatars[`tray:${family}`] ? 0 : trayLineDrops[family]
}

async function action(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    message.error(String(error))
  }
}

function folderMenu(key: string, folder: ProjectView): void {
  if (folder.remote) return
  if (key === 'open') void action(() => api.openFolder(folder.id))
  if (key === 'rename') {
    renaming.value = folder
    newName.value = folder.name
  }
  if (key === 'remove')
    dialog.warning({
      title: '移除目录关联',
      content: `移除「${folder.name}」的面板记录？实际文件会保留；该项目的技能经验和变量覆盖会一并删除。`,
      positiveText: '移除关联',
      negativeText: '取消',
      onPositiveClick: () => action(() => api.removeFolder(folder.id))
    })
}
async function rename(): Promise<void> {
  if (!renaming.value) return
  saving.value = true
  try {
    await api.renameFolder(renaming.value.id, newName.value)
    renaming.value = null
  } catch (error) {
    message.error(String(error))
  } finally {
    saving.value = false
  }
}
const menu = [
  { label: '在 Finder 中打开', key: 'open' },
  { label: '修改显示名称', key: 'rename' },
  { type: 'divider' as const, key: 'divider' },
  { label: '移除关联', key: 'remove' }
]
</script>

<template>
  <DeviceFilter />
  <div class="grid-toolbar">
    <div class="filter-tabs">
      <button
        v-for="item in tabs"
        :key="item.key"
        :data-filter="item.key"
        :class="{ selected: filter === item.key }"
        :aria-pressed="filter === item.key"
        @click="filter = item.key"
      >
        {{ item.label }}<span class="tab-count">{{ item.count }}</span>
      </button>
    </div>
    <span class="toolbar-sessions"
      >活跃会话 <strong>{{ sessionCount }}</strong></span
    >
  </div>
  <div v-if="!allFolders.length" class="empty-panel">
    <div class="empty-illustration">
      <div class="empty-ring"></div>
      <FolderPlus :size="46" :stroke-width="1.2" /><span class="empty-badge"
        ><CircleCheck :size="18"
      /></span>
    </div>
    <span class="eyebrow">A PLACE FOR YOUR PROJECTS</span>
    <h2>把你的项目，放在这里</h2>
    <p>关联一个本地文件夹，随时了解 Git 状态，<br />以及哪些 agent 正在与你协作。</p>
    <n-button type="primary" @click="action(() => api.addFolder())">关联第一个文件夹</n-button
    ><span class="empty-hint">Git 仓库与普通文件夹都支持</span>
  </div>
  <div v-else-if="!folders.length" class="no-results">当前筛选下没有项目。</div>
  <div v-else class="project-grid">
    <article
      v-for="folder in folders"
      :key="`${folder.deviceId}:${folder.id}`"
      class="project-card"
      :class="{ 'is-busy': folder.online && folder.sessions.length, 'is-offline': !folder.online }"
      :data-folder="folder.name"
      :data-activity-state="folder.activityState"
      :style="{ '--activity-color': activityColors[folder.activityState] }"
    >
      <!-- 透明人物轮廓依次遮挡，空白区域透出旧人物；合成后再统一淡化，避免身体部分混色。 -->
      <div
        v-if="folder.backgroundSessions.length"
        class="card-avatar-background"
        aria-hidden="true"
      >
        <img
          v-for="(session, index) in folder.backgroundSessions"
          :key="`${session.terminal}:${session.sessionId}`"
          class="card-avatar-background-image"
          :src="cardBackgroundUrl(session)"
          :style="{
            '--avatar-shift': folder.backgroundSessions.length - 1 - index,
            '--background-avatar-drop': trayBackgroundDrop(session)
          }"
          alt=""
          draggable="false"
        />
      </div>
      <div class="card-top">
        <n-popover trigger="hover" placement="bottom-start" :delay="200" :width="340">
          <template #trigger>
            <button class="folder-symbol" :aria-label="`查看 ${folder.name} 项目详情`">
              <Folder :size="18" :stroke-width="1.5" />
            </button>
          </template>
          <div class="folder-details detail-panel">
            <strong class="detail-title">{{ folder.name }}</strong>
            <div class="detail-field">
              <span>文件路径</span><code>{{ folder.path }}</code>
            </div>
            <div v-if="!folder.available" class="detail-warning">文件夹已移动或暂时不可访问</div>
            <template v-if="folder.git">
              <div v-if="folder.git.error" class="detail-warning">
                Git 状态读取失败：{{ folder.git.error }}
              </div>
              <template v-else>
                <div class="detail-field">
                  <span>分支</span><code>{{ folder.git.branch }}</code>
                </div>
                <div class="detail-field detail-inline">
                  <span>Git 状态</span>
                  <n-tag
                    size="small"
                    :bordered="false"
                    :type="folder.git.clean ? 'success' : 'warning'"
                    >{{ folder.git.clean ? 'clean' : 'dirty' }}</n-tag
                  >
                </div>
                <div class="detail-counts">
                  <span class="added">新增 {{ folder.git.added }}</span>
                  <span class="modified">修改 {{ folder.git.modified }}</span>
                  <span class="deleted">删除 {{ folder.git.deleted }}</span>
                </div>
              </template>
            </template>
            <div v-else class="detail-muted">普通文件夹 · 无 Git 状态</div>
          </div>
        </n-popover>
        <h2 class="card-project-name">{{ folder.name }}</h2>
        <SessionAvatars
          v-if="trayMode && folder.sessions.length"
          class="tray-session-avatars"
          :sessions="folder.sessions"
          :max-visible="2"
        />
        <n-dropdown
          v-if="!folder.remote"
          :options="menu"
          trigger="click"
          @select="(key: string) => folderMenu(key, folder)"
          ><button class="icon-button" :aria-label="`${folder.name} 操作`">
            <MoreHorizontal :size="18" /></button
        ></n-dropdown>
      </div>
      <div v-if="folder.remote" class="device-origin">
        {{ folder.deviceName }} · {{ folder.online ? '在线' : '离线'
        }}<span v-if="folder.lastSeen">
          · 更新于 {{ new Date(folder.lastSeen).toLocaleTimeString() }}</span
        >
      </div>
      <div class="card-meta">
        <div v-if="!folder.available" class="folder-warning">目录不可访问</div>
        <div v-else-if="folder.git" class="git-row">
          <span v-if="folder.git.error" class="git-error-label">Git 状态异常</span>
          <template v-else>
            <span class="branch-name"><GitBranch :size="13" />{{ folder.git.branch }}</span>
            <span class="git-clean" :class="folder.git.clean ? 'clean' : 'dirty'">{{
              folder.git.clean ? 'clean' : 'dirty'
            }}</span>
          </template>
        </div>
        <div v-else class="plain-folder">普通文件夹</div>
        <div v-if="!trayMode" class="occupancy">
          <span class="status-dot"></span>
          {{ activityLabels[folder.activityState] }}
        </div>
      </div>
      <template v-if="!trayMode">
        <div class="card-divider"></div>
        <div v-if="!folder.sessions.length" class="idle-state">
          <CircleCheck :size="16" />目前没有 agent 在执行
        </div>
        <SessionAvatars v-else :sessions="folder.sessions" />
      </template>
    </article>
    <button
      v-if="dashboard.deviceFilter === 'local' || dashboard.deviceFilter === 'all'"
      class="add-card"
      @click="action(() => api.addFolder())"
    >
      <span class="add-card-icon">+</span><span>关联新文件夹</span>
    </button>
  </div>
  <n-modal
    :show="!!renaming"
    preset="card"
    title="修改显示名称"
    style="width: 400px"
    @update:show="
      (value) => {
        if (!value) renaming = null
      }
    "
    ><n-input
      v-model:value="newName"
      placeholder="目录显示名称"
      maxlength="100"
      show-count
      @keyup.enter="rename"
    /><template #footer
      ><div class="modal-actions">
        <n-button @click="renaming = null">取消</n-button
        ><n-button type="primary" :loading="saving" :disabled="!newName.trim()" @click="rename"
          >保存</n-button
        >
      </div></template
    ></n-modal
  >
</template>
