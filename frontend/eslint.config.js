// ESLint flat config for Nuxt (Vue 3) + TypeScript
// Follows repo guidelines: ESM, 2 spaces, single quotes
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default tseslint.config(
  // Ignore generated/build artifacts
  { ignores: ['.nuxt/**', '.nuxt-dev/**', '.output/**', '.output-dev/**', 'node_modules/**', 'dist/**'] },

  // Plain TS/JS files first
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: { projectService: true },
    },
  },

  // Recommended JS rules
  js.configs.recommended,

  // TypeScript rules (type-checked)
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // Vue 3 recommended rules
  ...vue.configs['flat/recommended'],

  // Ensure .vue uses vue-eslint-parser last (override any earlier parser)
  {
    files: ['**/*.vue'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        projectService: true,
      },
    },
    plugins: { vue },
  },

  // Project conventions & small overrides
  {
    files: ['**/*.vue'],
    rules: {
      // Workaround: rule crashes on certain TS-in-template types
      '@typescript-eslint/unified-signatures': 'off',
    },
  },

  // Project conventions & small overrides
  {
    rules: {
      // Code style
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'never'],
      indent: ['error', 2, { SwitchCase: 1 }],
      'eol-last': ['error', 'always'],
      'no-trailing-spaces': 'error',

      // Vue specific
      'vue/multi-word-component-names': 'off',
      'vue/script-setup-uses-vars': 'error',
      'vue/html-indent': ['error', 2],
    },
  }
)
