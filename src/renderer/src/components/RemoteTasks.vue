<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NTag, useDialog, useMessage } from 'naive-ui'
import { MessagesSquare, Trash2 } from 'lucide-vue-next'
import { useDashboard } from '../store'
import { chatAvatarUrl } from '../avatars'
import type { ChatChannelSummary, ChatMessage } from '../../../shared/chat'
import AgentConversation, { type ConversationItem } from './AgentConversation.vue'

const dashboard = useDashboard()
const api = window.ebisu
const message = useMessage()
const dialog = useDialog()
/** 当前选中的频道 ID；列表非空时默认选中最新一条会话。 */
const selectedId = ref<string | null>(null)
const chatMessages = ref<ChatMessage[]>([])
const chatLoading = ref(false)
const chats = computed<ChatChannelSummary[]>(() => dashboard.snapshot?.lan?.chats ?? [])

/** 设备 ID 到名称：本机与已配对设备；未知设备显示短 ID。 */
function deviceName(id: string) {
  const lan = dashboard.snapshot?.lan
  if (lan?.device.id === id) return `${lan.device.name}（本机）`
  return lan?.peers.find((peer) => peer.id === id)?.name ?? id.slice(0, 8)
}

const selectedChat = computed(() =>
  selectedId.value ? chats.value.find((c) => c.id === selectedId.value) : undefined
)

// 列表非空且当前未选中（或原选中频道已被删除）时，自动选中排在第一位的频道。
watch(
  chats,
  (list) => {
    if (!list.length) {
      selectedId.value = null
      chatMessages.value = []
      return
    }
    if (!selectedId.value || !list.some((item) => item.id === selectedId.value)) {
      selectedId.value = list[0].id
    }
  },
  { immediate: true }
)

async function loadChat() {
  const id = selectedId.value
  if (!id) return
  chatLoading.value = true
  try {
    const messages = await api.chatHistory(id)
    if (selectedId.value === id) chatMessages.value = messages
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  } finally {
    chatLoading.value = false
  }
}

// 频道切换或摘要更新（新消息、图片同步完成）时重新拉取完整历史。
watch(
  () => [
    selectedId.value,
    selectedChat.value?.count,
    selectedChat.value?.last?.id,
    selectedChat.value?.pendingFiles
  ],
  (next, previous) => {
    if (next[0] !== previous?.[0]) chatMessages.value = []
    void loadChat()
  },
  { immediate: true }
)

function selectChat(id: string) {
  if (selectedId.value === id) return
  selectedId.value = id
}

/** 从本机与远端快照的活跃会话中按（设备, 终端, 会话 ID）查找发送者模型。 */
function activeSessionModel(origin: string, author: string, sessionId?: string): string | null {
  const terminal = author.split('/').pop()?.trim().toLowerCase()
  if (!terminal) return null
  const localId = dashboard.snapshot?.lan?.device.id
  const folders = dashboard.views.folders.filter((folder) =>
    folder.deviceId === 'local' ? origin === localId : folder.deviceId === origin
  )
  const sessions = folders.flatMap((folder) => folder.sessions)
  if (sessionId) {
    const exact = sessions.find(
      (s) => s.terminal === terminal && s.sessionId === sessionId && s.model
    )
    if (exact?.model) return exact.model
  }
  const byTerminal = sessions.find((s) => s.terminal === terminal && s.model)
  return byTerminal?.model ?? null
}

function parseClaimSession(body: string): string | undefined {
  try {
    const session = JSON.parse(body)?.session
    return typeof session === 'string' && session.trim() ? session.trim() : undefined
  } catch {
    return undefined
  }
}

const conversation = computed(() => {
  const chat = selectedChat.value
  if (!chat) return null
  const sorted = [...chatMessages.value].sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
  // 收集频道内各发送者认领绑定的会话 ID，用于回退查询活跃会话模型。
  const boundSessions = new Map<string, string>()
  for (const item of sorted) {
    if (item.type === 'claim') {
      const session = parseClaimSession(item.body)
      if (session) boundSessions.set(item.from, session)
    }
  }
  // 首个发言者（通常是主控）固定在右侧，其余参与者在左侧；各设备上布局一致。
  const participants = [...new Set([...sorted.map((m) => m.from), ...chat.members])]
  const items: ConversationItem[] = sorted.map((item) => {
    const model =
      item.model ?? activeSessionModel(item.origin, item.from, boundSessions.get(item.from))
    return {
      key: item.id,
      author: item.from,
      avatar: chatAvatarUrl({ author: item.from, model }, dashboard.revision),
      recipient: item.to ?? undefined,
      device: deviceName(item.origin),
      side: item.from === participants[0] ? 'right' : 'left',
      type: item.type,
      time: item.createdAt,
      body: item.body,
      images: item.attachments?.map((file) => ({
        key: file.hash,
        name: file.name,
        src: file.path ? `ebisu-asset://chat-image/${file.hash}` : null,
        pending: !file.path
      }))
    }
  })
  return {
    title: chat.title,
    subtitle: `${chat.devices.map(deviceName).join(' · ')} · ${chat.count} 条消息`,
    participants,
    items
  }
})

/** 左侧会话列表项头像：优先取最后一条消息发送者的模型头像，其次取首位成员。 */
function channelAvatar(chat: ChatChannelSummary): string | undefined {
  if (chat.last) {
    const model = chat.last.model ?? activeSessionModel(chat.last.origin, chat.last.from)
    return chatAvatarUrl({ author: chat.last.from, model }, dashboard.revision)
  }
  const firstMember = chat.members[0]
  return firstMember ? chatAvatarUrl({ author: firstMember }, dashboard.revision) : undefined
}

function channelInitial(chat: ChatChannelSummary): string {
  const source = chat.last?.from.split('/').pop() || chat.title
  return (source.trim()[0] || '#').toUpperCase()
}

function shortTime(value: number) {
  return new Date(value).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** 删除 Agent 对话频道；确认后本机与其他持有副本的设备都会删除。 */
function removeChat(chat: ChatChannelSummary) {
  dialog.warning({
    title: '删除对话频道',
    content: `删除「${chat.title}」及其全部消息？其他参与设备上的副本也会一并删除，且无法恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.deleteChat(chat.id)
        if (selectedId.value === chat.id) selectedId.value = null
        message.success('已删除频道')
      } catch (error) {
        message.error(String(error), { duration: 6000 })
      } finally {
        await dashboard.refresh()
      }
    }
  })
}
</script>

<template>
  <section class="remote-tasks-page">
    <div class="page-heading remote-tasks-heading">
      <h1>聊天室<span class="title-period">.</span></h1>
    </div>

    <div class="chatroom-layout">
      <aside class="chat-list-pane" aria-label="聊天会话列表">
        <header class="chat-list-head">
          <strong>会话列表</strong>
          <span class="tab-count">{{ chats.length }}</span>
        </header>
        <div v-if="!chats.length" class="chat-list-empty">
          <MessagesSquare :size="28" />
          <span>暂无聊天会话</span>
        </div>
        <div v-else class="chat-list-scroll">
          <article
            v-for="chat in chats"
            :key="chat.id"
            class="chat-list-item"
            :class="{ active: selectedId === chat.id }"
            role="button"
            tabindex="0"
            @click="selectChat(chat.id)"
            @keydown.enter="selectChat(chat.id)"
          >
            <div class="chat-list-avatar">
              <img
                v-if="channelAvatar(chat)"
                :src="channelAvatar(chat)"
                :alt="chat.last?.from || chat.title"
                draggable="false"
              />
              <span v-else class="chat-list-avatar-fallback">{{ channelInitial(chat) }}</span>
            </div>
            <div class="chat-list-body">
              <div class="chat-list-top">
                <strong class="chat-list-title" :title="chat.title">{{ chat.title }}</strong>
                <time class="chat-list-time">{{
                  shortTime(chat.last?.createdAt ?? chat.updatedAt)
                }}</time>
              </div>
              <p v-if="chat.last" class="chat-list-preview">
                <strong>{{ chat.last.from }}：</strong>{{ chat.last.body }}
              </p>
              <p v-else class="chat-list-preview">
                {{ chat.members.join('、') || '暂无参与者' }}
              </p>
              <div class="chat-list-foot">
                <span class="chat-list-devices">{{ chat.devices.map(deviceName).join(' · ') }}</span>
                <div class="chat-card-actions">
                  <n-tag size="tiny" :bordered="false">{{ chat.count }} 条</n-tag>
                  <button
                    class="chat-delete-button"
                    type="button"
                    :title="`删除 ${chat.title}`"
                    :aria-label="`删除 ${chat.title}`"
                    @click.stop="removeChat(chat)"
                  >
                    <Trash2 :size="14" />
                  </button>
                </div>
              </div>
            </div>
          </article>
        </div>
      </aside>

      <div class="chat-detail-pane">
        <AgentConversation
          v-if="conversation"
          :title="conversation.title"
          :subtitle="conversation.subtitle"
          :participants="conversation.participants"
          :items="conversation.items"
          :loading="chatLoading"
        />
        <div v-else class="chat-detail-empty">
          <MessagesSquare :size="36" />
          <strong>{{ chats.length ? '选择一个会话查看对话详情' : '暂时没有聊天会话' }}</strong>
          <span>Agent 通过 ebisu-chat 创建频道并发消息后，会在所有参与设备上同步出现。</span>
        </div>
      </div>
    </div>
  </section>
</template>
