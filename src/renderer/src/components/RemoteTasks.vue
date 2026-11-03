<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NButton, NInput, NSelect, NTag, useMessage } from 'naive-ui'
import { ListTodo, Plus, Send } from 'lucide-vue-next'
import { useDashboard } from '../store'
import type { RemoteCommand, RemoteCommandTerminal, RemoteDevice } from '../../../shared/lan'

interface TaskRecord {
  command: RemoteCommand
  deviceId: string
  deviceName: string
  outgoing: boolean
}

const dashboard = useDashboard()
const api = window.ebisu
const message = useMessage()
const tab = ref<'running' | 'create'>('running')
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
        <article v-for="item in tasks" :key="item.command.commandId" class="remote-task-card">
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
              @click="cancel(item)"
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
  </section>
</template>
