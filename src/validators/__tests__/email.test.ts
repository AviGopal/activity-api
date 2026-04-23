/**
 * Test suite for email validation functions
 */
import { 
  validateEmail, 
  validateEmailStrict, 
  validateEmailComprehensive, 
  validateEmails 
} from '../email';

describe('Email Validation', () => {
  describe('validateEmail (basic)', () => {
    it('should validate basic email addresses', () => {
      expect(validateEmail('user@example.com')).toBe(true);
      expect(validateEmail('john.doe@company.co.uk')).toBe(true);
      expect(validateEmail('admin@domain.org')).toBe(true);
    });

    it('should reject invalid email addresses', () => {
      expect(validateEmail('invalid.email')).toBe(false);
      expect(validateEmail('user@')).toBe(false);
      expect(validateEmail('@example.com')).toBe(false);
      expect(validateEmail('user@domain')).toBe(false);
      expect(validateEmail('user name@example.com')).toBe(false);
    });

    it('should reject emails with invalid characters', () => {
      expect(validateEmail('user@@example.com')).toBe(false);
      expect(validateEmail('user@exam ple.com')).toBe(false);
    });

    it('should reject emails without TLD', () => {
      expect(validateEmail('user@localhost')).toBe(false);
      expect(validateEmail('user@domain.c')).toBe(false);
    });
  });

  describe('validateEmailStrict (stricter validation)', () => {
    it('should validate standard email addresses', () => {
      expect(validateEmailStrict('user@example.com')).toBe(true);
      expect(validateEmailStrict('john.doe@company.co.uk')).toBe(true);
      expect(validateEmailStrict('admin-user@domain.org')).toBe(true);
    });

    it('should reject invalid formats', () => {
      expect(validateEmailStrict('user@domain')).toBe(false);
      expect(validateEmailStrict('user@.com')).toBe(false);
      expect(validateEmailStrict('.user@domain.com')).toBe(false);
    });

    it('should allow numbers and dots in local part', () => {
      expect(validateEmailStrict('user123@example.com')).toBe(true);
      expect(validateEmailStrict('first.last@example.com')).toBe(true);
    });
  });

  describe('validateEmailComprehensive (RFC 5322 compliant)', () => {
    it('should validate complex email addresses', () => {
      expect(validateEmailComprehensive('user@example.com')).toBe(true);
      expect(validateEmailComprehensive('user+tag@example.com')).toBe(true);
      expect(validateEmailComprehensive('user_name@example.com')).toBe(true);
      expect(validateEmailComprehensive('user.name+tag@example.co.uk')).toBe(true);
    });

    it('should accept special characters in local part', () => {
      expect(validateEmailComprehensive('user+test@example.com')).toBe(true);
      expect(validateEmailComprehensive('user_123@example.com')).toBe(true);
      expect(validateEmailComprehensive('first.last@example.com')).toBe(true);
    });

    it('should reject invalid formats', () => {
      expect(validateEmailComprehensive('user@domain')).toBe(false);
      expect(validateEmailComprehensive('user name@example.com')).toBe(false);
      expect(validateEmailComprehensive('@example.com')).toBe(false);
    });
  });

  describe('validateEmails (batch validation)', () => {
    it('should separate valid and invalid emails', () => {
      const emails = [
        'valid@example.com',
        'invalid.email',
        'user@domain.co.uk',
        'no-at-sign.com',
        'test@test.org'
      ];

      const result = validateEmails(emails);

      expect(result.valid).toEqual([
        'valid@example.com',
        'user@domain.co.uk',
        'test@test.org'
      ]);
      expect(result.invalid).toEqual([
        'invalid.email',
        'no-at-sign.com'
      ]);
    });

    it('should handle empty arrays', () => {
      const result = validateEmails([]);
      expect(result.valid).toEqual([]);
      expect(result.invalid).toEqual([]);
    });

    it('should handle all valid emails', () => {
      const emails = ['user1@example.com', 'user2@example.com'];
      const result = validateEmails(emails);
      expect(result.valid).toHaveLength(2);
      expect(result.invalid).toHaveLength(0);
    });

    it('should handle all invalid emails', () => {
      const emails = ['invalid1', 'invalid2'];
      const result = validateEmails(emails);
      expect(result.valid).toHaveLength(0);
      expect(result.invalid).toHaveLength(2);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty strings', () => {
      expect(validateEmail('')).toBe(false);
      expect(validateEmailStrict('')).toBe(false);
      expect(validateEmailComprehensive('')).toBe(false);
    });

    it('should handle whitespace-only strings', () => {
      expect(validateEmail('   ')).toBe(false);
      expect(validateEmailStrict('   ')).toBe(false);
      expect(validateEmailComprehensive('   ')).toBe(false);
    });

    it('should handle very long email addresses', () => {
      const longLocal = 'a'.repeat(64) + '@example.com';
      expect(validateEmail(longLocal)).toBe(true);
    });

    it('should be case-insensitive for validation purposes', () => {
      expect(validateEmail('User@Example.Com')).toBe(true);
      expect(validateEmail('USER@EXAMPLE.COM')).toBe(true);
    });
  });
});
