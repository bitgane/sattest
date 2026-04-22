import { escapeHtml, getNonce } from './html.js';

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes less-than signs', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes greater-than signs', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes all special characters together', () => {
    expect(escapeHtml(`<a href="x" class='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;'
    );
  });

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('returns string with no special chars unchanged', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });
});

describe('getNonce', () => {
  it('returns a base64 string', () => {
    const nonce = getNonce();
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBeGreaterThan(0);
    // Base64 pattern
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('returns unique values on successive calls', () => {
    const a = getNonce();
    const b = getNonce();
    expect(a).not.toBe(b);
  });

  it('returns 24-character base64 (16 bytes)', () => {
    const nonce = getNonce();
    // 16 bytes -> 24 base64 chars (with possible padding)
    expect(nonce.length).toBeLessThanOrEqual(24);
    expect(nonce.length).toBeGreaterThanOrEqual(22);
  });
});
