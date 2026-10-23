<script setup lang="ts">
import { NBadge, NPopover } from 'naive-ui'
import type { SessionActivity } from '../../../shared/types'
import { avatarUrl } from '../avatars'
import { useDashboard } from '../store'
import SessionDetails from './SessionDetails.vue'

/** 普通头像与溢出气泡内的头像共用状态、详情和复制入口，避免两种展示行为不一致。 */
defineProps<{ session: SessionActivity }>()
const dashboard = useDashboard()
const badgeTypes = { executing: 'info', waiting: 'warning', error: 'error' } as const
const phaseLabels = { executing: '执行中', waiting: '需要处理', error: '出现故障' } as const
</script>

<template>
  <n-popover trigger="hover" placement="bottom-start" :delay="200" :width="320">
    <template #trigger>
      <button
        class="session"
        :class="{ waiting: session.phase === 'waiting', error: session.phase === 'error' }"
        :aria-label="`查看 ${session.terminal} 会话 ${session.sessionId} 详情，${phaseLabels[session.phase]}`"
      >
        <n-badge
          class="session-status-badge"
          :data-status="session.phase"
          :type="badgeTypes[session.phase]"
          :offset="[-4, 2]"
          processing
        >
          <img
            :src="avatarUrl(session, dashboard.revision)"
            class="session-avatar"
            :alt="session.terminal"
          />
          <template #value>
            <span v-if="session.phase === 'waiting'" aria-hidden="true">?</span>
            <span v-else-if="session.phase === 'error'" aria-hidden="true">!</span>
            <span v-else class="session-executing-dots" aria-hidden="true">
              <i></i><i></i><i></i>
            </span>
          </template>
        </n-badge>
      </button>
    </template>
    <SessionDetails :session="session" />
  </n-popover>
</template>
