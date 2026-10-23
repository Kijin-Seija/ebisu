<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  darkTheme,
  lightTheme,
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NButton,
  NIcon,
  NSpin,
  zhCN,
  dateZhCN,
  type GlobalThemeOverrides
} from 'naive-ui'
import { LayoutGrid, SlidersHorizontal, Plus, RefreshCw, ArrowUpRight } from 'lucide-vue-next'
import { useDashboard } from './store'
import Dashboard from './components/Dashboard.vue'
import Settings from './components/Settings.vue'
import StoneMark from './components/StoneMark.vue'

const dashboard = useDashboard()
const api = window.ebisu
const page = ref<'projects' | 'settings'>('projects')
const trayMode = new URLSearchParams(location.search).has('tray')
const systemDark = ref(matchMedia('(prefers-color-scheme: dark)').matches)
const query = matchMedia('(prefers-color-scheme: dark)')
const updateSystem = (event: MediaQueryListEvent) => {
  systemDark.value = event.matches
}
const dark = computed(
  () =>
    dashboard.snapshot?.settings.theme === 'dark' ||
    (dashboard.snapshot?.settings.theme !== 'light' && systemDark.value)
)
const folders = computed(() => dashboard.snapshot?.folders ?? [])
let unsubscribe: (() => void) | undefined
onMounted(() => {
  void dashboard.refresh()
  unsubscribe = window.ebisu.onChanged(() => {
    void dashboard.refresh()
  })
  query.addEventListener('change', updateSystem)
})
onUnmounted(() => {
  unsubscribe?.()
  query.removeEventListener('change', updateSystem)
})
/** 指定交互组件沿用库默认字号；从主题读取，避免在两种主题中手动维护一套数值。 */
const defaultFontSizes = Object.fromEntries(
  Object.entries(lightTheme.common!).filter(([key]) => key.startsWith('fontSize'))
)
/** 只覆盖主色；成功、信息、警告沿用 Naive UI 自带语义色，badge 与标签保持一致。 */
const accentPalette = computed(() =>
  dark.value
    ? {
        primaryColor: '#f08cb4',
        primaryColorHover: '#f6a8c6',
        primaryColorPressed: '#d9739d'
      }
    : {
        primaryColor: '#c2185b',
        primaryColorHover: '#cf2f68',
        primaryColorPressed: '#9c1247'
      }
)
const themeOverrides = computed<GlobalThemeOverrides>(() => ({
  common: {
    ...accentPalette.value,
    borderRadius: '9px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
    // 其他组件保持放大效果，下面单独恢复 badge/button/select/dropdown/input 的默认字号。
    fontSize: '16px',
    fontSizeMini: '14px',
    fontSizeTiny: '14px',
    fontSizeSmall: '16px',
    fontSizeMedium: '16px',
    fontSizeLarge: '17px',
    fontSizeHuge: '18px'
  },
  Badge: { common: defaultFontSizes },
  Button: { common: defaultFontSizes, fontWeight: '500' },
  Dropdown: { common: defaultFontSizes },
  Input: { common: defaultFontSizes },
  Select: {
    common: defaultFontSizes,
    // 选择器的展示区和弹出选项各自使用独立主题，均需要恢复默认字号。
    peers: {
      InternalSelection: { common: defaultFontSizes },
      InternalSelectMenu: { common: defaultFontSizes }
    }
  },
  Message: { fontSize: '16px' },
  Dialog: { titleFontSize: '20px' },
  Card: {
    titleFontSizeSmall: '18px',
    titleFontSizeMedium: '20px',
    titleFontSizeLarge: '20px',
    titleFontSizeHuge: '20px'
  }
}))
</script>

<template>
  <n-config-provider
    :theme="dark ? darkTheme : null"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-message-provider
      ><n-dialog-provider>
        <div class="app-shell" :class="{ dark, 'tray-mode': trayMode }">
          <aside v-if="!trayMode" class="sidebar">
            <div class="traffic-space"></div>
            <div class="brand">
              <div class="brand-mark"><StoneMark class="stone-mark" /></div>
              <span>ebisu<span class="brand-dot">.</span></span>
            </div>
            <nav class="navigation" aria-label="主导航">
              <button :class="{ active: page === 'projects' }" @click="page = 'projects'">
                <LayoutGrid :size="18" />项目面板<span class="nav-count">{{ folders.length }}</span>
              </button>
              <button :class="{ active: page === 'settings' }" @click="page = 'settings'">
                <SlidersHorizontal :size="18" />设置
              </button>
            </nav>
            <div class="sidebar-bottom">
              <span
                class="status-dot"
                :class="dashboard.snapshot?.service.running ? 'green' : 'yellow'"
              ></span
              ><span>{{
                dashboard.snapshot?.service.running ? '本机服务运行中' : '本机服务不可用'
              }}</span
              ><span class="version">v0.1</span>
            </div>
          </aside>
          <main class="workspace">
            <header v-if="trayMode" class="tray-toolbar">
              <div class="tray-brand"><StoneMark class="stone-mark" /> ebisu<span>.</span></div>
              <div class="tray-actions">
                <n-button
                  quaternary
                  size="small"
                  title="切换视图"
                  @click="page = page === 'projects' ? 'settings' : 'projects'"
                  ><n-icon><SlidersHorizontal /></n-icon
                ></n-button>
                <n-button quaternary size="small" title="打开主窗口" @click="api.showMain()"
                  ><n-icon><ArrowUpRight /></n-icon
                ></n-button>
              </div>
            </header>
            <section class="page-content">
              <div v-if="!dashboard.snapshot" class="loading-state">
                <n-spin />
                <p>{{ dashboard.error || '正在整理你的工作空间…' }}</p>
              </div>
              <template v-else>
                <div v-if="!dashboard.snapshot.service.running" class="service-error">
                  通知服务不可用：{{ dashboard.snapshot.service.error }}。请重启应用。
                </div>
                <template v-if="page === 'projects'">
                  <div v-if="!trayMode" class="page-heading project-heading">
                    <h1>项目面板<span class="title-period">.</span></h1>
                    <div class="heading-actions"><RefreshButton /><AddButton /></div>
                  </div>
                  <Dashboard :tray-mode="trayMode" :dark="dark" />
                </template>
                <template v-else>
                  <div v-if="!trayMode" class="page-heading settings-heading">
                    <h1>设置<span class="title-period">.</span></h1>
                  </div>
                  <Settings />
                </template>
              </template>
            </section>
          </main>
        </div> </n-dialog-provider
    ></n-message-provider>
  </n-config-provider>
</template>

<script lang="ts">
import { defineComponent, h, ref as vueRef } from 'vue'
import { useMessage } from 'naive-ui'
/** 按钮放在消息 Provider 内部，异步失败可就地反馈而不产生未处理拒绝。 */
const actionButton = (kind: 'add' | 'refresh') =>
  defineComponent({
    setup() {
      const loading = vueRef(false)
      const message = useMessage()
      return () =>
        h(
          NButton,
          {
            type: kind === 'add' ? 'primary' : 'default',
            loading: loading.value,
            onClick: async () => {
              loading.value = true
              try {
                await (kind === 'add' ? window.ebisu.addFolder() : window.ebisu.rescan())
              } catch (error) {
                message.error(String(error))
              } finally {
                loading.value = false
              }
            }
          },
          {
            default: () => (kind === 'add' ? '关联文件夹' : '刷新'),
            icon: () =>
              h(NIcon, null, { default: () => h(kind === 'add' ? Plus : RefreshCw, { size: 16 }) })
          }
        )
    }
  })
const AddButton = actionButton('add')
const RefreshButton = actionButton('refresh')
</script>
