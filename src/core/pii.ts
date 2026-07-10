/**
 * Masking of personal data for logs and staff notifications.
 *
 * - Phone-like sequences (7-15 digits with +, spaces, dashes, or parens) keep the
 *   first 2 and last 2 digits: '+7 776 412 63 53' -> '+7 7•• ••• •• 53'.
 * - Bare digit runs of 9-12 (IIN / passport numbers) are hidden entirely: '••••'.
 * - Emails keep the first character and the domain: 'a***@example.com'.
 * - Dates (2026-08-10), prices (147050 KZT), and booking numbers with letters
 *   pass through untouched.
 */

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

// One digit followed by 6-14 more digits, each optionally preceded by up to two
// space/dash/paren separators (covers '+7 (776) 412 63 53'), optional leading '+'.
const DIGIT_SEQUENCE_RE = /\+?\d(?:[ \-()]{0,2}\d){6,14}/g;

const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/;

export function maskPII(s: string): string {
  const withEmailsMasked = s.replace(EMAIL_RE, (_m, first: string, domain: string) => {
    return `${first}***@${domain}`;
  });

  return withEmailsMasked.replace(DIGIT_SEQUENCE_RE, (match) => {
    if (ISO_DATE_RE.test(match)) return match; // dates are not PII
    const digitCount = match.replace(/\D/g, '').length;
    const isBareRun = /^\d+$/.test(match);
    if (isBareRun) {
      // IIN (12 digits) / passport-like identifiers — hide entirely.
      return digitCount >= 9 && digitCount <= 12 ? '••••' : match;
    }
    if (digitCount < 7 || digitCount > 15) return match;
    // Phone: keep country/first 2 digits and the last 2, preserve formatting.
    let seen = 0;
    return match
      .split('')
      .map((ch) => {
        if (!/\d/.test(ch)) return ch;
        seen++;
        return seen <= 2 || seen > digitCount - 2 ? ch : '•';
      })
      .join('');
  });
}
