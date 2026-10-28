<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NButton,
  NCode,
  NDrawer,
  NDrawerContent,
  NInput,
  NSelect,
  NSpin,
  NTag,
  useMessage
} from 'naive-ui'
import type { SkillView } from '../device-views'
import type { ImportDraft, SkillExport } from '../../../shared/lan'
import { renameSkillPackage } from '../../../shared/skill-import'
import { useDashboard } from '../store'
const props = defineProps<{ skill: SkillView | null }>()
const emit = defineEmits<{ close: [] }>()
const message = useMessage()
const dashboard = useDashboard()
const exported = ref<SkillExport | null>(null)
const draft = ref<ImportDraft | null>(null)
const name = ref('')
const texts = ref<Record<string, string>>({})
const file = ref('SKILL.md')
const busy = ref(false)
const failure = ref('')
let request = 0
const preview = computed(() => {
  const pkg = draft.value?.package ?? exported.value?.package
  if (!pkg) return null
  const changed = draft.value ? renameSkillPackage(pkg, name.value) : pkg
  for (const [relative, content] of Object.entries(texts.value))
    changed.files[relative].content = content
  return changed
})
const current = computed(() => preview.value?.files[file.value])
const original = computed(() => draft.value?.package.files[file.value])
const changedFiles = computed(() =>
  Object.keys(preview.value?.files ?? {}).filter(
    (relative) =>
      preview.value!.files[relative].content !== draft.value?.package.files[relative]?.content
  )
)
watch(name, (next, previous) => {
  if (!draft.value || !Object.keys(texts.value).length) return
  // 后改名称也保留用户的草稿，只更新其中仍能明确识别的身份与自引用。
  const pkg = renameSkillPackage(draft.value.package, previous)
  for (const [relative, content] of Object.entries(texts.value))
    pkg.files[relative].content = content
  const renamed = renameSkillPackage(pkg, next)
  texts.value = Object.fromEntries(
    Object.keys(texts.value).map((relative) => [relative, renamed.files[relative].content])
  )
})
watch(
  () => props.skill,
  async (skill) => {
    const token = ++request
    draft.value = null
    exported.value = null
    texts.value = {}
    file.value = 'SKILL.md'
    failure.value = ''
    if (!skill) return
    busy.value = true
    try {
      const result = await window.ebisu.remoteSkill(skill.deviceId, skill.id)
      if (token === request) exported.value = result
    } catch (error) {
      if (token === request) failure.value = String(error)
    } finally {
      if (token === request) busy.value = false
    }
  },
  { immediate: true }
)
async function prepare() {
  if (!props.skill) return
  const skill = props.skill
  const token = request
  busy.value = true
  try {
    const result = await window.ebisu.prepareImport(skill.deviceId, skill.id)
    if (request !== token) return
    texts.value = {}
    name.value = result.package.name
    draft.value = result
  } catch (error) {
    message.error(String(error))
  } finally {
    if (request === token) busy.value = false
  }
}
async function confirm() {
  if (!draft.value) return
  busy.value = true
  try {
    await window.ebisu.confirmImport(draft.value.id, {
      name: name.value,
      texts: { ...texts.value }
    })
    message.success('技能已保存到本机，请配置变量并选择终端安装。')
    await dashboard.refresh()
    emit('close')
  } catch (error) {
    message.error(String(error), { duration: 6000 })
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <n-drawer
    :show="!!skill"
    width="min(1000px, 96vw)"
    @update:show="
      (show: boolean) => {
        if (!show) emit('close')
      }
    "
  >
    <n-drawer-content :title="`${draft ? '导入预览' : '远端技能'} · ${skill?.name ?? ''}`" closable>
      <n-spin :show="busy">
        <p class="device-origin">
          来源：{{ skill?.deviceName }} · {{ skill?.online ? '在线' : '离线' }}
        </p>
        <p v-if="failure" class="lan-error" role="alert">{{ failure }}</p>
        <template v-if="preview">
          <p>{{ preview.description }}</p>
          <p v-if="preview.dependencies?.length" class="section-meta">
            依赖：{{ preview.dependencies.join('、') }}
          </p>
          <n-button v-if="!draft" type="primary" :disabled="busy" @click="prepare"
            >导入本机</n-button
          >
          <template v-else>
            <p>仅导入文件和变量定义，经验、变量取值与安装记录不携带。</p>
            <n-tag
              v-if="draft.existingId && name === draft.package.name && !changedFiles.length"
              type="success"
              >本机已有相同内容</n-tag
            >
            <p v-if="draft.conflict && name === draft.package.name" class="lan-error">
              本机已有同名的不同技能，请输入新名称。
            </p>
            <label class="lan-field"
              >本机技能名称<n-input
                v-model:value="name"
                maxlength="63"
                :input-props="{ 'aria-label': '导入技能名称' }"
            /></label>
            <p class="section-meta">
              改名会更新入口名称和明确的 --skill
              自引用。请检查差异，修正脚本中的自定义引用；脚本文件名和路径保持原样。
            </p>
            <p class="section-meta">已修改文件：{{ changedFiles.join('、') || '无' }}</p>
          </template>
          <n-select
            v-model:value="file"
            :options="
              Object.keys(preview.files)
                .sort()
                .map((relative) => ({
                  label: `${relative}${changedFiles.includes(relative) && draft ? ' · 已修改' : ''}`,
                  value: relative
                }))
            "
            aria-label="远端技能文件"
            class="lan-file-select"
          />
          <template v-if="current?.encoding !== 'base64'">
            <div v-if="draft" class="import-diff">
              <div>
                <h3>原文</h3>
                <pre><n-code :code="original?.content ?? ''" /></pre>
              </div>
              <div>
                <h3>导入内容（可修改）</h3>
                <n-input
                  :value="current?.content ?? ''"
                  type="textarea"
                  :autosize="{ minRows: 16, maxRows: 32 }"
                  :input-props="{ 'aria-label': '导入文件内容' }"
                  @update:value="(value: string) => (texts[file] = value)"
                />
              </div>
            </div>
            <pre v-else class="remote-source"><n-code :code="current?.content ?? ''" /></pre>
          </template>
          <p v-else class="section-meta">二进制文件，随技能包原样导入，不提供文本编辑。</p>
          <div v-if="preview.variables?.length" class="lan-device-list">
            <h3>变量定义</h3>
            <p v-for="variable in preview.variables" :key="variable.name">
              <code>{{ variable.name }}</code> · {{ variable.description
              }}<span v-if="variable.required"> · 必填</span>
            </p>
          </div>
        </template>
      </n-spin>
      <template #footer
        ><n-button
          v-if="draft"
          type="primary"
          :loading="busy"
          :disabled="!name.trim()"
          @click="confirm"
          >{{
            draft.existingId && name === draft.package.name && !changedFiles.length
              ? '使用已有技能'
              : '确认导入'
          }}</n-button
        ></template
      >
    </n-drawer-content>
  </n-drawer>
</template>
