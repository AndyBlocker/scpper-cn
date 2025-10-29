// https://nuxt.com/docs/api/configuration/nuxt-config
const command = process.env.NUXT_COMMAND || process.env.npm_lifecycle_event || '';
const isDevCommand = command === 'dev';
// Keep dev server artifacts out of the production output directories.
const buildDir = isDevCommand ? '.nuxt-dev' : '.nuxt';
const outputDir = isDevCommand ? '.output-dev' : '.output';

const envBoolean = (value: string | undefined, fallback = false) => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const envNumber = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export default defineNuxtConfig({
  srcDir: '.',
  buildDir,
  compatibilityDate: '2025-08-23',
  // Vite 构建参数：使用 esbuild（多线程）最小化与更高目标，显著缩短构建时间
  vite: {
    build: {
      minify: 'esbuild',
      target: 'esnext',
      sourcemap: false,
      cssCodeSplit: true
    },
    esbuild: {
      legalComments: 'none'
    },
    optimizeDeps: {
      esbuildOptions: { target: 'esnext' }
    }
  },
  modules: [
    '@nuxtjs/tailwindcss'
  ],
  tailwindcss: {
    cssPath: 'assets/css/tailwind.css'
  },
  runtimeConfig: {
    public: {
      // 使用环境变量或默认值
      // 开发: BFF_BASE=http://localhost:4396 npm run dev
      // 生产: BFF_BASE=/api npm run build
      bffBase: process.env.BFF_BASE || '/api',
      debugFetchTimings: envBoolean(process.env.DEBUG_FETCH_TIMINGS, false),
      debugFetchMinDurationMs: envNumber(process.env.DEBUG_FETCH_MIN_DURATION_MS, 0),
      slowFetchThresholdMs: envNumber(process.env.SLOW_FETCH_THRESHOLD_MS, 800)
    }
  },
  nitro: {
    output: {
      dir: outputDir
    },
    preset: 'node-server',
    // 在生产环境代理 /api 请求到 BFF 服务
    devProxy: {
      '/api': {
        target: 'http://localhost:4396',
        changeOrigin: true,
        prependPath: false,
        rewrite: (path: string) => path.replace(/^\/api/, '')
      }
    },
    // 生产环境也启用代理
    routeRules: {
      '/api/**': { proxy: 'http://localhost:4396/**' }
    }
  },
  app: {
    head: {
      title: 'SCPPER-CN',
      titleTemplate: (titleChunk?: string) => {
        const base = 'SCPPER-CN';
        if (!titleChunk) return base;
        // Avoid duplicating base when pages already include it
        return titleChunk.includes(base) ? titleChunk : `${titleChunk} - ${base}`;
      },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#0A0A0B', media: '(prefers-color-scheme: dark)' },
        { name: 'theme-color', content: '#F6F6F7', media: '(prefers-color-scheme: light)' }
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/icons/favicon-light.svg', media: '(prefers-color-scheme: light)' },
        { rel: 'icon', type: 'image/svg+xml', href: '/icons/favicon-dark.svg', media: '(prefers-color-scheme: dark)' },
        { rel: 'mask-icon', href: '/icons/safari-pinned-tab.svg', color: '#10B981' }
      ],
      script: [
        {
          id: 'theme-init',
          innerHTML: `
            (function() {
              try {
                var storedTheme = localStorage.getItem('theme');
                var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                var initialTheme = (storedTheme === 'light' || storedTheme === 'dark')
                  ? storedTheme
                  : (prefersDark ? 'dark' : 'light');
                var storedScheme = localStorage.getItem('color-scheme');
                var scheme = storedScheme && /^[-a-z]+$/.test(storedScheme) ? storedScheme : 'aurora';
                var root = document.documentElement;
                root.classList.remove('light', 'dark');
                Array.prototype.slice.call(root.classList).forEach(function(c){ if(c && c.indexOf('scheme-')===0) root.classList.remove(c); });
                root.classList.add(initialTheme === 'light' ? 'light' : 'dark');
                root.classList.add('scheme-' + scheme);
                if (storedTheme !== initialTheme) localStorage.setItem('theme', initialTheme);
                if (!storedScheme) localStorage.setItem('color-scheme', scheme);
                var TOKEN_TO_VAR = {
                  bg: '--bg',
                  fg: '--fg',
                  muted: '--muted',
                  mutedStrong: '--muted-strong',
                  panel: '--panel',
                  panelBorder: '--panel-border',
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
                var hexToRgb = function(hex) {
                  if (!hex) return null;
                  var raw = String(hex).trim().replace(/^#/, '');
                  if (raw.length === 3) {
                    raw = raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2];
                  }
                  if (raw.length !== 6) return null;
                  var r = parseInt(raw.slice(0, 2), 16);
                  var g = parseInt(raw.slice(2, 4), 16);
                  var b = parseInt(raw.slice(4, 6), 16);
                  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
                  return r + ' ' + g + ' ' + b;
                };
                var buildOverrideCss = function(mode, record) {
                  if (!record || typeof record !== 'object') return '';
                  var rows = [];
                  for (var key in record) {
                    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
                    var cssVar = TOKEN_TO_VAR[key];
                    if (!cssVar) continue;
                    var rgb = hexToRgb(record[key]);
                    if (!rgb) continue;
                    rows.push('  ' + cssVar + ': ' + rgb + ';');
                    if (key === 'accent') {
                      rows.push('  --primary: ' + rgb + ';');
                    }
                    if (key === 'accentStrong') {
                      rows.push('  --primary-strong: ' + rgb + ';');
                    }
                  }
                  if (!rows.length) return '';
                  var selector = mode === 'dark' ? 'html.dark' : 'html.light';
                  return selector + ' {\\n' + rows.join('\\n') + '\\n}';
                };
                var overridesRaw = localStorage.getItem('theme-overrides');
                if (overridesRaw) {
                  try {
                    var overrides = JSON.parse(overridesRaw) || {};
                    var cssLight = buildOverrideCss('light', overrides.light);
                    var cssDark = buildOverrideCss('dark', overrides.dark);
                    var cssText = [cssLight, cssDark].filter(Boolean).join('\\n');
                    if (cssText) {
                      var styleEl = document.getElementById('theme-overrides-style');
                      if (!styleEl) {
                        styleEl = document.createElement('style');
                        styleEl.id = 'theme-overrides-style';
                        document.head.appendChild(styleEl);
                      }
                      styleEl.textContent = cssText;
                    }
                  } catch (err) {
                    console.warn('[theme] preload overrides failed', err);
                  }
                }
              } catch (_) {}
            })();
          `,
          type: 'text/javascript'
        }
      ],
      __dangerouslyDisableSanitizersByTagID: {
        'theme-init': ['innerHTML']
      }
    }
  }
});
