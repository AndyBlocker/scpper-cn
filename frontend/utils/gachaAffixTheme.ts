import type { AffixVisualStyle } from '~/types/gacha'

export type AffixTheme = {
  filter: string
  chip: string
  overlay: string
  frame: string
}

export const affixThemeMap: Record<AffixVisualStyle, AffixTheme> = {
  NONE: {
    filter: 'none',
    chip: 'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300',
    overlay: '',
    frame: 'ring-1 ring-neutral-200/70 dark:ring-neutral-700/70'
  },
  MONO: {
    filter: 'grayscale(1) contrast(1.16)',
    chip: 'border-neutral-300 bg-neutral-100 text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800/70 dark:text-neutral-200',
    overlay: 'bg-gradient-to-tr from-black/35 via-transparent to-white/10',
    frame: 'ring-1 ring-black/25 dark:ring-neutral-400/35'
  },
  SILVER: {
    filter: 'saturate(0.85) contrast(1.07) brightness(1.05)',
    chip: 'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-500/50 dark:bg-slate-500/10 dark:text-slate-200',
    overlay: 'bg-gradient-to-tr from-slate-100/35 via-white/5 to-white/30 dark:from-slate-200/20 dark:to-white/20',
    frame: 'ring-1 ring-slate-300/70 shadow-[0_0_18px_-10px_rgba(148,163,184,0.9)] dark:ring-slate-400/40'
  },
  GOLD: {
    filter: 'sepia(0.55) saturate(1.65) brightness(1.08) contrast(1.08)',
    chip: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/55 dark:bg-amber-500/10 dark:text-amber-200',
    overlay: 'bg-gradient-to-tr from-amber-500/25 via-yellow-100/10 to-amber-100/35',
    frame: 'ring-1 ring-amber-300/80 shadow-[0_0_24px_-10px_rgba(251,191,36,0.95)] dark:ring-amber-400/45'
  },
  CYAN: {
    filter: 'hue-rotate(168deg) saturate(1.34) brightness(1.05)',
    chip: 'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-500/50 dark:bg-cyan-500/10 dark:text-cyan-200',
    overlay: 'bg-gradient-to-tr from-cyan-400/22 via-transparent to-sky-200/22',
    frame: 'ring-1 ring-cyan-300/70 shadow-[0_0_22px_-11px_rgba(34,211,238,0.85)] dark:ring-cyan-400/45'
  },
  PRISM: {
    filter: 'saturate(1.82) hue-rotate(9deg) brightness(1.08)',
    chip: 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-200',
    overlay: 'bg-gradient-to-tr from-fuchsia-400/22 via-cyan-200/12 to-amber-200/24',
    frame: 'ring-1 ring-violet-300/75 shadow-[0_0_24px_-11px_rgba(196,181,253,0.95)] dark:ring-violet-400/45'
  },
  COLORLESS: {
    filter: 'saturate(0.15) contrast(1.18) brightness(1.2)',
    chip: 'border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-500/55 dark:bg-zinc-500/10 dark:text-zinc-200',
    overlay: 'bg-gradient-to-tr from-zinc-200/22 via-white/20 to-zinc-100/24 dark:from-zinc-200/12 dark:to-white/12',
    frame: 'ring-1 ring-zinc-300/80 shadow-[0_0_22px_-10px_rgba(212,212,216,0.95)] dark:ring-zinc-400/50'
  },
  WILDCARD: {
    filter: 'saturate(1.25) contrast(1.08) hue-rotate(18deg)',
    chip: 'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-500/50 dark:bg-orange-500/10 dark:text-orange-200',
    overlay: 'bg-gradient-to-tr from-orange-400/20 via-amber-100/10 to-orange-200/25',
    frame: 'ring-1 ring-orange-300/75 shadow-[0_0_22px_-11px_rgba(251,146,60,0.85)] dark:ring-orange-400/45'
  },
  SPECTRUM: {
    filter: 'saturate(1.4) hue-rotate(-8deg) brightness(1.05)',
    chip: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/50 dark:bg-rose-500/10 dark:text-rose-200',
    overlay: 'bg-gradient-to-tr from-rose-400/24 via-fuchsia-200/12 to-rose-100/28',
    frame: 'ring-1 ring-rose-300/75 shadow-[0_0_22px_-11px_rgba(251,113,133,0.85)] dark:ring-rose-400/45'
  },
  MIRROR: {
    filter: 'saturate(0.95) contrast(1.12) brightness(1.1)',
    chip: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/50 dark:bg-sky-500/10 dark:text-sky-200',
    overlay: 'bg-gradient-to-tr from-sky-300/24 via-white/12 to-slate-100/24',
    frame: 'ring-1 ring-sky-300/75 shadow-[0_0_22px_-11px_rgba(56,189,248,0.85)] dark:ring-sky-400/45'
  },
  ORBIT: {
    filter: 'saturate(1.18) hue-rotate(42deg) brightness(1.04)',
    chip: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/50 dark:bg-emerald-500/10 dark:text-emerald-200',
    overlay: 'bg-gradient-to-tr from-emerald-300/20 via-cyan-100/10 to-lime-100/22',
    frame: 'ring-1 ring-emerald-300/75 shadow-[0_0_22px_-11px_rgba(16,185,129,0.82)] dark:ring-emerald-400/45'
  },
  ECHO: {
    filter: 'saturate(1.05) contrast(1.06) brightness(1.03)',
    chip: 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/50 dark:bg-indigo-500/10 dark:text-indigo-200',
    overlay: 'bg-gradient-to-tr from-indigo-400/18 via-violet-100/10 to-indigo-200/22',
    frame: 'ring-1 ring-indigo-300/75 shadow-[0_0_22px_-11px_rgba(99,102,241,0.82)] dark:ring-indigo-400/45'
  },
  NEXUS: {
    filter: 'saturate(1.4) hue-rotate(-12deg) brightness(1.06)',
    chip: 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-200',
    overlay: 'bg-gradient-to-tr from-violet-500/22 via-amber-200/12 to-violet-200/26',
    frame: 'ring-1 ring-violet-300/80 shadow-[0_0_24px_-10px_rgba(124,58,237,0.9)] dark:ring-violet-400/50'
  },
  ANCHOR: {
    filter: 'saturate(0.8) contrast(1.15) brightness(1.02)',
    chip: 'border-slate-400 bg-slate-100 text-slate-700 dark:border-slate-500/55 dark:bg-slate-500/10 dark:text-slate-200',
    overlay: 'bg-gradient-to-tr from-slate-400/20 via-blue-100/8 to-slate-200/22',
    frame: 'ring-1 ring-slate-400/75 shadow-[0_0_20px_-10px_rgba(71,85,105,0.85)] dark:ring-slate-400/45'
  },
  FLUX: {
    filter: 'saturate(1.6) hue-rotate(24deg) brightness(1.1)',
    chip: 'border-pink-300 bg-pink-50 text-pink-700 dark:border-pink-500/50 dark:bg-pink-500/10 dark:text-pink-200',
    overlay: 'bg-gradient-to-tr from-pink-500/22 via-fuchsia-200/12 to-pink-200/26',
    frame: 'ring-1 ring-pink-300/80 shadow-[0_0_24px_-10px_rgba(219,39,119,0.9)] dark:ring-pink-400/50'
  }
}

export function normalizeAffixStyle(style: AffixVisualStyle | null | undefined): AffixVisualStyle {
  if (!style) return 'NONE'
  const normalized = String(style)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_') as AffixVisualStyle
  return affixThemeMap[normalized] ? normalized : 'NONE'
}
