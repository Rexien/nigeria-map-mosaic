/**
 * Nigeria Mosaic - Big Screen & Projector Display Controller
 * 
 * Renders Nigeria GeoJSON boundary, creates projected collision mask,
 * executes boundary-constrained d3-cloud layout, subscribes to Supabase Realtime,
 * and manages ambient animation.
 */

(function() {
  'use strict';

  // State
  let geojsonData = null;
  let allResponses = [];
  let renderedWordMap = new Map(); // stem -> placed word object
  let lastRepackCount = 0;
  let isRepacking = false;
  let currentWidth = 1920;
  let currentHeight = 1080;
  let cachedBoard = null;
  let currentProjection = null;
  let ambientIntervalId = null;
  let regionalPoints = null;

  // DOM Elements
  const stageEl = document.getElementById('mosaic-stage');
  const svgEl = document.getElementById('map-svg');
  const mapGroupEl = document.getElementById('map-boundary-group');
  const wordsGroupEl = document.getElementById('words-layer');
  const totalCountEl = document.getElementById('stat-total-count');
  const uniqueCountEl = document.getElementById('stat-unique-count');
  const repackIndicator = document.getElementById('repack-indicator');
  const loadingOverlay = document.getElementById('loading-overlay');
  const submitUrlBadge = document.getElementById('submit-url-badge');
  const questionTitleEl = document.getElementById('display-question');
  const isEmbedded = new URLSearchParams(window.location.search).get('embed') === '1';

  /**
   * Initializes the display page
   */
  async function init() {
    applyProjectorOwnership();
    applyConfig();
    updateSubmitUrlHint();
    await loadGeoJSON();
    setupStageDimensions();
    buildProjectionAndMask();
    drawMapBoundary();
    
    // Initial data fetch
    await loadInitialData();
    
    // Subscribe to realtime updates
    setupRealtime();

    // Start ambient animation
    startAmbientShimmer();

    // Hide loader
    if (loadingOverlay) {
      loadingOverlay.style.opacity = '0';
      setTimeout(() => {
        loadingOverlay.style.display = 'none';
      }, 600);
    }

    // Handle window resize (debounced)
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        setupStageDimensions();
        buildProjectionAndMask();
        drawMapBoundary();
        triggerRepack(true);
      }, 300);
    });
  }

  /**
   * The parent /display surface owns projector connection state. Embedded Lens
   * therefore removes standalone realtime chrome while keeping it on /lens/live.
   */
  function applyProjectorOwnership() {
    if (!isEmbedded) return;
    document.documentElement.classList.add('is-embedded');
    const badgeLabel = document.querySelector('.event-badge span:last-child');
    if (badgeLabel) badgeLabel.textContent = 'Responses';
  }

  /**
   * Applies config values to DOM
   */
  function applyConfig() {
    const config = window.APP_CONFIG || {};
    if (questionTitleEl && config.QUESTION_TEXT) {
      questionTitleEl.textContent = config.QUESTION_TEXT;
    }
  }

  /**
   * Updates the footer submit URL badge
   */
  function updateSubmitUrlHint() {
    if (!submitUrlBadge) return;
    try {
      const configuredUrl = window.APP_CONFIG?.PUBLIC_EVENT_URL;
      const joinUrl = configuredUrl ? new URL(configuredUrl, window.location.origin) : new URL(window.location.origin);
      const cleanUrl = `${joinUrl.host}${joinUrl.pathname}`.replace(/\/$/, '');
      submitUrlBadge.textContent = cleanUrl;
    } catch (e) {
      submitUrlBadge.textContent = window.location.host || 'Event Submit Page';
    }
  }

  /**
   * Loads the Nigeria GeoJSON boundary
   */
  async function loadGeoJSON() {
    if (window.NIGERIA_GEOJSON) {
      geojsonData = window.NIGERIA_GEOJSON;
      return;
    }

    try {
      const resp = await fetch('data/nigeria.geojson');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      geojsonData = await resp.json();
    } catch (err) {
      console.error('Failed to fetch nigeria.geojson, using fallback bounds:', err);
      // Fallback check
      if (window.NIGERIA_GEOJSON) {
        geojsonData = window.NIGERIA_GEOJSON;
      }
    }
  }

  /**
   * Measures stage dimensions
   */
  function setupStageDimensions() {
    const rect = stageEl.getBoundingClientRect();
    currentWidth = Math.max(Math.floor(rect.width), 800);
    currentHeight = Math.max(Math.floor(rect.height), 600);

    svgEl.setAttribute('width', currentWidth);
    svgEl.setAttribute('height', currentHeight);
    svgEl.setAttribute('viewBox', `0 0 ${currentWidth} ${currentHeight}`);
  }

  /**
   * Builds the projected GeoJSON collision mask
   * CRITICAL: Projection maps lat/lng -> canvas/SVG pixel space before rasterization!
   */
  function buildProjectionAndMask() {
    if (!geojsonData) return;

    // Generous safe padding (10% horizontally, 12% vertically) for projector safety
    const padX = Math.round(currentWidth * 0.08);
    const padY = Math.round(currentHeight * 0.10);

    // 1. Create projection fitted directly to SVG stage dimensions
    currentProjection = d3.geoMercator()
      .fitExtent([[padX, padY], [currentWidth - padX, currentHeight - padY]], geojsonData);

    // 2. Offscreen Canvas for bitmask rasterization
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = currentWidth;
    maskCanvas.height = currentHeight;
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

    // Step A: Fill entire canvas with solid opaque black (outside region = occupied)
    maskCtx.fillStyle = '#000000';
    maskCtx.fillRect(0, 0, currentWidth, currentHeight);

    // Step B: Cut out Nigeria using destination-out with the projected geometry
    maskCtx.globalCompositeOperation = 'destination-out';
    const pathGenerator = d3.geoPath().projection(currentProjection).context(maskCtx);
    maskCtx.beginPath();
    pathGenerator(geojsonData);
    maskCtx.fill();

    // Step C: Convert raster pixels to 32-bit integer bitmask array for d3-cloud
    // d3-cloud requires a 1D Int32Array where width is (currentWidth >> 5)
    const sw = currentWidth >> 5;
    const board = new Int32Array(sw * currentHeight);
    const imgData = maskCtx.getImageData(0, 0, currentWidth, currentHeight).data;

    // Reset regional points
    regionalPoints = {
      northEast: [],
      northWest: [],
      southWest: [],
      southEastSouthSouth: [],
      middleBelt: [],
      center: [],
      all: []
    };

    for (let y = 0; y < currentHeight; y++) {
      const rowOffset = y * currentWidth;
      const boardOffset = y * sw;
      for (let x = 0; x < currentWidth; x++) {
        // Check if pixel is INSIDE Nigeria (alpha <= 128)
        if (imgData[(rowOffset + x) * 4 + 3] <= 128) {
          const pt = { x, y };
          regionalPoints.all.push(pt);

          // Classify into geographic zones
          const normX = x / currentWidth;
          const normY = y / currentHeight;

          if (normY < 0.46 && normX > 0.52) {
            regionalPoints.northEast.push(pt); // Borno / Yobe / Adamawa
          } else if (normY < 0.46 && normX <= 0.52) {
            regionalPoints.northWest.push(pt); // Sokoto / Kebbi / Kano
          } else if (normY > 0.54 && normX < 0.44) {
            regionalPoints.southWest.push(pt); // Lagos / Ogun / Oyo
          } else if (normY > 0.54 && normX >= 0.44) {
            regionalPoints.southEastSouthSouth.push(pt); // Delta / Rivers / Calabar
          } else {
            regionalPoints.middleBelt.push(pt); // Abuja / Plateau / Benue
          }

          if (normX >= 0.40 && normX <= 0.60 && normY >= 0.42 && normY <= 0.58) {
            regionalPoints.center.push(pt);
          }
        } else {
          // Outside Nigeria boundary -> set bit to 1 (occupied)
          board[boardOffset + (x >> 5)] |= (1 << (31 - (x % 32)));
        }
      }
    }

    cachedBoard = board;
    console.log(`✅ Projected Nigeria boundary mask initialized (${currentWidth}x${currentHeight}) with ${regionalPoints.all.length} inside sample points`);
  }

  /**
   * Renders the background SVG Nigeria map silhouette & glow
   */
  function drawMapBoundary() {
    if (!geojsonData || !currentProjection) return;

    mapGroupEl.innerHTML = '';

    const pathGen = d3.geoPath().projection(currentProjection);
    const pathData = pathGen(geojsonData);

    // 1. Outer Glow path
    const glowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    glowPath.setAttribute('d', pathData);
    glowPath.setAttribute('class', 'nigeria-glow-border');
    mapGroupEl.appendChild(glowPath);

    // 2. Main filled boundary path
    const mainPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    mainPath.setAttribute('d', pathData);
    mainPath.setAttribute('class', 'nigeria-path');
    mapGroupEl.appendChild(mainPath);
  }

  /**
   * Loads initial response dataset
   */
  async function loadInitialData() {
    try {
      allResponses = await window.MosaicDB.fetchResponses(false);
      updateStats();
      triggerRepack(false);
    } catch (err) {
      console.error('Failed to load initial responses:', err);
    }
  }

  /**
   * Updates stats counters in header
   */
  function updateStats() {
    const active = allResponses.filter(r => !r.is_hidden);
    if (totalCountEl) totalCountEl.textContent = active.length;

    const stemmer = window.WordStemmer;
    if (stemmer && uniqueCountEl) {
      const groups = stemmer.aggregateWordGroups(active);
      uniqueCountEl.textContent = groups.length;
    }
  }

  /**
   * Triggers a full word layout calculation and rendering
   * @param {boolean} isInstant - If true, skips fade-out delay
   */
  function triggerRepack(isInstant = false) {
    if (isRepacking || !cachedBoard) return;
    isRepacking = true;

    if (repackIndicator) repackIndicator.classList.add('visible');

    const stemmer = window.WordStemmer;
    const config = window.APP_CONFIG || {};
    const wordGroups = stemmer ? stemmer.aggregateWordGroups(allResponses) : [];

    if (wordGroups.length === 0) {
      wordsGroupEl.innerHTML = '';
      isRepacking = false;
      if (repackIndicator) repackIndicator.classList.remove('visible');
      return;
    }

    // Dynamic font sizing scale based on number of distinct word groups
    const totalGroups = wordGroups.length;
    let minFontSize = config.FONT_SIZE_MIN || 18;
    let maxFontSize = config.FONT_SIZE_MAX || 100;

    // Scale sizing so few words fill early, many words fit late
    if (totalGroups <= 6) {
      minFontSize = 30;
      maxFontSize = 76;
    } else if (totalGroups <= 15) {
      minFontSize = 28;
      maxFontSize = 95;
    } else if (totalGroups <= 40) {
      minFontSize = 20;
      maxFontSize = 75;
    } else if (totalGroups <= 100) {
      minFontSize = 16;
      maxFontSize = 58;
    } else {
      minFontSize = 13;
      maxFontSize = 46;
    }

    const maxCount = Math.max(...wordGroups.map(d => d.count), 1);
    const minCount = Math.min(...wordGroups.map(d => d.count), 1);

    // High contrast projector palette
    const palette = config.COLOR_PALETTE || ['#FBBF24', '#FFFFFF', '#10B981', '#F59E0B'];

    // Geographic regional pools for balanced spatial distribution across all of Nigeria
    const regionsList = [
      regionalPoints.northEast,
      regionalPoints.southWest,
      regionalPoints.northWest,
      regionalPoints.southEastSouthSouth,
      regionalPoints.middleBelt,
      regionalPoints.all
    ].filter(arr => arr && arr.length > 0);

    const wordsData = wordGroups.map((d, index) => {
      // Font size scaled by square root of count
      const sqrtCount = Math.sqrt(d.count);
      const sqrtMax = Math.sqrt(maxCount);
      const sqrtMin = Math.sqrt(minCount);

      let normalized = 0.5;
      if (sqrtMax > sqrtMin) {
        normalized = (sqrtCount - sqrtMin) / (sqrtMax - sqrtMin);
      }

      const computedSize = Math.round(minFontSize + normalized * (maxFontSize - minFontSize));

      // Determine starting seed coordinates across geographic zones
      let startX = currentWidth / 2;
      let startY = currentHeight / 2;

      if (index === 0) {
        // Top #1 dominant word gets central heart of Nigeria
        const centerPool = regionalPoints.center.length > 0 ? regionalPoints.center : regionalPoints.all;
        if (centerPool.length > 0) {
          const pt = centerPool[Math.floor(Math.random() * centerPool.length)];
          startX = pt.x;
          startY = pt.y;
        }
      } else {
        // Other words cycle across geographic regions (Borno, Lagos, Kebbi, Delta, Abuja, etc.)
        const targetRegion = regionsList[(index - 1) % regionsList.length] || regionalPoints.all;
        if (targetRegion && targetRegion.length > 0) {
          const pt = targetRegion[Math.floor(Math.random() * targetRegion.length)];
          startX = pt.x;
          startY = pt.y;
        }
      }

      // Color selection with high contrast
      let color;
      if (index === 0 && d.count > 1) {
        color = '#FBBF24'; // Radiant Gold for #1
      } else if (index === 1 && d.count > 1) {
        color = '#FFFFFF'; // Crisp White for #2
      } else if (index === 2 && d.count > 1) {
        color = '#10B981'; // Electric Emerald for #3
      } else {
        color = palette[index % palette.length];
      }

      return {
        text: d.text,
        stem: d.stem,
        count: d.count,
        computedSize: computedSize,
        color: color,
        startX: startX,
        startY: startY,
        latestAt: d.latestAt
      };
    });

    // Create fresh copy of boundary mask for d3-cloud collision detection
    const maskCopy = new Int32Array(cachedBoard);

    // Initialize d3-cloud
    const layout = d3.layout.cloud()
      .size([currentWidth, currentHeight])
      .words(wordsData)
      .padding(3)
      .rotate(0) // Strictly horizontal for maximum readability on projector
      .font(config.FONT_FAMILY || 'Outfit, sans-serif')
      .fontWeight(config.FONT_WEIGHT || '800')
      .fontSize(d => d.computedSize)
      .initialBoard(maskCopy) // Constrain strictly inside Nigeria
      .random(() => Math.random())
      .on('end', (placedWords) => {
        renderPlacedWords(placedWords, isInstant);
        lastRepackCount = allResponses.filter(r => !r.is_hidden).length;
        isRepacking = false;
        if (repackIndicator) {
          setTimeout(() => repackIndicator.classList.remove('visible'), 500);
        }
      });

    layout.start();
  }

  /**
   * Renders the placed word layout into the SVG
   * @param {Array<Object>} placedWords 
   * @param {boolean} isInstant 
   */
  function renderPlacedWords(placedWords, isInstant) {
    const config = window.APP_CONFIG || {};

    // Center translation for d3-cloud coordinates
    const centerX = currentWidth / 2;
    const centerY = currentHeight / 2;

    wordsGroupEl.setAttribute('transform', `translate(${centerX}, ${centerY})`);

    // Smooth transition
    if (!isInstant) {
      wordsGroupEl.style.transition = 'opacity 0.4s ease';
      wordsGroupEl.style.opacity = '0';
    }

    setTimeout(() => {
      wordsGroupEl.innerHTML = '';
      renderedWordMap.clear();

      placedWords.forEach((d) => {
        const textNode = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        textNode.textContent = d.text;
        textNode.setAttribute('text-anchor', 'middle');
        textNode.setAttribute('transform', `translate(${d.x}, ${d.y})`);
        textNode.setAttribute('font-family', config.FONT_FAMILY || 'Outfit, sans-serif');
        textNode.setAttribute('font-weight', config.FONT_WEIGHT || '700');
        textNode.setAttribute('font-size', `${d.size}px`);
        textNode.setAttribute('fill', d.color);
        textNode.setAttribute('class', 'cloud-word');
        textNode.setAttribute('data-stem', d.stem);

        // Tooltip title for inspection
        const titleNode = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        titleNode.textContent = `${d.text} (${d.count} submission${d.count > 1 ? 's' : ''})`;
        textNode.appendChild(titleNode);

        wordsGroupEl.appendChild(textNode);
        renderedWordMap.set(d.stem, { element: textNode, data: d });
      });

      wordsGroupEl.style.opacity = '1';
    }, isInstant ? 0 : 400);
  }

  /**
   * Handles incoming single submission
   * @param {Object} newRecord 
   */
  function handleNewSubmission(newRecord) {
    if (!newRecord || newRecord.is_hidden) return;

    // Check if already in memory
    const exists = allResponses.find(r => r.id === newRecord.id);
    if (!exists) {
      allResponses.push(newRecord);
    }

    updateStats();

    const activeCount = allResponses.filter(r => !r.is_hidden).length;
    const repackInterval = (window.APP_CONFIG && window.APP_CONFIG.REPACK_INTERVAL) || 25;

    // Trigger full repack every REPACK_INTERVAL responses
    if (activeCount - lastRepackCount >= repackInterval) {
      triggerRepack(false);
      return;
    }

    const stemmer = window.WordStemmer;
    const wordStem = newRecord.stem || (stemmer ? stemmer.stem(newRecord.raw_word) : newRecord.raw_word.toLowerCase());

    // If word stem already rendered, pulse it
    if (renderedWordMap.has(wordStem)) {
      const existing = renderedWordMap.get(wordStem);
      if (existing && existing.element) {
        existing.element.classList.remove('newly-added');
        void existing.element.offsetWidth; // Trigger reflow
        existing.element.classList.add('newly-added');
        existing.element.style.filter = 'drop-shadow(0 0 16px #10B981) brightness(1.6)';
        setTimeout(() => {
          if (existing.element) existing.element.style.filter = '';
        }, 1200);
      }
    } else {
      // Trigger a repack so the new word is geometrically packed into Nigeria shape
      triggerRepack(false);
    }
  }

  /**
   * Handles updated record (e.g. hidden status changed by admin)
   * @param {Object} updatedRecord 
   */
  function handleUpdatedRecord(updatedRecord) {
    if (!updatedRecord) return;

    if (updatedRecord.id === 'refresh') {
      loadInitialData();
      return;
    }

    const idx = allResponses.findIndex(r => r.id === updatedRecord.id);
    if (idx !== -1) {
      allResponses[idx] = updatedRecord;
    } else {
      allResponses.push(updatedRecord);
    }

    updateStats();
    triggerRepack(false);
  }

  /**
   * Sets up Realtime listener
   */
  function setupRealtime() {
    window.MosaicDB.subscribeRealtime({
      onInsert: (newRecord) => {
        handleNewSubmission(newRecord);
      },
      onUpdate: (updatedRecord) => {
        handleUpdatedRecord(updatedRecord);
      },
      onDelete: () => {
        loadInitialData();
      }
    });
  }

  /**
   * Starts ambient shimmer sweep across words
   * Keeps display lively and dynamic for 2+ hours
   */
  function startAmbientShimmer() {
    if (ambientIntervalId) clearInterval(ambientIntervalId);

    ambientIntervalId = setInterval(() => {
      if (renderedWordMap.size === 0) return;

      const wordsArray = Array.from(renderedWordMap.values());
      const pickCount = Math.min(Math.max(1, Math.floor(wordsArray.length * 0.15)), 4);

      // Randomly pick a few words
      for (let i = 0; i < pickCount; i++) {
        const rand = wordsArray[Math.floor(Math.random() * wordsArray.length)];
        if (rand && rand.element) {
          rand.element.classList.add('ambient-shimmer');
          setTimeout(() => {
            if (rand.element) rand.element.classList.remove('ambient-shimmer');
          }, 2200);
        }
      }
    }, 4000);
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
