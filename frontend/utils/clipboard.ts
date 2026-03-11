export async function copyTextWithFallback(text: string, promptLabel = '请复制内容'): Promise<boolean> {
  const value = text.trim()
  if (!value || typeof window === 'undefined') return false

  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch (error) {
    // Some environments deny clipboard permissions; fallback handled below.
    console.debug('[clipboard] navigator copy unavailable', error)
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    if (copied) return true
  } catch (error) {
    console.warn('[clipboard] copy failed', error)
  }

  window.prompt(promptLabel, value)
  return false
}
