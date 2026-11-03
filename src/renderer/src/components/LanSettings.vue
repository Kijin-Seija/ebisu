<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NButton, NInput, NSelect, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useDashboard } from '../store'
import type {
  NearbyDevice,
  RemoteCommand,
  RemoteCommandTerminal,
  RemoteDevice
} from '../../../shared/lan'
const dashboard = useDashboard()
const api = window.ebisu
const message = useMessage()
const dialog = useDialog()
const name = ref('')
const busy = ref(false)
const requesting = ref('')
const commandBusy = ref('')
const commandForms = reactive<
  Record<string, { terminal: RemoteCommandTerminal; path: string; prompt: string }>
>({})
const commandHistory = ref<RemoteCommand[]>([])
const commandTargets = reactive<Record<string, string>>({})
const terminalOptions = [
  { label: 'Codex', value: 'codex' },
  { label: 'Claude Code', value: 'claude' },
  { label: 'DeepSeek Harness', value: 'dsh' },
  { label: 'Qoder', value: 'qoder' }
]
const allCommands = computed(() => {
  const byId = new Map<string, RemoteCommand>()
  for (const command of dashboard.snapshot?.lan?.commands ?? [])
    byId.set(command.commandId, command)
  for (const command of commandHistory.value) byId.set(command.commandId, command)
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
})
/** 已配对设备不再出现在附近设备里，主进程已过滤，这里不再重复判断。 */
const nearby = computed<NearbyDevice[]>(() =>
  [...(dashboard.snapshot?.lan?.discovered ?? [])].sort((a, b) => a.name.localeCompare(b.name))
)
const peers = computed<RemoteDevice[]>(() =>
  [...(dashboard.snapshot?.lan?.peers ?? [])].sort((a, b) => a.name.localeCompare(b.name))
)
watch(
  () => dashboard.snapshot?.lan?.device.name,
  (value) => {
    if (value) name.value = value
  },
  { immediate: true }
)
async function run(action: () => Promise<unknown>) {
  busy.value = true
  try {
    await action()
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  } finally {
    busy.value = false
    await dashboard.refresh()
  }
}
function forget(id: string, label: string) {
  dialog.warning({
    title: '解除配对',
    content: `撤销「${label}」的访问权限并清除其缓存？已导入的技能会保留。`,
    positiveText: '解除配对',
    negativeText: '取消',
    onPositiveClick: () => run(() => api.unpairDevice(id))
  })
}
function formFor(id: string) {
  return (commandForms[id] ??= { terminal: 'codex', path: '', prompt: '' })
}
async function submitCommand(peer: RemoteDevice) {
  const form = formFor(peer.id)
  if (!form.path.trim() || !form.prompt.trim()) {
    message.warning('请填写远端绝对路径和任务提示词')
    return
  }
  commandBusy.value = peer.id
  try {
    const command = await api.remoteCommand(peer.id, {
      terminal: form.terminal,
      path: form.path.trim(),
      prompt: form.prompt.trim(),
      requestId: crypto.randomUUID()
    })
    commandHistory.value.unshift(command)
    commandTargets[command.commandId] = peer.id
    form.prompt = ''
    void watchCommand(peer.id, command)
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  } finally {
    commandBusy.value = ''
    await dashboard.refresh()
  }
}
async function watchCommand(deviceId: string, initial: RemoteCommand) {
  let current = initial
  for (let attempt = 0; attempt < 180; attempt++) {
    if (['completed', 'failed', 'cancelled'].includes(current.status)) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      current = await api.remoteCommandStatus(deviceId, current.commandId)
      const index = commandHistory.value.findIndex((item) => item.commandId === current.commandId)
      if (index >= 0) commandHistory.value[index] = current
    } catch {
      break
    }
  }
}
async function cancelCommand(item: RemoteCommand, deviceId: string) {
  try {
    const result = await api.cancelRemoteCommand(deviceId, item.commandId)
    const index = commandHistory.value.findIndex((entry) => entry.commandId === item.commandId)
    if (index >= 0) commandHistory.value[index] = result
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  }
}
async function cancelIncomingCommand(item: RemoteCommand) {
  try {
    const result = await api.cancelLocalCommand(item.commandId)
    const index =
      dashboard.snapshot?.lan?.commands.findIndex((entry) => entry.commandId === item.commandId) ??
      -1
    if (index >= 0 && dashboard.snapshot?.lan) dashboard.snapshot.lan.commands[index] = result
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  }
}
/** 请求配对后等待对方确认；超时仍会由后台继续等待，并在成功后自动出现在已配对设备里。 */
async function request(device: NearbyDevice) {
  requesting.value = device.id
  try {
    const outcome = await api.requestPair(device.id)
    if (outcome === 'paired') message.success(`已与「${device.name}」配对`)
    else if (outcome === 'declined') message.warning(`「${device.name}」拒绝了配对请求`)
    else message.info(`已向「${device.name}」发送请求，请在对方设备上确认`)
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  } finally {
    requesting.value = ''
    await dashboard.refresh()
  }
}
</script>
<template>
  <section v-if="dashboard.snapshot?.lan" class="lan-settings">
    <div class="section-heading">
      <h2>局域网共享</h2>
      <n-switch
        :value="dashboard.snapshot.lan.enabled"
        :disabled="busy"
        aria-label="局域网共享"
        @update:value="(value: boolean) => run(() => api.configureLan(value, name))"
      />
    </div>
    <p class="section-meta lan-intro">
      配对后可互相查看项目状态、技能，并按本机开关远程创建 Agent 会话。
    </p>
    <div class="lan-remote-execution">
      <div class="section-heading">
        <h3>远程 Agent 任务</h3>
        <n-switch
          :value="dashboard.snapshot.lan.remoteExecution"
          :disabled="busy"
          aria-label="允许远程 Agent 自动执行"
          @update:value="(value: boolean) => run(() => api.configureRemoteExecution(value))"
        />
      </div>
      <p class="section-meta lan-warning">
        开启后，已配对设备可以在本机任意绝对路径自动启动任务。请只与可信设备配对。
      </p>
    </div>
    <label class="lan-name-label" for="lan-device-name">本机名称</label>
    <div class="lan-name-row">
      <n-input
        v-model:value="name"
        maxlength="100"
        placeholder="本机名称"
        :input-props="{ 'aria-label': '本机名称', id: 'lan-device-name' }"
      /><n-button
        :disabled="busy || !name.trim()"
        @click="run(() => api.configureLan(!!dashboard.snapshot?.lan?.enabled, name))"
        >保存名称</n-button
      >
    </div>
    <p v-if="dashboard.snapshot.lan.error" role="alert" class="lan-error">
      {{ dashboard.snapshot.lan.error }}
    </p>
    <template v-if="dashboard.snapshot.lan.enabled">
      <div class="lan-device-list">
        <h3>附近设备</h3>
        <p v-if="!nearby.length" class="section-meta lan-empty">
          正在寻找同一局域网内已开启共享的设备…
        </p>
        <div v-else class="lan-grid">
          <div
            v-for="device in nearby"
            :key="device.id"
            class="lan-device-card"
            :data-device="device.id"
          >
            <span class="lan-device-name" :title="device.name">{{ device.name }}</span>
            <n-button
              size="small"
              secondary
              :loading="requesting === device.id"
              :disabled="busy || !!requesting"
              :title="device.fingerprint ? undefined : '对方版本不支持请求配对，请升级 Ebisu'"
              @click="request(device)"
              >请求配对</n-button
            >
          </div>
        </div>
      </div>
    </template>
    <p v-else class="section-meta lan-empty">
      开启后可发现同一局域网内的其他 Ebisu 设备；已配对设备仍可查看和解除配对。
    </p>
    <!-- 已配对设备保留缓存，关闭共享时仍可查看离线状态并解除配对。 -->
    <div class="lan-device-list">
      <h3>已配对设备</h3>
      <p v-if="!peers.length" class="section-meta lan-empty">尚未配对设备</p>
      <div v-else class="lan-grid">
        <div
          v-for="peer in peers"
          :key="peer.id"
          class="lan-device-card is-paired"
          :data-device="peer.id"
        >
          <div class="lan-device-head">
            <span class="lan-device-name" :title="peer.name">{{ peer.name }}</span>
            <n-tag size="small" :type="peer.online ? 'success' : 'default'">{{
              peer.online ? '在线' : '离线'
            }}</n-tag>
          </div>
          <p class="section-meta lan-card-meta">
            {{ peer.address }}
          </p>
          <p class="section-meta lan-card-meta">
            {{
              peer.lastSeen ? `最后更新 ${new Date(peer.lastSeen).toLocaleString()}` : '尚未同步'
            }}
          </p>
          <p v-if="peer.error" class="lan-error">{{ peer.error }}</p>
          <div
            v-if="dashboard.snapshot.lan.remoteExecution && peer.online"
            class="lan-command-form"
          >
            <n-select
              v-model:value="formFor(peer.id).terminal"
              :options="terminalOptions"
              size="small"
            />
            <n-input
              v-model:value="formFor(peer.id).path"
              size="small"
              placeholder="远端绝对路径"
              aria-label="远端绝对路径"
            />
            <n-input
              v-model:value="formFor(peer.id).prompt"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 5 }"
              placeholder="要处理的任务提示词"
              aria-label="远程任务提示词"
            />
            <n-button
              size="small"
              type="primary"
              :loading="commandBusy === peer.id"
              :disabled="!!commandBusy"
              @click="submitCommand(peer)"
              >创建远程会话</n-button
            >
          </div>
          <n-button size="small" :disabled="busy" @click="forget(peer.id, peer.name)"
            >解除配对</n-button
          >
        </div>
      </div>
    </div>
    <div v-if="allCommands.length" class="lan-device-list">
      <h3>远程任务记录</h3>
      <div class="lan-command-list">
        <div v-for="command in allCommands" :key="command.commandId" class="lan-command-row">
          <div>
            <strong>{{ command.terminal }} · {{ command.status }}</strong>
            <p class="section-meta lan-card-meta">{{ command.path }} · {{ command.source.name }}</p>
            <p v-if="command.result" class="section-meta lan-card-meta">
              {{ command.result.summary }}
            </p>
          </div>
          <n-button
            v-if="!['completed', 'failed', 'cancelled'].includes(command.status)"
            size="small"
            @click="
              commandTargets[command.commandId]
                ? cancelCommand(command, commandTargets[command.commandId])
                : cancelIncomingCommand(command)
            "
            >取消</n-button
          >
        </div>
      </div>
    </div>
  </section>
</template>
