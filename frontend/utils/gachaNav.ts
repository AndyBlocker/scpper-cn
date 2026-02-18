export type GachaPageKey = 'index' | 'placement' | 'market' | 'trade' | 'album' | 'missions'

export const gachaPageTitleMap: Record<GachaPageKey, string> = {
  index: '抽卡',
  placement: '放置',
  market: '股市',
  trade: '交易',
  album: '图鉴',
  missions: '任务'
}

export const gachaNavDescMap: Record<GachaPageKey, string> = {
  index: '卡池 & 历史',
  placement: '挂机收益',
  market: '开仓 & 结算',
  trade: '集换市场',
  album: '收藏 & 进度',
  missions: '目标 & 成就'
}

// SVG icon paths (24x24 viewBox, stroke-based)
export const gachaNavIconMap: Record<GachaPageKey, string> = {
  index: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  placement: 'M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z',
  market: 'M3 3v18h18M7 16l4-4 4 4 5-6',
  trade: 'M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01',
  album: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z',
  missions: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'
}

export interface GachaNavItem {
  key: GachaPageKey
  label: string
  desc: string
  to: string
  icon: string
}

export const gachaNavItems: GachaNavItem[] = [
  { key: 'index', label: '抽卡', desc: '卡池 & 历史', to: '/gachas', icon: gachaNavIconMap.index },
  { key: 'placement', label: '放置', desc: '挂机收益', to: '/gachas/placement', icon: gachaNavIconMap.placement },
  { key: 'market', label: '股市', desc: '开仓 & 结算', to: '/gachas/market', icon: gachaNavIconMap.market },
  { key: 'trade', label: '交易', desc: '集换市场', to: '/gachas/trade', icon: gachaNavIconMap.trade },
  { key: 'album', label: '图鉴', desc: '收藏 & 进度', to: '/gachas/album', icon: gachaNavIconMap.album },
  { key: 'missions', label: '任务', desc: '目标 & 成就', to: '/gachas/missions', icon: gachaNavIconMap.missions }
]
