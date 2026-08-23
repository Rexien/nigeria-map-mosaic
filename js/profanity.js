/**
 * Nigeria Mosaic - Profanity & Inappropriate Content Filter
 * 
 * Provides silent detection and sanitization for event submissions.
 */

(function(root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ProfanityFilter = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {

  /**
   * Checks if a word is on the profanity blocklist
   * @param {string} word 
   * @returns {boolean}
   */
  function isProfane(word) {
    if (!word || typeof word !== 'string') return false;

    const cleaned = word.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const blocklist = (window.APP_CONFIG && window.APP_CONFIG.PROFANITY_BLOCKLIST) || [];

    for (let i = 0; i < blocklist.length; i++) {
      const bad = blocklist[i].toLowerCase().trim();
      if (bad && (cleaned === bad || cleaned.includes(bad))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Validates word submission structure
   * - Must be a single word (no whitespace)
   * - Length between 1 and MAX_WORD_LENGTH
   * 
   * @param {string} word 
   * @returns {{ valid: boolean, error: string | null }}
   */
  function validateSubmission(word) {
    if (!word || typeof word !== 'string') {
      return { valid: false, error: 'Please enter a word.' };
    }

    const trimmed = word.trim();
    if (trimmed.length === 0) {
      return { valid: false, error: 'Please enter a word.' };
    }

    // Check for any internal whitespace
    if (/\s/.test(trimmed)) {
      return { valid: false, error: 'Please enter only one single word with no spaces.' };
    }

    // Check for camelCase bypass (capital letters after the first character)
    if (/[A-Z]/.test(trimmed.slice(1))) {
      return { valid: false, error: 'Please enter only one single word (no camelCase like "TwoWords").' };
    }

    const maxLen = (window.APP_CONFIG && window.APP_CONFIG.MAX_WORD_LENGTH) || 20;
    if (trimmed.length > maxLen) {
      return { valid: false, error: `Word is too long (maximum ${maxLen} characters).` };
    }

    // Check for weird symbols only
    if (/^[^a-zA-Z0-9]+$/.test(trimmed)) {
      return { valid: false, error: 'Please enter a valid word with letters.' };
    }

    return { valid: true, error: null };
  }

  return {
    isProfane,
    validateSubmission
  };
}));
