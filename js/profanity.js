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
   * - Must be 1 or 2 words (maximum 1 space separator)
   * - Length between 1 and MAX_WORD_LENGTH
   * 
   * @param {string} word 
   * @returns {{ valid: boolean, error: string | null }}
   */
  function validateSubmission(word) {
    if (!word || typeof word !== 'string') {
      return { valid: false, error: 'Please enter one or two words.' };
    }

    const trimmed = word.trim().replace(/\s+/g, ' ');
    if (trimmed.length === 0) {
      return { valid: false, error: 'Please enter one or two words.' };
    }

    // Check for maximum 2 words (at most 1 space separator)
    const wordCount = trimmed.split(' ').length;
    if (wordCount > 2) {
      return { valid: false, error: 'Please enter a maximum of two words (e.g. "Warm Hospitality").' };
    }

    const maxLen = (window.APP_CONFIG && window.APP_CONFIG.MAX_WORD_LENGTH) || 25;
    if (trimmed.length > maxLen) {
      return { valid: false, error: `Submission is too long (maximum ${maxLen} characters).` };
    }

    // Check for weird symbols only
    if (/^[^a-zA-Z0-9\s]+$/.test(trimmed)) {
      return { valid: false, error: 'Please enter valid words with letters.' };
    }

    return { valid: true, error: null };
  }

  return {
    isProfane,
    validateSubmission
  };
}));
