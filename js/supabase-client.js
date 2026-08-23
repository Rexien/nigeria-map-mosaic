/**
 * Nigeria Mosaic - Supabase Data Layer & Realtime Client
 * 
 * Connects to Supabase for live submissions and realtime synchronization.
 * Includes seamless local fallback mode for testing prior to entering API keys.
 */

(function(root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.MosaicDB = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {

  let supabaseClient = null;
  let isDemoMode = false;
  let realtimeChannel = null;

  // Local storage key for demo testing
  const DEMO_STORAGE_KEY = 'nigeria_mosaic_demo_responses';

  // Seed sample words for arrival question ("What makes you proud to be Nigerian?")
  const DEFAULT_SEED_WORDS = [
    'Resilience', 'Resilient', 'Culture', 'Music', 'Innovation',
    'Hospitality', 'Unity', 'Brilliance', 'Creativity', 'Energy',
    'Afrobeats', 'Progress', 'Heritage', 'Greatness', 'Strength',
    'Food', 'Nollywood', 'Excellence', 'Community', 'Fashion',
    'Pioneer', 'Hope', 'Spirit', 'Dynamism'
  ];

  /**
   * Initializes the Supabase client
   */
  function init() {
    const config = window.APP_CONFIG || {};
    const url = config.SUPABASE_URL;
    const key = config.SUPABASE_ANON_KEY;

    // Check if valid credentials are provided
    if (!url || !key || url.includes('YOUR_SUPABASE_PROJECT_ID') || key.includes('YOUR_SUPABASE_ANON_PUBLIC_KEY')) {
      console.warn('⚠️ Supabase credentials not configured in config.js. Running in Local Demo Mode.');
      isDemoMode = true;
      initDemoStorage();
      return;
    }

    try {
      if (typeof supabase !== 'undefined' && supabase.createClient) {
        supabaseClient = supabase.createClient(url, key, {
          auth: { persistSession: false }
        });
        isDemoMode = false;
        console.log('✅ Connected to Supabase Live Backend');
      } else {
        console.warn('⚠️ Supabase JS SDK not detected. Falling back to Demo Mode.');
        isDemoMode = true;
        initDemoStorage();
      }
    } catch (err) {
      console.error('Error initializing Supabase client:', err);
      isDemoMode = true;
      initDemoStorage();
    }
  }

  /**
   * Initializes mock storage with seed words for testing
   */
  function initDemoStorage() {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (!stored) {
        const seedData = DEFAULT_SEED_WORDS.map((w, idx) => {
          const stemmer = window.WordStemmer;
          const stem = stemmer ? stemmer.stem(w) : w.toLowerCase();
          return {
            id: 'demo-' + (Date.now() - (idx * 5000)),
            raw_word: w,
            word_lower: w.toLowerCase(),
            stem: stem,
            is_hidden: false,
            is_flagged: false,
            created_at: new Date(Date.now() - (DEFAULT_SEED_WORDS.length - idx) * 60000).toISOString()
          };
        });
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(seedData));
      }
    } catch (e) {
      console.error('Local storage unavailable:', e);
    }
  }

  /**
   * Fetches all responses
   * @param {boolean} includeHidden - If true, returns all (for admin), otherwise only active
   * @returns {Promise<Array<Object>>}
   */
  async function fetchResponses(includeHidden = false) {
    if (!supabaseClient || isDemoMode) {
      try {
        const stored = localStorage.getItem(DEMO_STORAGE_KEY);
        const data = stored ? JSON.parse(stored) : [];
        if (includeHidden) return data;
        return data.filter(d => !d.is_hidden);
      } catch (e) {
        return [];
      }
    }

    try {
      let query = supabaseClient
        .from(window.APP_CONFIG.TABLE_NAME || 'responses')
        .select('*')
        .order('created_at', { ascending: true });

      if (!includeHidden) {
        query = query.eq('is_hidden', false);
      }

      const { data, error } = await query;
      if (error) {
        console.error('Error fetching responses from Supabase:', error);
        throw error;
      }
      return data || [];
    } catch (err) {
      console.error('Fetch error:', err);
      throw err;
    }
  }

  /**
   * Submits a single word to Supabase
   * @param {string} rawWord 
   * @returns {Promise<{ success: boolean, data?: Object, error?: string }>}
   */
  async function submitWord(rawWord) {
    const word = (rawWord || '').trim();
    const stemmer = window.WordStemmer;
    const profanity = window.ProfanityFilter;

    // Validate
    if (profanity) {
      const validation = profanity.validateSubmission(word);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
    }

    const wordLower = word.toLowerCase();
    const wordStem = stemmer ? stemmer.stem(word) : wordLower;
    const isBad = profanity ? profanity.isProfane(word) : false;

    // If bad word, silently drop or mark flagged
    const newRecord = {
      raw_word: word,
      word_lower: wordLower,
      stem: wordStem,
      is_hidden: isBad, // Silently hide if flagged
      is_flagged: isBad,
      created_at: new Date().toISOString()
    };

    if (!supabaseClient || isDemoMode) {
      newRecord.id = 'demo-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
      try {
        const stored = localStorage.getItem(DEMO_STORAGE_KEY);
        const list = stored ? JSON.parse(stored) : [];
        list.push(newRecord);
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(list));

        // Dispatch local event for same-tab / multi-tab demo sync
        window.dispatchEvent(new CustomEvent('mosaic:demo-insert', { detail: newRecord }));
        window.dispatchEvent(new StorageEvent('storage', {
          key: DEMO_STORAGE_KEY,
          newValue: JSON.stringify(list)
        }));
      } catch (e) {
        console.error('Failed to write to demo storage:', e);
      }
      return { success: true, data: newRecord };
    }

    try {
      const { data, error } = await supabaseClient
        .from(window.APP_CONFIG.TABLE_NAME || 'responses')
        .insert([newRecord])
        .select()
        .single();

      if (error) {
        console.error('Supabase insert error:', error);
        return { success: false, error: error.message || 'Submission failed. Please try again.' };
      }

      return { success: true, data };
    } catch (err) {
      console.error('Submit exception:', err);
      return { success: false, error: 'Network error. Please try again.' };
    }
  }

  /**
   * Toggles hidden status of a response (Admin moderation)
   * @param {string} id 
   * @param {boolean} isHidden 
   * @returns {Promise<boolean>}
   */
  async function setHiddenStatus(id, isHidden) {
    if (!supabaseClient || isDemoMode) {
      try {
        const stored = localStorage.getItem(DEMO_STORAGE_KEY);
        const list = stored ? JSON.parse(stored) : [];
        const item = list.find(d => d.id === id);
        if (item) {
          item.is_hidden = isHidden;
          localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(list));
          window.dispatchEvent(new CustomEvent('mosaic:demo-update', { detail: item }));
          return true;
        }
      } catch (e) {
        console.error('Demo update error:', e);
      }
      return false;
    }

    try {
      const { error } = await supabaseClient
        .from(window.APP_CONFIG.TABLE_NAME || 'responses')
        .update({ is_hidden: isHidden })
        .eq('id', id);

      if (error) {
        console.error('Supabase update error:', error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('Update error:', err);
      return false;
    }
  }

  /**
   * Subscribes to Realtime database updates
   * @param {Object} callbacks - { onInsert, onUpdate, onDelete }
   * @returns {Object} subscription handle
   */
  function subscribeRealtime(callbacks = {}) {
    init();

    const { onInsert, onUpdate, onDelete } = callbacks;

    if (!supabaseClient || isDemoMode) {
      console.log('📡 Realtime listening in local demo mode');

      const handleInsert = (e) => {
        if (onInsert && e.detail) onInsert(e.detail);
      };
      const handleUpdate = (e) => {
        if (onUpdate && e.detail) onUpdate(e.detail);
      };
      const handleStorage = (e) => {
        if (e.key === DEMO_STORAGE_KEY && e.newValue) {
          // Trigger update notification
          if (onUpdate) onUpdate({ id: 'refresh' });
        }
      };

      window.addEventListener('mosaic:demo-insert', handleInsert);
      window.addEventListener('mosaic:demo-update', handleUpdate);
      window.addEventListener('storage', handleStorage);

      return {
        unsubscribe: () => {
          window.removeEventListener('mosaic:demo-insert', handleInsert);
          window.removeEventListener('mosaic:demo-update', handleUpdate);
          window.removeEventListener('storage', handleStorage);
        }
      };
    }

    try {
      const tableName = window.APP_CONFIG.TABLE_NAME || 'responses';
      realtimeChannel = supabaseClient
        .channel('public:' + tableName)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: tableName },
          (payload) => {
            console.log('⚡ Realtime INSERT:', payload.new);
            if (onInsert && payload.new) onInsert(payload.new);
          }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: tableName },
          (payload) => {
            console.log('⚡ Realtime UPDATE:', payload.new);
            if (onUpdate && payload.new) onUpdate(payload.new);
          }
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: tableName },
          (payload) => {
            console.log('⚡ Realtime DELETE:', payload.old);
            if (onDelete && payload.old) onDelete(payload.old);
          }
        )
        .subscribe((status) => {
          console.log('Realtime subscription status:', status);
        });

      return {
        unsubscribe: () => {
          if (realtimeChannel) {
            supabaseClient.removeChannel(realtimeChannel);
          }
        }
      };
    } catch (err) {
      console.error('Subscription error:', err);
      return { unsubscribe: () => {} };
    }
  }

  // Auto initialize on load
  init();

  return {
    init,
    isDemoMode: () => isDemoMode,
    fetchResponses,
    submitWord,
    setHiddenStatus,
    subscribeRealtime
  };
}));
