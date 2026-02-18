import { useGachaCore } from '~/composables/api/gachaCore'
import { useGachaDrawApi } from '~/composables/api/gachaDraw'
import { useGachaPlacementApi } from '~/composables/api/gachaPlacement'
import { useGachaMarketApi } from '~/composables/api/gachaMarket'
import { useGachaTradeApi } from '~/composables/api/gachaTrade'
import { useGachaBuyRequestApi } from '~/composables/api/gachaBuyRequest'
import { useGachaTicketsApi } from '~/composables/api/gachaTickets'
import { useGachaMissionsApi } from '~/composables/api/gachaMissions'
import { useGachaAlbumApi } from '~/composables/api/gachaAlbum'
import { useGachaAdminApi } from '~/composables/api/gachaAdmin'
import { useGachaLockApi } from '~/composables/api/gachaLock'
import { useGachaShowcaseApi } from '~/composables/api/gachaShowcase'

export function useGacha() {
  const core = useGachaCore()
  const drawApi = useGachaDrawApi(core)
  const placementApi = useGachaPlacementApi(core)
  const marketApi = useGachaMarketApi(core)
  const tradeApi = useGachaTradeApi(core)
  const buyRequestApi = useGachaBuyRequestApi(core)
  const ticketsApi = useGachaTicketsApi(core)
  const missionsApi = useGachaMissionsApi(core)
  const albumApi = useGachaAlbumApi(core)
  const adminApi = useGachaAdminApi(core)
  const lockApi = useGachaLockApi(core)
  const showcaseApi = useGachaShowcaseApi(core)

  return {
    state: core.state,
    activate: core.activate,
    getConfig: core.getConfig,
    getFeatures: core.getFeatures,
    getWallet: core.getWallet,
    claimDaily: core.claimDaily,
    getEconomyConfig: core.getEconomyConfig,
    resetCache: core.resetCache,
    fetchNotifications: core.fetchNotifications,
    ...drawApi,
    ...placementApi,
    ...marketApi,
    ...tradeApi,
    ...buyRequestApi,
    ...ticketsApi,
    ...missionsApi,
    ...albumApi,
    ...adminApi,
    ...lockApi,
    ...showcaseApi
  }
}
