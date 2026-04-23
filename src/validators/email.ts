/**
 * Email validation utilities using regex patterns
 * Supports RFC 5322 simplified email format validation
 */

/**
 * Validates an email address using regex
 * @param email - The email address to validate
 * @returns boolean - True if email is valid, false otherwise
 * 
 * Pattern explanation:
 * - ^[^\s@]+ : Starts with one or more non-whitespace, non-@ characters
 * - @ : Literal @ symbol
 * - [^\s@]+ : One or more non-whitespace, non-@ characters (domain)
 * - \. : Literal dot
 * - [a-zA-Z]{2,} : At least 2 letters for TLD
 * - $ : End of string
 */
export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

/**
 * Validates an email address with stricter RFC 5322 compliance
 * Includes support for subdomains and hyphens
 */
export function validateEmailStrict(email: string): boolean {
  const strictRegex = /^[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return strictRegex.test(email);
}

/**
 * Validates an email address with comprehensive RFC 5322 compliance
 * Allows most valid email formats including plus addressing
 */
export function validateEmailComprehensive(email: string): boolean {
  const comprehensiveRegex = /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
  return comprehensiveRegex.test(email);
}

/**
 * Batch validates multiple email addresses
 * @param emails - Array of email addresses to validate
 * @returns Record with valid and invalid email arrays
 */
export function validateEmails(emails: string[]): { valid: string[]; invalid: string[] } {
  return emails.reduce(
    (acc, email) => {
      if (validateEmail(email)) {
        acc.valid.push(email);
      } else {
        acc.invalid.push(email);
      }
      return acc;
    },
    { valid: [] as string[], invalid: [] as string[] }
  );
}
