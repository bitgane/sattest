module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/__mocks__/vscode.mocks.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      diagnostics: { ignoreDiagnostics: [151002] },
    }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@noble|nostr-tools)/)',
  ],
  setupFilesAfterEnv: ['./src/jest.setup.ts'],
};
