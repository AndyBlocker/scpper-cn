import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * 通用的 URL query 参数 tab 切换逻辑。
 * 用于 gacha 子页面的 tab 切换（如 index.vue 的 draw/history，album.vue 的 album/progress）。
 */
export function useQueryTab<T extends string>(options: {
  defaultTab: T
  paramName?: string
}) {
  const { defaultTab, paramName = 'tab' } = options
  const route = useRoute()
  const router = useRouter()

  const activeTab = computed<T>(() => {
    const raw = route.query[paramName]
    return (typeof raw === 'string' && raw) ? raw as T : defaultTab
  })

  function setTab(tab: T) {
    if (tab === defaultTab) {
      const query = { ...route.query }
      delete query[paramName]
      router.replace({ path: route.path, query })
    } else {
      router.replace({ path: route.path, query: { ...route.query, [paramName]: tab } })
    }
  }

  return { activeTab, setTab }
}
