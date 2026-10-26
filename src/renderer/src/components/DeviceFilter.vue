<script setup lang="ts">
import { computed, watch } from 'vue'
import { NSelect } from 'naive-ui'
import { useDashboard } from '../store'
const dashboard = useDashboard()
const options = computed(() => [
  { label: '本机', value: 'local' },
  { label: '全部设备', value: 'all' },
  ...(dashboard.snapshot?.lan?.peers ?? []).map((peer) => ({
    label: `${peer.name}${peer.online ? '' : ' · 离线'}`,
    value: peer.id
  }))
])
watch(options, (items) => {
  if (!items.some((item) => item.value === dashboard.deviceFilter)) dashboard.deviceFilter = 'local'
})
</script>
<template>
  <n-select
    v-model:value="dashboard.deviceFilter"
    :options="options"
    aria-label="筛选设备"
    class="device-filter"
  />
</template>
