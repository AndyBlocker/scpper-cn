<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

definePageMeta({
  title: 'Interface Styles',
  layout: 'default'
})

type MarketRow = {
  pair: string
  price: string
  change: string
  up: boolean
}

const prices = ref<MarketRow[]>([
  { pair: 'SCP/CN', price: '4,291.05', change: '+2.4%', up: true },
  { pair: 'O5/KEY', price: '1,102.40', change: '-0.8%', up: false },
  { pair: 'MTF/EPS', price: '892.11', change: '+5.1%', up: true }
])

type StatItem = {
  label: string
  value: string
  delta: string
  tone: string
}

type ActivityItem = {
  title: string
  detail: string
  time: string
  tone: string
}

type PageRow = {
  title: string
  rating: string
  comments: string
  tags: string[]
}

type NavItem = {
  label: string
  to: string
  active: boolean
}

type TabItem = {
  label: string
  active: boolean
}

type MetricItem = {
  label: string
  value: string
  detail: string
  progress: number
  tone: string
  bar: string
}

type ContentBlock = {
  title: string
  summary: string
  meta: string
  tags: string[]
}

type ChecklistItem = {
  title: string
  status: string
  tone: string
  dot: string
}

type PageCardSample = {
  title: string
  subtitle: string
  author: string
  summary: string
  rating: string
  comments: string
  classLabel: string
  classTone: string
  tags: string[]
}

type UserStat = {
  label: string
  value: string
}

type UserProfile = {
  name: string
  role: string
  clearance: string
  note: string
  initials: string
}

const statItems: StatItem[] = [
  { label: '今日投票', value: '1,284', delta: '+6.2%', tone: 'text-emerald-500' },
  { label: '新增条目', value: '32', delta: '+4', tone: 'text-sky-500' },
  { label: '待审', value: '9', delta: '2 未处理', tone: 'text-amber-500' }
]

const activityItems: ActivityItem[] = [
  { title: 'SCP-CN-1733', detail: '新增 5 条讨论回复', time: '2 分钟前', tone: 'text-emerald-500' },
  { title: '作者追踪', detail: 'Editor_A 发布新作', time: '25 分钟前', tone: 'text-sky-500' },
  { title: '收藏列表', detail: '新增 3 个条目', time: '1 小时前', tone: 'text-neutral-400' }
]

const pageRows: PageRow[] = [
  { title: 'SCP-CN-0732', rating: '+128', comments: '24', tags: ['scp', 'cn', 'euclid'] },
  { title: 'SCP-CN-1409', rating: '+72', comments: '18', tags: ['scp', 'keter'] },
  { title: 'SCP-CN-2119', rating: '+44', comments: '9', tags: ['scp', '故事'] }
]

const paginationItems = [1, 2, 3, 4, 5]
const activePage = 2

const navItems: NavItem[] = [
  { label: '概览', to: '/sample/page', active: true },
  { label: '榜单', to: '/ranking', active: false },
  { label: '工具', to: '/tools', active: false },
  { label: '收藏', to: '/account', active: false }
]

const tabItems: TabItem[] = [
  { label: '全部', active: true },
  { label: '关注', active: false },
  { label: '热门', active: false }
]

const metricItems: MetricItem[] = [
  {
    label: '活跃作者',
    value: '86',
    detail: '+12 本周',
    progress: 72,
    tone: 'text-emerald-500',
    bar: 'bg-emerald-500'
  },
  {
    label: '平均评分',
    value: '+4.8',
    detail: '+0.6',
    progress: 64,
    tone: 'text-sky-500',
    bar: 'bg-sky-500'
  },
  {
    label: '待审条目',
    value: '15',
    detail: '需处理 6',
    progress: 38,
    tone: 'text-amber-500',
    bar: 'bg-amber-500'
  }
]

const contentBlocks: ContentBlock[] = [
  {
    title: '收容记录更新',
    summary: '最新补充实验记录与交叉引用，适合置顶提醒。',
    meta: '更新于 2 小时前 · SCP-CN-2999',
    tags: ['记录', '修订']
  },
  {
    title: '作者推荐',
    summary: '编辑部精选作者访谈与写作指导，适合作为专题展示。',
    meta: '推荐人：Overseer · 早些时候',
    tags: ['访谈', '精选']
  },
  {
    title: '行动报告',
    summary: '快速浏览任务回顾、人员清单与收容状态摘要。',
    meta: '发布于 昨天 · MTF-乙',
    tags: ['行动', '报告']
  }
]

const checklistItems: ChecklistItem[] = [
  { title: '校验评分波动', status: '进行中', tone: 'text-amber-500', dot: 'bg-amber-500' },
  { title: '同步新条目', status: '已完成', tone: 'text-emerald-500', dot: 'bg-emerald-500' },
  { title: '复查标签覆盖', status: '待处理', tone: 'text-rose-500', dot: 'bg-rose-500' }
]

const objectClassTags = ['Safe', 'Euclid', 'Keter', 'Thaumiel']

const pageCardSamples: PageCardSample[] = [
  {
    title: 'SCP-CN-3000',
    subtitle: '万世流芳',
    author: 'Dr_Wengwan',
    summary: '以终末故事为主题的经典条目，适合展示评分与标签组合。',
    rating: '+850',
    comments: '128',
    classLabel: 'Keter',
    classTone: 'bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-300',
    tags: ['终末', '时间', '传奇']
  },
  {
    title: 'SCP-CN-1999',
    subtitle: '白日梦协议',
    author: 'Editor_A',
    summary: '展示实验记录、作者信息与摘要排版的常见页面卡片。',
    rating: '+72',
    comments: '24',
    classLabel: 'Euclid',
    classTone: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300',
    tags: ['实验', '记录', '档案']
  }
]

const userProfile: UserProfile = {
  name: 'Dr. Clef',
  role: 'Site Director',
  clearance: 'Level 4 · Top Secret',
  note: '现实扭曲者 / 行动指挥',
  initials: 'DC'
}

const userStats: UserStat[] = [
  { label: '条目', value: '128' },
  { label: '收藏', value: '48' },
  { label: '评分', value: '+2.4k' }
]

const userTags = ['站点主管', '编辑委员会', '高危权限']

const cursorVisible = ref(true)
let cursorTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  cursorTimer = setInterval(() => {
    cursorVisible.value = !cursorVisible.value
  }, 800)
})

onUnmounted(() => {
  if (cursorTimer) {
    clearInterval(cursorTimer)
  }
})
</script>

<template>
  <div class="min-h-screen bg-[#f4f0e9] text-[#201d1a] p-4 md:p-8 font-sans transition-colors duration-300">
    <header class="mb-12 max-w-7xl mx-auto">
      <h1 class="text-3xl font-bold tracking-tight mb-2 font-serif border-b-4 border-[#201d1a] pb-2">
        Visual Language Exploration
      </h1>
      <p class="text-[#726a61]">
        四种风格方向：科技、股票、磁带未来主义、终端风。
      </p>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-7xl mx-auto pb-20">
      <section class="group relative overflow-hidden rounded-[4px] bg-[#fffaf2] border-2 border-[#201d1a] shadow-[6px_6px_0px_rgba(32,29,26,0.85)]">
        <div class="absolute top-3 right-4 h-5 w-20 bg-[#eadac2] border border-[#201d1a]/40 rotate-[-2deg]"></div>

        <div class="relative p-6 md:p-8 h-full flex flex-col">
          <div class="flex items-center justify-between mb-8">
            <div class="flex items-center gap-2">
              <div class="w-2 h-2 bg-[#d65c40] border border-[#201d1a]"></div>
              <span class="text-[#201d1a] text-xs font-medium tracking-widest uppercase font-mono">System Online</span>
            </div>
            <div class="px-2 py-1 border border-[#201d1a] text-[10px] text-[#201d1a] font-mono">
              v4.0.2
            </div>
          </div>

          <div class="space-y-4 flex-grow">
            <h2 class="text-2xl font-semibold font-serif text-[#201d1a]">Neural Uplink</h2>
            <div class="p-4 border-2 border-[#201d1a] bg-[#f7f1e7] transition-colors cursor-pointer shadow-[3px_3px_0px_rgba(32,29,26,0.5)]">
              <div class="flex justify-between items-end">
                <div>
                  <div class="text-[#726a61] text-xs mb-1 font-mono uppercase">Upload Speed</div>
                  <div class="text-[#201d1a] text-xl font-semibold">842 MB/s</div>
                </div>
                <div class="h-8 w-24 flex items-end gap-1">
                  <div class="w-full bg-[#d65c40]/20 h-[40%]"></div>
                  <div class="w-full bg-[#d65c40]/40 h-[70%]"></div>
                  <div class="w-full bg-[#d65c40] h-[100%]"></div>
                  <div class="w-full bg-[#d65c40]/60 h-[60%]"></div>
                </div>
              </div>
            </div>
          </div>

          <button class="mt-8 w-full py-3 bg-[#201d1a] text-[#fffaf2] font-mono uppercase tracking-widest shadow-[4px_4px_0px_#d65c40] border-2 border-[#201d1a] transition-all active:translate-x-[2px] active:translate-y-[2px]">
            Initiate Sequence
          </button>
        </div>
      </section>

      <section class="rounded-[2px] border-2 border-[#201d1a] bg-[#1b1917] text-[#d6c9b8] font-mono text-xs overflow-hidden shadow-[6px_6px_0px_rgba(32,29,26,0.85)]">
        <div class="border-b-2 border-[#201d1a] bg-[#141311] p-2 flex justify-between items-center select-none">
          <span class="font-bold text-[#f5e6d5]">MARKET_RUNNER.EXE</span>
          <div class="flex gap-1">
            <div class="w-3 h-3 bg-[#2a2623] border border-[#3a332d]"></div>
            <div class="w-3 h-3 bg-[#2a2623] border border-[#3a332d]"></div>
          </div>
        </div>

        <div class="p-4 grid grid-cols-3 gap-4 border-b border-[#2a2623]">
          <div class="border-l-2 border-[#8bb89a] pl-2">
            <div class="text-[10px] text-[#8f857a]">HSI</div>
            <div class="text-[#8bb89a]">▲ 18,492</div>
          </div>
          <div class="border-l-2 border-[#c97c72] pl-2">
            <div class="text-[10px] text-[#8f857a]">SPX</div>
            <div class="text-[#c97c72]">▼ 4,102</div>
          </div>
          <div class="border-l-2 border-[#8bb89a] pl-2">
            <div class="text-[10px] text-[#8f857a]">BTC</div>
            <div class="text-[#8bb89a]">▲ 64,201</div>
          </div>
        </div>

        <table class="w-full text-left border-collapse">
          <thead class="bg-[#24211f] text-[#9b9187]">
            <tr>
              <th class="p-2 border-b border-[#2a2623] font-normal">ASSET</th>
              <th class="p-2 border-b border-[#2a2623] font-normal text-right">PRICE</th>
              <th class="p-2 border-b border-[#2a2623] font-normal text-right">24H</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in prices" :key="item.pair" class="hover:bg-[#24211f] cursor-crosshair transition-colors">
              <td class="p-2 border-b border-[#2a2623] font-bold text-[#f5e6d5]">{{ item.pair }}</td>
              <td class="p-2 border-b border-[#2a2623] text-right">{{ item.price }}</td>
              <td class="p-2 border-b border-[#2a2623] text-right" :class="item.up ? 'text-[#8bb89a]' : 'text-[#c97c72]'">
                {{ item.change }}
              </td>
            </tr>
          </tbody>
        </table>

        <div class="p-2 bg-[#141311] text-[10px] flex justify-between items-center">
          <span class="animate-pulse text-[#8bb89a]">● LIVE FEED</span>
          <span>LATENCY: 12ms</span>
        </div>
      </section>

      <section class="bg-[#f7f1e7] p-6 rounded-[4px] shadow-[6px_6px_0px_rgba(32,29,26,0.85)] border-2 border-[#201d1a]">
        <div class="bg-[#2b2723] p-6 rounded-[2px] mb-6 border-2 border-[#201d1a] relative overflow-hidden">
          <div class="absolute top-0 right-0 w-28 h-56 bg-white/5 skew-x-12 opacity-40 pointer-events-none"></div>

          <h2 class="text-[#f5b74a] font-mono text-lg tracking-widest uppercase mb-1">
            Main Deck
          </h2>
          <div class="h-24 w-full border-2 border-[#5f4c30] bg-[#141311] rounded-[2px] p-2 relative">
            <div class="absolute inset-0 bg-[linear-gradient(rgba(245,183,74,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(245,183,74,0.12)_1px,transparent_1px)] bg-[size:20px_20px]"></div>
            <div class="relative z-10 text-[#f5b74a] font-mono text-sm">
              > EJECTING TAPE...<br>
              > ERROR 404
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <button class="bg-[#efe7db] p-4 rounded-[2px] font-bold text-[#4b4238] uppercase tracking-wider shadow-[3px_3px_0px_rgba(32,29,26,0.7)] active:translate-x-[2px] active:translate-y-[2px] transition-all border-2 border-[#201d1a]">
            Rewind
          </button>
          <button class="bg-[#d65c40] p-4 rounded-[2px] font-bold text-white uppercase tracking-wider shadow-[3px_3px_0px_rgba(32,29,26,0.7)] active:translate-x-[2px] active:translate-y-[2px] transition-all border-2 border-[#201d1a]">
            Execute
          </button>
        </div>
      </section>

      <section class="terminal-container bg-[#11100f] p-6 rounded-[2px] shadow-[6px_6px_0px_rgba(32,29,26,0.85)] font-mono text-[#7dff74] relative overflow-hidden border-2 border-[#201d1a]">
        <div class="scanlines absolute inset-0 pointer-events-none z-10"></div>
        <div class="glow absolute inset-0 pointer-events-none z-20"></div>

        <div class="relative z-30">
          <div class="mb-6 text-sm opacity-70">
            login: admin<br>
            password: ***********<br>
            last login: Thu Jan 15 2026 14:02:11 on tty1
          </div>

          <div class="space-y-2">
            <div class="flex">
              <span class="mr-2 text-[#5fd3ff]">~</span>
              <span>scpper-cli --status</span>
            </div>
            <div class="pl-4 opacity-80">
              <div>[OK] Database Connection</div>
              <div>[OK] Neural Network</div>
              <div class="text-[#f5b74a]">[WARN] High Memory Usage (92%)</div>
            </div>

            <div class="flex mt-4">
              <span class="mr-2 text-[#5fd3ff]">~</span>
              <span class="flex">
                sudo rm -rf /var/logs/*
                <span v-if="cursorVisible" class="w-2.5 h-5 bg-[#7dff74] ml-1 block"></span>
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <section class="max-w-7xl mx-auto pb-24 space-y-8">
      <div>
        <h2 class="text-2xl font-semibold text-neutral-900 dark:text-white">四种风格组件对照</h2>
        <p class="text-neutral-500 dark:text-neutral-400 max-w-3xl">
          同一组核心组件在不同视觉风格下的对照，便于选择整体页面方向。
        </p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-cyan-500/20 bg-neutral-900 p-5 text-white shadow-xl">
          <div class="flex items-center justify-between text-[10px] uppercase tracking-widest text-cyan-200/70">
            <span>Neural Uplink</span>
            <span>Core</span>
          </div>
          <div class="mt-4 space-y-4 text-sm">
            <div>
              <div class="text-lg font-semibold text-white">SCP-CN-3000</div>
              <p class="text-xs text-cyan-100/70">科技风格数据仪表</p>
            </div>
            <div class="flex flex-wrap gap-2 text-xs">
              <span class="rounded-full bg-cyan-500/20 px-2.5 py-1 text-cyan-100">#uplink</span>
              <span class="rounded-full bg-white/10 px-2.5 py-1 text-cyan-100">#sync</span>
              <span class="rounded-full bg-white/10 px-2.5 py-1 text-cyan-100">#signal</span>
            </div>
            <div class="flex flex-wrap gap-2 text-xs">
              <button class="rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 py-2 font-medium text-white shadow-lg">启动</button>
              <button class="rounded-lg border border-cyan-400/40 px-3 py-2 text-cyan-100">查看日志</button>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <input type="text" placeholder="输入编号" class="flex-1 rounded-lg border border-cyan-500/20 bg-white/5 px-3 py-2 text-cyan-100 placeholder:text-cyan-200/40" />
              <button class="rounded-lg bg-white/10 px-3 py-2 text-cyan-100">查询</button>
            </div>
            <div class="rounded-xl border border-cyan-500/20 bg-white/5 p-3 text-xs">
              <div class="flex items-center justify-between text-cyan-100/70">
                <span>实时评分</span>
                <span>+128</span>
              </div>
              <div class="mt-2 space-y-1 text-cyan-100/70">
                <div class="flex items-center justify-between border-t border-cyan-500/10 pt-1">
                  <span>SCP-CN-1733</span>
                  <span>+42</span>
                </div>
                <div class="flex items-center justify-between">
                  <span>SCP-CN-1999</span>
                  <span>+18</span>
                </div>
              </div>
            </div>
            <div class="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
              系统状态：同步中，预计 30 秒完成。
            </div>
          </div>
        </div>

        <div class="rounded-none border border-slate-700 bg-slate-950 p-5 font-mono text-slate-300 shadow-xl">
          <div class="flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-500">
            <span>Market Terminal</span>
            <span>Core</span>
          </div>
          <div class="mt-4 space-y-4 text-xs">
            <div>
              <div class="text-base font-semibold text-slate-100">SCP/CN FEED</div>
              <p class="text-[11px] text-slate-500">实时监控终端</p>
            </div>
            <div class="flex flex-wrap gap-2 text-[11px]">
              <span class="rounded border border-slate-600 px-2 py-1 text-slate-400">LIVE</span>
              <span class="rounded border border-slate-700 px-2 py-1 text-slate-400">INDEX</span>
              <span class="rounded border border-emerald-500/40 px-2 py-1 text-emerald-400">SAFE</span>
            </div>
            <div class="flex flex-wrap gap-2 text-[11px]">
              <button class="rounded border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100">EXEC</button>
              <button class="rounded border border-slate-700 px-3 py-2 text-slate-300">QUEUE</button>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <input type="text" placeholder="SCP-CN-1733" class="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-200 placeholder:text-slate-600" />
              <button class="rounded border border-slate-700 bg-slate-800 px-3 py-2 text-slate-200">RUN</button>
            </div>
            <div class="rounded border border-slate-800 bg-slate-900 p-3 text-[11px]">
              <div class="flex items-center justify-between text-slate-500">
                <span>RATING</span>
                <span>+64</span>
              </div>
              <div class="mt-2 space-y-1">
                <div class="flex items-center justify-between border-t border-slate-800 pt-1">
                  <span>SCP-CN-0944</span>
                  <span class="text-emerald-400">+12</span>
                </div>
                <div class="flex items-center justify-between">
                  <span>SCP-CN-2560</span>
                  <span class="text-rose-400">-4</span>
                </div>
              </div>
            </div>
            <div class="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300">
              STATUS: FEED STABLE · LATENCY 12ms
            </div>
          </div>
        </div>

        <div class="rounded-3xl border-b-8 border-r-8 border-[#c5c5c0] bg-[#e5e5e0] p-5 text-neutral-700 shadow-xl">
          <div class="flex items-center justify-between text-[10px] uppercase tracking-widest text-neutral-500">
            <span>Cassette Deck</span>
            <span>Core</span>
          </div>
          <div class="mt-4 space-y-4 text-sm">
            <div>
              <div class="text-lg font-semibold text-neutral-800">收容室主控台</div>
              <p class="text-xs text-neutral-500">磁带未来主义调度面板</p>
            </div>
            <div class="flex flex-wrap gap-2 text-xs">
              <span class="rounded-full border border-neutral-300 bg-white/80 px-2.5 py-1 text-neutral-600">#warm</span>
              <span class="rounded-full border border-neutral-300 bg-white/80 px-2.5 py-1 text-neutral-600">#analog</span>
              <span class="rounded-full border border-neutral-300 bg-white/80 px-2.5 py-1 text-neutral-600">#deck</span>
            </div>
            <div class="flex flex-wrap gap-2 text-xs">
              <button class="rounded-lg bg-[#d4d4d0] px-3 py-2 font-semibold text-neutral-700 shadow-[0_4px_0_#a3a3a0]">REW</button>
              <button class="rounded-lg bg-orange-600 px-3 py-2 font-semibold text-white shadow-[0_4px_0_#9a3412]">EXEC</button>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <input type="text" placeholder="输入指令" class="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-neutral-700 placeholder:text-neutral-400" />
              <button class="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-neutral-600">送出</button>
            </div>
            <div class="rounded-xl border border-neutral-300 bg-white/80 p-3 text-xs">
              <div class="flex items-center justify-between text-neutral-500">
                <span>收容状态</span>
                <span class="text-emerald-600">稳定</span>
              </div>
              <div class="mt-2 space-y-1 text-neutral-600">
                <div class="flex items-center justify-between border-t border-neutral-200 pt-1">
                  <span>MTF-乙</span>
                  <span>就绪</span>
                </div>
                <div class="flex items-center justify-between">
                  <span>隔离区</span>
                  <span>2/4</span>
                </div>
              </div>
            </div>
            <div class="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-700">
              提示：今日有 3 项维护任务。
            </div>
          </div>
        </div>

        <div class="rounded-md border border-green-700/60 bg-black p-5 font-mono text-green-500 shadow-2xl">
          <div class="flex items-center justify-between text-[10px] uppercase tracking-widest text-green-400/70">
            <span>Terminal Green</span>
            <span>Core</span>
          </div>
          <div class="mt-4 space-y-4 text-xs">
            <div>
              <div class="text-base font-semibold text-green-300">ACCESS LOG</div>
              <p class="text-[11px] text-green-700">RAISA 通道记录</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <span class="rounded border border-green-600/60 px-2 py-1 text-green-400">AUTH</span>
              <span class="rounded border border-green-600/60 px-2 py-1 text-green-400">LOG</span>
              <span class="rounded border border-green-600/60 px-2 py-1 text-green-400">SEC</span>
            </div>
            <div class="flex flex-wrap gap-2">
              <button class="rounded border border-green-500/60 bg-green-500 px-3 py-2 text-black">EXEC</button>
              <button class="rounded border border-green-500/60 px-3 py-2 text-green-400">TRACE</button>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <input type="text" placeholder="SCP-CN-099" class="flex-1 rounded border border-green-700 bg-black px-3 py-2 text-green-400 placeholder:text-green-700" />
              <button class="rounded border border-green-600/60 px-3 py-2 text-green-400">FIND</button>
            </div>
            <div class="rounded border border-green-700/50 bg-green-900/10 p-3">
              <div class="flex items-center justify-between text-green-400/70">
                <span>SESSION</span>
                <span>ACTIVE</span>
              </div>
              <div class="mt-2 space-y-1">
                <div class="flex items-center justify-between border-t border-green-700/40 pt-1">
                  <span>LEVEL-4</span>
                  <span class="text-green-300">GRANTED</span>
                </div>
                <div class="flex items-center justify-between">
                  <span>NODE-13</span>
                  <span>LOCKED</span>
                </div>
              </div>
            </div>
            <div class="rounded border border-green-600/60 bg-green-500/10 px-3 py-2 text-green-300">
              ALERT: MEMORY USAGE 92%
            </div>
          </div>
        </div>
      </div>

      <div class="pt-4 space-y-4">
        <div>
          <h3 class="text-lg font-semibold text-neutral-900 dark:text-white">更多风格提案</h3>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">可作为活动专题或特殊页面风格。</p>
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div class="paper-scope rounded-3xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-6 font-serif text-[rgb(var(--fg))] shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
            <div class="flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-[rgb(var(--muted))]">
              <span>The Archives</span>
              <span>Extra</span>
            </div>
            <div class="mt-4 space-y-4 text-sm leading-relaxed">
              <div>
                <div class="text-lg font-semibold tracking-tight">档案备份室</div>
                <p class="text-xs text-[rgb(var(--muted))]">纸质档案与历史记录风格</p>
              </div>
              <div class="flex flex-wrap gap-2 text-xs">
                <span class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#paper</span>
                <span class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#archive</span>
              </div>
              <div class="flex flex-wrap gap-2 text-xs">
                <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-3 py-2 text-[rgb(var(--fg))]">归档</button>
                <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-transparent px-3 py-2 text-[rgb(var(--muted-strong))]">检索</button>
              </div>
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <input type="text" placeholder="编号" class="flex-1 border-b border-[rgb(var(--panel-border))] bg-transparent px-3 py-2 text-[rgb(var(--fg))] placeholder:text-[rgb(var(--muted))]" />
                <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-3 py-2 text-[rgb(var(--fg))]">查找</button>
              </div>
              <div class="rounded border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-3 text-xs shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <div class="flex items-center justify-between text-[rgb(var(--muted))]">
                  <span>借阅记录</span>
                  <span>2/12</span>
                </div>
                <div class="mt-2 space-y-1">
                  <div class="flex items-center justify-between border-t border-[rgb(var(--panel-border))] pt-1">
                    <span>CN-1733</span>
                    <span>已归档</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span>CN-1999</span>
                    <span>待更新</span>
                  </div>
                </div>
              </div>
              <div class="rounded border border-[rgb(var(--panel-border))] bg-[rgb(var(--accent-weak))] px-3 py-2 text-xs text-[rgb(var(--muted-strong))]">
                注意：夜间档案室暂停开放。
              </div>
            </div>
          </div>

          <div class="rounded-2xl border border-white/10 bg-slate-900/60 p-5 text-slate-100 backdrop-blur-xl shadow-[0_20px_60px_-40px_rgba(59,130,246,0.5)]">
            <div class="flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-300">
              <span>Reality Anchor</span>
              <span>Extra</span>
            </div>
            <div class="mt-4 space-y-4 text-sm">
              <div>
                <div class="text-lg font-semibold text-white">SRA 控制台</div>
                <p class="text-xs text-slate-300">玻璃态科研界面</p>
              </div>
              <div class="flex flex-wrap gap-2 text-xs">
                <span class="rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-blue-100">#glass</span>
                <span class="rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-blue-100">#anchor</span>
              </div>
              <div class="flex flex-wrap gap-2 text-xs">
                <button class="rounded-full border border-white/10 bg-gradient-to-r from-blue-500/30 to-purple-500/30 px-3 py-2 text-blue-100">稳定</button>
                <button class="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-slate-200">记录</button>
              </div>
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <input type="text" placeholder="波动阈值" class="flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-slate-100 placeholder:text-slate-400" />
                <button class="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-blue-100">设定</button>
              </div>
              <div class="rounded-xl border border-white/10 bg-white/5 p-3 text-xs">
                <div class="flex items-center justify-between text-slate-300">
                  <span>HUME</span>
                  <span>0.94</span>
                </div>
                <div class="mt-2 space-y-1">
                  <div class="flex items-center justify-between border-t border-white/10 pt-1">
                    <span>稳定器</span>
                    <span class="text-blue-200">在线</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span>核心</span>
                    <span class="text-blue-200">正常</span>
                  </div>
                </div>
              </div>
              <div class="rounded-xl border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-200">
                监测中：现实锚点波动稳定。
              </div>
            </div>
          </div>

          <div class="rounded-2xl border border-slate-800 bg-slate-950 p-5 text-slate-100 shadow-xl">
            <div class="flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-400">
              <span>Overwatch Command</span>
              <span>Extra</span>
            </div>
            <div class="mt-4 space-y-4 text-sm">
              <div>
                <div class="text-lg font-semibold text-white">O5 指挥室</div>
                <p class="text-xs text-slate-400">高级权限深色调度面板</p>
              </div>
              <div class="flex flex-wrap gap-2 text-xs">
                <span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-amber-200">#o5</span>
                <span class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-emerald-200">#secure</span>
              </div>
              <div class="flex flex-wrap gap-2 text-xs">
                <button class="rounded-lg border border-amber-500/40 bg-amber-500/20 px-3 py-2 text-amber-100">批准</button>
                <button class="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-200">待审</button>
              </div>
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <input type="text" placeholder="指令编号" class="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 placeholder:text-slate-500" />
                <button class="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-200">确认</button>
              </div>
              <div class="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs">
                <div class="flex items-center justify-between text-slate-400">
                  <span>优先级</span>
                  <span class="text-amber-200">Level 4</span>
                </div>
                <div class="mt-2 space-y-1">
                  <div class="flex items-center justify-between border-t border-slate-800 pt-1">
                    <span>审批中</span>
                    <span>12</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span>已完成</span>
                    <span>48</span>
                  </div>
                </div>
              </div>
              <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                今日有 3 条高优先级请求。
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="paper-scope max-w-7xl mx-auto pb-24 space-y-12 rounded-3xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--bg))] p-8 md:p-12 text-[rgb(var(--fg))] shadow-[0_24px_60px_-40px_rgba(0,0,0,0.35)]">
      <div>
        <h2 class="text-2xl font-semibold font-serif tracking-tight leading-tight text-[rgb(var(--fg))]">SCPper Core UI Blocks</h2>
        <p class="text-[rgb(var(--muted))] max-w-3xl leading-relaxed">
          常见 UI 元素与组件形态，覆盖排版、交互、数据与内容展示。
        </p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Typography & Content</h3>
            <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">文本</span>
          </div>
          <div class="mt-4 space-y-3">
            <p class="text-xs uppercase tracking-[0.2em] text-[rgb(var(--muted))]">SCPper Chronicle</p>
            <h4 class="text-2xl font-semibold font-serif text-[rgb(var(--fg))]">档案概要与阅读体验</h4>
            <p class="text-sm leading-relaxed text-[rgb(var(--muted-strong))]">
              通过统一的排版体系呈现摘要、引用与
              <span class="px-1.5 py-0.5 rounded bg-[rgb(var(--tag-bg))] font-mono text-xs text-[rgb(var(--muted-strong))]">SCP-CN-1733</span>
              标识符，让正文段落更易扫描。
            </p>
            <div class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4">
              <div class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">Content Block</div>
              <p class="mt-2 text-sm text-[rgb(var(--muted-strong))]">
                适合放置简介、摘要或重要提示，内容层级清晰可读。
              </p>
            </div>
            <div class="rounded-xl border-l-4 border-orange-500 bg-orange-50/70 p-3 text-sm text-[rgb(var(--fg))]">
              <p class="font-medium">引用提示 / Callout</p>
              <p class="mt-1 text-xs text-[rgb(var(--muted))]">
                用于强调关键一句话或编辑提示。
              </p>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div class="space-y-2">
                <div class="text-3xl font-semibold font-serif text-[rgb(var(--fg))]">层级标题一</div>
                <div class="text-2xl font-semibold font-serif text-[rgb(var(--fg))]">层级标题二</div>
                <div class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">层级标题三</div>
                <p class="text-sm text-[rgb(var(--muted-strong))]">
                  正文段落展示阅读节奏与可读性。
                </p>
                <p class="text-xs uppercase tracking-[0.2em] text-[rgb(var(--muted))]">Caption / 注释</p>
                <p class="text-xs text-[rgb(var(--muted))]">
                  <span class="text-orange-600 underline decoration-orange-300">交互式链接</span>
                  与强调文本样式。
                </p>
              </div>
              <div class="space-y-3 text-xs text-[rgb(var(--muted))]">
                <blockquote class="rounded-xl border border-[rgb(var(--panel-border))] bg-[#f7f0e6] p-3">
                  <p class="text-sm font-medium text-[rgb(var(--fg))]">引用示例</p>
                  <p class="mt-1">用于突出说明或引用条目中的关键语句。</p>
                </blockquote>
                <ul class="space-y-1">
                  <li class="flex items-center gap-2">
                    <span class="h-1.5 w-1.5 rounded-full bg-orange-500"></span>
                    快速扫描重点内容
                  </li>
                  <li class="flex items-center gap-2">
                    <span class="h-1.5 w-1.5 rounded-full bg-orange-500"></span>
                    统一的列表与说明结构
                  </li>
                  <li class="flex items-center gap-2">
                    <span class="h-1.5 w-1.5 rounded-full bg-orange-500"></span>
                    支持多级文本展示
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <div class="mt-4 flex flex-wrap gap-2 text-xs">
            <span class="inline-flex items-center gap-1 rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#scp</span>
            <span class="inline-flex items-center gap-1 rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#cn</span>
            <span class="inline-flex items-center gap-1 rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#keter</span>
            <span class="inline-flex items-center gap-1 rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#主题精品</span>
          </div>
        </div>

        <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Buttons & Badges</h3>
            <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">交互</span>
          </div>
          <div class="mt-4 flex flex-wrap gap-3">
            <button class="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium tracking-[0.04em] text-white shadow-[0_10px_20px_-12px_rgba(0,0,0,0.3)] transition hover:bg-orange-700">主按钮</button>
            <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-4 py-2 text-sm font-medium text-[rgb(var(--muted-strong))] hover:border-[#a88b63]">次按钮</button>
            <button class="rounded-sm px-4 py-2 text-sm font-medium text-[rgb(var(--muted))] hover:text-[rgb(var(--fg))]">轻量按钮</button>
            <button class="rounded-sm border border-[#e2b4aa] bg-[#fff1ee] px-4 py-2 text-sm font-medium text-rose-700">危险操作</button>
          </div>
          <div class="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-3">
              <div class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">Badges</div>
              <div class="mt-2 flex flex-wrap gap-2">
                <span class="inline-flex items-center rounded-sm border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700">NEW</span>
                <span class="inline-flex items-center rounded-sm border border-amber-200 bg-amber-50 px-2.5 py-1 text-amber-700">HOT</span>
                <span class="inline-flex items-center rounded-sm border border-stone-200 bg-stone-100 px-2.5 py-1 text-stone-600">跟踪中</span>
              </div>
            </div>
            <div class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-3">
              <div class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">Tags</div>
              <div class="mt-2 flex flex-wrap gap-2">
                <span class="inline-flex items-center rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#原创</span>
                <span class="inline-flex items-center rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#翻译</span>
                <span class="inline-flex items-center rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#goi</span>
              </div>
            </div>
            <div class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-3">
              <div class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">Object Class</div>
              <div class="mt-2 flex flex-wrap gap-2">
                <span v-for="tag in objectClassTags" :key="tag" class="inline-flex items-center rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">
                  {{ tag }}
                </span>
              </div>
            </div>
          </div>
          <div class="mt-4 flex flex-wrap gap-2 text-xs">
            <span class="inline-flex items-center gap-2 rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-3 py-1 text-[rgb(var(--muted-strong))]">
              <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
              已发布
            </span>
            <span class="inline-flex items-center gap-2 rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-3 py-1 text-[rgb(var(--muted-strong))]">
              <span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>
              待审核
            </span>
            <span class="inline-flex items-center gap-2 rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-3 py-1 text-[rgb(var(--muted-strong))]">
              <span class="h-1.5 w-1.5 rounded-full bg-rose-500"></span>
              已暂停
            </span>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Forms</h3>
            <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">表单</span>
          </div>
          <form class="mt-4 space-y-4">
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-[0.16em] text-[rgb(var(--muted))]">搜索</label>
              <input type="text" placeholder="输入标题或标签" class="w-full rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-3 py-2 text-sm text-[rgb(var(--fg))] placeholder:text-[rgb(var(--muted))] focus:border-orange-500 focus:ring-2 focus:ring-orange-200" />
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="space-y-1">
                <label class="text-xs font-semibold uppercase tracking-[0.16em] text-[rgb(var(--muted))]">分类</label>
                <select class="w-full rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-3 py-2 text-sm text-[rgb(var(--fg))]">
                  <option>全部</option>
                  <option>SCP</option>
                  <option>故事</option>
                </select>
              </div>
              <div class="space-y-1">
                <label class="text-xs font-semibold uppercase tracking-[0.16em] text-[rgb(var(--muted))]">排序</label>
                <select class="w-full rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-3 py-2 text-sm text-[rgb(var(--fg))]">
                  <option>最新</option>
                  <option>评分最高</option>
                  <option>评论最多</option>
                </select>
              </div>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-[0.16em] text-[rgb(var(--muted))]">备注</label>
              <textarea rows="3" placeholder="为筛选结果添加备注" class="w-full rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-3 py-2 text-sm text-[rgb(var(--fg))] placeholder:text-[rgb(var(--muted))]"></textarea>
            </div>
            <div class="flex flex-wrap items-center gap-4 text-sm text-[rgb(var(--muted-strong))]">
              <label class="flex items-center gap-2">
                <input type="checkbox" checked class="h-4 w-4 rounded border-[rgb(var(--panel-border))] bg-[#f7f0e6] text-orange-600 focus:ring-orange-500" />
                仅显示精品
              </label>
              <label class="flex items-center gap-2">
                <input type="radio" name="visibility" checked class="h-4 w-4 border-[rgb(var(--panel-border))] bg-[#f7f0e6] text-orange-600 focus:ring-orange-500" />
                全部
              </label>
              <label class="flex items-center gap-2">
                <input type="radio" name="visibility" class="h-4 w-4 border-[rgb(var(--panel-border))] bg-[#f7f0e6] text-orange-600 focus:ring-orange-500" />
                我的收藏
              </label>
            </div>
            <div class="flex flex-wrap gap-3">
              <button type="button" class="rounded-sm bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700">应用过滤</button>
              <button type="button" class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-4 py-2 text-sm font-medium text-[rgb(var(--muted-strong))]">重置</button>
            </div>
          </form>
        </div>

        <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)] space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Cards & Metrics</h3>
            <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">指标</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div v-for="item in statItems" :key="item.label" class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-3">
              <div class="text-xs text-[rgb(var(--muted))]">{{ item.label }}</div>
              <div class="mt-2 text-2xl font-semibold font-serif text-[rgb(var(--fg))]">{{ item.value }}</div>
              <div class="text-xs font-medium" :class="item.tone">{{ item.delta }}</div>
            </div>
          </div>
          <div class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p class="text-xs uppercase tracking-widest text-[rgb(var(--muted))]">Featured</p>
                <h4 class="mt-1 text-lg font-semibold font-serif text-[rgb(var(--fg))]">SCP-CN-1999</h4>
                <p class="mt-1 text-sm text-[rgb(var(--muted-strong))]">
                  试验记录与观察报告交织的经典条目展示。
                </p>
              </div>
              <div class="text-right">
                <div class="text-xs text-[rgb(var(--muted))]">评分</div>
                <div class="text-2xl font-semibold font-serif text-[rgb(var(--fg))]">+72</div>
                <div class="text-xs text-emerald-600">+3 今日</div>
              </div>
            </div>
            <div class="mt-3 flex flex-wrap gap-2 text-xs">
              <span class="inline-flex items-center rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#scp</span>
              <span class="inline-flex items-center rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#chronicle</span>
              <span class="inline-flex items-center rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#featured</span>
            </div>
          </div>
          <div class="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div class="space-y-3">
              <article v-for="card in pageCardSamples" :key="card.title" class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p class="text-xs text-[rgb(var(--muted))]">{{ card.subtitle }}</p>
                    <h4 class="mt-1 text-lg font-semibold font-serif text-[rgb(var(--fg))]">{{ card.title }}</h4>
                    <p class="mt-1 text-xs text-[rgb(var(--muted))]">作者 {{ card.author }}</p>
                  </div>
                  <span class="inline-flex items-center rounded-sm px-2.5 py-1 text-xs font-medium" :class="card.classTone">{{ card.classLabel }}</span>
                </div>
                <p class="mt-2 text-sm text-[rgb(var(--muted-strong))]">{{ card.summary }}</p>
                <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span class="inline-flex items-center gap-2 rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-3 py-1 text-[rgb(var(--muted-strong))]">
                    <span class="text-emerald-600">▲ {{ card.rating }}</span>
                    <span class="text-[rgb(var(--tag-border))]">/</span>
                    <span>{{ card.comments }} 评论</span>
                  </span>
                  <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-3 py-1 text-xs text-[rgb(var(--muted-strong))]">查看</button>
                </div>
                <div class="mt-2 flex flex-wrap gap-2 text-xs">
                  <span v-for="tag in card.tags" :key="`${card.title}-${tag}`" class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#{{ tag }}</span>
                </div>
              </article>
            </div>
            <div class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4">
              <div class="flex items-center gap-3">
                <div class="flex h-12 w-12 items-center justify-center rounded-full border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] text-sm font-semibold text-[rgb(var(--muted-strong))]">
                  {{ userProfile.initials }}
                </div>
                <div>
                  <div class="text-sm font-semibold font-serif text-[rgb(var(--fg))]">{{ userProfile.name }}</div>
                  <div class="text-xs text-[rgb(var(--muted))]">{{ userProfile.role }}</div>
                  <div class="text-xs text-[rgb(var(--muted))]">{{ userProfile.clearance }}</div>
                </div>
              </div>
              <p class="mt-3 text-xs text-[rgb(var(--muted))]">{{ userProfile.note }}</p>
              <div class="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <div v-for="stat in userStats" :key="stat.label" class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2 py-2">
                  <div class="text-[rgb(var(--muted))]">{{ stat.label }}</div>
                  <div class="mt-1 text-sm font-semibold font-serif text-[rgb(var(--fg))]">{{ stat.value }}</div>
                </div>
              </div>
              <div class="mt-3 flex flex-wrap gap-2 text-xs">
                <span v-for="tag in userTags" :key="tag" class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">
                  {{ tag }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Content Blocks</h3>
            <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">内容</span>
          </div>
          <div class="mt-4 space-y-3">
            <article v-for="block in contentBlocks" :key="block.title" class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4">
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p class="text-xs text-[rgb(var(--muted))]">{{ block.meta }}</p>
                  <h4 class="mt-1 text-lg font-semibold font-serif text-[rgb(var(--fg))]">{{ block.title }}</h4>
                  <p class="mt-1 text-sm text-[rgb(var(--muted-strong))]">{{ block.summary }}</p>
                </div>
                <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-3 py-1 text-xs font-medium text-[rgb(var(--muted-strong))]">查看</button>
              </div>
              <div class="mt-3 flex flex-wrap gap-2 text-xs">
                <span v-for="tag in block.tags" :key="`${block.title}-${tag}`" class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2.5 py-1 text-[rgb(var(--muted-strong))]">#{{ tag }}</span>
              </div>
            </article>
          </div>
        </div>

        <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Stats & Progress</h3>
            <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">状态</span>
          </div>
          <div class="mt-4 space-y-3">
            <div v-for="metric in metricItems" :key="metric.label" class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-3">
              <div class="flex items-center justify-between text-xs text-[rgb(var(--muted))]">
                <span>{{ metric.label }}</span>
                <span class="font-medium" :class="metric.tone">{{ metric.detail }}</span>
              </div>
              <div class="mt-2 flex items-end justify-between">
                <div class="text-2xl font-semibold font-serif text-[rgb(var(--fg))]">{{ metric.value }}</div>
                <div class="text-xs text-[rgb(var(--muted))]">完成度</div>
              </div>
              <div class="mt-2 h-2 rounded-full bg-[rgb(var(--tag-bg))] overflow-hidden">
                <div class="h-2 rounded-full" :class="metric.bar" :style="{ width: `${metric.progress}%` }"></div>
              </div>
            </div>
          </div>
          <div class="mt-4 rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4">
            <div class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">Checklist</div>
            <ul class="mt-3 space-y-2 text-sm">
              <li v-for="item in checklistItems" :key="item.title" class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2">
                  <span class="h-2 w-2 rounded-full" :class="item.dot"></span>
                  <span class="text-[rgb(var(--fg))]">{{ item.title }}</span>
                </div>
                <span class="text-xs font-medium" :class="item.tone">{{ item.status }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Lists & Alerts</h3>
            <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">列表</span>
          </div>
          <ul class="mt-4 space-y-3 text-sm">
            <li v-for="item in activityItems" :key="item.title" class="flex items-start justify-between gap-4 border-b border-[rgb(var(--panel-border))] pb-3 last:border-b-0 last:pb-0">
              <div>
                <div class="font-medium text-[rgb(var(--fg))]">{{ item.title }}</div>
                <div class="text-xs text-[rgb(var(--muted))]">{{ item.detail }}</div>
              </div>
              <div class="text-xs font-medium" :class="item.tone">{{ item.time }}</div>
            </li>
          </ul>
          <div class="mt-6 space-y-3">
            <div class="rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              成功：今日新增 12 篇条目。
            </div>
            <div class="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              提醒：有 3 个投稿等待审核。
            </div>
            <div class="rounded-sm border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              警告：评分波动异常，请检查投票日志。
            </div>
          </div>
        </div>

        <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Tables & Pagination</h3>
            <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">数据</span>
          </div>
          <div class="mt-4 overflow-hidden rounded-xl border border-[rgb(var(--panel-border))]">
            <table class="min-w-full text-sm">
              <thead class="bg-[rgb(var(--tag-bg))] text-[rgb(var(--muted))]">
                <tr>
                  <th class="px-3 py-2 text-left font-medium uppercase tracking-widest text-[10px]">条目</th>
                  <th class="px-3 py-2 text-right font-medium uppercase tracking-widest text-[10px]">评分</th>
                  <th class="px-3 py-2 text-right font-medium uppercase tracking-widest text-[10px]">评论</th>
                  <th class="px-3 py-2 text-right font-medium uppercase tracking-widest text-[10px]">标签</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in pageRows" :key="row.title" class="border-t border-[rgb(var(--panel-border))]">
                  <td class="px-3 py-2 font-medium font-serif text-[rgb(var(--fg))]">{{ row.title }}</td>
                  <td class="px-3 py-2 text-right text-emerald-600">{{ row.rating }}</td>
                  <td class="px-3 py-2 text-right text-[rgb(var(--muted-strong))]">{{ row.comments }}</td>
                  <td class="px-3 py-2">
                    <div class="flex flex-wrap justify-end gap-1">
                      <span v-for="tag in row.tags" :key="`${row.title}-${tag}`" class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-2 py-0.5 text-xs text-[rgb(var(--muted-strong))]">#{{ tag }}</span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div class="text-xs text-[rgb(var(--muted))]">共 24 页</div>
            <nav class="flex items-center gap-1 text-sm text-[rgb(var(--muted-strong))]" aria-label="Pagination">
              <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-2.5 py-1">上一页</button>
              <button
                v-for="page in paginationItems"
                :key="page"
                class="rounded-sm px-2.5 py-1"
                :class="page === activePage ? 'bg-orange-600 text-white' : 'border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] text-[rgb(var(--muted-strong))]'"
              >
                {{ page }}
              </button>
              <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-2.5 py-1">下一页</button>
            </nav>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-[rgb(var(--muted))]">
            <span>每页</span>
            <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-3 py-1 text-xs text-[rgb(var(--muted-strong))]">20</button>
            <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-3 py-1 text-xs text-[rgb(var(--muted-strong))]">40</button>
            <button class="rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-3 py-1 text-xs text-[rgb(var(--muted-strong))]">80</button>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Empty States</h3>
            <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">空状态</span>
          </div>
          <div class="mt-4 space-y-4">
            <div class="rounded-xl border border-dashed border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-6 text-center">
              <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] text-[rgb(var(--muted))] text-lg font-semibold">空</div>
              <p class="mt-3 text-sm text-[rgb(var(--fg))]">暂无收藏条目</p>
              <p class="text-xs text-[rgb(var(--muted))]">探索最新条目或添加筛选条件。</p>
              <button type="button" class="mt-4 rounded-sm border border-[rgb(var(--panel-border))] bg-[rgb(var(--tag-bg))] px-4 py-2 text-xs font-medium text-[rgb(var(--muted-strong))]">去发现</button>
            </div>
            <div class="rounded-xl border border-dashed border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs uppercase tracking-widest text-[rgb(var(--muted))]">待处理</p>
                  <p class="text-sm text-[rgb(var(--muted-strong))]">暂无待审条目</p>
                </div>
                <span class="rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700">全部清空</span>
              </div>
            </div>
          </div>
        </div>

        <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Loading States</h3>
            <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">加载</span>
          </div>
          <div class="mt-4 space-y-4">
            <div class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4">
              <div class="flex items-center gap-3">
                <div class="h-10 w-10 rounded-full bg-[rgb(var(--tag-bg))] animate-pulse"></div>
                <div class="flex-1 space-y-2">
                  <div class="h-3 w-1/2 rounded bg-[rgb(var(--tag-bg))] animate-pulse"></div>
                  <div class="h-3 w-2/3 rounded bg-[rgb(var(--tag-bg))] animate-pulse"></div>
                </div>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-3">
              <div v-for="n in 3" :key="`loading-card-${n}`" class="h-20 rounded-xl bg-[rgb(var(--tag-bg))] animate-pulse"></div>
            </div>
            <div class="rounded-xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-4 py-3">
              <div class="flex items-center gap-2 text-sm text-[rgb(var(--muted-strong))]">
                <span class="relative flex h-2 w-2">
                  <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-600 opacity-60"></span>
                  <span class="relative inline-flex h-2 w-2 rounded-full bg-orange-600"></span>
                </span>
                正在同步最新数据…
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="rounded-2xl border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-7 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.25)]">
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-semibold font-serif text-[rgb(var(--fg))]">Navigation & Tabs</h3>
          <span class="text-[10px] uppercase tracking-widest text-[rgb(var(--muted))]">导航</span>
        </div>
        <nav class="mt-4 flex flex-wrap gap-2 text-sm">
          <NuxtLink
            v-for="item in navItems"
            :key="item.label"
            :to="item.to"
            class="rounded-sm px-4 py-2 transition"
            :class="item.active ? 'bg-orange-600 text-white shadow-[0_8px_18px_-12px_rgba(0,0,0,0.3)]' : 'border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] text-[rgb(var(--muted-strong))] hover:border-orange-500'"
          >
            {{ item.label }}
          </NuxtLink>
        </nav>
        <div class="mt-4 inline-flex flex-wrap items-center gap-1 rounded-sm bg-[rgb(var(--tag-bg))] p-1">
          <button
            v-for="tab in tabItems"
            :key="tab.label"
            class="rounded-sm px-4 py-1.5 text-sm transition"
            :class="tab.active ? 'bg-[rgb(var(--panel))] text-[rgb(var(--fg))] shadow' : 'text-[rgb(var(--muted))]'"
          >
            {{ tab.label }}
          </button>
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-3 text-xs text-[rgb(var(--muted))]">
          <span>Tab 状态展示</span>
          <span class="inline-flex items-center gap-1">
            <span class="h-2 w-2 rounded-full bg-emerald-500"></span>
            Online
          </span>
          <span class="inline-flex items-center gap-1">
            <span class="h-2 w-2 rounded-full bg-amber-500"></span>
            Draft
          </span>
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-2 text-xs text-[rgb(var(--muted))]">
          <NuxtLink to="/" class="hover:text-orange-600">首页</NuxtLink>
          <span>/</span>
          <NuxtLink to="/sample" class="hover:text-orange-600">样式</NuxtLink>
          <span>/</span>
          <span class="text-[rgb(var(--fg))]">展示</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.paper-scope {
  --bg: 250 248 245;
  --fg: 60 56 54;
  --muted: 132 122 112;
  --muted-strong: 96 88 80;
  --panel: 255 255 252;
  --panel-border: 226 219 210;
  --tag-bg: 244 239 233;
  --tag-border: 226 219 210;
  --tag-text: 108 98 90;
  --input-bg: 255 254 250;
  --input-border: 210 202 193;
  --accent: 199 94 68;
  --accent-strong: 163 68 44;
  --accent-weak: 238 214 198;
  letter-spacing: 0.01em;
  line-height: 1.6;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  color: rgb(var(--fg));
}

.scanlines {
  background: linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0),
    rgba(255, 255, 255, 0) 50%,
    rgba(0, 0, 0, 0.2) 50%,
    rgba(0, 0, 0, 0.2)
  );
  background-size: 100% 4px;
}

.glow {
  box-shadow: inset 0 0 50px rgba(0, 255, 0, 0.1);
  background: radial-gradient(circle, rgba(0, 255, 0, 0.05) 0%, rgba(0, 0, 0, 0) 70%);
}

.terminal-container {
  text-shadow: 0 0 4px rgba(34, 197, 94, 0.5);
}
</style>
