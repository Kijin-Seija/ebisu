import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Snapshot } from '../../shared/types'

/** 两个窗口各自持有只读快照；主进程变更事件触发重新读取。 */
export const useDashboard = defineStore('dashboard', () => {
  const snapshot = ref<Snapshot | null>(null)
  const error = ref('')
  const revision = ref(0)
  let pending: Promise<void> | undefined
  let dirty = false
  function refresh(): Promise<void> {
    if (pending) {
      dirty = true
      return pending
    }
    pending = (async () => {
      do {
        dirty = false
        try {
          snapshot.value = await window.ebisu.snapshot()
          revision.value++
          error.value = ''
        } catch (failure) {
          error.value = String(failure)
        }
      } while (dirty)
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
  return { snapshot, error, revision, refresh }
})
