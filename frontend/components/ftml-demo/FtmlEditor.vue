<template>
  <div class="editor-pane">
    <div class="pane-header">
      <div class="pane-title">
        <span>源文本</span>
        <span class="pane-badge">FTML</span>
      </div>
      <span class="pane-stats">
        {{ stats.lines }} 行 · {{ stats.words }} 词 · {{ stats.chars }} 字符 · 标签 {{ stats.tags }}
        <template v-if="workerVersion"> · FTML v{{ workerVersion }}</template>
      </span>
    </div>
    <div class="editor-wrap" ref="editorWrapRef" @click="handleWrapperClick">
      <textarea
        ref="textareaRef"
        :value="modelValue"
        @input="handleInput"
        @keydown="handleKeydown"
        class="editor-textarea"
        :class="{ hidden: cmInitialized }"
        spellcheck="false"
        placeholder="在此输入 FTML / Wikidot 文本..."
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'

const props = defineProps<{
  modelValue: string
  stats: { lines: number; chars: number; words: number; tags: number }
  workerVersion: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'render'): void
  (e: 'save'): void
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const editorWrapRef = ref<HTMLElement | null>(null)
const cmInitialized = ref(false)

// CodeMirror instance (will be initialized client-side)
let cmEditor: any = null

function handleInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)
}

function handleKeydown(event: KeyboardEvent) {
  // Ctrl/Cmd + Enter to render
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    emit('render')
    return
  }
  // Ctrl/Cmd + S to save
  if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    emit('save')
    return
  }
}

function handleWrapperClick() {
  console.log('[FtmlEditor] Wrapper clicked, cmEditor:', cmEditor ? 'exists' : 'null')
  if (cmEditor) {
    cmEditor.focus()
    console.log('[FtmlEditor] Focus called on CodeMirror')
  } else if (textareaRef.value) {
    textareaRef.value.focus()
    console.log('[FtmlEditor] Focus called on textarea')
  }
}

// Initialize CodeMirror (client-side only)
async function initCodeMirror() {
  console.log('[FtmlEditor] initCodeMirror called')

  if (typeof window === 'undefined') {
    console.log('[FtmlEditor] Not in browser, skipping')
    return
  }
  if (cmEditor) {
    console.log('[FtmlEditor] Already initialized, skipping')
    return
  }

  // Wait for next tick to ensure textarea is mounted
  await nextTick()

  console.log('[FtmlEditor] After nextTick, textareaRef:', textareaRef.value ? 'exists' : 'null')
  console.log('[FtmlEditor] editorWrapRef:', editorWrapRef.value ? 'exists' : 'null')

  if (editorWrapRef.value) {
    const rect = editorWrapRef.value.getBoundingClientRect()
    console.log('[FtmlEditor] Container dimensions:', rect.width, 'x', rect.height)
  }

  if (!textareaRef.value) {
    console.warn('[FtmlEditor] textarea ref is null, skipping CodeMirror init')
    return
  }

  try {
    console.log('[FtmlEditor] Importing CodeMirror...')
    // CodeMirror 5 uses UMD, need to import differently
    const CodeMirror = await import('codemirror').then(m => m.default || m)
    console.log('[FtmlEditor] CodeMirror imported:', typeof CodeMirror)

    // Import modes and addons
    await import('codemirror/mode/gfm/gfm')
    await import('codemirror/mode/xml/xml')
    await import('codemirror/addon/mode/overlay')
    await import('codemirror/addon/edit/matchbrackets')
    await import('codemirror/addon/edit/closebrackets')
    await import('codemirror/addon/selection/active-line')

    // Define FTML/Wikidot syntax mode
    CodeMirror.defineMode('ftml', (config: any) => {
      const gfmMode = CodeMirror.getMode(config, 'gfm')

      return CodeMirror.overlayMode(gfmMode, {
        token: (stream: any) => {
          // [[module]] or [[div]] or [[/div]] blocks
          if (stream.match(/\[\[\/?\w+/)) {
            // Continue to match until ]]
            while (!stream.eol()) {
              if (stream.match(']]')) break
              stream.next()
            }
            return 'ftml-block'
          }

          // [[[triple bracket links]]]
          if (stream.match(/\[\[\[/)) {
            while (!stream.eol()) {
              if (stream.match(']]]')) break
              stream.next()
            }
            return 'ftml-link'
          }

          // @@inline code@@
          if (stream.match(/@@/)) {
            while (!stream.eol()) {
              if (stream.match('@@')) break
              stream.next()
            }
            return 'ftml-code'
          }

          // --strikethrough--
          if (stream.match(/--(?=[^\s-])/)) {
            while (!stream.eol()) {
              if (stream.match('--')) break
              stream.next()
            }
            return 'ftml-strike'
          }

          // __underline__
          if (stream.match(/__(?=[^\s_])/)) {
            while (!stream.eol()) {
              if (stream.match('__')) break
              stream.next()
            }
            return 'ftml-underline'
          }

          // {{monospace}}
          if (stream.match(/\{\{/)) {
            while (!stream.eol()) {
              if (stream.match('}}')) break
              stream.next()
            }
            return 'ftml-mono'
          }

          // [!-- comments --]
          if (stream.match(/\[!--/)) {
            while (!stream.eol()) {
              if (stream.match('--]')) break
              stream.next()
            }
            return 'ftml-comment'
          }

          stream.next()
          return null
        }
      })
    })

    await nextTick()

    // Re-check after async operations - the ref might have become null
    if (!textareaRef.value) {
      console.warn('[FtmlEditor] textarea ref became null after async imports')
      return
    }

    console.log('[FtmlEditor] Creating CodeMirror instance...')
    cmEditor = CodeMirror.fromTextArea(textareaRef.value, {
      lineNumbers: true,
      lineWrapping: true,
      mode: 'ftml',
      theme: 'default',
      indentUnit: 2,
      tabSize: 2,
      matchBrackets: true,
      autoCloseBrackets: true,
      styleActiveLine: true,
    })
    console.log('[FtmlEditor] CodeMirror instance created')

    cmEditor.setValue(props.modelValue)
    cmInitialized.value = true
    console.log('[FtmlEditor] cmInitialized set to true')

    // Refresh editor after a short delay to apply CSS fixes
    setTimeout(() => cmEditor?.refresh(), 100)

    cmEditor.on('change', () => {
      const value = cmEditor.getValue()
      if (value !== props.modelValue) {
        emit('update:modelValue', value)
      }
    })

    cmEditor.on('keydown', (_cm: any, ev: KeyboardEvent) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault()
        emit('render')
      }
      if (ev.key === 's' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault()
        emit('save')
      }
    })

    // Focus the editor
    cmEditor.focus()
    console.log('[FtmlEditor] Initialization complete, editor focused')
  } catch (e) {
    console.error('[FtmlEditor] CodeMirror initialization failed:', e)
    cmInitialized.value = false
    cmEditor = null
    // Ensure textarea is visible and focusable
    if (textareaRef.value) {
      textareaRef.value.style.position = ''
      textareaRef.value.style.opacity = ''
      textareaRef.value.style.pointerEvents = ''
    }
  }
}

// Sync value to CodeMirror
watch(
  () => props.modelValue,
  (newVal) => {
    if (cmEditor && cmEditor.getValue() !== newVal) {
      const cursor = cmEditor.getCursor()
      cmEditor.setValue(newVal)
      cmEditor.setCursor(cursor)
    }
  }
)

onMounted(async () => {
  await initCodeMirror()
  // If first attempt failed but textarea exists, try again after a short delay
  if (!cmEditor && textareaRef.value) {
    setTimeout(() => {
      if (!cmEditor && textareaRef.value) {
        initCodeMirror()
      }
    }, 100)
  }
})

onUnmounted(() => {
  if (cmEditor) {
    cmEditor.toTextArea()
    cmEditor = null
    cmInitialized.value = false
  }
})

// Expose focus method
defineExpose({
  focus: () => {
    if (cmEditor) {
      cmEditor.focus()
    } else if (textareaRef.value) {
      textareaRef.value.focus()
    }
  },
  setCursor: (line: number, ch: number) => {
    if (cmEditor) {
      cmEditor.focus()
      cmEditor.setCursor({ line: Math.max(0, line - 1), ch: Math.max(0, ch - 1) })
      cmEditor.scrollIntoView(null, 80)
    }
  },
})
</script>

<style scoped>
.editor-pane {
  @apply flex flex-col h-full;
  @apply bg-white dark:bg-neutral-900;
}

.pane-header {
  @apply flex items-center justify-between px-4 py-2.5;
  @apply bg-neutral-50 dark:bg-neutral-800/50;
  @apply border-b border-neutral-200 dark:border-neutral-700;
}

.pane-title {
  @apply flex items-center gap-2 font-semibold text-neutral-800 dark:text-neutral-100;
}

.pane-badge {
  @apply text-[10px] px-1.5 py-0.5 rounded;
  @apply bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400;
  @apply font-semibold;
}

.pane-stats {
  @apply text-xs text-neutral-500 dark:text-neutral-400 font-mono;
}

.editor-wrap {
  @apply flex-1 min-h-0 relative overflow-hidden;
}

.editor-textarea {
  @apply w-full h-full resize-none;
  @apply px-4 py-3;
  @apply bg-white dark:bg-neutral-900;
  @apply text-neutral-800 dark:text-neutral-100;
  @apply font-mono text-sm leading-relaxed;
  @apply border-none outline-none;
}

.editor-textarea.hidden {
  @apply absolute opacity-0 pointer-events-none;
}

.editor-textarea::placeholder {
  @apply text-neutral-400 dark:text-neutral-500;
}

/* CodeMirror styles are in global CSS (assets/css/tailwind.css) */
</style>
