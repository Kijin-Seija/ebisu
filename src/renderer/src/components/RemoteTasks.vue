<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NButton, NInput, NSelect, NTag, useDialog, useMessage } from 'naive-ui'
import { ListTodo, MessagesSquare, Plus, Send } from 'lucide-vue-next'
import { useDashboard } from '../store'
import type { RemoteCommand, RemoteCommandTerminal, RemoteDevice } from '../../../shared/lan'
import type { ChatChannelSummary, ChatMessage } from '../../../shared/chat'
import AgentConversation, { type ConversationItem } from './AgentConversation.vue'

interface TaskRecord {
  command: RemoteCommand
  deviceId: string
  deviceName: string
  outgoing: boolean
}

const dashboard = useDashboard()
const api = window.ebisu
const message = useMessage()
const dialog = useDialog()
const tab = ref<'running' | 'chats' | 'create'>('running')
/** 当前打开的对话：Agent 频道或单条远程任务。 */
const selected = ref<{ kind: 'chat' | 'command'; id: string } | null>(null)
const chatMessages = ref<ChatMessage[]>([])
const chatLoading = ref(false)
const submitting = ref(false)
const history = ref<TaskRecord[]>([])
const selectedDevice = ref('')
const form = reactive<{
  terminal: RemoteCommandTerminal
  path: string
  prompt: string
}>({ terminal: 'codex', path: '', prompt: '' })
const terminalOptions = [
  { label: 'Codex', value: 'codex' },
  { label: 'Claude Code', value: 'claude' },
  { label: 'DeepSeek Harness', value: 'dsh' },
  { label: 'Qoder', value: 'qoder' }
]
const peers = computed<RemoteDevice[]>(() =>
  (dashboard.snapshot?.lan?.peers ?? []).filter((peer) => peer.online)
)
const deviceOptions = computed(() =>
  peers.value.map((peer) => ({ label: peer.name, value: peer.id }))
)
watch(
  deviceOptions,
  (options) => {
    if (!options.some((option) => option.value === selectedDevice.value))
      selectedDevice.value = options[0]?.value ?? ''
  },
  { immediate: true }
)
const tasks = computed<TaskRecord[]>(() => {
  const byId = new Map<string, TaskRecord>()
  const localDeviceId = dashboard.snapshot?.lan?.device.id
  for (const command of dashboard.snapshot?.lan?.commands ?? []) {
    byId.set(command.commandId, {
      command,
      deviceId: command.source.id,
      deviceName: command.source.name,
      outgoing: false
    })
  }
  for (const item of history.value) byId.set(item.command.commandId, item)
  return [...byId.values()]
    .sort((a, b) => b.command.createdAt - a.command.createdAt)
    .map((item) => ({
      ...item,
      // 本机列表中的任务来自远端；历史记录中的任务目标已在 history 中保存。
      outgoing: item.outgoing && item.command.source.id === localDeviceId
    }))
})
const activeTasks = computed(() =>
  tasks.value.filter((item) => ['queued', 'running', 'waiting'].includes(item.command.status))
)
const chats = computed<ChatChannelSummary[]>(() => dashboard.snapshot?.lan?.chats ?? [])
const localDeviceId = computed(() => dashboard.snapshot?.lan?.device.id ?? '')
/** 设备 ID 到名称：本机与已配对设备；未知设备显示短 ID。 */
function deviceName(id: string) {
  const lan = dashboard.snapshot?.lan
  if (lan?.device.id === id) return `${lan.device.name}（本机）`
  return lan?.peers.find((peer) => peer.id === id)?.name ?? id.slice(0, 8)
}
const selectedChat = computed(() =>
  selected.value?.kind === 'chat' ? chats.value.find((c) => c.id === selected.value!.id) : undefined
)
const selectedTask = computed(() =>
  selected.value?.kind === 'command'
    ? tasks.value.find((t) => t.command.commandId === selected.value!.id)
    : undefined
)
async function loadChat() {
  const id = selected.value?.kind === 'chat' ? selected.value.id : null
  if (!id) return
  chatLoading.value = true
  try {
    const messages = await api.chatHistory(id)
    if (selected.value?.id === id) chatMessages.value = messages
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  } finally {
    chatLoading.value = false
  }
}
// 频道摘要随快照刷新；最后一条消息变化时重新拉取完整历史。
watch(
  () => [
    selected.value?.id,
    selectedChat.value?.count,
    selectedChat.value?.last?.id,
    // 图片下载完成后 pendingFiles 减少，重新拉取以更新附件路径。
    selectedChat.value?.pendingFiles
  ],
  () => void loadChat()
)
function open(kind: 'chat' | 'command', id: string) {
  chatMessages.value = []
  selected.value = { kind, id }
}
const conversation = computed(() => {
  const chat = selectedChat.value
  if (chat) {
    const sorted = [...chatMessages.value].sort(
      (a, b) => a.createdAt - b.createdAt || a.seq - b.seq
    )
    // 首个发言者（通常是主控）固定在右侧，其余参与者在左侧；各设备上布局一致。
    const participants = [...new Set([...sorted.map((m) => m.from), ...chat.members])]
    const items: ConversationItem[] = sorted.map((item) => ({
      key: item.id,
      author: item.from,
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
    }))
    return {
      title: chat.title,
      subtitle: `${chat.devices.map(deviceName).join(' · ')} · ${chat.count} 条消息`,
      participants,
      items
    }
  }
  const task = selectedTask.value
  if (!task) return null
  const command = task.command
  const target = task.outgoing ? task.deviceName : deviceName(localDeviceId.value)
  const source = task.outgoing ? deviceName(localDeviceId.value) : task.deviceName
  const agent = `${command.terminal}${command.sessionId ? ` · ${command.sessionId.slice(0, 12)}` : ''}`
  const items: ConversationItem[] = [
    {
      key: 'prompt',
      author: '发起方',
      device: source,
      side: task.outgoing ? 'right' : 'left',
      type: 'task',
      time: command.createdAt,
      body: command.prompt
    }
  ]
  if (command.result)
    items.push({
      key: 'result',
      author: agent,
      device: target,
      side: task.outgoing ? 'left' : 'right',
      type: command.result.status,
      time: command.finishedAt ?? command.createdAt,
      body: [command.result.summary, command.result.error].filter(Boolean).join('\n\n'),
      detail: command.result.output
    })
  else
    items.push({
      key: 'pending',
      author: agent,
      device: target,
      side: task.outgoing ? 'left' : 'right',
      type: command.status,
      time: command.startedAt ?? command.createdAt,
      body: `${displayStatus(command.status)}…`,
      pending: true
    })
  return {
    title: `${command.terminal} 远程任务`,
    subtitle: `${source} → ${target} · ${command.path}`,
    participants: ['发起方', agent],
    items
  }
})
// 打开的对象被清理或消失时回到列表。
watch(conversation, (value) => {
  if (selected.value && !value && !chatLoading.value) selected.value = null
})
function shortTime(value: number) {
  return new Date(value).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}
const statusLabel: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  waiting: '等待输入',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
}
const statusType: Record<string, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  queued: 'default',
  running: 'info',
  waiting: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'default'
}
function displayStatus(status: string) {
  return statusLabel[status] ?? status
}
async function submit() {
  if (!selectedDevice.value) {
    message.warning('请先选择远程设备')
    return
  }
  if (!form.path.trim() || !form.prompt.trim()) {
    message.warning('请填写远端绝对路径和任务提示词')
    return
  }
  const peer = peers.value.find((item) => item.id === selectedDevice.value)
  if (!peer) {
    message.warning('远程设备已离线')
    return
  }
  submitting.value = true
  try {
    const command = await api.remoteCommand(peer.id, {
      requestId: crypto.randomUUID(),
      terminal: form.terminal,
      path: form.path.trim(),
      prompt: form.prompt.trim()
    })
    const item = { command, deviceId: peer.id, deviceName: peer.name, outgoing: true }
    history.value.unshift(item)
    form.prompt = ''
    tab.value = 'running'
    void watchTask(item)
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  } finally {
    submitting.value = false
    await dashboard.refresh()
  }
}
async function watchTask(item: TaskRecord) {
  let current = item.command
  for (let attempt = 0; attempt < 180; attempt++) {
    if (!['queued', 'running', 'waiting'].includes(current.status)) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      current = await api.remoteCommandStatus(item.deviceId, current.commandId)
      item.command = current
    } catch {
      break
    }
  }
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
        if (selected.value?.kind === 'chat' && selected.value.id === chat.id) selected.value = null
        message.success('已删除频道')
      } catch (error) {
        message.error(String(error), { duration: 6000 })
      } finally {
        await dashboard.refresh()
      }
    }
  })
}
async function cancel(item: TaskRecord) {
  try {
    item.command = item.outgoing
      ? await api.cancelRemoteCommand(item.deviceId, item.command.commandId)
      : await api.cancelLocalCommand(item.command.commandId)
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  }
}
</script>

<template>
  <section class="remote-tasks-page">
    <div class="page-heading remote-tasks-heading">
      <div>
        <p class="eyebrow">LAN AUTOMATION</p>
        <h1>远程 Agent 任务<span class="title-period">.</span></h1>
        <p>在已配对设备上创建会出现在对应终端会话列表中的任务。</p>
      </div>
    </div>
    <AgentConversation
      v-if="conversation"
      :title="conversation.title"
      :subtitle="conversation.subtitle"
      :participants="conversation.participants"
      :items="conversation.items"
      :loading="chatLoading"
      @back="selected = null"
    />
    <template v-else>
      <div class="remote-task-tabs" role="tablist" aria-label="远程任务视图">
        <button
          role="tab"
          :aria-selected="tab === 'running'"
          :class="{ selected: tab === 'running' }"
          @click="tab = 'running'"
        >
          <ListTodo :size="16" />正在执行
          <span class="tab-count">{{ activeTasks.length }}</span>
        </button>
        <button
          role="tab"
          :aria-selected="tab === 'chats'"
          :class="{ selected: tab === 'chats' }"
          @click="tab = 'chats'"
        >
          <MessagesSquare :size="16" />Agent 对话
          <span class="tab-count">{{ chats.length }}</span>
        </button>
        <button
          role="tab"
          :aria-selected="tab === 'create'"
          :class="{ selected: tab === 'create' }"
          @click="tab = 'create'"
        >
          <Plus :size="16" />手动执行
        </button>
      </div>

      <div v-if="tab === 'running'" class="remote-task-list">
        <div v-if="!tasks.length" class="remote-task-empty">
          <ListTodo :size="34" />
          <strong>暂时没有远程任务</strong>
          <span>选择“手动执行”在其他设备上创建一个 Agent 会话。</span>
          <n-button type="primary" @click="tab = 'create'">创建远程任务</n-button>
        </div>
        <template v-else>
          <article
            v-for="item in tasks"
            :key="item.command.commandId"
            class="remote-task-card clickable"
            role="button"
            tabindex="0"
            @click="open('command', item.command.commandId)"
            @keydown.enter="open('command', item.command.commandId)"
          >
            <div class="remote-task-card-head">
              <div>
                <div class="remote-task-title">
                  <strong>{{ item.command.terminal }}</strong>
                  <n-tag size="small" :type="statusType[item.command.status] ?? 'default'">
                    {{ displayStatus(item.command.status) }}
                  </n-tag>
                </div>
                <p class="remote-task-device">
                  {{ item.outgoing ? '发送到' : '来自' }} {{ item.deviceName }}
                </p>
              </div>
              <n-button
                v-if="['queued', 'running', 'waiting'].includes(item.command.status)"
                size="small"
                secondary
                @click.stop="cancel(item)"
                >取消</n-button
              >
            </div>
            <p class="remote-task-path">{{ item.command.path }}</p>
            <p class="remote-task-prompt">{{ item.command.prompt }}</p>
            <div class="remote-task-meta">
              <span v-if="item.command.sessionId">会话 {{ item.command.sessionId }}</span>
              <span v-if="item.command.result">{{ item.command.result.summary }}</span>
            </div>
          </article>
        </template>
      </div>

      <div v-else-if="tab === 'chats'" class="remote-task-list">
        <div v-if="!chats.length" class="remote-task-empty">
          <MessagesSquare :size="34" />
          <strong>暂时没有 Agent 对话</strong>
          <span>Agent 通过 report --chat 创建频道并发消息后，会在所有参与设备上同步出现。</span>
        </div>
        <article
          v-for="chat in chats"
          v-else
          :key="chat.id"
          class="remote-task-card clickable"
          role="button"
          tabindex="0"
          @click="open('chat', chat.id)"
          @keydown.enter="open('chat', chat.id)"
        >
          <div class="remote-task-card-head">
            <div>
              <div class="remote-task-title">
                <strong>{{ chat.title }}</strong>
                <n-tag size="small">{{ chat.count }} 条</n-tag>
              </div>
              <p class="remote-task-device">
                {{ chat.members.join('、') || '暂无参与者' }}
              </p>
            </div>
            <div class="chat-card-actions">
              <span class="section-meta">{{
                shortTime(chat.last?.createdAt ?? chat.updatedAt)
              }}</span>
              <n-button size="small" secondary type="error" @click.stop="removeChat(chat)"
                >删除</n-button
              >
            </div>
          </div>
          <p v-if="chat.last" class="remote-task-prompt chat-preview">
            <strong>{{ chat.last.from }}：</strong>{{ chat.last.body }}
          </p>
          <div class="remote-task-meta">
            <span>{{ chat.devices.map(deviceName).join(' · ') }}</span>
          </div>
        </article>
      </div>

      <div v-else class="remote-task-composer">
        <div class="remote-task-composer-intro">
          <Send :size="26" />
          <div>
            <h2>创建远程会话</h2>
            <p>任务会在目标设备的对应终端中创建真实会话，并出现在该终端的会话列表。</p>
          </div>
        </div>
        <div class="remote-task-form-grid">
          <label>
            <span>远程设备</span>
            <n-select
              v-model:value="selectedDevice"
              :options="deviceOptions"
              placeholder="选择已配对设备"
              :disabled="!deviceOptions.length"
            />
          </label>
          <label>
            <span>终端</span>
            <n-select v-model:value="form.terminal" :options="terminalOptions" />
          </label>
          <label class="remote-task-path-field">
            <span>远端项目路径</span>
            <n-input v-model:value="form.path" placeholder="/Users/you/code/project" />
          </label>
        </div>
        <label class="remote-task-prompt-field">
          <span>任务提示词</span>
          <n-input
            v-model:value="form.prompt"
            type="textarea"
            :autosize="{ minRows: 8, maxRows: 16 }"
            placeholder="描述你希望远程 Agent 完成的任务…"
          />
        </label>
        <div class="remote-task-composer-footer">
          <span v-if="!deviceOptions.length" class="section-meta">没有在线的已配对设备</span>
          <span v-else class="section-meta">任务将在远程设备自动执行，并返回结构化结论。</span>
          <n-button
            type="primary"
            size="large"
            :loading="submitting"
            :disabled="!deviceOptions.length"
            @click="submit"
          >
            <template #icon><Send :size="16" /></template>
            创建远程会话
          </n-button>
        </div>
      </div>
    </template>
  </section>
</template>
