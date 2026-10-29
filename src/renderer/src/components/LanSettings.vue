<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NInput, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useDashboard } from '../store'
import type { NearbyDevice, RemoteDevice } from '../../../shared/lan'
const dashboard = useDashboard()
const api = window.ebisu
const message = useMessage()
const dialog = useDialog()
const name = ref('')
const busy = ref(false)
const requesting = ref('')
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
    <p class="section-meta lan-intro">配对后可互相查看项目状态和技能，技能需手动导入。</p>
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
          <n-button size="small" :disabled="busy" @click="forget(peer.id, peer.name)"
            >解除配对</n-button
          >
        </div>
      </div>
    </div>
  </section>
</template>
