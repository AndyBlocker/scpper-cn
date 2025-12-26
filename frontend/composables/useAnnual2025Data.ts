import { computed } from 'vue'
import type { Ref } from 'vue'
import type {
  AnnualCategoryHelpers,
  AnnualSiteData,
  AnnualUserData,
  CategoryMonthlyItem,
  CategorySplit,
  CategoryTopAuthor,
  CategoryTopPage,
  SiteData,
  UserData
} from '~/types/annual2025'
import { normalizePeriod } from '~/utils/annual2025'

const periodLabelMap: Record<string, string> = {
  year: '年度',
  yearly: '年度',
  month: '月度',
  week: '周度',
  day: '日度'
}

export function useAnnual2025Data(rawSiteData: Ref<SiteData | null>, rawUserData: Ref<UserData | null>) {
  const siteData = computed<AnnualSiteData>(() => {
    const raw = rawSiteData.value
    if (!raw) {
      return getDefaultSiteData()
    }

    const totalPages = raw.overview.pages.total
    const totalWords = raw.overview.words.totalOriginal + raw.overview.words.totalTranslation

    const byCategory = raw.overview.pages.byCategory
    const categoryTotal = Object.values(byCategory).reduce((a, b) => a + b, 0)
    const categoryKeyMap: Record<string, string> = {
      scp: 'scp',
      tale: 'tale',
      故事: 'tale',
      'goi-format': 'goi-format',
      'goi格式': 'goi-format',
      wanderers: 'wanderers',
      '艺术作品': 'art',
      art: 'art',
      '文章': 'article',
      article: 'article',
      other: 'other'
    }
    const categoryColors: Record<string, { from: string; to: string }> = {
      scp: { from: '#ef4444', to: '#dc2626' },
      tale: { from: '#3b82f6', to: '#2563eb' },
      'goi-format': { from: '#eab308', to: '#ca8a04' },
      art: { from: '#a855f7', to: '#9333ea' },
      wanderers: { from: '#22c55e', to: '#16a34a' },
      article: { from: '#06b6d4', to: '#0891b2' },
      other: { from: '#6b7280', to: '#4b5563' }
    }
    const categoryLabels: Record<string, string> = {
      scp: 'SCP文档',
      tale: '故事',
      'goi-format': 'GOI格式',
      art: '艺术作品',
      wanderers: '被放逐者的图书馆',
      article: '文章',
      other: '其他'
    }

    const breakdownByCategory = Object.entries(byCategory)
      .map(([key, count]) => {
        const normalized = categoryKeyMap[key] || key
        const ratio = categoryTotal > 0 ? count / categoryTotal : 0
        const percent = Math.round(ratio * 100)
        return {
          label: categoryLabels[normalized] || categoryLabels[key] || key,
          count,
          colorFrom: categoryColors[normalized]?.from || '#6b7280',
          colorTo: categoryColors[normalized]?.to || '#4b5563',
          ratio,
          percent
        }
      })
      .sort((a, b) => b.count - a.count)

    const rawTagStats = raw.tagStats || {}
    const byObjectClass = rawTagStats.byObjectClass || {}
    const objectClassDefs = [
      { key: 'safe', label: 'Safe', color: '#22c55e' },
      { key: 'euclid', label: 'Euclid', color: '#facc15' },
      { key: 'keter', label: 'Keter', color: '#ef4444' },
      { key: 'thaumiel', label: 'Thaumiel', color: '#a855f7' },
      { key: 'apollyon', label: 'Apollyon', color: '#f97316' },
      { key: 'archon', label: 'Archon', color: '#f59e0b' },
      { key: 'ticonderoga', label: 'Ticonderoga', color: '#38bdf8' },
      { key: 'neutralized', label: '无效化', color: '#94a3b8' },
      { key: 'decommissioned', label: '被废除', color: '#64748b' },
      { key: 'esoteric-class', label: '机密分级', color: '#6366f1' },
      { key: 'pending', label: '等待分级', color: '#14b8a6' }
    ]
    const classKeyAliases: Record<string, string> = {
      safe: 'safe',
      euclid: 'euclid',
      keter: 'keter',
      thaumiel: 'thaumiel',
      apollyon: 'apollyon',
      archon: 'archon',
      ticonderoga: 'ticonderoga',
      neutralized: 'neutralized',
      '无效化': 'neutralized',
      decommissioned: 'decommissioned',
      '被废除': 'decommissioned',
      'esoteric-class': 'esoteric-class',
      '机密分级': 'esoteric-class',
      pending: 'pending',
      '等待分级': 'pending'
    }
    const classCounts: Record<string, { count: number; originals: number; translations: number }> = {}
    Object.entries(byObjectClass).forEach(([cls, data]) => {
      const normalized = classKeyAliases[cls] || cls.toLowerCase()
      const count = Number(data?.count || 0)
      const originals = Number((data as any)?.originals || (data as any)?.originalCount || 0)
      const translations = Number((data as any)?.translations || (data as any)?.translationCount || 0)
      const existing = classCounts[normalized] || { count: 0, originals: 0, translations: 0 }
      classCounts[normalized] = {
        count: existing.count + count,
        originals: existing.originals + originals,
        translations: existing.translations + translations
      }
    })
    const totalScpClasses = objectClassDefs.reduce((sum, def) => sum + (classCounts[def.key]?.count || 0), 0)
    const scpByClass = objectClassDefs.map(def => {
      const entry = classCounts[def.key] || { count: 0, originals: 0, translations: 0 }
      const ratio = totalScpClasses > 0 ? entry.count / totalScpClasses : 0
      return {
        key: def.key,
        label: def.label,
        count: entry.count,
        originals: entry.originals,
        translations: entry.translations,
        ratio,
        percent: totalScpClasses > 0 ? Math.round(ratio * 100) : 0,
        color: def.color
      }
    })

    const branchFlags: Record<string, string> = {
      cn: '🇨🇳', en: '🇺🇸', ru: '🇷🇺', ko: '🇰🇷', jp: '🇯🇵', fr: '🇫🇷', pl: '🇵🇱', es: '🇪🇸', th: '🇹🇭', de: '🇩🇪', it: '🇮🇹', int: '🌐'
    }
    const branchNames: Record<string, string> = {
      cn: 'CN (中国分部)',
      en: 'EN (英语本部)',
      ru: 'RU (俄国分部)',
      ko: 'KO (韩国分部)',
      jp: 'JP (日本分部)',
      fr: 'FR (法国分部)',
      pl: 'PL (波兰分部)',
      es: 'ES (西班牙分部)',
      th: 'TH (泰国分部)',
      de: 'DE (德国分部)',
      it: 'IT (意大利分部)',
      int: 'INT (国际翻译)'
    }
    const byBranch = rawTagStats.byBranch || {}
    const totalTranslations = Object.entries(byBranch)
      .filter(([branch]) => branch !== 'cn')
      .reduce((a, [, data]) => a + data.count, 0)
    const translationsByBranch = Object.entries(byBranch)
      .filter(([branch, branchData]) => branch !== 'cn' && branchData.count > 0)
      .map(([branch, branchData]) => ({
        branch: branchNames[branch] || branch.toUpperCase(),
        branchKey: branch,
        count: branchData.count,
        percent: totalTranslations > 0 ? Math.round((branchData.count / totalTranslations) * 100) : 0,
        flag: branchFlags[branch] || '🌍'
      }))
      .sort((a, b) => {
        if (a.branchKey === 'en') return -1
        if (b.branchKey === 'en') return 1
        return b.count - a.count
      })

    const boutiqueTags = (() => {
      const rawBoutique = rawTagStats.boutiqueTags || { totalPages: 0, tags: [] }
      const tags = (rawBoutique.tags || []).map((tag: any) => ({
        tag: tag.tag,
        count: Number(tag.count) || 0
      }))
      return {
        totalPages: Number(rawBoutique.totalPages) || 0,
        tags: tags.sort((a, b) => b.count - a.count)
      }
    })()

    const newTagsThisYear = (() => {
      const rawNewTags = rawTagStats.newTagsThisYear || []
      return rawNewTags
        .map((tag: any) => ({
          tag: tag.tag,
          count: Number(tag.count) || 0,
          firstSeen: tag.firstSeen || ''
        }))
        .sort((a, b) => b.count - a.count)
    })()

    const topByOriginal = raw.authorRankings.topByOriginalCount[0]
    const topByTranslation = raw.authorRankings.topByTranslationCount[0]
    const topByWords = raw.authorRankings.topByWordCount[0]
    const topByRating = raw.authorRankings.topByTotalRating[0]
    const topVoter = raw.voterRankings?.topByTotalVotes?.[0]

    const rawCategoryBest = raw.categoryBest || {}
    const categoryBestConfig = [
      { key: 'scp', cat: 'SCP 文档', icon: 'FileText', iconClass: 'text-red-400', iconBgClass: 'bg-red-900/20' },
      { key: '故事', cat: '基金会故事', icon: 'BookOpen', iconClass: 'text-blue-400', iconBgClass: 'bg-blue-900/20' },
      { key: 'goi格式', cat: 'GOI 格式', icon: 'Layers', iconClass: 'text-yellow-400', iconBgClass: 'bg-yellow-900/20' },
      { key: 'wanderers', cat: '被放逐者的图书馆', icon: 'Library', iconClass: 'text-green-400', iconBgClass: 'bg-green-900/20' },
      { key: '艺术作品', cat: '艺术作品', icon: 'Palette', iconClass: 'text-purple-400', iconBgClass: 'bg-purple-900/20' },
      { key: '文章', cat: '文章', icon: 'Newspaper', iconClass: 'text-cyan-400', iconBgClass: 'bg-cyan-900/20' }
    ]
    const categoryBest = categoryBestConfig
      .map(cfg => {
        const entry = rawCategoryBest[cfg.key]
        const hasSplit = entry && (entry.original || entry.translation)
        const fallbackEntry = !hasSplit && entry && typeof entry === 'object' && 'title' in entry ? entry as any : null
        let original = entry?.original || null
        let translation = entry?.translation || null
        if (!original && !translation && fallbackEntry) {
          if (fallbackEntry.isOriginal === false) {
            translation = fallbackEntry
          } else {
            original = fallbackEntry
          }
        }
        if (!original && !translation) return null
        const mapEntry = (item: any) => ({
          title: item.title,
          author: item.authorDisplayName || item.authorName || '-',
          rating: item.rating,
          wikidotId: item.wikidotId || null
        })
        return {
          cat: cfg.cat,
          icon: cfg.icon,
          iconClass: cfg.iconClass,
          iconBgClass: cfg.iconBgClass,
          original: original ? mapEntry(original) : null,
          translation: translation ? mapEntry(translation) : null
        }
      })
      .filter(Boolean) as AnnualSiteData['categoryBest']

    const rawExtremeStats = raw.extremeStats || {}

    const longestPage = raw.pageRankings.longestPages?.[0]
    const shortestPage = raw.pageRankings.shortestHighRated?.[0]

    const monthlyPages = raw.trends?.monthlyPages || []
    const monthlyTrends = monthlyPages.map(m => Number(m.total))
    const monthlySeries = monthlyPages.map((m, idx) => ({
      monthLabel: m.month ? `${Number(m.month.split('-')[1])}月` : `${idx + 1}月`,
      total: Number(m.total) || 0,
      originals: Number(m.originals) || 0,
      translations: Number(m.translations) || 0
    }))

    const categoryKeyNormalize: Record<string, string> = {
      scp: 'scp',
      SCP: 'scp',
      tale: '故事',
      故事: '故事',
      'goi-format': 'goi格式',
      'goi格式': 'goi格式',
      goiformat: 'goi格式',
      wanderers: 'wanderers',
      Wanderers: 'wanderers',
      art: '艺术作品',
      '艺术作品': '艺术作品',
      article: '文章',
      文章: '文章'
    }

    const normalizedCategoryDetails = Object.entries(raw.categoryDetails || {}).reduce((acc, [key, detail]) => {
      const normalizedKey = categoryKeyNormalize[key] || categoryKeyNormalize[key.toLowerCase()] || key
      acc[normalizedKey] = detail
      return acc
    }, {} as Record<string, any>)

    const categoryMonthly = Object.entries(normalizedCategoryDetails).reduce((acc, [key, detail]) => {
      const monthly = (detail?.monthlyTrends || []).map((m: any, idx: number) => ({
        monthLabel: m.month ? `${Number(m.month.split('-')[1])}月` : `${idx + 1}月`,
        total: Number(m.total) || 0,
        originals: Number(m.originals) || 0,
        translations: Number(m.translations) || 0
      }))
      acc[key] = monthly
      return acc
    }, {} as Record<string, CategoryMonthlyItem[]>)

    const tagColors = [
      'text-red-400 border-red-500/30 bg-red-500/10',
      'text-blue-400 border-blue-500/30 bg-blue-500/10',
      'text-pink-400 border-pink-500/30 bg-pink-500/10',
      'text-purple-400 border-purple-500/30 bg-purple-500/10',
      'text-yellow-400 border-yellow-500/30 bg-yellow-500/10',
      'text-green-400 border-green-500/30 bg-green-500/10',
      'text-cyan-400 border-cyan-500/30 bg-cyan-500/10',
      'text-orange-400 border-orange-500/30 bg-orange-500/10',
      'text-indigo-400 border-indigo-500/30 bg-indigo-500/10',
      'text-teal-400 border-teal-500/30 bg-teal-500/10'
    ]
    const funFactsTags = raw.funFacts?.popularTags || []
    const popularTags = funFactsTags.slice(0, 10).map((t, i) => ({
      tag: t.tag,
      count: t.count,
      colorClass: tagColors[i % tagColors.length]
    }))

    const rawDistributions = raw.distributions || {}
    const mapDistribution = (dist: any) => {
      const buckets = Array.isArray(dist?.buckets) ? dist.buckets : []
      const maxCount = Math.max(...buckets.map(b => Number(b.count) || 0), 1)
      const mappedBuckets = buckets.map((b: any) => ({
        label: b.label,
        count: Number(b.count) || 0,
        min: typeof b.min === 'number' ? b.min : null,
        max: typeof b.max === 'number' ? b.max : null,
        heightPercent: maxCount > 0 ? Math.round((Number(b.count) || 0) / maxCount * 100) : 0
      }))
      return {
        total: typeof dist?.total === 'number' ? dist.total : mappedBuckets.reduce((sum, item) => sum + item.count, 0),
        buckets: mappedBuckets
      }
    }
    const distributions = {
      tagCount: mapDistribution(rawDistributions.tagCount),
      titleLength: mapDistribution(rawDistributions.titleLength),
      votesCast: mapDistribution(rawDistributions.votesCast),
      contentWords: mapDistribution(rawDistributions.contentWords)
    }

    return {
      overview: {
        pages: {
          total: totalPages,
          growth: raw.overview.pages.growth || '-',
          originals: raw.overview.pages.originals,
          translations: raw.overview.pages.translations,
          deleted: raw.overview.pages.deleted || 0
        },
        users: {
          total: raw.overview.users.total,
          newThisYear: raw.overview.users.newThisYear,
          activeThisYear: raw.overview.users.activeThisYear,
          translators: raw.overview.users.translators
        },
        votes: {
          total: raw.overview.votes.total,
          up: raw.overview.votes.up || 0,
          down: raw.overview.votes.down || 0,
          upRate: raw.overview.votes.total > 0 ? Math.round((raw.overview.votes.up || 0) / raw.overview.votes.total * 1000) / 10 : 0,
          avgPerPage: raw.overview.votes.avgPerPage,
          dailyAvg: Math.round(raw.overview.votes.total / 365)
        },
        words: {
          total: totalWords,
          totalOriginal: raw.overview.words.totalOriginal,
          totalTranslation: raw.overview.words.totalTranslation,
          avgPerOriginal: raw.overview.words.avgPerOriginal,
          avgPerTranslation: raw.overview.words.avgPerTranslation,
          avgPerDoc: totalPages > 0 ? Math.round(totalWords / totalPages) : 0
        }
      },
      topContributors: {
        mostRating: {
          user: topByRating?.displayName || '-',
          count: topByRating?.totalRating || 0,
          wikidotId: topByRating?.wikidotId || null,
          unit: '分',
          label: '总评分第一'
        },
        mostOriginals: {
          user: topByOriginal?.displayName || '-',
          count: topByOriginal?.originalCount || 0,
          wikidotId: topByOriginal?.wikidotId || null,
          unit: '篇',
          label: '原创数量第一'
        },
        mostTranslations: {
          user: topByTranslation?.displayName || '-',
          count: topByTranslation?.translationCount || 0,
          wikidotId: topByTranslation?.wikidotId || null,
          unit: '篇',
          label: '翻译数量第一'
        },
        mostWords: {
          user: topByWords?.displayName || '-',
          count: topByWords?.totalWords || 0,
          wikidotId: topByWords?.wikidotId || null,
          unit: '字',
          label: '总字数第一'
        },
        mostVotes: {
          user: topVoter?.displayName || '-',
          count: topVoter?.totalVotes || 0,
          wikidotId: topVoter?.wikidotId || null,
          unit: '票',
          label: '投票数第一'
        }
      },
      categoryBest,
      records: {
        longest: { title: longestPage?.title || '-', author: longestPage?.authorDisplayName || '-', count: longestPage?.wordCount || 0, label: '年度最长文档', wikidotId: longestPage?.wikidotId || null },
        shortest: { title: shortestPage?.title || '-', author: shortestPage?.authorDisplayName || '-', count: shortestPage?.wordCount || 0, label: '年度最短高分文档', wikidotId: shortestPage?.wikidotId || null },
        topTranslation: raw.pageRankings?.topRatedTranslations?.[0] ? {
          title: raw.pageRankings.topRatedTranslations[0].title,
          author: raw.pageRankings.topRatedTranslations[0].authorDisplayName || raw.pageRankings.topRatedTranslations[0].authorName || '-',
          rating: raw.pageRankings.topRatedTranslations[0].rating,
          wikidotId: raw.pageRankings.topRatedTranslations[0].wikidotId || null
        } : null,
        mostProlificAuthor: topByOriginal ? {
          name: topByOriginal.displayName || '-',
          count: topByOriginal.originalCount || 0,
          wikidotId: topByOriginal.wikidotId
        } : null,
        mostActiveVoter: topVoter ? {
          name: topVoter.displayName || '-',
          count: topVoter.totalVotes || 0,
          wikidotId: topVoter.wikidotId
        } : null,
        mostProlificWriter: topByWords ? {
          name: topByWords.displayName || '-',
          count: topByWords.totalWords || 0,
          wikidotId: topByWords.wikidotId
        } : null
      },
      extremeStats: {
        mostVotesTotal: rawExtremeStats.mostVotesTotal || null,
        mostVotesOneDay: rawExtremeStats.mostVotesOneDay || null,
        mostUpvotesOneDay: rawExtremeStats.mostUpvotesOneDay || null,
        mostProlificDay: rawExtremeStats.mostProlificDay || null
      },
      breakdown: {
        byCategory: breakdownByCategory,
        scpByClass,
        translationsByBranch
      },
      trends: {
        monthly: monthlyTrends,
        monthlySeries
      },
      pageRankings: {
        topRatedOriginals: (raw.pageRankings?.topRatedOriginals || []).map(p => ({
          rank: p.rank,
          title: p.title,
          rating: p.rating,
          author: p.authorDisplayName || p.authorName || '-',
          tags: p.tags || [],
          desc: `这篇作品在2025年获得了 ${p.rating} 分的高评价。`
        })),
        topOriginal: raw.pageRankings?.topRatedOriginals?.[0] ? {
          title: raw.pageRankings.topRatedOriginals[0].title,
          rating: raw.pageRankings.topRatedOriginals[0].rating,
          author: raw.pageRankings.topRatedOriginals[0].authorDisplayName || raw.pageRankings.topRatedOriginals[0].authorName || '-',
          tags: raw.pageRankings.topRatedOriginals[0].tags || [],
          desc: `这篇作品在2025年获得了 ${raw.pageRankings.topRatedOriginals[0].rating} 分的高评价。`
        } : { title: '-', rating: 0, author: '-', tags: [], desc: '' },
        topTranslation: raw.pageRankings?.topRatedTranslations?.[0] ? {
          title: raw.pageRankings.topRatedTranslations[0].title,
          rating: raw.pageRankings.topRatedTranslations[0].rating,
          author: raw.pageRankings.topRatedTranslations[0].authorDisplayName || raw.pageRankings.topRatedTranslations[0].authorName || '-',
          tags: raw.pageRankings.topRatedTranslations[0].tags || [],
          desc: `这篇作品在2025年获得了 ${raw.pageRankings.topRatedTranslations[0].rating} 分的高评价。`
        } : { title: '-', rating: 0, author: '-', tags: [], desc: '' }
      },
      funFacts: {
        popularTags
      },
      tagInsights: {
        boutiqueTags,
        newTagsThisYear
      },
      distributions,
      categoryDetails: normalizedCategoryDetails,
      categoryMonthly,
      monthlyVotes: (() => {
        const rawMonthly = raw.monthlyVoteStats?.monthlyVotes || []
        const maxTotal = Math.max(...rawMonthly.map(v => v.total || 0), 1)
        const maxHeight = 100
        return rawMonthly.map((v, idx) => {
          const total = v.total || 0
          const up = v.up || 0
          const down = v.down || 0
          const totalHeight = maxTotal > 0 ? Math.round((total / maxTotal) * maxHeight) : 0
          const upHeight = total > 0 ? Math.round((up / total) * totalHeight) : 0
          const downHeight = totalHeight - upHeight
          return {
            month: v.month,
            monthLabel: v.month ? `${Number(v.month.split('-')[1])}月` : `${idx + 1}月`,
            total,
            up,
            down,
            upRate: v.upRate || 0,
            upHeight,
            downHeight
          }
        })
      })(),
      votesByCategory: (() => {
        const rawVotes = raw.votesByCategory?.votesByCategory || {}
        const categoryNameMap: Record<string, string> = {
          scp: 'SCP',
          故事: '故事',
          goi格式: 'GOI',
          wanderers: '图书馆',
          艺术作品: '艺术',
          文章: '文章'
        }
        const maxTotal = Math.max(...Object.values(rawVotes).map((d: any) => d.total || 0), 1)
        const maxSqrt = Math.sqrt(maxTotal)
        return Object.entries(rawVotes).map(([key, data]: [string, any]) => ({
          name: categoryNameMap[key] || key,
          total: data.total || 0,
          up: data.up || 0,
          down: data.down || 0,
          upPercent: data.total > 0 ? Math.round((data.up / data.total) * 100) : 0,
          downPercent: data.total > 0 ? Math.round((data.down / data.total) * 100) : 0,
          scaledPercent: data.total > 0 && maxSqrt > 0 ? Math.round((Math.sqrt(data.total) / maxSqrt) * 100) : 0
        })).sort((a, b) => b.total - a.total)
      })(),
      hourlyRevisions: (() => {
        const rawHourly = raw.revisionTimeDistribution?.hourlyRevisions || []
        const maxCount = Math.max(...rawHourly.map(h => h.count || 0), 1)
        const maxHeight = 80
        const peakHour = rawHourly.reduce((max, h) => (h.count > max.count ? h : max), { hour: 0, count: 0 }).hour
        return Array.from({ length: 24 }, (_, i) => {
          const hourData = rawHourly.find(h => h.hour === i)
          const count = hourData?.count || 0
          const isNight = i >= 0 && i < 6 || i >= 22
          const isPeak = i === peakHour
          return {
            hour: i,
            count,
            height: maxCount > 0 ? Math.round((count / maxCount) * maxHeight) : 0,
            isNight,
            isPeak
          }
        })
      })(),
      revisionByTimeOfDay: (() => {
        const rawByTimeOfDay = raw.revisionTimeDistribution?.byTimeOfDay || []
        const totalCount = rawByTimeOfDay.reduce((sum, p) => sum + (p.count || 0), 0)
        const colorMap: Record<string, string> = {
          凌晨: 'bg-[#1e3a8a]',
          早晨: 'bg-[#0ea5e9]',
          上午: 'bg-[#38bdf8]',
          中午: 'bg-[#facc15]',
          下午: 'bg-[#f97316]',
          晚上: 'bg-[#a855f7]',
          深夜: 'bg-[#4338ca]'
        }
        return rawByTimeOfDay.map(p => ({
          period: p.period,
          count: p.count || 0,
          percent: totalCount > 0 ? Math.round((p.count / totalCount) * 100) : 0,
          colorClass: colorMap[p.period] || 'bg-gray-500'
        }))
      })(),
      revisionByWeekday: (() => {
        const rawWeekday = raw.revisionTimeDistribution?.byWeekday || raw.revisionTimeDistribution?.byDayOfWeek || []
        const weekdayOrder = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
        const weekdayAlias: Record<string, string> = {
          monday: '周一',
          mon: '周一',
          '1': '周一',
          '星期一': '周一',
          '周一': '周一',
          tuesday: '周二',
          tue: '周二',
          '2': '周二',
          '星期二': '周二',
          '周二': '周二',
          wednesday: '周三',
          wed: '周三',
          '3': '周三',
          '星期三': '周三',
          '周三': '周三',
          thursday: '周四',
          thu: '周四',
          '4': '周四',
          '星期四': '周四',
          '周四': '周四',
          friday: '周五',
          fri: '周五',
          '5': '周五',
          '星期五': '周五',
          '周五': '周五',
          saturday: '周六',
          sat: '周六',
          '6': '周六',
          '星期六': '周六',
          '周六': '周六',
          sunday: '周日',
          sun: '周日',
          '0': '周日',
          '7': '周日',
          '星期日': '周日',
          '星期天': '周日',
          '周日': '周日'
        }
        const counts: Record<string, number> = {}
        rawWeekday.forEach((item: any) => {
          const rawLabel = item.weekday ?? item.day ?? item.label
          if (rawLabel === undefined || rawLabel === null) return
          const key = weekdayAlias[String(rawLabel).toLowerCase()] || String(rawLabel)
          counts[key] = (counts[key] || 0) + (item.count || 0)
        })
        const maxCount = Math.max(...Object.values(counts), 0)
        return weekdayOrder.map(label => {
          const count = counts[label] || 0
          return {
            weekday: label,
            count,
            percent: maxCount > 0 ? Math.round((count / maxCount) * 100) : 0,
            isPeak: maxCount > 0 && count === maxCount
          }
        })
      })(),
      monthlyRevisions: (() => {
        const rawMonthly = raw.revisionTimeDistribution?.monthlyRevisions || []
        const maxCount = Math.max(...rawMonthly.map(m => m.count || 0), 1)
        const maxHeight = 60
        return rawMonthly.map((m, idx) => ({
          month: m.month,
          monthLabel: m.month ? `${Number(m.month.split('-')[1])}月` : `${idx + 1}月`,
          count: m.count || 0,
          height: maxCount > 0 ? Math.round((m.count / maxCount) * maxHeight) : 0
        }))
      })(),
      interestingStats: (() => {
        const rawInteresting = raw.interestingStats || {}
        const weekdayVotes = rawInteresting.weekdayVsWeekend?.weekday?.votes || 0
        const weekendVotes = rawInteresting.weekdayVsWeekend?.weekend?.votes || 0
        const totalWeekVotes = weekdayVotes + weekendVotes
        const rawMostTagsPage = rawInteresting.mostTagsPage || null
        const mostTagsPage = rawMostTagsPage && (rawMostTagsPage.tagCount || 0) > 0 ? rawMostTagsPage : null
        return {
          mostActiveVotingDay: rawInteresting.mostActiveVotingDay || null,
          peakVotingHour: rawInteresting.peakVotingHour || null,
          fastestRisingPage: rawInteresting.fastestRisingPage || null,
          mostCollaborativePage: rawInteresting.mostCollaborativePage || null,
          longestPage: rawInteresting.longestPage || null,
          mostControversialPage: rawInteresting.mostControversialPage || null,
          longestTitlePage: rawInteresting.longestTitlePage || null,
          mostTagsPage,
          weekdayVsWeekend: {
            weekday: rawInteresting.weekdayVsWeekend?.weekday || { votes: 0, pages: 0 },
            weekend: rawInteresting.weekdayVsWeekend?.weekend || { votes: 0, pages: 0 },
            weekdayPercent: totalWeekVotes > 0 ? Math.round((weekdayVotes / totalWeekVotes) * 100) : 0,
            weekendPercent: totalWeekVotes > 0 ? Math.round((weekendVotes / totalWeekVotes) * 100) : 0
          },
          firstRevision: rawInteresting.firstRevision || null
        }
      })(),
      deletedPageStats: raw.deletedPageStats || undefined
    }
  })

  const getCategoryMonthlyTrends = (key: string): CategoryMonthlyItem[] => {
    const categoryMonthly = siteData.value.categoryMonthly || {}
    if (categoryMonthly[key]) return categoryMonthly[key]
    const lowerKey = key.toLowerCase()
    const foundKey = Object.keys(categoryMonthly).find(k => k.toLowerCase() === lowerKey)
    return foundKey ? categoryMonthly[foundKey] : []
  }

  const getCategoryMonthlyTotal = (key: string) => {
    return getCategoryMonthlyTrends(key).reduce((sum, item) => sum + item.total, 0)
  }

  const getCategoryMonthlyMax = (key: string) => {
    const list = getCategoryMonthlyTrends(key)
    if (!list.length) return 1
    const maxVal = Math.max(...list.map(item => item.total))
    return maxVal > 0 ? maxVal : 1
  }

  const getCategoryDetail = (key: string) => {
    const categoryDetails = siteData.value.categoryDetails || {}
    if (categoryDetails[key]) return categoryDetails[key]
    const lowerKey = key.toLowerCase()
    const foundKey = Object.keys(categoryDetails).find(k => k.toLowerCase() === lowerKey)
    return foundKey ? categoryDetails[foundKey] : null
  }

  const getCategoryTopPages = (key: string, kind: 'original' | 'translation'): CategoryTopPage[] => {
    const detail = getCategoryDetail(key)
    if (!detail) return []
    const directKey = kind === 'original' ? 'topPagesOriginal' : 'topPagesTranslation'
    const directList = detail[directKey]
    if (Array.isArray(directList)) return directList
    const combined = Array.isArray(detail.topPages) ? detail.topPages : []
    if (kind === 'original') return combined.filter((p: any) => p.isOriginal)
    return combined.filter((p: any) => !p.isOriginal)
  }

  const getCategoryTopAuthors = (key: string, kind: 'original' | 'translation'): CategoryTopAuthor[] => {
    const detail = getCategoryDetail(key)
    if (!detail) return []
    const directKey = kind === 'original' ? 'topAuthorsOriginal' : 'topAuthorsTranslation'
    const directList = detail[directKey]
    if (Array.isArray(directList)) return directList
    if (kind === 'original' && Array.isArray(detail.topAuthors)) return detail.topAuthors
    return []
  }

  const getCategorySplit = (key: string): CategorySplit => {
    const detail = getCategoryDetail(key)?.overview || {}
    const originals = detail.originals || 0
    const translations = detail.translations || 0
    const total = detail.totalPages || originals + translations || 0
    const originalPercent = total > 0 ? Math.round((originals / total) * 100) : 0
    const translationPercent = total > 0 ? Math.round((translations / total) * 100) : 0
    return { originals, translations, total, originalPercent, translationPercent }
  }

  const userData = computed<AnnualUserData>(() => {
    const raw = rawUserData.value
    if (!raw) {
      return getDefaultUserData()
    }

    const timelineSource = (raw.timeline || []).filter(t => {
      const pages = Number(t.pages ?? (t as any).pageCount ?? 0)
      const votes = Number(t.votesCast ?? (t as any).votesReceived ?? 0)
      return pages > 0 || votes > 0 || t.highlight
    })

    const monthColorMap: Record<number, { dot: string; text: string }> = {
      1: { dot: 'bg-rose-400', text: 'text-rose-400' },
      2: { dot: 'bg-orange-400', text: 'text-orange-400' },
      3: { dot: 'bg-amber-400', text: 'text-amber-400' },
      4: { dot: 'bg-yellow-400', text: 'text-yellow-400' },
      5: { dot: 'bg-lime-400', text: 'text-lime-400' },
      6: { dot: 'bg-green-400', text: 'text-green-400' },
      7: { dot: 'bg-emerald-400', text: 'text-emerald-400' },
      8: { dot: 'bg-teal-400', text: 'text-teal-400' },
      9: { dot: 'bg-cyan-400', text: 'text-cyan-400' },
      10: { dot: 'bg-blue-400', text: 'text-blue-400' },
      11: { dot: 'bg-indigo-400', text: 'text-indigo-400' },
      12: { dot: 'bg-purple-400', text: 'text-purple-400' }
    }

    const scoredTimeline = timelineSource.map(t => ({
      ...t,
      score: Number(t.pages ?? (t as any).pageCount ?? 0) * 2 + Number(t.votesCast ?? (t as any).votesReceived ?? 0)
    }))

    const bestByMonth = new Map<string, (typeof scoredTimeline)[number]>()
    for (const entry of scoredTimeline) {
      const existing = bestByMonth.get(entry.month)
      if (!existing || entry.score > existing.score) {
        bestByMonth.set(entry.month, entry)
      }
    }

    const orderedTimeline = Array.from(bestByMonth.values())
      .sort((a, b) => a.month.localeCompare(b.month))

    const timelineItems = orderedTimeline.map((t) => {
      const monthNum = parseInt(t.month.split('-')[1]) || 1
      const monthName = `${monthNum}月`
      const colors = monthColorMap[monthNum] || { dot: 'bg-blue-400', text: 'text-blue-400' }
      const fallbackParts: string[] = []
      if ((t.pages ?? 0) > 0) fallbackParts.push(`创作 ${t.pages} 篇`)
      if ((t.votesCast ?? 0) > 0) fallbackParts.push(`投票 ${t.votesCast} 次`)
      const eventText = t.highlight?.text || fallbackParts.join('，') || '本月无活动'
      return {
        month: monthName,
        event: eventText,
        dotClass: colors.dot,
        textClass: colors.text
      }
    })

    const tagColors = ['bg-purple-500', 'bg-orange-500', 'bg-red-600', 'bg-blue-500', 'bg-green-500']
    const creationTagsByPages = (raw.preferences as any)?.creationTagsByPages || []
    const voteTagsByVotes = raw.preferences?.favoriteTagsByVotes || []
    const creationMax = creationTagsByPages.length > 0
      ? Math.max(...creationTagsByPages.map((t: any) => Number(t.pageCount) || 0), 1)
      : 1
    const voteMax = voteTagsByVotes.length > 0
      ? Math.max(...voteTagsByVotes.map((t: any) => Number(t.voteCount) || 0), 1)
      : 1
    const toPercent = (value: number, max: number) => {
      if (max <= 0) return 0
      const percent = Math.round((value / max) * 100)
      return value > 0 ? Math.max(percent, 6) : 0
    }
    const creationTags = creationTagsByPages.slice(0, 5).map((t: any, i: number) => ({
      tag: t.tag,
      value: Number(t.pageCount) || 0,
      unit: '篇',
      detail: t.avgRating ? `★${t.avgRating}` : '',
      barPercent: toPercent(Number(t.pageCount) || 0, creationMax),
      bgClass: tagColors[i % tagColors.length]
    }))
    const voteTags = voteTagsByVotes.slice(0, 5).map((t: any, i: number) => ({
      tag: t.tag,
      value: Number(t.voteCount) || 0,
      unit: '票',
      detail: t.voteCount ? `UpVote率 ${Math.round(t.upRate * 100)}%` : '',
      barPercent: toPercent(Number(t.voteCount) || 0, voteMax),
      bgClass: tagColors[i % tagColors.length]
    }))
    const topTags = creationTags.length > 0 ? creationTags : voteTags
    const topTagsSource = creationTags.length > 0 ? 'creation' : (voteTags.length > 0 ? 'voting' : 'none')

    const upRate = raw.overview?.votesCast?.upRate || 0
    let votingStyleLabel = '均衡型读者'
    let votingStyleDesc = 'UpVote 与 DownVote 保持平衡'
    if (upRate >= 0.9) {
      votingStyleLabel = '鼓励型读者'
      votingStyleDesc = `UpVote 占比 ${Math.round(upRate * 100)}%，积极参与社区互动`
    } else if (upRate >= 0.7) {
      votingStyleLabel = '温和型读者'
      votingStyleDesc = `UpVote 占比 ${Math.round(upRate * 100)}%，较为正面的评价风格`
    } else if (upRate < 0.5) {
      votingStyleLabel = '严格型读者'
      votingStyleDesc = `UpVote 占比 ${Math.round(upRate * 100)}%，对作品有较高要求`
    }

    const defaultRankChange = { startRank: 0, endRank: 0, change: 0, direction: 'up' }
    const mapPercentile = (p: any) => {
      if (!p) return null
      return {
        value: Number(p.value) || 0,
        rank: Number(p.rank) || 0,
        total: Number(p.total) || 0,
        percentile: typeof p.percentile === 'number' ? p.percentile : 1,
        percentileLabel: p.percentileLabel || '活跃参与者'
      }
    }
    const percentiles = {
      votesCast: mapPercentile(raw.percentiles?.votesCast),
      contentWords: mapPercentile(raw.percentiles?.contentWords)
    }

    return {
      userId: raw.userId,
      wikidotId: raw.wikidotId || null,
      userName: raw.userName,
      displayName: raw.displayName,
      overview: {
        rankChange: raw.overview?.rankChange || defaultRankChange,
        creation: {
          totalCount: raw.overview?.creation?.totalCount || 0,
          totalWords: raw.overview?.creation?.totalWords || 0,
          originals: raw.overview?.creation?.originalCount || 0,
          translations: raw.overview?.creation?.translationCount || 0
        },
        ratings: raw.overview?.ratings || { totalRatingGained: 0, avgRating: 0 },
        votesReceived: raw.overview?.votesReceived || { total: 0, up: 0, down: 0, netScore: 0, upRate: 0 },
        votesCast: raw.overview?.votesCast || { total: 0, up: 0, down: 0, upRate: 0, activeDays: 0 },
        activity: {
          activeDays: raw.overview?.activity?.activeDays || 0,
          firstActivityDate: raw.overview?.activity?.firstActivityDate || '',
          lastActivityDate: raw.overview?.activity?.lastActivityDate || '',
          mostActiveMonth: raw.overview?.activity?.mostActiveMonth || '',
          longestStreak: raw.overview?.activity?.longestStreak || 0
        }
      },
      timeline: timelineItems.length > 0 ? timelineItems : (() => {
        const fallbackItems: { month: string; event: string; dotClass: string; textClass: string }[] = []
        const totalWorks = raw.overview?.creation?.totalCount || 0
        const totalVotesCast = raw.overview?.votesCast?.total || 0
        const activeDays = raw.overview?.activity?.activeDays || 0
        const mostActiveMonth = raw.overview?.activity?.mostActiveMonth || ''

        if (mostActiveMonth) {
          const monthNum = parseInt(mostActiveMonth.split('-')[1]) || 1
          const colors = monthColorMap[monthNum] || { dot: 'bg-blue-400', text: 'text-blue-400' }
          fallbackItems.push({
            month: `${monthNum}月`,
            event: '最活跃的月份',
            dotClass: colors.dot,
            textClass: colors.text
          })
        }
        if (totalWorks > 0) {
          fallbackItems.push({
            month: '创作',
            event: `发布了 ${totalWorks} 篇作品`,
            dotClass: 'bg-green-400',
            textClass: 'text-green-400'
          })
        }
        if (totalVotesCast > 0) {
          fallbackItems.push({
            month: '互动',
            event: `参与 ${totalVotesCast} 次投票`,
            dotClass: 'bg-purple-400',
            textClass: 'text-purple-400'
          })
        }
        if (activeDays > 0) {
          fallbackItems.push({
            month: '活跃',
            event: `累计活跃 ${activeDays} 天`,
            dotClass: 'bg-amber-400',
            textClass: 'text-amber-400'
          })
        }
        if (fallbackItems.length === 0) {
          fallbackItems.push({
            month: '全年',
            event: '保持对社区的关注',
            dotClass: 'bg-blue-400',
            textClass: 'text-blue-400'
          })
        }
        return fallbackItems
      })(),
      preferences: {
        topTags: topTags.length > 0 ? topTags : [
          { tag: '无数据', value: 0, unit: '', detail: '', barPercent: 0, bgClass: 'bg-gray-500' }
        ],
        topTagsSource,
        votingTopTags: (raw.preferences?.favoriteTagsByVotes || []).slice(0, 5).map((t, i) => ({
          tag: t.tag,
          voteCount: t.voteCount,
          upRate: Math.round(t.upRate * 100),
          bgClass: tagColors[i % tagColors.length]
        })),
        votingStyle: {
          up: raw.overview?.votesCast?.up || 0,
          down: raw.overview?.votesCast?.down || 0,
          label: votingStyleLabel,
          desc: votingStyleDesc
        }
      },
      achievements: (() => {
        const mapped = (raw.achievements || []).map(a => {
          const periodType = normalizePeriod(a.period)
          // 直接使用后端生成的完整标题，不做二次处理
          const title = a.title || ''
          // 计算限定条件数量：标签中用 "|" 分隔的组合数
          const tagStr = a.tag || ''
          const qualifierCount = tagStr ? tagStr.split('|').length : 0

          return {
            id: a.id,
            tier: a.tier || 'bronze',
            title,
            description: a.description || '',
            originalTitle: title,
            value: `${a.value || 0}${a.valueLabel || ''}`,
            period: periodType,
            periodText: a.periodText || periodLabelMap[periodType] || '成就',
            rarityLabel: a.rarityLabel || '',
            tag: tagStr,
            earnedAt: a.earnedAt || '',
            qualifierLength: qualifierCount,
            metric: (a as any).metric || ''
          }
        })
        if (mapped.length === 0) {
          const totalWorks = raw.overview?.creation?.totalCount || 0
          const votesTotal = raw.overview?.votesReceived?.total || 0
          const hasWorks = totalWorks > 0
          const hasVotes = votesTotal > 0
          mapped.push({
            id: 'participation-placeholder',
            tier: 'honorable',
            title: hasWorks ? '创作参与' : '社区参与',
            description: hasWorks ? `今年发布了 ${totalWorks} 篇作品` : hasVotes ? `今年收获了 ${votesTotal} 次评价` : '保持了对社区的关注',
            originalTitle: '',
            value: hasWorks ? `${totalWorks}篇` : hasVotes ? `${votesTotal}票` : '活跃',
            period: 'year',
            periodText: '年度',
            rarityLabel: '',
            tag: '',
            earnedAt: '',
            qualifierLength: 0
          })
        }
        return mapped
      })(),
      percentiles,
      rankings: {
        overall: {
          rank: raw.rankings?.overall?.rank || 0,
          percentile: raw.rankings?.overall?.percentile ?? 1,
          percentileLabel: raw.rankings?.overall?.percentileLabel || '活跃参与者'
        }
      },
      revisionTimeDistribution: (() => {
        const rawRevision = raw.revisionTimeDistribution
        if (!rawRevision) {
          return {
            hourly: [] as { hour: number; count: number; height: number; isNight: boolean; isPeak: boolean }[],
            byTimeOfDay: [] as { period: string; count: number; percent: number; colorClass: string }[],
            peakHour: null as { hour: number; count: number; label: string } | null,
            totalRevisions: 0
          }
        }

        const hourlyData = rawRevision.hourly || []
        const maxCount = Math.max(...hourlyData.map(h => h.count || 0), 1)
        const maxHeight = 60
        const peakCount = maxCount

        const periodColorMap: Record<string, string> = {
          凌晨: 'bg-[#1e3a8a]',
          早晨: 'bg-[#0ea5e9]',
          上午: 'bg-[#38bdf8]',
          中午: 'bg-[#facc15]',
          下午: 'bg-[#f97316]',
          晚上: 'bg-[#a855f7]',
          深夜: 'bg-[#4338ca]'
        }

        const byTimeOfDay = rawRevision.byTimeOfDay || []
        const totalTimeOfDay = byTimeOfDay.reduce((sum, p) => sum + (p.count || 0), 0)

        return {
          hourly: hourlyData.map(h => ({
            hour: h.hour,
            count: h.count || 0,
            height: maxCount > 0 ? Math.round(((h.count || 0) / maxCount) * maxHeight) : 0,
            isNight: h.hour >= 0 && h.hour < 6 || h.hour >= 22,
            isPeak: h.count === peakCount && peakCount > 0
          })),
          byTimeOfDay: byTimeOfDay.map(p => ({
            period: p.period,
            count: p.count || 0,
            percent: totalTimeOfDay > 0 ? Math.round(((p.count || 0) / totalTimeOfDay) * 100) : 0,
            colorClass: periodColorMap[p.period] || 'bg-sky-500'
          })),
          peakHour: rawRevision.peakHour || null,
          totalRevisions: rawRevision.totalRevisions || 0
        }
      })()
    }
  })

  const categoryHelpers: AnnualCategoryHelpers = {
    getCategoryMonthlyTrends,
    getCategoryMonthlyTotal,
    getCategoryMonthlyMax,
    getCategoryTopPages,
    getCategoryTopAuthors,
    getCategorySplit
  }

  return {
    siteData,
    userData,
    categoryHelpers
  }
}

function getDefaultSiteData(): AnnualSiteData {
  return {
    overview: {
      pages: { total: 0, growth: '-', originals: 0, translations: 0, deleted: 0 },
      users: { total: 0, newThisYear: 0, activeThisYear: 0, translators: 0 },
      votes: { total: 0, up: 0, down: 0, upRate: 0, avgPerPage: 0, dailyAvg: 0 },
      words: { total: 0, totalOriginal: 0, totalTranslation: 0, avgPerOriginal: 0, avgPerTranslation: 0, avgPerDoc: 0 }
    },
    topContributors: {
      mostRating: { user: '-', count: 0, wikidotId: null as number | null, unit: '分', label: '总评分第一' },
      mostOriginals: { user: '-', count: 0, wikidotId: null as number | null, unit: '篇', label: '原创数量第一' },
      mostTranslations: { user: '-', count: 0, wikidotId: null as number | null, unit: '篇', label: '翻译数量第一' },
      mostWords: { user: '-', count: 0, wikidotId: null as number | null, unit: '字', label: '总字数第一' },
      mostVotes: { user: '-', count: 0, wikidotId: null as number | null, unit: '票', label: '投票数第一' }
    },
    categoryBest: [],
    records: {
      longest: { title: '-', author: '-', count: 0, label: '年度最长文档', wikidotId: null as number | null },
      shortest: { title: '-', author: '-', count: 0, label: '年度最短高分文档', wikidotId: null as number | null },
      topTranslation: null as { title: string; author: string; rating: number; wikidotId: number | null } | null,
      mostProlificAuthor: null,
      mostActiveVoter: null,
      mostProlificWriter: null
    },
    extremeStats: {
      mostVotesTotal: null,
      mostVotesOneDay: null,
      mostUpvotesOneDay: null,
      mostProlificDay: null
    },
    breakdown: {
      byCategory: [],
      scpByClass: [],
      translationsByBranch: []
    },
    trends: { monthly: [], monthlySeries: [] },
    pageRankings: {
      topRatedOriginals: [],
      topOriginal: { title: '-', rating: 0, author: '-', tags: [], desc: '' },
      topTranslation: { title: '-', rating: 0, author: '-', tags: [], desc: '' }
    },
    funFacts: { popularTags: [] },
    tagInsights: {
      boutiqueTags: { totalPages: 0, tags: [] },
      newTagsThisYear: []
    },
    distributions: {
      tagCount: { total: 0, buckets: [] },
      titleLength: { total: 0, buckets: [] },
      votesCast: { total: 0, buckets: [] },
      contentWords: { total: 0, buckets: [] }
    },
    categoryDetails: {},
    categoryMonthly: {},
    monthlyVotes: [],
    votesByCategory: [],
    hourlyRevisions: [],
    revisionByTimeOfDay: [],
    revisionByWeekday: [],
    monthlyRevisions: [],
    interestingStats: {
      mostActiveVotingDay: null,
      peakVotingHour: null,
      fastestRisingPage: null,
      mostCollaborativePage: null,
      longestPage: null,
      mostControversialPage: null,
      longestTitlePage: null,
      mostTagsPage: null,
      weekdayVsWeekend: { weekday: { votes: 0, pages: 0 }, weekend: { votes: 0, pages: 0 }, weekdayPercent: 0, weekendPercent: 0 }
    }
  }
}

function getDefaultUserData(): AnnualUserData {
  return {
    userId: 0,
    wikidotId: null,
    userName: '',
    displayName: '加载中...',
    overview: {
      rankChange: { startRank: 0, endRank: 0, change: 0, direction: 'up' },
      creation: { totalCount: 0, totalWords: 0, originals: 0, translations: 0 },
      ratings: { totalRatingGained: 0, avgRating: 0 },
      votesReceived: { total: 0, up: 0, down: 0, netScore: 0, upRate: 0 },
      votesCast: { total: 0, up: 0, down: 0, upRate: 0, activeDays: 0 },
      activity: { activeDays: 0, longestStreak: 0, firstActivityDate: '', lastActivityDate: '', mostActiveMonth: '' }
    },
    timeline: [],
    preferences: {
      topTags: [],
      topTagsSource: 'none',
      votingTopTags: [],
      votingStyle: { up: 0, down: 0, label: '-', desc: '-' }
    },
    achievements: [],
    percentiles: {
      votesCast: null,
      contentWords: null
    },
    rankings: { overall: { rank: 0, percentile: 1, percentileLabel: '-' } },
    revisionTimeDistribution: {
      hourly: [],
      byTimeOfDay: [],
      peakHour: null,
      totalRevisions: 0
    }
  }
}
