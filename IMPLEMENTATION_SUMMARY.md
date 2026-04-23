# Email Validation Function Implementation

## Goal
Create a TypeScript function that validates email addresses using regex patterns.

## Solution Overview
Created a comprehensive email validation module with three levels of validation strictness and batch processing capability.

## Files Created

### 1. `src/validators/email.ts`
Main implementation file containing:

#### Functions Provided:

1. **validateEmail(email: string): boolean**
   - Basic email validation using simplified regex
   - Pattern: `/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/`
   - Use case: General-purpose email validation
   - Supports: Basic format with domain and TLD

2. **validateEmailStrict(email: string): boolean**
   - Stricter validation with character restrictions
   - Pattern: `/^[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/`
   - Use case: When you need to enforce specific character sets
   - Supports: Numbers, dots, hyphens, underscores, percent signs

3. **validateEmailComprehensive(email: string): boolean**
   - RFC 5322 simplified compliance
   - Full support for special characters and plus addressing
   - Use case: Maximum compatibility with modern email systems
   - Supports: Plus addressing (user+tag@example.com), most RFC 5322 characters

4. **validateEmails(emails: string[]): { valid: string[]; invalid: string[] }**
   - Batch validation utility
   - Returns object with separated valid/invalid email arrays
   - Use case: Processing multiple emails efficiently

### 2. `src/validators/__tests__/email.test.ts`
Comprehensive test suite with 20+ test cases covering:
- Valid email addresses
- Invalid email addresses
- Edge cases (empty strings, whitespace, very long addresses)
- Special characters and plus addressing
- Batch validation
- Case sensitivity

## Regex Patterns Explained

### Basic Pattern
```regex
^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$
```
- `^` - Start of string
- `[^\s@]+` - One or more non-whitespace, non-@ characters (local part)
- `@` - Literal @ symbol
- `[^\s@]+` - One or more non-whitespace, non-@ characters (domain)
- `\.` - Literal dot
- `[a-zA-Z]{2,}` - At least 2 letters for top-level domain
- `$` - End of string

### Strict Pattern
```regex
^[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$
```
- Restricts characters to: letters, numbers, dots, hyphens, underscores, percent
- More predictable character handling
- Better for validation systems with strict requirements

### Comprehensive Pattern (RFC 5322)
```regex
^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$
```
- Supports plus addressing (gmail style)
- Allows most RFC 5322 special characters
- Handles subdomains properly
- Most permissive option

## Usage Examples

```typescript
import { validateEmail, validateEmails } from './validators/email';

// Single email validation
const isValid = validateEmail('user@example.com'); // true
const isValid2 = validateEmail('invalid.email'); // false

// Batch validation
const result = validateEmails([
  'valid@example.com',
  'invalid.email',
  'user@domain.co.uk'
]);
// result.valid: ['valid@example.com', 'user@domain.co.uk']
// result.invalid: ['invalid.email']

// Plus addressing support
const plusEmail = validateEmailComprehensive('user+tag@example.com'); // true
```

## Testing
Run tests with your test runner:
```bash
npm test -- email.test.ts
jest src/validators/__tests__/email.test.ts
```

## Design Decisions

1. **Three validation levels**: Different use cases require different strictness
2. **TypeScript types**: Fully typed for better IDE support
3. **Pure functions**: No side effects, easy to test and compose
4. **Batch utility**: Common pattern for processing multiple emails
5. **Well-documented**: Comments explain regex patterns and use cases
6. **Comprehensive tests**: 20+ test cases covering edge cases

## Notes

- Email validation via regex has limitations; real validation requires sending a confirmation email
- These functions validate format only, not actual email existence
- Choose the appropriate validation level for your use case
- Consider using a library like `email-validator` for production systems that need actual email verification
