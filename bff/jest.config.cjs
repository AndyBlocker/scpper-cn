module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {
    '^\\./web/router\\.js$': '<rootDir>/src/web/router.ts',
    '^\\./web/utils/dbPool\\.js$': '<rootDir>/src/web/utils/dbPool.ts',
    '^\\./web/utils/rateLimit\\.js$': '<rootDir>/src/web/utils/rateLimit.ts',
    '^\\./web/routes/tracking\\.js$': '<rootDir>/src/web/routes/tracking.ts',
    '^\\./routes/(.*)\\.js$': '<rootDir>/src/web/routes/$1.ts',
    '^\\./pageImagesConfig\\.js$': '<rootDir>/src/web/pageImagesConfig.ts',
    '^\\.\\./pageImagesConfig\\.js$': '<rootDir>/src/web/pageImagesConfig.ts',
    '^\\./helpers\\.js$': '<rootDir>/src/web/utils/helpers.ts',
    '^\\.\\./utils/helpers\\.js$': '<rootDir>/src/web/utils/helpers.ts',
    '^\\.\\./utils/embed/(.*)\\.js$': '<rootDir>/src/web/utils/embed/$1.ts',
    '^\\./(htmlWrapper|inlineCss|pageData|sparkline|svgBadge|textMetrics|theme|userData)\\.js$': '<rootDir>/src/web/utils/embed/$1.ts',
    '^\\.\\./userData\\.js$': '<rootDir>/src/web/utils/embed/userData.ts',
    '^\\./utils/dbPool\\.js$': '<rootDir>/src/web/utils/dbPool.ts',
    '^\\./utils/rateLimit\\.js$': '<rootDir>/src/web/utils/rateLimit.ts',
    '^\\.\\./utils/dbPool\\.js$': '<rootDir>/src/web/utils/dbPool.ts',
    '^\\.\\./utils/preview\\.js$': '<rootDir>/src/web/utils/preview.ts',
    '^\\.\\./utils/cache\\.js$': '<rootDir>/src/web/utils/cache.ts',
    '^\\.\\./utils/auth\\.js$': '<rootDir>/src/web/utils/auth.ts',
    '^\\./utils/cache\\.js$': '<rootDir>/src/web/utils/cache.ts',
    '^\\./utils/auth\\.js$': '<rootDir>/src/web/utils/auth.ts'
  }
};
