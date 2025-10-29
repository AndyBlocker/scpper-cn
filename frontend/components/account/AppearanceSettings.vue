<template>
  <div class="space-y-8">
    <section class="rounded-3xl border border-[rgba(var(--panel-border),0.45)] bg-[rgba(var(--panel),0.78)] p-6 shadow-[0_18px_48px_rgba(15,23,42,0.12)] backdrop-blur-xl dark:shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
      <header class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 class="text-lg font-semibold text-[rgb(var(--fg))]">主题模式</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">切换浅色或深色，并实时预览。</p>
        </div>
        <div class="inline-flex rounded-full border border-[rgba(var(--panel-border),0.5)] bg-[rgba(var(--panel),0.7)] p-1 text-sm">
          <button
            v-for="modeOption in modeOptions"
            :key="modeOption.key"
            type="button"
            class="flex items-center gap-2 rounded-full px-3 py-1.5 font-semibold transition"
            :class="themeMode === modeOption.key
              ? 'bg-[rgba(var(--accent),0.16)] text-[rgb(var(--accent))] shadow-sm'
              : 'text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))]'"
            @click="handleModeChange(modeOption.key)"
          >
            <span>{{ modeOption.label }}</span>
          </button>
        </div>
      </header>
      <p class="mt-4 rounded-2xl border border-dashed border-[rgba(var(--panel-border),0.45)] bg-[rgba(var(--panel),0.55)] px-4 py-3 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
        当前正在编辑 <span class="font-semibold text-[rgb(var(--accent))]">{{ editingModeLabel }}</span> 配置。切换模式将立即应用新主题，方便对比效果。
      </p>
    </section>

    <section class="rounded-3xl border border-[rgba(var(--panel-border),0.45)] bg-[rgba(var(--panel),0.78)] p-6 shadow-[0_18px_48px_rgba(15,23,42,0.12)] backdrop-blur-xl dark:shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
      <header class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 class="text-lg font-semibold text-[rgb(var(--fg))]">快速配色</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">选择一套适配浅色和深色的主色方案，作为自定义的起点。</p>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--panel-border),0.55)] px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:text-[rgb(var(--accent))] dark:text-neutral-300"
          @click="handleResetPresets"
        >
          <LucideIcon name="RotateCcw" class="h-4 w-4" stroke-width="2" />
          恢复默认配色
        </button>
      </header>
      <div class="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <button
          v-for="preset in presets"
          :key="preset.key"
          type="button"
          :aria-pressed="colorScheme === preset.key"
          class="group flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition"
          :class="colorScheme === preset.key
            ? 'border-[rgba(var(--accent),0.45)] bg-[rgba(var(--panel),0.85)] shadow-sm text-[rgb(var(--accent))]'
            : 'border-[rgba(var(--panel-border),0.4)] bg-[rgba(var(--panel),0.6)] text-neutral-600 hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] dark:text-neutral-300'"
          @click="handlePresetSelect(preset.key)"
        >
          <div class="flex flex-col gap-1">
            <span class="text-sm font-semibold">{{ preset.name }}</span>
            <span class="text-[11px] text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">Key: {{ preset.key }}</span>
          </div>
          <span
            class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/70 shadow-inner"
            :style="{ background: preset.gradient }"
          ></span>
        </button>
      </div>
    </section>

    <section class="rounded-3xl border border-[rgba(var(--panel-border),0.45)] bg-[rgba(var(--panel),0.78)] p-6 shadow-[0_18px_48px_rgba(15,23,42,0.12)] backdrop-blur-xl dark:shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
      <header class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 class="text-lg font-semibold text-[rgb(var(--fg))]">自定义颜色</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">为不同组件设置精确的颜色。覆盖项目会立即保存在浏览器本地。</p>
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-neutral-500 dark:text-neutral-400">编辑模式：</span>
          <div class="inline-flex rounded-full border border-[rgba(var(--panel-border),0.5)] bg-[rgba(var(--panel),0.65)] p-0.5">
            <button
              v-for="modeOption in modeOptions"
              :key="`editor-${modeOption.key}`"
              type="button"
              class="rounded-full px-2.5 py-1 font-semibold transition"
              :class="editingMode === modeOption.key
                ? 'bg-[rgba(var(--accent),0.18)] text-[rgb(var(--accent))]'
                : 'text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))]'"
              @click="handleModeChange(modeOption.key)"
            >
              {{ modeOption.label }}
            </button>
          </div>
        </div>
      </header>

      <div class="mt-6 space-y-6">
        <div
          v-for="group in tokenGroups"
          :key="group.key"
          class="rounded-2xl border border-[rgba(var(--panel-border),0.35)] bg-[rgba(var(--panel),0.55)] p-4"
        >
          <header class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 class="text-sm font-semibold text-[rgb(var(--fg))]">{{ group.label }}</h3>
              <p class="text-xs text-neutral-500 dark:text-neutral-400">{{ group.description }}</p>
            </div>
            <button
              v-if="group.tokens.some(token => isOverridden(editingMode, token.key))"
              type="button"
              class="mt-2 inline-flex items-center gap-1 rounded-full bg-[rgba(var(--accent),0.12)] px-3 py-1 text-[11px] font-semibold text-[rgb(var(--accent))] sm:mt-0"
              @click="clearGroupOverrides(group.tokens)"
            >
              <LucideIcon name="Minus" class="h-3.5 w-3.5" stroke-width="2" />
              清除覆盖
            </button>
          </header>
          <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div
              v-for="token in group.tokens"
              :key="`${group.key}-${token.key}`"
              class="flex items-center justify-between gap-3 rounded-xl border border-[rgba(var(--panel-border),0.3)] bg-[rgba(var(--panel),0.5)] px-3 py-3"
            >
              <div class="min-w-0">
                <div class="text-sm font-medium text-[rgb(var(--fg))]">{{ token.label }}</div>
                <div class="text-[11px] text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
                  {{ displayHex(editingMode, token.key) }}
                  <span v-if="isOverridden(editingMode, token.key)" class="ml-1 inline-flex items-center rounded-full bg-[rgba(var(--accent),0.18)] px-2 py-0.5 text-[10px] font-semibold text-[rgb(var(--accent))]">已覆盖</span>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <input
                  :id="`picker-${editingMode}-${token.key}`"
                  type="color"
                  class="h-10 w-10 cursor-pointer rounded-xl border border-[rgba(var(--panel-border),0.4)] bg-transparent"
                  :value="getColorValue(editingMode, token.key)"
                  @input="handleColorChange(editingMode, token.key, $event)"
                />
                <button
                  v-if="isOverridden(editingMode, token.key)"
                  type="button"
                  class="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[rgba(var(--panel-border),0.5)] text-neutral-500 hover:text-[rgb(var(--accent))]"
                  @click="clearOverride(editingMode, token.key)"
                  aria-label="清除该颜色的覆盖"
                >
                  <LucideIcon name="X" class="h-4 w-4" stroke-width="2" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-3xl border border-[rgba(var(--panel-border),0.45)] bg-[rgba(var(--panel),0.78)] p-6 shadow-[0_18px_48px_rgba(15,23,42,0.12)] backdrop-blur-xl dark:shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
      <header class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-lg font-semibold text-[rgb(var(--fg))]">导入与导出</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">备份你的主题设置或在不同设备间同步。</p>
        </div>
        <div v-if="message" :class="messageClass" class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold">
          <LucideIcon
            v-if="message.type === 'success'"
            name="Check"
            class="h-3.5 w-3.5"
            stroke-width="2"
          />
          <LucideIcon
            v-else
            name="AlertCircle"
            class="h-3.5 w-3.5"
            stroke-width="2"
          />
          <span>{{ message.text }}</span>
        </div>
      </header>
      <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div class="inline-flex items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-full bg-[rgb(var(--accent))] px-4 py-2 text-sm font-semibold text-white shadow-[0_16px_40px_rgba(10,132,255,0.28)] hover:-translate-y-0.5 transition"
            @click="handleExport"
          >
            <LucideIcon name="Upload" class="h-4 w-4" stroke-width="2" />
            导出主题
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--panel-border),0.55)] bg-[rgba(var(--panel),0.7)] px-4 py-2 text-sm font-semibold text-neutral-600 hover:text-[rgb(var(--accent))] dark:text-neutral-300"
            @click="triggerImport"
          >
            <LucideIcon name="Download" class="h-4 w-4" stroke-width="2" />
            导入主题
          </button>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--panel-border),0.55)] px-4 py-2 text-sm font-semibold text-neutral-600 hover:text-[rgb(var(--accent))] dark:text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!hasOverrides"
          @click="handleResetOverrides"
        >
          <LucideIcon name="Trash" class="h-4 w-4" stroke-width="2" />
          清空所有自定义
        </button>
      </div>
      <input ref="fileInputRef" type="file" accept="application/json" class="hidden" @change="handleImport" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useThemeSettings, type ThemeToken } from '~/composables/useThemeSettings'

type ThemeMode = 'light' | 'dark'

const {
  presets,
  themeMode,
  applyThemeMode,
  colorScheme,
  applyColorScheme,
  overrides,
  updateOverride,
  resetOverrides,
  hasOverrides,
  exportSettings,
  importSettings
} = useThemeSettings()

const modeOptions: Array<{ key: ThemeMode; label: string }> = [
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' }
]

const tokenGroups: Array<{
  key: string;
  label: string;
  description: string;
  tokens: Array<{ key: ThemeToken; label: string }>;
}> = [
  {
    key: 'base',
    label: '基础色彩',
    description: '页面的背景、文字与面板色调。',
    tokens: [
      { key: 'bg', label: '页面背景' },
      { key: 'fg', label: '正文文字' },
      { key: 'muted', label: '次要文字' },
      { key: 'mutedStrong', label: '强调文字' },
      { key: 'panel', label: '面板背景' },
      { key: 'panelBorder', label: '面板边框' }
    ]
  },
  {
    key: 'accent',
    label: '主色调',
    description: '品牌主色及其深浅层次，驱动按钮、链接与强调元素。',
    tokens: [
      { key: 'accent', label: '主色' },
      { key: 'accentStrong', label: '主色（深）' },
      { key: 'accentWeak', label: '主色（浅）' }
    ]
  },
  {
    key: 'structure',
    label: '导航与框架',
    description: '站点头部、侧边栏与背景光晕。',
    tokens: [
      { key: 'navBg', label: '导航背景' },
      { key: 'navBorder', label: '导航边框' },
      { key: 'sidebarBg', label: '侧栏背景' },
      { key: 'sidebarBorder', label: '侧栏边框' },
      { key: 'heroGlow', label: '背景光晕' }
    ]
  },
  {
    key: 'controls',
    label: '输入与标签',
    description: '输入框、过滤器、标签等交互元素。',
    tokens: [
      { key: 'inputBg', label: '输入背景' },
      { key: 'inputBorder', label: '输入边框' },
      { key: 'tagBg', label: '标签背景' },
      { key: 'tagBorder', label: '标签边框' },
      { key: 'tagText', label: '标签文字' }
    ]
  },
  {
    key: 'semantic',
    label: '状态色',
    description: '成功与警示色的深浅，用于标记提醒或按钮状态。',
    tokens: [
      { key: 'success', label: '成功色' },
      { key: 'successStrong', label: '成功（深）' },
      { key: 'danger', label: '警示色' },
      { key: 'dangerStrong', label: '警示（深）' }
    ]
  },
  {
    key: 'charts',
    label: '图表与栅格',
    description: '统计图使用的填充、线条与网格颜色。',
    tokens: [
      { key: 'chartUserFill', label: '图表主填充' },
      { key: 'chartUserLine', label: '图表主线条' },
      { key: 'chartAvgFill', label: '对比填充' },
      { key: 'chartAvgLine', label: '对比线条' },
      { key: 'chartGridLight', label: '网格（浅）' },
      { key: 'chartGridDark', label: '网格（深）' }
    ]
  }
]

const defaultPalette: Record<ThemeMode, Record<ThemeToken, string>> = {
  light: {
    bg: '#f4f6f9',
    fg: '#171717',
    muted: '#6e7681',
    mutedStrong: '#374151',
    panel: '#ffffff',
    panelBorder: '#e0e7f0',
    navBg: '#ffffff',
    navBorder: '#e0e7f0',
    sidebarBg: '#ffffff',
    sidebarBorder: '#e0e7f0',
    inputBg: '#f8fafc',
    inputBorder: '#d1d5db',
    tagBg: '#e2e8f0',
    tagBorder: '#cbd5e1',
    tagText: '#475569',
    heroGlow: '#0a84ff',
    accent: '#0a84ff',
    accentStrong: '#0060dc',
    accentWeak: '#a6c8ff',
    success: '#22c55e',
    successStrong: '#16a34a',
    danger: '#dc2626',
    dangerStrong: '#b91c1c',
    chartUserFill: '#0a84ff',
    chartUserLine: '#0060dc',
    chartAvgFill: '#94a3b8',
    chartAvgLine: '#64748b',
    chartGridLight: '#000000',
    chartGridDark: '#ffffff'
  },
  dark: {
    bg: '#0a0b0f',
    fg: '#f5f5f7',
    muted: '#9ca3af',
    mutedStrong: '#768392',
    panel: '#181a20',
    panelBorder: '#2e3240',
    navBg: '#12141c',
    navBorder: '#262a38',
    sidebarBg: '#14171f',
    sidebarBorder: '#2f3444',
    inputBg: '#1e2230',
    inputBorder: '#3f4860',
    tagBg: '#292d3a',
    tagBorder: '#465064',
    tagText: '#bac7dc',
    heroGlow: '#409cff',
    accent: '#409cff',
    accentStrong: '#0a84ff',
    accentWeak: '#76bcff',
    success: '#10b981',
    successStrong: '#10b981',
    danger: '#ef4444',
    dangerStrong: '#ef4444',
    chartUserFill: '#409cff',
    chartUserLine: '#0a84ff',
    chartAvgFill: '#94a3b8',
    chartAvgLine: '#64748b',
    chartGridLight: '#000000',
    chartGridDark: '#ffffff'
  }
} as const;

const editingMode = ref<ThemeMode>(themeMode.value);

watch(themeMode, (next) => {
  editingMode.value = next;
});

const editingModeLabel = computed(() => editingMode.value === 'light' ? '浅色模式' : '深色模式');

const message = ref<{ type: 'success' | 'error'; text: string } | null>(null);
let messageTimer: number | null = null;

const messageClass = computed(() => {
  if (!message.value) return '';
  return message.value.type === 'success'
    ? 'bg-[rgba(var(--success),0.12)] text-[rgb(var(--success-strong))]'
    : 'bg-[rgba(var(--danger),0.12)] text-[rgb(var(--danger-strong))]';
});

const fileInputRef = ref<HTMLInputElement | null>(null);

function showMessage(type: 'success' | 'error', text: string) {
  message.value = { type, text };
  if (typeof window !== 'undefined' && messageTimer != null) {
    window.clearTimeout(messageTimer);
  }
  if (typeof window !== 'undefined') {
    messageTimer = window.setTimeout(() => {
      message.value = null;
      messageTimer = null;
    }, 4000);
  }
}

function handleModeChange(mode: ThemeMode) {
  if (mode === themeMode.value) return;
  applyThemeMode(mode);
  editingMode.value = mode;
}

function handlePresetSelect(key: string) {
  applyColorScheme(key);
  showMessage('success', `已应用 ${key} 配色方案`);
}

function getColorValue(mode: ThemeMode, token: ThemeToken): string {
  const override = overrides.value[mode]?.[token];
  if (override) return override;

  const preset = presets.find((item) => item.key === colorScheme.value);

  if (token === 'accent' || token === 'accentStrong' || token === 'accentWeak') {
    if (preset) {
      if (mode === 'light') {
        if (token === 'accent') return preset.accentLight;
        if (token === 'accentStrong') return preset.accentLightStrong;
        return preset.accentLightWeak;
      } else {
        if (token === 'accent') return preset.accentDark;
        if (token === 'accentStrong') return preset.accentDarkStrong;
        return preset.accentDarkWeak;
      }
    }
  }

  if (token === 'chartUserFill') {
    if (preset) {
      return mode === 'light' ? preset.accentLight : preset.accentDark;
    }
  }
  if (token === 'chartUserLine') {
    if (preset) {
      return mode === 'light' ? preset.accentLightStrong : preset.accentDarkStrong;
    }
  }
  if (token === 'heroGlow' && preset) {
    return mode === 'light' ? preset.accentLight : preset.accentDark;
  }

  return defaultPalette[mode]?.[token] ?? '#000000';
}

function handleColorChange(mode: ThemeMode, token: ThemeToken, event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input?.value) return;
  updateOverride(mode, token, input.value);
}

function displayHex(mode: ThemeMode, token: ThemeToken): string {
  return getColorValue(mode, token).toUpperCase();
}

function isOverridden(mode: ThemeMode, token: ThemeToken): boolean {
  return Boolean(overrides.value[mode]?.[token]);
}

function clearOverride(mode: ThemeMode, token: ThemeToken) {
  updateOverride(mode, token, null);
}

function clearGroupOverrides(tokens: Array<{ key: ThemeToken }>) {
  for (const token of tokens) {
    if (isOverridden(editingMode.value, token.key)) {
      clearOverride(editingMode.value, token.key);
    }
  }
}

function handleResetOverrides() {
  resetOverrides();
  showMessage('success', '已清空所有自定义颜色');
}

function handleResetPresets() {
  applyColorScheme('aurora');
  resetOverrides();
  showMessage('success', '已恢复默认主题');
}

function handleExport() {
  try {
    const payload = exportSettings();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    if (typeof URL === 'undefined') {
      throw new Error('当前环境不支持导出');
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `scpper-theme-${payload.scheme}-${Date.now()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    showMessage('success', '已导出主题配置');
  } catch (error) {
    console.error('[theme] export failed', error);
    showMessage('error', '导出失败，请稍后重试');
  }
}

function triggerImport() {
  fileInputRef.value?.click();
}

async function handleImport(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    importSettings(payload);
    showMessage('success', '主题配置已导入并应用');
  } catch (error) {
    console.error('[theme] import failed', error);
    const messageText = error instanceof Error ? error.message : '导入失败，请检查文件内容';
    showMessage('error', messageText);
  } finally {
    input.value = '';
  }
}
</script>
