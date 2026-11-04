<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NModal, NSelect, useMessage } from 'naive-ui'
import { useDashboard } from '../store'
import { deviceViews, type SkillView } from '../device-views'
import type { ExperienceCopyResult, SkillDetail } from '../../../shared/skills'

const props = defineProps<{ show: boolean; source: SkillDetail | null; ids: string[] }>()
const emit = defineEmits<{ close: [] }>()
const dashboard = useDashboard()
const api = window.ebisu
const message = useMessage()
/** 目标技能的选择键：设备 ID + 技能 ID，避免不同设备的同 ID 技能冲突。 */
const target = ref<string | null>(null)
/** 源项目 ID -> 目标设备上的项目 ID；null 表示尚未选择。 */
const folderMap = ref<Record<string, string | null>>({})
const busy = ref(false)
const outcome = ref<{ result?: ExperienceCopyResult; failed: number; error?: string } | null>(null)
/** 目标候选不受设备筛选影响：始终合并本机与所有已配对设备的快照。 */
const all = computed(() => deviceViews(dashboard.snapshot, 'all'))
const localDeviceId = computed(() => dashboard.snapshot?.lan?.device.id ?? 'local')
const key = (skill: SkillView): string => `${skill.deviceId}:${skill.id}`
const targets = computed(() =>
  all.value.skills.filter(
    // 远程技能只列出在线设备；源技能本身不能作为目标。
    (skill) => (skill.remote ? skill.online : skill.id !== props.source?.id)
  )
)
const targetOptions = computed(() =>
  targets.value.map((skill) => ({
    label: `${skill.name} · ${skill.remote ? skill.deviceName : '本机'}`,
    value: key(skill)
  }))
)
const targetSkill = computed(() => targets.value.find((skill) => key(skill) === target.value))
const chosen = computed(
  () => props.source?.experiences.filter((item) => props.ids.includes(item.id)) ?? []
)
/** 所选经验涉及的源项目（本机项目），按出现顺序去重。 */
const sourceFolders = computed(() => {
  const ids = [...new Set(chosen.value.map((item) => item.folderId).filter((id) => !!id))]
  return ids.map((id) => ({
    id: id!,
    name: dashboard.snapshot?.folders.find((folder) => folder.id === id)?.name ?? id!,
    count: chosen.value.filter((item) => item.folderId === id).length
  }))
})
const targetFolders = computed(() =>
  targetSkill.value
    ? all.value.folders.filter(
        (folder) =>
          folder.deviceId === targetSkill.value!.deviceId &&
          folder.remote === targetSkill.value!.remote
      )
    : []
)
const folderOptions = computed(() =>
  targetFolders.value.map((folder) => ({
    label: `${folder.name} · ${folder.path}`,
    value: folder.id
  }))
)
/**
 * 切换目标技能时重建项目映射：
 * 本机目标默认沿用原项目；远程目标按项目名称唯一匹配，匹配不到或同名多个时留空让用户选择。
 */
watch(
  // 只在目标或源项目集合变化时重建；快照轮询刷新不能覆盖用户已手动选择的映射。
  () => `${target.value}|${sourceFolders.value.map((folder) => folder.id).join(',')}`,
  () => {
    const next: Record<string, string | null> = {}
    for (const folder of sourceFolders.value) {
      if (!targetSkill.value) next[folder.id] = null
      else if (!targetSkill.value.remote)
        next[folder.id] = targetFolders.value.some((item) => item.id === folder.id)
          ? folder.id
          : null
      else {
        const matches = targetFolders.value.filter((item) => item.name === folder.name)
        next[folder.id] = matches.length === 1 ? matches[0].id : null
      }
    }
    folderMap.value = next
  },
  { immediate: true }
)
watch(
  () => props.show,
  (show) => {
    if (!show) return
    target.value = null
    outcome.value = null
    busy.value = false
  }
)
const ready = computed(
  () =>
    !!targetSkill.value &&
    chosen.value.length > 0 &&
    sourceFolders.value.every((folder) => !!folderMap.value[folder.id])
)
async function confirm(): Promise<void> {
  const skill = targetSkill.value
  if (!skill || !ready.value) return
  busy.value = true
  try {
    const result = await api.copyExperiences({
      ids: chosen.value.map((item) => item.id),
      targetDeviceId: skill.remote ? skill.deviceId : null,
      targetSkillId: skill.id,
      folderMap: Object.fromEntries(
        Object.entries(folderMap.value).filter((entry): entry is [string, string] => !!entry[1])
      )
    })
    outcome.value = { result, failed: 0 }
    await dashboard.refresh()
  } catch (error) {
    // 写入是整批事务：失败时没有任何条目被写入。
    outcome.value = { failed: chosen.value.length, error: String(error) }
    message.error(String(error), { duration: 6000 })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="复制经验到技能"
    style="width: min(560px, 94vw)"
    data-copy-experiences
    @update:show="
      (value: boolean) => {
        if (!value) emit('close')
      }
    "
  >
    <template v-if="outcome">
      <p data-copy-result>
        成功 {{ outcome.result?.added ?? 0 }} 条 · 跳过 {{ outcome.result?.skipped ?? 0 }} 条 · 失败
        {{ outcome.failed }} 条
      </p>
      <p v-if="outcome.result?.skipped" class="section-meta">
        跳过的经验在目标技能的同一作用域中已存在相同内容。
      </p>
      <p v-if="outcome.error" class="section-meta">{{ outcome.error }}</p>
      <div class="copy-experience-actions">
        <n-button v-if="outcome.error" @click="outcome = null">返回修改</n-button>
        <n-button type="primary" @click="emit('close')">完成</n-button>
      </div>
    </template>
    <template v-else>
      <p class="section-meta">
        已选
        {{ chosen.length }} 条经验。复制后在目标技能中新建经验，内容原样保留，验证依据末尾追加来源。
      </p>
      <label class="copy-experience-field">
        <span>目标技能</span>
        <n-select
          v-model:value="target"
          filterable
          :options="targetOptions"
          placeholder="选择本机或在线设备上的技能"
          aria-label="目标技能"
        />
      </label>
      <template v-if="targetSkill && sourceFolders.length">
        <p class="section-meta">
          项目级经验需映射到{{
            targetSkill.remote ? ` ${targetSkill.deviceName} ` : '本机'
          }}上的项目：
        </p>
        <label v-for="folder in sourceFolders" :key="folder.id" class="copy-experience-field">
          <span>{{ folder.name }}（{{ folder.count }} 条）</span>
          <n-select
            v-model:value="folderMap[folder.id]"
            filterable
            :options="folderOptions"
            :status="folderMap[folder.id] ? undefined : 'warning'"
            placeholder="请选择目标项目"
            :aria-label="`目标项目 ${folder.name}`"
          />
        </label>
        <p v-if="!folderOptions.length" class="section-meta">
          目标设备上没有项目，无法复制项目级经验。
        </p>
      </template>
      <div class="copy-experience-actions">
        <n-button @click="emit('close')">取消</n-button>
        <n-button type="primary" :disabled="!ready" :loading="busy" @click="confirm">复制</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.copy-experience-field {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}
.copy-experience-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
