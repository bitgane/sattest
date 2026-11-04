package examples;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.junit.jupiter.api.Assertions.*;

class CalculatorTest {

    private Calculator calculator;

    @BeforeEach
    void setUp() {
        calculator = new Calculator();
    }

    @Test
    void shouldAddTwoNumbers() {
        assertEquals(5, calculator.add(2, 3));
    }

    @Test
    void shouldSubtractTwoNumbers() {
        assertEquals(1, calculator.subtract(3, 2));
    }

    @Test
    void shouldMultiplyTwoNumbers() {
        assertEquals(12, calculator.multiply(3, 4));
    }

    @Test
    void shouldDivide() {
        assertEquals(2.5, calculator.divide(5, 2));
    }

    @Test
    void shouldThrowOnDivideByZero() {
        assertThrows(ArithmeticException.class, () -> calculator.divide(1, 0));
    }

    @ParameterizedTest
    @CsvSource({"2, true", "3, false", "0, true", "-4, true"})
    void shouldCheckIsEven(int number, boolean expected) {
        assertEquals(expected, calculator.isEven(number));
    }

    @Test
    void shouldCalculateFactorial() {
        assertEquals(120, calculator.factorial(5));
    }

    @Test
    void shouldReturnOneForFactorialOfZero() {
        assertEquals(1, calculator.factorial(0));
    }

    @Test
    void shouldThrowOnNegativeFactorial() {
        assertThrows(IllegalArgumentException.class, () -> calculator.factorial(-1));
    }
}
