import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default tseslint.config(
  // Ignore generated/build artifacts
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    ignores: ['.nuxt/**', '.nuxt-dev/**', '.output/**', '.output-dev/**', 'node_modules/**', 'dist/**'],
  },

  // Plain TS/JS files first
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parser: tseslint.parser,
    },
  },

  // Recommended JS rules
  js.configs.recommended,

  // TypeScript rules
  ...tseslint.configs.recommended,
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
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/html-closing-bracket-spacing': 'off',
      'vue/html-indent': 'off',
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
      'vue/require-default-prop': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'no-undef': 'off',
      '@typescript-eslint/unified-signatures': 'off',
    },
  }
)
