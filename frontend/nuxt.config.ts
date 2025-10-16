// https://nuxt.com/docs/api/configuration/nuxt-config
const command = process.env.NUXT_COMMAND || process.env.npm_lifecycle_event || '';
const isDevCommand = command === 'dev';
// Keep dev server artifacts out of the production output directories.
const buildDir = isDevCommand ? '.nuxt-dev' : '.nuxt';
const outputDir = isDevCommand ? '.output-dev' : '.output';

export default defineNuxtConfig({
  srcDir: '.',
  buildDir,
  compatibilityDate: '2025-08-23',
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
      bffBase: process.env.BFF_BASE || '/api'
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
