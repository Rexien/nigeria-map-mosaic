/**
 * Nigeria Mosaic - Lightweight Suffix Stripper & Stemmer
 * 
 * Groups variants of the same root word (e.g. resilience / resilient / resiliency -> "resilien")
 * without any external heavy NLP dependencies.
 */

(function(root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.WordStemmer = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {

  /**
   * Cleans and normalizes a word string
   * @param {string} word 
   * @returns {string}
   */
  function cleanWord(word) {
    if (!word || typeof word !== 'string') return '';
    return word.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Suffix patterns sorted from longest/most specific to shortest
   */
  const SUFFIX_RULES = [
    // Multi-syllable derivational endings
    { pattern: /(ization|isation|ational|tional|fulness|ousness|iveness)$/, replace: '' },
    { pattern: /(ingly|lessly|fully|ically|istically)$/, replace: '' },
    { pattern: /(izing|ising|ation|ition|ution)$/, replace: '' },
    // -ence / -ance / -ency / -ancy / -ent / -ant
    { pattern: /(ience|iance|iency|iancy|ient|iant)$/, replace: 'i' },
    { pattern: /(ence|ance|ency|ancy|ent|ant)$/, replace: '' },
    // -able / -ible / -ably / -ibly
    { pattern: /(able|ible|ably|ibly)$/, replace: '' },
    // Noun / Adjective endings
    { pattern: /(ments|ment|nesses|ness|ships|ship|hoods|hood)$/, replace: '' },
    { pattern: /(icals|ical|ious|eous|uous|lessly|less|fully|ful)$/, replace: '' },
    { pattern: /(itive|ative|ive|izes|ises|ize|ise|ites|ite)$/, replace: '' },
    { pattern: /(ities|ity|eties|ety|ings|ing)$/, replace: '' },
    // Past tense and plurals
    { pattern: /(ied|ies)$/, replace: 'i' },
    { pattern: /(ier|iest)$/, replace: 'i' },
    { pattern: /(ed|es|er|est)$/, replace: '' },
    { pattern: /(ly)$/, replace: '' },
    { pattern: /(s)$/, replace: '' }
  ];

  /**
   * Custom stem overrides for high-frequency root concepts
   */
  const STEM_OVERRIDES = {
    'resilience': 'resilien',
    'resilient': 'resilien',
    'resiliency': 'resilien',
    'resiliently': 'resilien',
    'unity': 'unit',
    'united': 'unit',
    'unite': 'unit',
    'unifying': 'unit',
    'unification': 'unit',
    'success': 'success',
    'successful': 'success',
    'successfully': 'success',
    'innovation': 'innovat',
    'innovative': 'innovat',
    'innovate': 'innovat',
    'innovating': 'innovat',
    'innovator': 'innovat',
    'transformation': 'transform',
    'transformative': 'transform',
    'transform': 'transform',
    'transforming': 'transform',
    'strength': 'strength',
    'strong': 'strength',
    'stronger': 'strength',
    'strongest': 'strength',
    'strongly': 'strength',
    'growth': 'grow',
    'growing': 'grow',
    'grown': 'grow'
  };

  /**
   * Computes the stem for a given word
   * @param {string} word
   * @returns {string} stem
   */
  function stem(word) {
    const cleaned = cleanWord(word);
    if (!cleaned) return '';
    if (cleaned.length <= 3) return cleaned;

    // Check explicit overrides first
    if (STEM_OVERRIDES[cleaned]) {
      return STEM_OVERRIDES[cleaned];
    }

    let result = cleaned;

    // Apply suffix stripping rules
    for (let i = 0; i < SUFFIX_RULES.length; i++) {
      const { pattern, replace } = SUFFIX_RULES[i];
      if (pattern.test(result)) {
        const candidate = result.replace(pattern, replace);
        // Do not over-stem short roots (keep at least 3 characters)
        if (candidate.length >= 3) {
          result = candidate;
          break;
        }
      }
    }

    // Clean up trailing double consonants (e.g. "progress" -> "progres")
    if (result.length > 4 && result[result.length - 1] === result[result.length - 2]) {
      result = result.slice(0, -1);
    }

    return result;
  }

  /**
   * Capitalizes first letter of word cleanly for display
   * @param {string} word 
   * @returns {string}
   */
  function formatDisplayWord(word) {
    if (!word) return '';
    const trimmed = word.trim();
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  /**
   * Aggregates raw response objects into grouped words
   * Grouped by stem, displaying the most frequent spelling.
   * 
   * @param {Array<Object>} responses - Array of response records
   * @returns {Array<Object>} Array of grouped words [{ stem, text, count, latestAt, items }]
   */
  function aggregateWordGroups(responses) {
    if (!Array.isArray(responses) || responses.length === 0) {
      return [];
    }

    const stemMap = new Map();

    for (let i = 0; i < responses.length; i++) {
      const item = responses[i];
      if (item.is_hidden) continue;

      const raw = (item.raw_word || '').trim();
      if (!raw) continue;

      const wordStem = item.stem || stem(raw);
      if (!wordStem) continue;

      if (!stemMap.has(wordStem)) {
        stemMap.set(wordStem, {
          stem: wordStem,
          spellingCounts: new Map(),
          totalCount: 0,
          latestAt: item.created_at ? new Date(item.created_at).getTime() : 0,
          items: []
        });
      }

      const entry = stemMap.get(wordStem);
      entry.totalCount += 1;
      entry.items.push(item);

      const itemTime = item.created_at ? new Date(item.created_at).getTime() : Date.now();
      if (itemTime > entry.latestAt) {
        entry.latestAt = itemTime;
      }

      // Count exact human spelling / casing variations
      const formatted = formatDisplayWord(raw);
      const currentCount = entry.spellingCounts.get(formatted) || 0;
      entry.spellingCounts.set(formatted, currentCount + 1);
    }

    // Convert map to sorted word list
    const result = [];
    stemMap.forEach((entry) => {
      // Find the most frequent spelling variation
      let bestSpelling = '';
      let highestSpellingCount = -1;

      entry.spellingCounts.forEach((count, spelling) => {
        if (count > highestSpellingCount) {
          highestSpellingCount = count;
          bestSpelling = spelling;
        }
      });

      result.push({
        stem: entry.stem,
        text: bestSpelling,
        count: entry.totalCount,
        latestAt: entry.latestAt,
        items: entry.items
      });
    });

    // Sort descending by count, then by latest arrival
    result.sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return b.latestAt - a.latestAt;
    });

    return result;
  }

  return {
    cleanWord,
    stem,
    formatDisplayWord,
    aggregateWordGroups
  };
}));
