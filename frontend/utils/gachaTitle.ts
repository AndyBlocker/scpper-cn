const LEGACY_AFFIX_TITLE_SUFFIX_RE = /\s*[·•|｜]\s*(黑白词条|镀金词条|蓝图词条)\s*$/iu
const LEGACY_AFFIX_VERSION_SUFFIX_RE = /\s*[~～\-—–·•|｜]\s*(黑白|镀金|蓝图|mono|gilded|azure|cyan)\s*(?:版本|version|variant)\s*$/iu

function stripOnce(title: string) {
  return title
    .replace(LEGACY_AFFIX_TITLE_SUFFIX_RE, '')
    .replace(LEGACY_AFFIX_VERSION_SUFFIX_RE, '')
    .trim()
}

export function stripLegacyGachaTitleSuffix(input: string | null | undefined) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  let next = raw
  for (let i = 0; i < 4; i += 1) {
    const normalized = stripOnce(next)
    if (normalized === next) break
    next = normalized
  }
  return next || raw
}

export function displayCardTitle(title: string | null | undefined): string {
  return stripLegacyGachaTitleSuffix(title) || '未命名卡片'
}
