module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {
    '^\\./web/router\\.js$': '<rootDir>/src/web/router.ts',
    '^\\./routes/(.*)\\.js$': '<rootDir>/src/web/routes/$1.ts',
    '^\\./pageImagesConfig\\.js$': '<rootDir>/src/web/pageImagesConfig.ts',
    '^\\.\\./pageImagesConfig\\.js$': '<rootDir>/src/web/pageImagesConfig.ts',
    '^\\.\\./utils/preview\\.js$': '<rootDir>/src/web/utils/preview.ts'
  }
};
