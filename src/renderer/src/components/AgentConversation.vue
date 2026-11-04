<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { NButton, NImage, NImageGroup, NTag } from 'naive-ui'
import { ArrowLeft, MessagesSquare } from 'lucide-vue-next'

/** 对话流中的一条气泡；right 表示主控/首发言者一侧发出的内容。 */
export interface ConversationItem {
  key: string
  author: string
  /** 发送者对应的模型或终端头像地址。 */
  avatar?: string
  /** 定向消息的接收者。 */
  recipient?: string
  device: string
  side: 'left' | 'right'
  type: string
  time: number
  body: string
  /** 可折叠的补充内容，例如远程任务的原始输出。 */
  detail?: string
  pending?: boolean
  /** 图片附件；pending 表示本机仍在从对端同步该图片。 */
  images?: ConversationImage[]
}
export interface ConversationImage {
  key: string
  name: string
  /** ebisu-asset://chat-image/<hash>；同步中时为空。 */
  src: string | null
  pending?: boolean
}

const props = defineProps<{
  title: string
  subtitle: string
  participants: string[]
  items: ConversationItem[]
  loading?: boolean
  showBack?: boolean
}>()
const emit = defineEmits<{ back: [] }>()
const scroller = ref<HTMLElement>()
/** 参与者颜色按出现顺序分配，保证同一频道内稳定。 */
const tones = ['tone-0', 'tone-1', 'tone-2', 'tone-3']
function tone(author: string) {
  const index = props.participants.indexOf(author)
  return tones[(index < 0 ? 0 : index) % tones.length]
}
function avatarInitial(author: string) {
  const name = author.split('/').pop()?.trim() || author.trim()
  return (name[0] || '?').toUpperCase()
}
function time(value: number) {
  const date = new Date(value)
  const today = new Date().toDateString() === date.toDateString()
  return today
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : date.toLocaleString([], {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
}
/** 切换频道或停留在底部时跟随新消息滚动，避免打断向上翻阅。 */
watch(
  () => [props.title, props.items.length] as const,
  async ([nextTitle], previous) => {
    const switched = !previous || previous[0] !== nextTitle
    const element = scroller.value
    const atBottom =
      !element || element.scrollHeight - element.scrollTop - element.clientHeight < 80
    await nextTick()
    if (scroller.value && (switched || atBottom || !previous?.[1]))
      scroller.value.scrollTop = scroller.value.scrollHeight
  },
  { immediate: true }
)
</script>

<template>
  <section class="conversation">
    <header class="conversation-head">
      <n-button v-if="showBack" quaternary circle aria-label="返回列表" @click="emit('back')">
        <template #icon><ArrowLeft :size="18" /></template>
      </n-button>
      <div class="conversation-title">
        <h2>{{ title }}</h2>
        <p>{{ subtitle }}</p>
      </div>
      <div class="conversation-participants">
        <span v-for="name in participants" :key="name" :class="['participant', tone(name)]">
          {{ name }}
        </span>
      </div>
    </header>
    <div ref="scroller" class="conversation-scroll">
      <div v-if="!items.length" class="remote-task-empty">
        <MessagesSquare :size="30" />
        <strong>{{ loading ? '正在加载对话…' : '还没有消息' }}</strong>
      </div>
      <article
        v-for="item in items"
        :key="item.key"
        :class="['bubble-row', item.side, { pending: item.pending }]"
      >
        <div class="bubble-avatar" :title="item.author">
          <img v-if="item.avatar" :src="item.avatar" :alt="item.author" draggable="false" />
          <span v-else class="bubble-avatar-fallback" :class="tone(item.author)">{{
            avatarInitial(item.author)
          }}</span>
        </div>
        <div class="bubble-content">
          <div class="bubble-meta">
            <strong :class="tone(item.author)">{{ item.author }}</strong>
            <template v-if="item.recipient">
              <span>→</span>
              <strong :class="tone(item.recipient)">{{ item.recipient }}</strong>
            </template>
            <span>{{ item.device }}</span>
            <n-tag v-if="item.type !== 'text'" size="tiny" :bordered="false">{{ item.type }}</n-tag>
            <time>{{ time(item.time) }}</time>
          </div>
          <div class="bubble">
            <p>{{ item.body }}</p>
            <n-image-group v-if="item.images?.length">
              <div class="bubble-images">
                <template v-for="image in item.images" :key="image.key">
                  <n-image
                    v-if="image.src"
                    class="bubble-image"
                    :src="image.src"
                    :alt="image.name"
                    :title="image.name"
                    width="120"
                    height="120"
                    object-fit="cover"
                  />
                  <div v-else class="bubble-image placeholder" :title="image.name">图片同步中…</div>
                </template>
              </div>
            </n-image-group>
            <details v-if="item.detail">
              <summary>查看原始输出</summary>
              <pre>{{ item.detail }}</pre>
            </details>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
