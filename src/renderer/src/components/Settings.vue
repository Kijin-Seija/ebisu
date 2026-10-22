<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NSelect, NTooltip, useDialog, useMessage } from 'naive-ui'
import { RefreshCw, Download, Trash2, ImagePlus, Info } from 'lucide-vue-next'
import { useDashboard } from '../store'
import type { AvatarKey, IntegrationView, Settings } from '../../../shared/types'

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
  ...(['codex', 'workbuddy', 'claude', 'grok', 'qoder'] as const).map((key) => ({
    key: `terminal:${key}` as AvatarKey,
    label: {
      codex: 'Codex',
      workbuddy: 'WorkBuddy',
      claude: 'Claude Code',
      grok: 'Grok',
      qoder: 'Qoder'
    }[key]
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
    content: '将移除 Ebisu 管理的通知 skill、规则与 hook，保留已有终端配置和备份。',
    positiveText: '卸载集成',
    negativeText: '取消',
    onPositiveClick: () =>
      run(`${item.id}:uninstall`, () => api.uninstall(item.id), '集成已卸载；现有会话可能需要重启')
  })
}
</script>

<template>
  <div class="section-heading integration-heading">
    <h2>终端集成</h2>
    <div class="section-actions">
      <span class="section-meta">{{ installedCount }} / 5 已安装</span>
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
          <div v-for="evidence in item.evidence" :key="evidence">{{ evidence }}</div></n-tooltip
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
        <strong>会话头像</strong>
        <p>识别模型时使用模型形象，否则使用终端商标。点击头像可替换本地图片。</p>
      </div>
      <n-button text size="small" @click="run('reset', () => api.resetAvatars(), '已恢复默认头像')"
        >恢复默认</n-button
      >
    </div>
    <div class="avatar-grid">
      <button
        v-for="item in avatarItems"
        :key="item.key"
        class="avatar-option"
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
        ><small>{{ item.key.startsWith('model:') ? '模型形象' : '终端商标' }}</small>
      </button>
    </div>
  </div>
</template>
