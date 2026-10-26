<script setup lang="ts">
import { ref, watch } from 'vue'
import { NButton, NInput, NSelect, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useDashboard } from '../store'
const dashboard = useDashboard()
const api = window.ebisu
const message = useMessage()
const dialog = useDialog()
const name = ref('')
const address = ref<string | null>(null)
const invitation = ref('')
const received = ref('')
const override = ref('')
const busy = ref(false)
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
async function invite() {
  invitation.value = await api.createInvitation(address.value || undefined)
  try {
    await navigator.clipboard.writeText(invitation.value)
    message.success('邀请已复制，五分钟内在另一台设备粘贴')
  } catch {
    message.info('请选择下方邀请串手动复制')
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
    <p class="section-meta">配对后可互相查看项目状态和技能，技能需手动导入。</p>
    <div class="lan-form-row">
      <n-input
        v-model:value="name"
        maxlength="100"
        placeholder="设备名称"
        :input-props="{ 'aria-label': '设备名称' }"
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
      <div class="lan-form-row">
        <n-select
          v-model:value="address"
          :options="dashboard.snapshot.lan.addresses.map((item) => ({ label: item, value: item }))"
          placeholder="本机共享地址（默认自动选择）"
          aria-label="本机共享地址"
        /><n-button :disabled="busy" @click="run(invite)">生成配对邀请</n-button>
      </div>
      <n-input
        v-if="invitation"
        :value="invitation"
        type="textarea"
        readonly
        :input-props="{ 'aria-label': '配对邀请' }"
        :rows="3"
      />
      <n-input
        v-model:value="received"
        type="textarea"
        placeholder="粘贴另一台设备生成的配对邀请"
        :input-props="{ 'aria-label': '接收配对邀请' }"
        :rows="3"
      />
      <div class="lan-form-row">
        <n-input
          v-model:value="override"
          placeholder="可选：手动指定对端 IP:端口"
          :input-props="{ 'aria-label': '对端地址' }"
        /><n-button
          type="primary"
          :disabled="busy || !received.trim()"
          @click="
            run(async () => {
              await api.pairDevice(received.trim(), override.trim() || undefined)
              received = ''
              message.success('配对成功')
            })
          "
          >配对设备</n-button
        >
      </div>
      <div v-if="dashboard.snapshot.lan.discovered.length" class="lan-device-list">
        <h3>附近设备</h3>
        <div
          v-for="device in dashboard.snapshot.lan.discovered"
          :key="device.id"
          class="lan-device-row"
        >
          <span>{{ device.name }} · {{ device.address }}</span
          ><span v-if="device.protocol !== 1">协议不兼容，请升级</span
          ><n-button v-else size="small" @click="override = device.address">使用此地址</n-button>
        </div>
        <p class="section-meta">仍需在对方设备生成邀请，发现设备不会自动授予访问权限。</p>
      </div>
    </template>
    <div class="lan-device-list">
      <h3>已配对设备</h3>
      <p v-if="!dashboard.snapshot.lan.peers.length" class="section-meta">尚未配对设备</p>
      <div v-for="peer in dashboard.snapshot.lan.peers" :key="peer.id" class="lan-peer">
        <div class="lan-device-row">
          <strong>{{ peer.name }}</strong
          ><n-tag size="small" :type="peer.online ? 'success' : 'default'">{{
            peer.online ? '在线' : '离线'
          }}</n-tag
          ><n-button size="small" :disabled="busy" @click="forget(peer.id, peer.name)"
            >解除配对</n-button
          >
        </div>
        <p class="section-meta">
          {{ peer.address }} ·
          {{ peer.lastSeen ? `最后更新 ${new Date(peer.lastSeen).toLocaleString()}` : '尚未同步' }}
        </p>
        <p v-if="peer.error" class="lan-error">{{ peer.error }}</p>
      </div>
    </div>
  </section>
</template>
