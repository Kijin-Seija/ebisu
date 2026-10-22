<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NBadge, NPopover } from 'naive-ui'
import type { SessionActivity } from '../../../shared/types'
import SessionAvatar from './SessionAvatar.vue'

// 托盘显式限制直接展示的头像数；主面板不传上限，随卡片宽度动态计算。
const props = defineProps<{ sessions: SessionActivity[]; maxVisible?: number }>()
const row = ref<HTMLElement>()
const width = ref(0)
// 尺寸同时传给 CSS 和容量计算；头像增大或间隔调整时不会导致 +x 挤到第二行。
const avatarSize = 34
const avatarGap = 8
const slots = computed(() =>
  Math.max(1, Math.floor((width.value + avatarGap) / (avatarSize + avatarGap)))
)
const visibleCount = computed(() => {
  if (props.maxVisible !== undefined) return props.maxVisible
  return props.sessions.length <= slots.value ? props.sessions.length : slots.value - 1
})
const visible = computed(() => props.sessions.slice(0, visibleCount.value))
const hidden = computed(() => props.sessions.slice(visibleCount.value))
/** +x 仅汇总被它折叠的会话，已直接展示的等待状态由各自 badge 提示。 */
const hiddenWaiting = computed(() => hidden.value.some((session) => session.phase === 'waiting'))
// Teleport 后的气泡不继承卡片上的变量，因此头像尺寸在两个容器中都显式提供。
const avatarStyle = {
  '--session-avatar-size': `${avatarSize}px`,
  '--session-avatar-gap': `${avatarGap}px`
}
let observer: ResizeObserver | undefined

/** 观察每张卡片的实际宽度，主窗口、托盘和窗口缩放时都只保留一行头像。 */
onMounted(() => {
  if (!row.value) return
  width.value = row.value.clientWidth
  observer = new ResizeObserver(([entry]) => {
    width.value = entry.contentRect.width
  })
  observer.observe(row.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div
    ref="row"
    class="session-avatar-row"
    :style="avatarStyle"
    :aria-label="`${sessions.length} 个活跃会话`"
  >
    <SessionAvatar
      v-for="session in visible"
      :key="`${session.terminal}:${session.sessionId}`"
      :session="session"
    />
    <n-popover v-if="hidden.length" trigger="hover" placement="bottom-start" :delay="200">
      <template #trigger>
        <n-badge
          class="session-status-badge session-group-badge"
          :show="hiddenWaiting"
          type="warning"
          value="!"
          :offset="[-4, 2]"
          processing
        >
          <button class="session-overflow" :aria-label="`查看其余 ${hidden.length} 个会话`">
            +{{ hidden.length }}
          </button>
        </n-badge>
      </template>
      <div class="overflow-session-avatars" :style="avatarStyle">
        <SessionAvatar
          v-for="session in hidden"
          :key="`${session.terminal}:${session.sessionId}`"
          :session="session"
        />
      </div>
    </n-popover>
  </div>
</template>
