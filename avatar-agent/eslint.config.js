import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const tsParserModule = require(path.resolve(currentDir, '../backend/node_modules/@typescript-eslint/parser/dist/index.js'))
const tsPluginModule = require(path.resolve(currentDir, '../backend/node_modules/@typescript-eslint/eslint-plugin/dist/index.js'))
const tsParser = tsParserModule.default ?? tsParserModule
const tsPlugin = tsPluginModule.default ?? tsPluginModule

export default [
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    ignores: [
      'dist/**',
      'node_modules/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
]
