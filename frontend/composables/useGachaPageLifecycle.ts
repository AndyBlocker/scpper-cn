import { computed, onMounted, unref, watch, type Ref, type MaybeRef } from 'vue'
import type { GachaPageContext } from '~/composables/useGachaPage'

interface GachaPageLifecycleOptions {
  page: {
    showBindingBlock: Ref<boolean>
    handleActivate: GachaPageContext['handleActivate']
    gacha: GachaPageContext['gacha']
  } | GachaPageContext
  tag: string
  loadInitial: () => Promise<void>
  afterLoad?: () => Promise<void> | void
  requireActivated?: MaybeRef<boolean>
}

export function useGachaPageLifecycle(options: GachaPageLifecycleOptions) {
  let loadInFlight: Promise<void> | null = null

  const walletBalance = computed(() => options.page.gacha.state.value.wallet?.balance ?? null)

  const isActivatedReady = () =>
    options.requireActivated == null ? true : Boolean(unref(options.requireActivated))

  const canLoad = () => !options.page.showBindingBlock.value && isActivatedReady()

  async function runLoad(reason: string): Promise<void> {
    if (loadInFlight) {
      await loadInFlight
      return
    }

    const currentRun = (async () => {
      try {
        await options.loadInitial()
        if (options.afterLoad) {
          await options.afterLoad()
        }
      } catch (error) {
        console.warn(`[${options.tag}] ${reason} load failed`, error)
      }
    })()

    loadInFlight = currentRun.finally(() => {
      if (loadInFlight === currentRun) {
        loadInFlight = null
      }
    })
    await loadInFlight
  }

  watch(options.page.showBindingBlock, (blocked: boolean) => {
    if (!blocked && isActivatedReady()) {
      void runLoad('after-bind')
    }
  })

  if (options.requireActivated != null) {
    watch(
      () => Boolean(unref(options.requireActivated)),
      (next: boolean, prev: boolean) => {
        if (next && !prev && !options.page.showBindingBlock.value) {
          void runLoad('after-activated-ready')
        }
      }
    )
  }

  onMounted(() => {
    if (canLoad()) {
      void runLoad('initial')
    }
  })

  async function onActivate() {
    const result = await options.page.handleActivate()
    if (result.ok) {
      await runLoad('after-activate')
    }
    return result
  }

  return {
    walletBalance,
    onActivate,
    runLoad
  }
}
