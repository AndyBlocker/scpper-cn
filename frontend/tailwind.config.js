/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[class~="dark"]'],
  content: [
    './components/**/*.{vue,js,ts}',
    './layouts/**/*.{vue,js,ts}',
    './pages/**/*.{vue,js,ts}',
    './plugins/**/*.{js,ts}',
    './app.vue',
    './nuxt.config.ts'
  ],
  theme: {
    extend: {
      colors: {
        // CSS variable driven colors
        'accent': 'rgb(var(--accent) / <alpha-value>)',
        'accent-strong': 'rgb(var(--accent-strong) / <alpha-value>)',
        'accent-weak': 'rgb(var(--accent-weak) / <alpha-value>)',
        'primary': 'rgb(var(--primary) / <alpha-value>)',
        'danger': 'rgb(var(--danger) / <alpha-value>)',
        'danger-strong': 'rgb(var(--danger-strong) / <alpha-value>)',
        neutral: {
          950: '#0a0a0b'
        }
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    }
  },
  plugins: [
    require('@tailwindcss/typography')
  ]
}

