/**
 * Nigeria Mosaic - Admin Live Moderation Controller
 * 
 * Provides live response monitoring, instant Hide/Unhide moderation,
 * word searching, and status filtering.
 */

(function() {
  'use strict';

  // State
  let responses = [];
  let currentFilter = 'all'; // 'all', 'active', 'hidden', 'flagged'
  let searchQuery = '';

  // DOM Elements
  const tableBody = document.getElementById('responses-tbody');
  const searchInput = document.getElementById('search-input');
  const filterTabs = document.querySelectorAll('.filter-tab');
  
  const statTotal = document.getElementById('stat-admin-total');
  const statActive = document.getElementById('stat-admin-active');
  const statHidden = document.getElementById('stat-admin-hidden');
  const statFlagged = document.getElementById('stat-admin-flagged');

  const pinModal = document.getElementById('pin-modal-overlay');
  const pinInput = document.getElementById('pin-input');
  const btnSubmitPin = document.getElementById('btn-submit-pin');
  const pinError = document.getElementById('pin-error');

  /**
   * Initializes Admin Page
   */
  async function init() {
    checkPinAccess();
    setupEventListeners();
    await loadResponses();
    setupRealtime();
  }

  /**
   * PIN Protection
   */
  function checkPinAccess() {
    const config = window.APP_CONFIG || {};
    const adminPin = config.ADMIN_PIN;

    if (!adminPin || adminPin.trim() === '') {
      if (pinModal) pinModal.style.display = 'none';
      return;
    }

    const sessionAuth = sessionStorage.getItem('mosaic_admin_auth');
    if (sessionAuth === 'true') {
      if (pinModal) pinModal.style.display = 'none';
    } else {
      if (pinModal) pinModal.style.display = 'flex';
      if (pinInput) pinInput.focus();
    }
  }

  function handlePinSubmit() {
    const config = window.APP_CONFIG || {};
    const expected = config.ADMIN_PIN || '1960';
    const entered = pinInput.value.trim();

    if (entered === expected) {
      sessionStorage.setItem('mosaic_admin_auth', 'true');
      pinModal.style.display = 'none';
    } else {
      pinError.textContent = 'Incorrect PIN. Please try again.';
      pinInput.value = '';
      pinInput.focus();
    }
  }

  /**
   * Sets up UI event listeners
   */
  function setupEventListeners() {
    if (btnSubmitPin) {
      btnSubmitPin.addEventListener('click', handlePinSubmit);
    }
    if (pinInput) {
      pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handlePinSubmit();
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase().trim();
        renderTable();
      });
    }

    filterTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        filterTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter = tab.getAttribute('data-filter') || 'all';
        renderTable();
      });
    });
  }

  /**
   * Loads all responses from database
   */
  async function loadResponses() {
    try {
      responses = await window.MosaicDB.fetchResponses(true);
      // Sort newest first
      responses.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      updateStats();
      renderTable();
    } catch (err) {
      console.error('Failed to load admin responses:', err);
    }
  }

  /**
   * Updates stats counters
   */
  function updateStats() {
    const total = responses.length;
    const active = responses.filter(r => !r.is_hidden).length;
    const hidden = responses.filter(r => r.is_hidden).length;
    const flagged = responses.filter(r => r.is_flagged).length;

    if (statTotal) statTotal.textContent = total;
    if (statActive) statActive.textContent = active;
    if (statHidden) statHidden.textContent = hidden;
    if (statFlagged) statFlagged.textContent = flagged;
  }

  /**
   * Formats ISO timestamp into clean human time
   */
  function formatTime(isoString) {
    if (!isoString) return '--:--:--';
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      return isoString;
    }
  }

  /**
   * Renders the responses table
   */
  function renderTable() {
    if (!tableBody) return;

    let filtered = responses.filter(item => {
      // Filter tab
      if (currentFilter === 'active' && item.is_hidden) return false;
      if (currentFilter === 'hidden' && !item.is_hidden) return false;
      if (currentFilter === 'flagged' && !item.is_flagged) return false;

      // Search query
      if (searchQuery) {
        const raw = (item.raw_word || '').toLowerCase();
        const stem = (item.stem || '').toLowerCase();
        if (!raw.includes(searchQuery) && !stem.includes(searchQuery)) {
          return false;
        }
      }

      return true;
    });

    if (filtered.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="5" class="empty-state">
            No responses match your search or filter.
          </td>
        </tr>
      `;
      return;
    }

    tableBody.innerHTML = '';

    filtered.forEach(item => {
      const tr = document.createElement('tr');
      const stemmer = window.WordStemmer;
      const displayWord = stemmer ? stemmer.formatDisplayWord(item.raw_word) : item.raw_word;

      const isHidden = item.is_hidden;
      const isFlagged = item.is_flagged;

      tr.innerHTML = `
        <td>
          <div class="word-cell">
            <span>${escapeHtml(displayWord)}</span>
            <span class="stem-badge" title="Root Stem">${escapeHtml(item.stem || '')}</span>
            ${isFlagged ? '<span class="badge-flagged">Flagged</span>' : ''}
          </div>
        </td>
        <td>
          ${isHidden 
            ? '<span class="badge-hidden"><span style="width:6px;height:6px;background:#EF4444;border-radius:50%"></span> Hidden</span>' 
            : '<span class="badge-live"><span style="width:6px;height:6px;background:#10B981;border-radius:50%"></span> Live on Screen</span>'}
        </td>
        <td style="color: var(--text-dim); font-family: 'Space Grotesk', monospace; font-size: 0.85rem;">
          ${formatTime(item.created_at)}
        </td>
        <td>
          <button 
            type="button" 
            class="btn-toggle-hide ${isHidden ? 'action-unhide' : 'action-hide'}" 
            data-id="${item.id}"
            data-hidden="${isHidden}"
          >
            ${isHidden ? '✓ Show on Screen' : '✕ Hide from Display'}
          </button>
        </td>
      `;

      // Attach button listener
      const btn = tr.querySelector('.btn-toggle-hide');
      if (btn) {
        btn.addEventListener('click', () => handleToggleHide(item.id, !isHidden));
      }

      tableBody.appendChild(tr);
    });
  }

  /**
   * Handles Hide / Unhide button click
   */
  async function handleToggleHide(id, makeHidden) {
    const success = await window.MosaicDB.setHiddenStatus(id, makeHidden);
    if (success) {
      const item = responses.find(r => r.id === id);
      if (item) {
        item.is_hidden = makeHidden;
        updateStats();
        renderTable();
      }
    } else {
      alert('Failed to update status. Please check your connection.');
    }
  }

  /**
   * Escapes HTML string
   */
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Sets up Realtime listener for live admin monitoring
   */
  function setupRealtime() {
    window.MosaicDB.subscribeRealtime({
      onInsert: (newRecord) => {
        if (!newRecord) return;
        const exists = responses.find(r => r.id === newRecord.id);
        if (!exists) {
          responses.unshift(newRecord);
          updateStats();
          renderTable();
        }
      },
      onUpdate: (updatedRecord) => {
        if (!updatedRecord) return;
        const idx = responses.findIndex(r => r.id === updatedRecord.id);
        if (idx !== -1) {
          responses[idx] = updatedRecord;
          updateStats();
          renderTable();
        }
      },
      onDelete: () => {
        loadResponses();
      }
    });
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
