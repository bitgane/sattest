import * as crypto from 'crypto';

/**
 * Escapes a string for safe embedding in HTML content.
 * Prevents XSS by neutralising characters that have special meaning in HTML.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generates a cryptographically-random nonce for use in Content-Security-Policy
 * script-src directives.
 */
export function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}
