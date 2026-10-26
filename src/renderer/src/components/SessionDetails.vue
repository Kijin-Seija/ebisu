<script setup lang="ts">
import { NButton, NTag, NTooltip, useMessage } from 'naive-ui'
import { Copy, ExternalLink } from 'lucide-vue-next'
import type { SessionActivity } from '../../../shared/types'

defineProps<{ session: SessionActivity }>()
const message = useMessage()
const names = {
  codex: 'Codex',
  workbuddy: 'WorkBuddy',
  claude: 'Claude Code',
  grok: 'Grok',
  qoder: 'Qoder'
}
const phaseTypes = { executing: 'info', waiting: 'warning', error: 'error' } as const
const phaseLabels = { executing: '执行中', waiting: '问题待确认', error: '出现故障' } as const

/** Codex 会话 ID 同时是桌面深链的 thread ID；其他终端暂不提供跳转按钮。 */
async function openSession(session: SessionActivity): Promise<void> {
  if (session.terminal !== 'codex') return
  try {
    await window.ebisu.openSession(session.terminal, session.sessionId)
  } catch (error) {
    message.error(String(error))
  }
}

/** 详情里始终展示完整 ID；复制失败就地反馈。 */
async function copyId(id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(id)
    message.success('会话 ID 已复制')
  } catch {
    message.error('复制失败，请选择会话 ID 手动复制')
  }
}
</script>

<template>
  <div class="session-details detail-panel">
    <div class="detail-session-heading">
      <div class="detail-session-name">
        <strong>{{ names[session.terminal] }}</strong>
        <n-tooltip v-if="session.terminal === 'codex'">
          <template #trigger>
            <n-button
              text
              size="small"
              class="open-session-button"
              aria-label="打开 Codex 会话"
              @click.stop="openSession(session)"
            >
              <template #icon><ExternalLink :size="14" /></template>
            </n-button>
          </template>
          打开 Codex 会话
        </n-tooltip>
      </div>
      <n-tag size="small" :bordered="false" :type="phaseTypes[session.phase]">
        {{ phaseLabels[session.phase] }}
      </n-tag>
    </div>
    <div class="detail-field session-task">
      <span>任务</span
      ><strong class="session-task-title">{{ session.taskTitle || '未提供' }}</strong>
    </div>
    <div class="detail-field">
      <span>模型</span><code>{{ session.model || '未知' }}</code>
    </div>
    <div class="detail-field">
      <div class="session-id-heading">
        <span>会话 ID</span>
        <n-button
          text
          size="small"
          class="copy-session-id"
          aria-label="复制 ID"
          title="复制 ID"
          @click="copyId(session.sessionId)"
        >
          <template #icon><Copy :size="14" /></template>
        </n-button>
      </div>
      <code class="session-full-id">{{ session.sessionId }}</code>
    </div>
  </div>
</template>
