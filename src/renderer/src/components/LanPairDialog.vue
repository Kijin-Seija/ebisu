<script setup lang="ts">
import { ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useDashboard } from '../store'
import type { PairRequestView } from '../../../shared/lan'

const dashboard = useDashboard()
const api = window.ebisu
const dialog = useDialog()
const message = useMessage()
/** 已提示过的请求 ID；快照刷新时不应重复弹出同一请求。 */
const shown = ref(new Set<string>())
const presenting = ref(false)

/** 逐个确认收到的配对请求；同一时间只保留一个弹窗，其余按到达顺序排队。 */
async function present(requests: PairRequestView[]) {
  if (presenting.value) return
  const next = requests.find((request) => !shown.value.has(request.id))
  if (!next) return
  presenting.value = true
  shown.value.add(next.id)
  try {
    await new Promise<void>((resolve) => {
      dialog.create({
        title: '局域网配对请求',
        content: `是否接受来自「${next.device.name}」的邀请？`,
        positiveText: '接受',
        negativeText: '拒绝',
        closable: false,
        maskClosable: false,
        closeOnEsc: false,
        onPositiveClick: () => {
          void respond(next, true)
        },
        onNegativeClick: () => {
          void respond(next, false)
        },
        onAfterLeave: resolve
      })
    })
  } finally {
    presenting.value = false
    const current = dashboard.snapshot?.lan?.requests ?? []
    // 只保留仍然存在的请求，用户已处理或已过期的记录不再提示。
    shown.value = new Set([...shown.value].filter((id) => current.some((item) => item.id === id)))
    void present(current)
  }
}

async function respond(request: PairRequestView, accept: boolean) {
  try {
    await api.respondPair(request.id, accept)
    if (accept) message.success(`已与「${request.device.name}」配对`)
    else message.info(`已拒绝「${request.device.name}」的配对请求`)
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  } finally {
    await dashboard.refresh()
  }
}

watch(
  () => dashboard.snapshot?.lan?.requests ?? [],
  (requests) => {
    void present(requests)
  },
  { immediate: true }
)
</script>
<template>
  <span class="lan-pair-dialog" hidden></span>
</template>
