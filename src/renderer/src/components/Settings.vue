<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NSelect, NTooltip, useDialog, useMessage } from 'naive-ui'
import { RefreshCw, Download, Trash2, ImagePlus, Info } from 'lucide-vue-next'
import { useDashboard } from '../store'
import LanSettings from './LanSettings.vue'
import {
  terminalIds,
  terminalNames,
  type AvatarKey,
  type IntegrationView,
  type Settings
} from '../../../shared/types'

const dashboard = useDashboard()
const api = window.ebisu
const message = useMessage()
const dialog = useDialog()
const pending = ref('')
const themeOptions = [
  { label: '跟随系统', value: 'system' },
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' }
]
const avatarItems: { key: AvatarKey; label: string }[] = [
  ...(['gpt', 'claude', 'deepseek', 'kimi', 'qwen', 'gemini', 'grok'] as const).map((key) => ({
    key: `model:${key}` as AvatarKey,
    label: {
      gpt: 'GPT',
      claude: 'Claude',
      deepseek: 'DeepSeek',
      kimi: 'Kimi',
      qwen: 'Qwen',
      gemini: 'Gemini',
      grok: 'Grok'
    }[key]
  })),
  ...terminalIds.map((key) => ({
    key: `terminal:${key}` as AvatarKey,
    // 头像格子空间有限，DSH 使用短名称，避免折行；其他界面仍显示完整名称。
    label: key === 'dsh' ? 'DSH' : terminalNames[key]
  }))
]
const allAvatarItems = [
  ...avatarItems,
  ...avatarItems
    .filter((item) => item.key.startsWith('model:'))
    .map((item) => ({
      ...item,
      key: item.key.replace('model:', 'tray:') as AvatarKey
    }))
]
const installedCount = computed(
  () => dashboard.snapshot?.integrations.filter((item) => item.installed).length ?? 0
)
async function run(
  key: string,
  operation: () => Promise<unknown>,
  success?: string
): Promise<void> {
  pending.value = key
  try {
    const result = await operation()
    if (success || typeof result === 'string')
      message.success(success || String(result), { duration: 5000 })
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  } finally {
    pending.value = ''
    await dashboard.refresh()
  }
}
function uninstall(item: IntegrationView): void {
  dialog.warning({
    title: `卸载 ${item.name} 集成`,
    content:
      '将移除 Ebisu 管理的规则、hook、管理技能及业务技能入口；中央技能、共享经验、变量和已有终端配置保留。',
    positiveText: '卸载集成',
    negativeText: '取消',
    onPositiveClick: () =>
      run(`${item.id}:uninstall`, () => api.uninstall(item.id), '集成已卸载；现有会话可能需要重启')
  })
}
</script>

<template>
  <LanSettings />
  <div class="section-heading integration-heading">
    <h2>终端集成</h2>
    <div class="section-actions">
      <span class="section-meta"
        >{{ installedCount }} /
        {{ dashboard.snapshot?.integrations.length ?? terminalIds.length }} 已安装</span
      >
      <n-button
        :loading="pending === 'rescan'"
        :disabled="!!pending"
        @click="run('rescan', () => api.rescan(), '已重新探测终端')"
      >
        <template #icon><RefreshCw :size="15" /></template>重新探测
      </n-button>
    </div>
  </div>
  <div class="integration-list">
    <div
      v-for="item in dashboard.snapshot?.integrations"
      :key="item.id"
      class="integration-row"
      :data-terminal="item.id"
    >
      <img
        :src="`ebisu-asset://avatar/terminal/${item.id}?v=${dashboard.revision}`"
        :alt="item.name"
        class="terminal-icon"
      />
      <div class="integration-info">
        <div class="integration-name">
          <strong>{{ item.name }}</strong
          ><span class="detected-label" :class="{ missing: !item.detected }"
            ><span class="status-dot" :class="item.detected ? 'green' : 'gray'"></span
            >{{ item.detected ? '已检测到' : '未安装' }}</span
          >
        </div>
        <n-tooltip v-if="item.evidence.length" :delay="600"
          ><template #trigger
            ><span class="integration-evidence">{{ item.evidence[0] }}</span></template
          >
          <div v-for="evidence in item.evidence" :key="evidence">
            {{ evidence }}
          </div></n-tooltip
        >
      </div>
      <span class="installation-badge" :class="{ installed: item.installed }">{{
        item.installed ? '已安装' : '未安装'
      }}</span>
      <div class="integration-actions">
        <template v-if="item.installed"
          ><n-button
            size="small"
            :disabled="!!pending"
            :loading="pending === `${item.id}:check`"
            @click="run(`${item.id}:check`, () => api.check(item.id))"
            >检查</n-button
          ><n-button
            v-if="item.health === 'damaged'"
            size="small"
            :disabled="!!pending || !item.detected"
            @click="
              run(`${item.id}:install`, () => api.install(item.id), '配置已更新，请重启已有会话')
            "
            >修复</n-button
          ><n-button
            quaternary
            size="small"
            :disabled="!!pending"
            :loading="pending === `${item.id}:uninstall`"
            :title="`卸载 ${item.name} 集成`"
            @click="uninstall(item)"
            ><Trash2 :size="15" /></n-button></template
        ><n-button
          v-else
          size="small"
          :type="item.detected ? 'primary' : 'default'"
          :disabled="!item.detected || !!pending"
          :loading="pending === `${item.id}:install`"
          @click="
            run(`${item.id}:install`, () => api.install(item.id), '集成已安装，请重启已有会话')
          "
          ><template #icon><Download :size="14" /></template>安装集成</n-button
        >
      </div>
    </div>
  </div>
  <div class="integration-tip">
    <Info :size="15" />
    <p>
      集成包含全局规则、skill 与终端支持的
      hook。安装后重启已有会话，可通过“检查”确认本机服务连通。十分钟无心跳会自动释放占用。
    </p>
  </div>
  <div class="section-heading preference-heading">
    <h2>外观偏好</h2>
  </div>
  <div class="preference-panel">
    <div class="preference-row">
      <div>
        <strong>界面主题</strong>
        <p>主窗口与托盘弹窗使用相同的外观</p>
      </div>
      <n-select
        :value="dashboard.snapshot?.settings.theme"
        :options="themeOptions"
        style="width: 150px"
        @update:value="(theme: Settings['theme']) => run('theme', () => api.setTheme(theme))"
      />
    </div>
    <div class="preference-divider"></div>
    <div class="avatar-section-heading">
      <div>
        <strong>头像与背景</strong>
        <p>
          会话头像使用终端商标；卡片背景使用已识别模型的角色形象，未识别模型时不显示背景。点击图片可替换本地素材。
        </p>
      </div>
      <n-button text size="small" @click="run('reset', () => api.resetAvatars(), '已恢复默认头像')"
        >恢复默认</n-button
      >
    </div>
    <div class="avatar-grid">
      <button
        v-for="item in allAvatarItems"
        :key="item.key"
        class="avatar-option"
        :data-avatar="item.key"
        :disabled="!!pending"
        @click="run(item.key, () => api.chooseAvatar(item.key))"
      >
        <div>
          <img
            :src="`ebisu-asset://avatar/${item.key.replace(':', '/')}?v=${dashboard.revision}`"
            :alt="item.label"
          /><span class="avatar-edit"><ImagePlus :size="14" /></span>
        </div>
        <span>{{ item.label }}</span
        ><small>{{
          item.key.startsWith('terminal:')
            ? '终端商标'
            : item.key.startsWith('tray:')
              ? '托盘模型形象'
              : '模型形象'
        }}</small>
      </button>
    </div>
  </div>
</template>
