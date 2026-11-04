module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  moduleNameMapper: {
    // `vscode` is not an installable package (the API is injected by the
    // extension host at runtime), so map it to a real file to make it
    // resolvable in tests. The rich mock is supplied by the explicit
    // `jest.mock('vscode', …)` factory in src/jest.setup.ts, which overrides
    // this file's contents; this entry only anchors module resolution.
    '^vscode$': '<rootDir>/src/__mocks__/vscode.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      diagnostics: { ignoreDiagnostics: [151002] },
    }],
    // nostr-tools' crypto dependencies (@noble/*, @scure/*) ship as ESM only.
    // Transpile them to CommonJS so tests can sign, verify and encrypt for
    // real instead of mocking the protocol away.
    '^.+/node_modules/(@noble|@scure)/.+\\.js$': ['ts-jest', {
      tsconfig: { allowJs: true, module: 'commonjs', target: 'ES2022', esModuleInterop: true },
      diagnostics: false,
    }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@noble|@scure|nostr-tools)/)',
    'node_modules/nostr-tools/node_modules/(?!(@noble|@scure)/)',
  ],
  setupFilesAfterEnv: ['./src/jest.setup.ts'],
};
