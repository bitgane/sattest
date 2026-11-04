/**
 * Multi-language test discovery configuration.
 *
 * Each config defines how to find test files and extract test declarations
 * for a given language family.  Two pattern kinds are supported:
 *
 *  - **line**  – regex is applied to each line independently.
 *  - **annotation** – an annotation line is detected first, then the next
 *    method/function declaration within `lookahead` lines supplies the name.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinePattern {
  kind: 'line';
  /** Global-flagged regex. Capture group `nameGroup` holds the test name. */
  regex: RegExp;
  nameGroup: number;
}

export interface AnnotationPattern {
  kind: 'annotation';
  /** Regex (no /g) to detect an annotation/attribute line. */
  annotationRegex: RegExp;
  /** Regex (no /g) to match the method/function declaration after the annotation. */
  methodRegex: RegExp;
  /** Capture group index in `methodRegex` that holds the test name. */
  nameGroup: number;
  /** Max lines to look ahead from the annotation to find the method (default 5). */
  lookahead?: number;
}

export type TestPattern = LinePattern | AnnotationPattern;

export interface LanguageTestConfig {
  name: string;
  /** File extensions (without dot) handled by this config. */
  extensions: string[];
  /** VS Code language identifiers (used for CodeLens, activation events). */
  languageIds: string[];
  /** Glob patterns passed to `workspace.findFiles`. */
  fileGlobs: string[];
  /** One or more patterns for extracting test names from file content. */
  patterns: TestPattern[];
}

// ---------------------------------------------------------------------------
// Language configurations
// ---------------------------------------------------------------------------

export const LANGUAGE_CONFIGS: LanguageTestConfig[] = [
  // ── JavaScript / TypeScript (Jest, Mocha, Vitest, Jasmine, node:test) ──
  {
    name: 'JavaScript/TypeScript',
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
    languageIds: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    fileGlobs: ['**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}'],
    patterns: [
      {
        kind: 'line',
        regex:
          /(?:it|test|describe)(?:\.(?:only|skip|concurrent|todo)|\.each\s*\([^)]*\))?\s*\(\s*['"`]([^'"`]+)['"`]/g,
        nameGroup: 1,
      },
    ],
  },

  // ── Java (JUnit 4 / 5, TestNG) ────────────────────────────────────────
  {
    name: 'Java',
    extensions: ['java'],
    languageIds: ['java'],
    fileGlobs: ['**/*Test.java', '**/*Tests.java', '**/Test*.java', '**/*IT.java'],
    patterns: [
      {
        kind: 'annotation',
        annotationRegex: /@(?:Test|ParameterizedTest|RepeatedTest)\b/,
        methodRegex:
          /(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:void|[\w<>\[\],.?\s]+?)\s+(\w+)\s*\(/,
        nameGroup: 1,
        lookahead: 10,
      },
    ],
  },

  // ── Python (pytest, unittest) ──────────────────────────────────────────
  {
    name: 'Python',
    extensions: ['py'],
    languageIds: ['python'],
    fileGlobs: ['**/test_*.py', '**/*_test.py'],
    patterns: [
      {
        kind: 'line',
        regex: /(?:async\s+)?def\s+(test_\w+)\s*\(/g,
        nameGroup: 1,
      },
      {
        kind: 'line',
        regex: /class\s+(Test\w+)\s*[:(]/g,
        nameGroup: 1,
      },
    ],
  },

  // ── Go (testing) ──────────────────────────────────────────────────────
  {
    name: 'Go',
    extensions: ['go'],
    languageIds: ['go'],
    fileGlobs: ['**/*_test.go'],
    patterns: [
      {
        kind: 'line',
        regex: /func\s+(Test\w+|Benchmark\w+|Example\w+)\s*\(/g,
        nameGroup: 1,
      },
    ],
  },

  // ── Rust ──────────────────────────────────────────────────────────────
  {
    name: 'Rust',
    extensions: ['rs'],
    languageIds: ['rust'],
    fileGlobs: ['**/tests/**/*.rs', '**/src/**/*.rs'],
    patterns: [
      {
        kind: 'annotation',
        annotationRegex: /#\[(?:test|tokio::test|async_std::test)\]/,
        methodRegex: /(?:async\s+)?fn\s+(\w+)\s*\(/,
        nameGroup: 1,
        lookahead: 3,
      },
    ],
  },

  // ── C# (xUnit, NUnit, MSTest) ─────────────────────────────────────────
  {
    name: 'C#',
    extensions: ['cs'],
    languageIds: ['csharp'],
    fileGlobs: ['**/*Test.cs', '**/*Tests.cs', '**/*Spec.cs'],
    patterns: [
      {
        kind: 'annotation',
        annotationRegex: /\[(?:Fact|Theory|Test|TestCase|TestMethod)\b/,
        methodRegex:
          /(?:public|private|protected|internal)?\s*(?:async\s+)?(?:Task\s+|void\s+|[\w<>\[\],.?\s]+?\s+)(\w+)\s*\(/,
        nameGroup: 1,
        lookahead: 5,
      },
    ],
  },

  // ── Ruby (minitest, RSpec) ─────────────────────────────────────────────
  {
    name: 'Ruby',
    extensions: ['rb'],
    languageIds: ['ruby'],
    fileGlobs: ['**/*_test.rb', '**/*_spec.rb', '**/test_*.rb'],
    patterns: [
      {
        kind: 'line',
        regex: /def\s+(test_\w+)/g,
        nameGroup: 1,
      },
      {
        kind: 'line',
        regex: /(?:it|describe|context)\s+['"]([^'"]+)['"]/g,
        nameGroup: 1,
      },
    ],
  },

  // ── PHP (PHPUnit, Pest) ────────────────────────────────────────────────
  {
    name: 'PHP',
    extensions: ['php'],
    languageIds: ['php'],
    fileGlobs: ['**/*Test.php'],
    patterns: [
      {
        kind: 'line',
        regex: /(?:public\s+)?function\s+(test\w+)\s*\(/g,
        nameGroup: 1,
      },
      // Pest-style
      {
        kind: 'line',
        regex: /(?:it|test)\s*\(\s*['"]([^'"]+)['"]/g,
        nameGroup: 1,
      },
    ],
  },

  // ── Kotlin (JUnit) ────────────────────────────────────────────────────
  {
    name: 'Kotlin',
    extensions: ['kt', 'kts'],
    languageIds: ['kotlin'],
    fileGlobs: ['**/*Test.kt', '**/*Tests.kt', '**/*Spec.kt'],
    patterns: [
      // Regular function names
      {
        kind: 'annotation',
        annotationRegex: /@(?:Test|ParameterizedTest|RepeatedTest)\b/,
        methodRegex: /(?:suspend\s+)?fun\s+(\w+)\s*\(/,
        nameGroup: 1,
        lookahead: 5,
      },
      // Backtick function names (Kotlin convention)
      {
        kind: 'annotation',
        annotationRegex: /@(?:Test|ParameterizedTest|RepeatedTest)\b/,
        methodRegex: /(?:suspend\s+)?fun\s+`([^`]+)`\s*\(/,
        nameGroup: 1,
        lookahead: 5,
      },
    ],
  },

  // ── Swift (XCTest) ────────────────────────────────────────────────────
  {
    name: 'Swift',
    extensions: ['swift'],
    languageIds: ['swift'],
    fileGlobs: ['**/*Tests.swift', '**/*Test.swift'],
    patterns: [
      {
        kind: 'line',
        regex: /(?:override\s+)?func\s+(test\w+)\s*\(\s*\)/g,
        nameGroup: 1,
      },
    ],
  },

  // ── Scala (ScalaTest, specs2) ──────────────────────────────────────────
  {
    name: 'Scala',
    extensions: ['scala'],
    languageIds: ['scala'],
    fileGlobs: ['**/*Test.scala', '**/*Spec.scala', '**/*Suite.scala'],
    patterns: [
      {
        kind: 'line',
        regex: /(?:it|test)\s*\(\s*"([^"]+)"/g,
        nameGroup: 1,
      },
      {
        kind: 'line',
        regex: /"([^"]+)"\s+(?:should|must|can)\b/g,
        nameGroup: 1,
      },
    ],
  },

  // ── C / C++ (Google Test, Catch2, CppUnit) ────────────────────────────
  {
    name: 'C/C++',
    extensions: ['cpp', 'cc', 'cxx', 'c', 'hpp'],
    languageIds: ['cpp', 'c'],
    fileGlobs: ['**/*_test.cpp', '**/*_test.cc', '**/test_*.cpp', '**/*_test.c', '**/test_*.c'],
    patterns: [
      // Google Test: TEST(Suite, Name)  /  TEST_F(Fixture, Name)
      {
        kind: 'line',
        regex: /TEST(?:_F|_P)?\s*\(\s*\w+\s*,\s*(\w+)\s*\)/g,
        nameGroup: 1,
      },
      // Catch2: TEST_CASE("name", "[tags]")
      {
        kind: 'line',
        regex: /TEST_CASE\s*\(\s*"([^"]+)"/g,
        nameGroup: 1,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Map from file extension → config (built once at import time). */
const extensionMap = new Map<string, LanguageTestConfig>();
for (const config of LANGUAGE_CONFIGS) {
  for (const ext of config.extensions) {
    extensionMap.set(ext, config);
  }
}

/** All VS Code language IDs we support (deduplicated). */
export const SUPPORTED_LANGUAGE_IDS: string[] = [
  ...new Set(LANGUAGE_CONFIGS.flatMap((c) => c.languageIds)),
];

/** All file globs across every language (for discovery). */
export const ALL_FILE_GLOBS: string[] = LANGUAGE_CONFIGS.flatMap((c) => c.fileGlobs);

/** Return the config for a given file extension (without dot). */
export function getConfigForExtension(ext: string): LanguageTestConfig | undefined {
  return extensionMap.get(ext.toLowerCase());
}

// ---------------------------------------------------------------------------
// Test extraction
// ---------------------------------------------------------------------------

export interface TestMatch {
  name: string;
  lineNumber: number;
  lineLength: number;
}

/**
 * Find all test declarations in `content` based on the file extension.
 * Returns an empty array if the extension is unrecognised or no tests match.
 */
export function findTestsInContent(content: string, filePath: string): TestMatch[] {
  const ext = filePath.split('.').pop() || '';
  const config = getConfigForExtension(ext);
  if (!config) {
    return [];
  }

  const lines = content.split('\n');
  const matches: TestMatch[] = [];

  for (const pattern of config.patterns) {
    if (pattern.kind === 'line') {
      pattern.regex.lastIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(lines[i])) !== null) {
          const name = match[pattern.nameGroup]?.trim();
          if (name) {
            matches.push({ name, lineNumber: i, lineLength: lines[i].length });
          }
        }
      }
    } else {
      // annotation pattern
      const lookahead = pattern.lookahead ?? 5;
      for (let i = 0; i < lines.length; i++) {
        if (pattern.annotationRegex.test(lines[i])) {
          for (let j = i + 1; j <= Math.min(i + lookahead, lines.length - 1); j++) {
            const methodMatch = pattern.methodRegex.exec(lines[j]);
            if (methodMatch) {
              const name = methodMatch[pattern.nameGroup]?.trim();
              if (name) {
                matches.push({ name, lineNumber: j, lineLength: lines[j].length });
              }
              break;
            }
          }
        }
      }
    }
  }

  return matches;
}
