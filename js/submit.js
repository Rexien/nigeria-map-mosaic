/**
 * Nigeria Mosaic - Attendee Submission Controller
 * 
 * Handles single-word input validation, space rejection, character counter,
 * submission to Supabase, and tactile feedback.
 */

(function() {
  'use strict';

  // DOM Elements
  const form = document.getElementById('word-form');
  const input = document.getElementById('word-input');
  const charCounter = document.getElementById('char-counter');
  const errorMsg = document.getElementById('error-msg');
  const submitBtn = document.getElementById('btn-submit');
  const submitBtnText = document.getElementById('btn-text');
  const submitBtnSpinner = document.getElementById('btn-spinner');
  
  const questionTitle = document.getElementById('question-title');
  const questionSubtitle = document.getElementById('question-subtitle');
  
  const formCard = document.getElementById('form-card-body');
  const successView = document.getElementById('success-view');
  const submittedWordDisplay = document.getElementById('submitted-word-display');
  const btnSubmitAnother = document.getElementById('btn-submit-another');

  const MAX_CHARS = (window.APP_CONFIG && window.APP_CONFIG.MAX_WORD_LENGTH) || 20;

  /**
   * Initializes the submit page
   */
  function init() {
    applyConfig();
    setupEventListeners();
    input.focus();
  }

  /**
   * Applies configurable question text from config.js
   */
  function applyConfig() {
    const config = window.APP_CONFIG || {};
    if (questionTitle && config.QUESTION_TEXT) {
      questionTitle.textContent = config.QUESTION_TEXT;
    }
    if (questionSubtitle && config.QUESTION_SUBTITLE) {
      questionSubtitle.textContent = config.QUESTION_SUBTITLE;
    }
    if (input) {
      input.maxLength = MAX_CHARS;
    }
    updateCharCounter();
  }

  /**
   * Sets up input listeners and form submissions
   */
  function setupEventListeners() {
    // Character counter and space detection on input
    input.addEventListener('input', handleInputChange);

    // Form submit
    form.addEventListener('submit', handleFormSubmit);

    // Submit another word button
    if (btnSubmitAnother) {
      btnSubmitAnother.addEventListener('click', resetForm);
    }
  }

  /**
   * Handles user keystroke input
   */
  function handleInputChange(e) {
    const value = input.value;
    updateCharCounter();

    // Check if input contains space
    if (/\s/.test(value)) {
      showError('Please enter only a single word with no spaces.');
      input.value = value.replace(/\s+/g, '');
      updateCharCounter();
      return;
    }

    // Check if user entered camelCase (e.g. TwoWords)
    if (/[A-Z]/.test(value.slice(1))) {
      showError('Please enter only a single word (no camelCase like "TwoWords").');
      return;
    }

    clearError();
  }

  /**
   * Updates remaining characters indicator
   */
  function updateCharCounter() {
    const len = input.value.length;
    charCounter.textContent = `${len}/${MAX_CHARS}`;
    if (len >= MAX_CHARS - 3) {
      charCounter.classList.add('limit-near');
    } else {
      charCounter.classList.remove('limit-near');
    }
  }

  /**
   * Shows validation error message
   * @param {string} msg 
   */
  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.add('visible');
    input.classList.add('has-error');
  }

  /**
   * Clears error state
   */
  function clearError() {
    errorMsg.textContent = '';
    errorMsg.classList.remove('visible');
    input.classList.remove('has-error');
  }

  /**
   * Sets loading state on submit button
   * @param {boolean} isLoading 
   */
  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    if (isLoading) {
      submitBtnText.style.display = 'none';
      submitBtnSpinner.style.display = 'block';
    } else {
      submitBtnText.style.display = 'block';
      submitBtnSpinner.style.display = 'none';
    }
  }

  /**
   * Handles form submission
   */
  async function handleFormSubmit(e) {
    e.preventDefault();
    clearError();

    const rawWord = input.value.trim();

    // Client-side validation
    const profanity = window.ProfanityFilter;
    if (profanity) {
      const validation = profanity.validateSubmission(rawWord);
      if (!validation.valid) {
        showError(validation.error);
        input.focus();
        return;
      }
    } else {
      if (!rawWord) {
        showError('Please enter a word.');
        return;
      }
      if (/\s/.test(rawWord)) {
        showError('Please enter only a single word with no spaces.');
        return;
      }
    }

    setLoading(true);

    try {
      const result = await window.MosaicDB.submitWord(rawWord);

      if (!result.success) {
        showError(result.error || 'Submission failed. Please try again.');
        setLoading(false);
        return;
      }

      // Tactile feedback on mobile devices
      if (navigator.vibrate) {
        navigator.vibrate([40, 50, 40]);
      }

      // Display formatted word on thank-you view
      const stemmer = window.WordStemmer;
      const displayWord = stemmer ? stemmer.formatDisplayWord(rawWord) : rawWord;
      submittedWordDisplay.textContent = `"${displayWord}"`;

      // Switch to success view
      formCard.style.display = 'none';
      successView.style.display = 'flex';

    } catch (err) {
      console.error('Submit error:', err);
      showError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Resets form to submit another word
   */
  function resetForm() {
    input.value = '';
    clearError();
    updateCharCounter();
    successView.style.display = 'none';
    formCard.style.display = 'flex';
    input.focus();
  }

  // Run on ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
