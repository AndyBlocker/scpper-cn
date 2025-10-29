import { computed, toRaw } from 'vue';
import { useState } from '#app';

type ThemeMode = 'light' | 'dark';

export type ThemeToken =
  | 'bg'
  | 'fg'
  | 'muted'
  | 'mutedStrong'
  | 'panel'
  | 'panelBorder'
  | 'navBg'
  | 'navBorder'
  | 'sidebarBg'
  | 'sidebarBorder'
  | 'inputBg'
  | 'inputBorder'
  | 'tagBg'
  | 'tagBorder'
  | 'tagText'
  | 'heroGlow'
  | 'accent'
  | 'accentStrong'
  | 'accentWeak'
  | 'success'
  | 'successStrong'
  | 'danger'
  | 'dangerStrong'
  | 'chartUserFill'
  | 'chartUserLine'
  | 'chartAvgFill'
  | 'chartAvgLine'
  | 'chartGridLight'
  | 'chartGridDark';

export type ThemeOverrides = {
  light: Partial<Record<ThemeToken, string>>;
  dark: Partial<Record<ThemeToken, string>>;
};

export type ThemeExportPayload = {
  version: 1;
  mode: ThemeMode;
  scheme: string;
  overrides: ThemeOverrides;
};

export type ColorSchemePreset = {
  key: string;
  name: string;
  gradient: string;
  accentLight: string;
  accentLightStrong: string;
  accentLightWeak: string;
  accentDark: string;
  accentDarkStrong: string;
  accentDarkWeak: string;
};

const THEME_MODE_KEY = 'theme';
const COLOR_SCHEME_KEY = 'color-scheme';
const OVERRIDES_KEY = 'theme-overrides';
const OVERRIDES_STYLE_ID = 'theme-overrides-style';

const DEFAULT_OVERRIDES: ThemeOverrides = {
  light: {},
  dark: {}
};

function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const source = toRaw(value as object) as T;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(source);
    } catch {
      // ignore and fall back
    }
  }
  try {
    return JSON.parse(JSON.stringify(source)) as T;
  } catch {
    if (Array.isArray(source)) {
      return source.slice() as unknown as T;
    }
    return { ...(source as Record<string, unknown>) } as T;
  }
}

const COLOR_SCHEMES: readonly ColorSchemePreset[] = [
  { key: 'aurora', name: 'Aurora 蓝', gradient: 'linear-gradient(135deg, #0A84FF, #40A4FF)', accentLight: '#0A84FF', accentLightStrong: '#0060DC', accentLightWeak: '#A6C8FF', accentDark: '#409CFF', accentDarkStrong: '#0A84FF', accentDarkWeak: '#76BCFF' },
  { key: 'emerald', name: 'Fresh 绿', gradient: 'linear-gradient(135deg, #0AAE78, #4ADEB8)', accentLight: '#0AAE78', accentLightStrong: '#077352', accentLightWeak: '#66E7B5', accentDark: '#1EC89D', accentDarkStrong: '#0AAE78', accentDarkWeak: '#7DEFC8' },
  { key: 'indigo', name: 'Ocean 靛蓝', gradient: 'linear-gradient(135deg, #5058F3, #6F7CFF)', accentLight: '#5058F3', accentLightStrong: '#4047D9', accentLightWeak: '#B4BEFF', accentDark: '#7F8AFF', accentDarkStrong: '#5058F3', accentDarkWeak: '#CDD4FF' },
  { key: 'rose', name: 'Sakura 粉', gradient: 'linear-gradient(135deg, #F3577C, #FF9DB5)', accentLight: '#F3577C', accentLightStrong: '#D92C58', accentLightWeak: '#FFB7CA', accentDark: '#FF7996', accentDarkStrong: '#F3577C', accentDarkWeak: '#FFD0DA' },
  { key: 'amber', name: 'Sunset 琥珀', gradient: 'linear-gradient(135deg, #F6A41A, #FFD166)', accentLight: '#F6A41A', accentLightStrong: '#D97A0A', accentLightWeak: '#FFD68A', accentDark: '#FFC452', accentDarkStrong: '#F6A41A', accentDarkWeak: '#FFE29F' },
  { key: 'violet', name: 'Violet 紫', gradient: 'linear-gradient(135deg, #A35CFF, #C3A6FF)', accentLight: '#A35CFF', accentLightStrong: '#8136EB', accentLightWeak: '#D1B9FF', accentDark: '#B989FF', accentDarkStrong: '#A35CFF', accentDarkWeak: '#E2CDFF' },
  { key: 'sky', name: 'Sky 青', gradient: 'linear-gradient(135deg, #14A4ED, #58CCFF)', accentLight: '#14A4ED', accentLightStrong: '#0587CB', accentLightWeak: '#8DDFFF', accentDark: '#4FC5FF', accentDarkStrong: '#14A4ED', accentDarkWeak: '#B8ECFF' },
  { key: 'crimson', name: 'Crimson 绯红', gradient: 'linear-gradient(135deg, #E2404F, #FF8A95)', accentLight: '#E2404F', accentLightStrong: '#B61F31', accentLightWeak: '#FFADB6', accentDark: '#FF6D7C', accentDarkStrong: '#E2404F', accentDarkWeak: '#FFBFC6' }
] as const;

const TOKEN_TO_CSS_VAR: Record<ThemeToken, string> = {
  bg: '--bg',
  fg: '--fg',
  muted: '--muted',
  mutedStrong: '--muted-strong',
  panel: '--panel',
  panelBorder: '--panel-border',
  navBg: '--nav-bg',
  navBorder: '--nav-border',
  sidebarBg: '--sidebar-bg',
  sidebarBorder: '--sidebar-border',
  inputBg: '--input-bg',
  inputBorder: '--input-border',
  tagBg: '--tag-bg',
  tagBorder: '--tag-border',
  tagText: '--tag-text',
  heroGlow: '--hero-glow',
  accent: '--accent',
  accentStrong: '--accent-strong',
  accentWeak: '--accent-weak',
  success: '--success',
  successStrong: '--success-strong',
  danger: '--danger',
  dangerStrong: '--danger-strong',
  chartUserFill: '--chart-user-fill',
  chartUserLine: '--chart-user-line',
  chartAvgFill: '--chart-avg-fill',
  chartAvgLine: '--chart-avg-line',
  chartGridLight: '--chart-grid-light',
  chartGridDark: '--chart-grid-dark'
};

function isClient(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function hexToRgbChannels(input: string): string | null {
  const hex = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}$/.test(hex) && !/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }
  const normalized = hex.length === 3
    ? hex.split('').map((c) => c + c).join('')
    : hex;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

function sanitizeOverrides(overrides: ThemeOverrides | null | undefined): ThemeOverrides {
  if (!overrides || typeof overrides !== 'object') {
    return clone(DEFAULT_OVERRIDES);
  }
  const safe: ThemeOverrides = { light: {}, dark: {} };
  for (const mode of ['light', 'dark'] as const) {
    const src = overrides[mode];
    if (!src || typeof src !== 'object') continue;
    for (const [token, value] of Object.entries(src)) {
      if (!(token in TOKEN_TO_CSS_VAR) || typeof value !== 'string') continue;
      if (!hexToRgbChannels(value)) continue;
      safe[mode][token as ThemeToken] = normalizeHex(value);
    }
  }
  return safe;
}

function normalizeHex(value: string): string {
  const hex = value.trim().replace(/^#/, '');
  if (hex.length === 3) {
    return `#${hex.split('').map((c) => c + c).join('')}`.toLowerCase();
  }
  return `#${hex.padEnd(6, '0').slice(0, 6)}`.toLowerCase();
}

function ensureOverrideStyleElement(): HTMLStyleElement | null {
  if (!isClient()) return null;
  const existing = document.getElementById(OVERRIDES_STYLE_ID) as HTMLStyleElement | null;
  if (existing) return existing;
  const el = document.createElement('style');
  el.id = OVERRIDES_STYLE_ID;
  document.head.appendChild(el);
  return el;
}

function buildOverrideCss(overrides: ThemeOverrides): string {
  const sections: string[] = [];
  const expand = (mode: 'light' | 'dark') => {
    const entries = overrides[mode];
    const rows: string[] = [];
    for (const [token, hex] of Object.entries(entries)) {
      const rgb = hexToRgbChannels(hex);
      if (!rgb) continue;
      const cssVar = TOKEN_TO_CSS_VAR[token as ThemeToken];
      rows.push(`  ${cssVar}: ${rgb};`);
      if (token === 'accent') {
        rows.push(`  --primary: ${rgb};`);
      }
      if (token === 'accentStrong') {
        rows.push(`  --primary-strong: ${rgb};`);
      }
    }
    return rows;
  };

  const lightRows = expand('light');
  if (lightRows.length > 0) {
    sections.push(`html.light {\n${lightRows.join('\n')}\n}`);
  }
  const darkRows = expand('dark');
  if (darkRows.length > 0) {
    sections.push(`html.dark {\n${darkRows.join('\n')}\n}`);
  }
  return sections.join('\n');
}

function removeSchemeClasses(root: Element) {
  const classes = Array.from(root.classList);
  for (const cls of classes) {
    if (cls.startsWith('scheme-')) {
      root.classList.remove(cls);
    }
  }
}

function applyAccentFromPreset(mode: 'light' | 'dark', preset: ColorSchemePreset, overrides: ThemeOverrides) {
  if (mode === 'light') {
    overrides.light.accent = normalizeHex(preset.accentLight);
    overrides.light.accentStrong = normalizeHex(preset.accentLightStrong);
    overrides.light.accentWeak = normalizeHex(preset.accentLightWeak);
    overrides.light.heroGlow = normalizeHex(preset.accentLight);
  } else {
    overrides.dark.accent = normalizeHex(preset.accentDark);
    overrides.dark.accentStrong = normalizeHex(preset.accentDarkStrong);
    overrides.dark.accentWeak = normalizeHex(preset.accentDarkWeak);
    overrides.dark.heroGlow = normalizeHex(preset.accentDark);
  }
}

export function useThemeSettings() {
  const themeMode = useState<ThemeMode>('theme-mode', () => 'dark');
  const colorScheme = useState<string>('theme-color-scheme', () => 'aurora');
  const overridesState = useState<ThemeOverrides>('theme-overrides-state', () => clone(DEFAULT_OVERRIDES));
  const initialized = useState<boolean>('theme-initialized', () => false);

  const presets = COLOR_SCHEMES;
  const presetKeys = new Set(presets.map((p) => p.key));

  const hasOverrides = computed(() => {
    return Object.keys(overridesState.value.light).length > 0 || Object.keys(overridesState.value.dark).length > 0;
  });

  const applyOverrides = (overrides: ThemeOverrides, persist = true) => {
    if (!isClient()) {
      overridesState.value = clone(overrides);
      return;
    }
    const styleEl = ensureOverrideStyleElement();
    if (styleEl) {
      const css = buildOverrideCss(overrides);
      styleEl.textContent = css;
    }
    overridesState.value = clone(overrides);
    if (persist) {
      try {
        localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overridesState.value));
      } catch (error) {
        console.warn('[theme] persist overrides failed', error);
      }
    }
  };

  const applyThemeMode = (mode: ThemeMode, persist = true) => {
    if (!isClient()) {
      themeMode.value = mode;
      return;
    }
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(mode === 'light' ? 'light' : 'dark');
    themeMode.value = mode;
    if (persist) {
      try {
        localStorage.setItem(THEME_MODE_KEY, mode);
      } catch (error) {
        console.warn('[theme] persist mode failed', error);
      }
    }
  };

  const toggleThemeMode = () => {
    applyThemeMode(themeMode.value === 'light' ? 'dark' : 'light');
  };

  const applyColorScheme = (schemeKey: string, persist = true, { syncOverrides = true }: { syncOverrides?: boolean } = {}) => {
    if (!presetKeys.has(schemeKey)) {
      schemeKey = 'aurora';
    }
    if (isClient()) {
      const root = document.documentElement;
      removeSchemeClasses(root);
      root.classList.add(`scheme-${schemeKey}`);
    }
    colorScheme.value = schemeKey;
    if (persist) {
      try {
        localStorage.setItem(COLOR_SCHEME_KEY, schemeKey);
      } catch (error) {
        console.warn('[theme] persist scheme failed', error);
      }
    }

    if (syncOverrides) {
      const preset = presets.find((p) => p.key === schemeKey);
      if (preset) {
        const overrides = clone(overridesState.value);
        applyAccentFromPreset('light', preset, overrides);
        applyAccentFromPreset('dark', preset, overrides);
        applyOverrides(overrides, persist);
      }
    }
  };

  const resetOverrides = () => {
    applyOverrides(clone(DEFAULT_OVERRIDES));
  };

  const updateOverride = (mode: ThemeMode, token: ThemeToken, hex: string | null) => {
    const overrides = clone(overridesState.value);
    if (!hex) {
      delete overrides[mode][token];
    } else {
      if (!hexToRgbChannels(hex)) return;
      overrides[mode][token] = normalizeHex(hex);
    }
    applyOverrides(overrides);
  };

  const initialize = () => {
    if (initialized.value) return;
    if (!isClient()) return;

    let storedMode: ThemeMode = 'dark';
    try {
      const raw = localStorage.getItem(THEME_MODE_KEY);
      if (raw === 'light' || raw === 'dark') {
        storedMode = raw;
      } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        storedMode = 'dark';
      } else {
        storedMode = 'light';
      }
    } catch (error) {
      console.warn('[theme] read stored mode failed', error);
    }
    applyThemeMode(storedMode, false);

    let storedScheme = 'aurora';
    try {
      const raw = localStorage.getItem(COLOR_SCHEME_KEY);
      if (raw && presetKeys.has(raw)) storedScheme = raw;
    } catch (error) {
      console.warn('[theme] read stored scheme failed', error);
    }
    applyColorScheme(storedScheme, false);

    let storedOverrides = clone(DEFAULT_OVERRIDES);
    try {
      const raw = localStorage.getItem(OVERRIDES_KEY);
      if (raw) {
        storedOverrides = sanitizeOverrides(JSON.parse(raw));
      }
    } catch (error) {
      console.warn('[theme] read stored overrides failed', error);
    }
    applyOverrides(storedOverrides, false);

    initialized.value = true;
  };

  const exportSettings = (): ThemeExportPayload => ({
    version: 1,
    mode: themeMode.value,
    scheme: colorScheme.value,
    overrides: clone(overridesState.value)
  });

  const importSettings = (payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('无效的主题文件');
    }
    const data = payload as Partial<ThemeExportPayload>;
    if (data.version !== 1) {
      throw new Error('主题文件版本不受支持');
    }
    if (data.mode !== 'light' && data.mode !== 'dark') {
      throw new Error('主题文件缺少模式信息');
    }
    if (!data.scheme || typeof data.scheme !== 'string') {
      throw new Error('主题文件缺少配色信息');
    }
    if (!data.overrides) {
      throw new Error('主题文件缺少自定义颜色');
    }

    const sanitized = sanitizeOverrides(data.overrides);
    applyOverrides(sanitized);
    applyColorScheme(data.scheme, true, { syncOverrides: false });
    applyThemeMode(data.mode);
  };

  return {
    presets,
    themeMode,
    colorScheme,
    overrides: overridesState,
    hasOverrides,
    applyThemeMode,
    toggleThemeMode,
    applyColorScheme,
    updateOverride,
    resetOverrides,
    initialize,
    exportSettings,
    importSettings
  };
}
