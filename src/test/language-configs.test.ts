import {
  LANGUAGE_CONFIGS,
  SUPPORTED_LANGUAGE_IDS,
  ALL_FILE_GLOBS,
  getConfigForExtension,
  findTestsInContent,
} from './language-configs.js';

describe('language-configs', () => {
  // ── Lookup helpers ──────────────────────────────────────────────────

  describe('getConfigForExtension', () => {
    it('returns config for known extensions', () => {
      expect(getConfigForExtension('ts')?.name).toBe('JavaScript/TypeScript');
      expect(getConfigForExtension('java')?.name).toBe('Java');
      expect(getConfigForExtension('py')?.name).toBe('Python');
      expect(getConfigForExtension('go')?.name).toBe('Go');
      expect(getConfigForExtension('rs')?.name).toBe('Rust');
      expect(getConfigForExtension('cs')?.name).toBe('C#');
      expect(getConfigForExtension('rb')?.name).toBe('Ruby');
      expect(getConfigForExtension('php')?.name).toBe('PHP');
      expect(getConfigForExtension('kt')?.name).toBe('Kotlin');
      expect(getConfigForExtension('swift')?.name).toBe('Swift');
      expect(getConfigForExtension('scala')?.name).toBe('Scala');
      expect(getConfigForExtension('cpp')?.name).toBe('C/C++');
    });

    it('returns undefined for unknown extensions', () => {
      expect(getConfigForExtension('txt')).toBeUndefined();
      expect(getConfigForExtension('md')).toBeUndefined();
    });

    it('is case-insensitive', () => {
      expect(getConfigForExtension('TS')?.name).toBe('JavaScript/TypeScript');
      expect(getConfigForExtension('JAVA')?.name).toBe('Java');
      expect(getConfigForExtension('Py')?.name).toBe('Python');
    });
  });

  describe('SUPPORTED_LANGUAGE_IDS', () => {
    it('includes core language IDs', () => {
      expect(SUPPORTED_LANGUAGE_IDS).toContain('typescript');
      expect(SUPPORTED_LANGUAGE_IDS).toContain('javascript');
      expect(SUPPORTED_LANGUAGE_IDS).toContain('java');
      expect(SUPPORTED_LANGUAGE_IDS).toContain('python');
      expect(SUPPORTED_LANGUAGE_IDS).toContain('go');
      expect(SUPPORTED_LANGUAGE_IDS).toContain('rust');
    });

    it('has no duplicates', () => {
      const unique = new Set(SUPPORTED_LANGUAGE_IDS);
      expect(unique.size).toBe(SUPPORTED_LANGUAGE_IDS.length);
    });
  });

  describe('ALL_FILE_GLOBS', () => {
    it('contains globs from all configs', () => {
      expect(ALL_FILE_GLOBS.length).toBeGreaterThan(0);
      // Spot-check a few
      expect(ALL_FILE_GLOBS).toContain('**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}');
      expect(ALL_FILE_GLOBS).toContain('**/*Test.java');
      expect(ALL_FILE_GLOBS).toContain('**/*_test.go');
    });
  });

  // ── JavaScript / TypeScript ─────────────────────────────────────────

  describe('findTestsInContent – JavaScript/TypeScript', () => {
    it('finds it/test/describe calls', () => {
      const content = `
describe('my suite', () => {
  it('should do something', () => {});
  test('another test', () => {});
});`;
      const matches = findTestsInContent(content, '/app/foo.test.ts');
      expect(matches).toHaveLength(3);
      expect(matches.map((m) => m.name)).toEqual([
        'my suite',
        'should do something',
        'another test',
      ]);
    });

    it('handles .only, .skip, .each modifiers', () => {
      const content = `
it.only('focused test', () => {});
test.skip('skipped test', () => {});
describe.each([1, 2])('suite %i', () => {});`;
      const matches = findTestsInContent(content, '/app/bar.spec.js');
      expect(matches).toHaveLength(3);
      expect(matches.map((m) => m.name)).toEqual(['focused test', 'skipped test', 'suite %i']);
    });

    it('handles backtick quotes', () => {
      const content = 'test(`template literal name`, () => {});';
      const matches = findTestsInContent(content, '/x.test.ts');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('template literal name');
    });

    it('returns empty for non-test content', () => {
      const content = 'const x = 1;\nfunction foo() {}';
      expect(findTestsInContent(content, '/x.test.ts')).toHaveLength(0);
    });
  });

  // ── Java ────────────────────────────────────────────────────────────

  describe('findTestsInContent – Java', () => {
    it('finds @Test annotated methods', () => {
      const content = `
import org.junit.jupiter.api.Test;

public class UserTest {
    @Test
    void shouldCreateUser() {
        // ...
    }

    @Test
    public void shouldDeleteUser() {
        // ...
    }
}`;
      const matches = findTestsInContent(content, '/src/test/UserTest.java');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.name)).toEqual(['shouldCreateUser', 'shouldDeleteUser']);
    });

    it('finds @ParameterizedTest and @RepeatedTest', () => {
      const content = `
    @ParameterizedTest
    @ValueSource(ints = {1, 2, 3})
    void testWithParams(int value) {}

    @RepeatedTest(3)
    void repeatedTest() {}
`;
      const matches = findTestsInContent(content, '/src/test/ParamTest.java');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.name)).toEqual(['testWithParams', 'repeatedTest']);
    });

    it('handles multiple annotations between @Test and method', () => {
      const content = `
    @Test
    @DisplayName("User creation test")
    @Timeout(5)
    void shouldCreateUser() {}
`;
      const matches = findTestsInContent(content, '/FooTest.java');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('shouldCreateUser');
    });

    it('handles JUnit 4 public void style', () => {
      const content = `
    @Test
    public void testOldStyle() {
        assertEquals(1, 1);
    }
`;
      const matches = findTestsInContent(content, '/OldTest.java');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('testOldStyle');
    });
  });

  // ── Python ──────────────────────────────────────────────────────────

  describe('findTestsInContent – Python', () => {
    it('finds test functions', () => {
      const content = `
def test_addition():
    assert 1 + 1 == 2

def test_subtraction():
    assert 2 - 1 == 1
`;
      const matches = findTestsInContent(content, '/tests/test_math.py');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.name)).toEqual(['test_addition', 'test_subtraction']);
    });

    it('finds async test functions', () => {
      const content = `
async def test_async_fetch():
    result = await fetch_data()
    assert result is not None
`;
      const matches = findTestsInContent(content, '/tests/test_async.py');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('test_async_fetch');
    });

    it('finds test classes', () => {
      const content = `
class TestCalculator:
    def test_add(self):
        pass

class TestStringUtils(unittest.TestCase):
    def test_upper(self):
        pass
`;
      const matches = findTestsInContent(content, '/tests/test_calc.py');
      // 2 classes + 2 test methods
      expect(matches).toHaveLength(4);
      expect(matches.map((m) => m.name)).toContain('TestCalculator');
      expect(matches.map((m) => m.name)).toContain('test_add');
    });

    it('ignores non-test functions', () => {
      const content = `
def helper_function():
    pass

def setup():
    pass
`;
      expect(findTestsInContent(content, '/tests/test_helpers.py')).toHaveLength(0);
    });
  });

  // ── Go ──────────────────────────────────────────────────────────────

  describe('findTestsInContent – Go', () => {
    it('finds Test and Benchmark functions', () => {
      const content = `
func TestAdd(t *testing.T) {
    if Add(1, 2) != 3 {
        t.Fatal("expected 3")
    }
}

func BenchmarkAdd(b *testing.B) {
    for i := 0; i < b.N; i++ {
        Add(1, 2)
    }
}

func ExampleAdd() {
    fmt.Println(Add(1, 2))
    // Output: 3
}
`;
      const matches = findTestsInContent(content, '/pkg/math_test.go');
      expect(matches).toHaveLength(3);
      expect(matches.map((m) => m.name)).toEqual(['TestAdd', 'BenchmarkAdd', 'ExampleAdd']);
    });

    it('ignores helper functions', () => {
      const content = `
func setupTest(t *testing.T) *Server {
    return nil
}
`;
      expect(findTestsInContent(content, '/pkg/helper_test.go')).toHaveLength(0);
    });
  });

  // ── Rust ────────────────────────────────────────────────────────────

  describe('findTestsInContent – Rust', () => {
    it('finds #[test] functions', () => {
      const content = `
#[cfg(test)]
mod tests {
    #[test]
    fn test_addition() {
        assert_eq!(1 + 1, 2);
    }

    #[test]
    fn test_subtraction() {
        assert_eq!(2 - 1, 1);
    }
}
`;
      const matches = findTestsInContent(content, '/src/lib.rs');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.name)).toEqual(['test_addition', 'test_subtraction']);
    });

    it('finds async test functions with tokio::test', () => {
      const content = `
    #[tokio::test]
    async fn test_async_operation() {
        let result = fetch().await;
        assert!(result.is_ok());
    }
`;
      const matches = findTestsInContent(content, '/src/api.rs');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('test_async_operation');
    });
  });

  // ── C# ──────────────────────────────────────────────────────────────

  describe('findTestsInContent – C#', () => {
    it('finds xUnit [Fact] and [Theory] tests', () => {
      const content = `
public class CalculatorTests
{
    [Fact]
    public void Add_ShouldReturnSum()
    {
        Assert.Equal(3, Calculator.Add(1, 2));
    }

    [Theory]
    [InlineData(1, 2, 3)]
    public void Add_WithParams(int a, int b, int expected)
    {
        Assert.Equal(expected, Calculator.Add(a, b));
    }
}
`;
      const matches = findTestsInContent(content, '/Tests/CalculatorTests.cs');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.name)).toEqual(['Add_ShouldReturnSum', 'Add_WithParams']);
    });

    it('finds NUnit [Test] and MSTest [TestMethod]', () => {
      const content = `
    [Test]
    public void ShouldWork() {}

    [TestMethod]
    public void TestMethod1() {}

    [TestCase(1)]
    public void WithCase(int x) {}
`;
      const matches = findTestsInContent(content, '/Tests/MixedTest.cs');
      expect(matches).toHaveLength(3);
    });
  });

  // ── Ruby ────────────────────────────────────────────────────────────

  describe('findTestsInContent – Ruby', () => {
    it('finds minitest methods', () => {
      const content = `
class TestCalculator < Minitest::Test
  def test_addition
    assert_equal 3, Calculator.add(1, 2)
  end

  def test_subtraction
    assert_equal 1, Calculator.sub(2, 1)
  end
end
`;
      const matches = findTestsInContent(content, '/test/test_calculator.rb');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.name)).toEqual(['test_addition', 'test_subtraction']);
    });

    it('finds RSpec it/describe/context blocks', () => {
      const content = `
describe 'Calculator' do
  context 'addition' do
    it 'adds two numbers' do
      expect(Calculator.add(1, 2)).to eq(3)
    end
  end
end
`;
      const matches = findTestsInContent(content, '/spec/calculator_spec.rb');
      expect(matches).toHaveLength(3);
      expect(matches.map((m) => m.name)).toEqual(['Calculator', 'addition', 'adds two numbers']);
    });
  });

  // ── PHP ─────────────────────────────────────────────────────────────

  describe('findTestsInContent – PHP', () => {
    it('finds PHPUnit test methods', () => {
      const content = `
class UserTest extends TestCase
{
    public function testCreateUser()
    {
        $this->assertTrue(true);
    }

    public function testDeleteUser()
    {
        $this->assertFalse(false);
    }
}
`;
      const matches = findTestsInContent(content, '/tests/UserTest.php');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.name)).toEqual(['testCreateUser', 'testDeleteUser']);
    });

    it('finds Pest-style tests', () => {
      const content = `
test('it creates a user', function () {
    expect(true)->toBeTrue();
});

it('deletes a user', function () {
    expect(true)->toBeTrue();
});
`;
      const matches = findTestsInContent(content, '/tests/UserTest.php');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.name)).toEqual(['it creates a user', 'deletes a user']);
    });
  });

  // ── Kotlin ──────────────────────────────────────────────────────────

  describe('findTestsInContent – Kotlin', () => {
    it('finds @Test annotated functions', () => {
      const content = `
class UserTest {
    @Test
    fun shouldCreateUser() {
        assertEquals(1, 1)
    }
}
`;
      const matches = findTestsInContent(content, '/src/test/UserTest.kt');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('shouldCreateUser');
    });

    it('finds backtick function names', () => {
      const content = `
    @Test
    fun \`should handle edge cases correctly\`() {
        assertTrue(true)
    }
`;
      const matches = findTestsInContent(content, '/src/test/EdgeTest.kt');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('should handle edge cases correctly');
    });
  });

  // ── Swift ───────────────────────────────────────────────────────────

  describe('findTestsInContent – Swift', () => {
    it('finds XCTest methods', () => {
      const content = `
class CalculatorTests: XCTestCase {
    func testAddition() {
        XCTAssertEqual(1 + 1, 2)
    }

    func testSubtraction() {
        XCTAssertEqual(2 - 1, 1)
    }

    func helperMethod() {
        // not a test
    }
}
`;
      const matches = findTestsInContent(content, '/Tests/CalculatorTests.swift');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.name)).toEqual(['testAddition', 'testSubtraction']);
    });
  });

  // ── Scala ───────────────────────────────────────────────────────────

  describe('findTestsInContent – Scala', () => {
    it('finds ScalaTest it/test blocks', () => {
      const content = `
class CalculatorSpec extends AnyFunSpec {
  it("should add numbers") {
    assert(1 + 1 === 2)
  }

  test("should subtract") {
    assert(2 - 1 === 1)
  }
}
`;
      const matches = findTestsInContent(content, '/test/CalculatorSpec.scala');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.name)).toEqual(['should add numbers', 'should subtract']);
    });

    it('finds WordSpec style', () => {
      const content = `
  "A Calculator" should "add" in {
    assert(1 + 1 === 2)
  }
`;
      const matches = findTestsInContent(content, '/test/CalcTest.scala');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('A Calculator');
    });
  });

  // ── C / C++ ─────────────────────────────────────────────────────────

  describe('findTestsInContent – C/C++', () => {
    it('finds Google Test macros', () => {
      const content = `
TEST(MathTest, Addition) {
    EXPECT_EQ(1 + 1, 2);
}

TEST_F(MathFixture, Subtraction) {
    EXPECT_EQ(2 - 1, 1);
}

TEST_P(ParamTest, Check) {
    EXPECT_TRUE(GetParam());
}
`;
      const matches = findTestsInContent(content, '/test/math_test.cpp');
      expect(matches).toHaveLength(3);
      expect(matches.map((m) => m.name)).toEqual(['Addition', 'Subtraction', 'Check']);
    });

    it('finds Catch2 TEST_CASE', () => {
      const content = `
TEST_CASE("Vectors can be sized and resized", "[vector]") {
    std::vector<int> v(5);
    REQUIRE(v.size() == 5);
}
`;
      const matches = findTestsInContent(content, '/test/vec_test.cpp');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('Vectors can be sized and resized');
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('findTestsInContent – edge cases', () => {
    it('returns empty for unknown file extension', () => {
      expect(findTestsInContent('test("foo", () => {})', '/x.unknown')).toHaveLength(0);
    });

    it('returns empty for empty content', () => {
      expect(findTestsInContent('', '/x.test.ts')).toHaveLength(0);
    });

    it('tracks correct line numbers', () => {
      const content = `// line 0
// line 1
it('on line 2', () => {});
// line 3
test('on line 4', () => {});`;
      const matches = findTestsInContent(content, '/x.test.ts');
      expect(matches[0].lineNumber).toBe(2);
      expect(matches[1].lineNumber).toBe(4);
    });
  });
});
