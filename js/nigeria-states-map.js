// js/nigeria-states-map.js
// Interactive and Accessible Nigeria States SVG Map Component
// Displays 36 states + Federal Capital Territory (FCT)
// Integrates with Decode the State candidate options (A-D) and reveal states.

(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof root !== 'undefined') root.NigeriaStatesMap = mod;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function escape(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c] || c));
  }

  function renderMap({
    container,
    options = [],
    selectedOption = null,
    correctOption = null,
    isRevealed = false,
    interactive = true,
    onSelect = null
  }) {
    if (!container) return;
    const statesMap = (typeof window !== 'undefined' && window.NIGERIA_STATES_MAP) ||
                      (typeof globalThis !== 'undefined' && globalThis.NIGERIA_STATES_MAP) || {};
    const viewBox = (typeof window !== 'undefined' && window.NIGERIA_MAP_VIEWBOX) ||
                    (typeof globalThis !== 'undefined' && globalThis.NIGERIA_MAP_VIEWBOX) || '0 0 800 680';

    // Build map of option index by normalized state name
    const optionMap = new Map();
    options.forEach((opt, idx) => {
      if (opt) optionMap.set(String(opt).trim().toLowerCase(), idx);
    });

    const candidateStateKeys = Object.keys(statesMap);

    let pathsHtml = '';
    let badgesHtml = '';

    candidateStateKeys.forEach(stateKey => {
      const state = statesMap[stateKey];
      const optIdx = optionMap.get(state.name.toLowerCase());
      const isCandidate = optIdx !== undefined;
      const isSelected = isCandidate && selectedOption === optIdx;
      const isCorrect = isRevealed && isCandidate && correctOption === optIdx;
      const isWrong = isRevealed && isSelected && !isCorrect;

      const classes = [
        'state-polygon',
        state.isFCT ? 'is-fct' : 'is-state',
        isCandidate ? 'is-candidate' : 'is-neutral',
        isSelected ? 'is-selected' : '',
        isCorrect ? 'is-correct' : '',
        isWrong ? 'is-wrong' : ''
      ].filter(Boolean).join(' ');

      const label = state.isFCT ? 'Federal Capital Territory (FCT)' : `${state.name} State`;
      const candidateLabel = isCandidate ? `${String.fromCharCode(65 + optIdx)}: ${label}` : label;

      pathsHtml += `<path class="${classes}"
        id="map-state-${escape(stateKey.toLowerCase().replace(/\s+/g, '-'))}"
        d="${state.path}"
        data-state="${escape(state.name)}"
        data-option-index="${isCandidate ? optIdx : ''}"
        ${isCandidate && interactive && !isRevealed ? `role="button" tabindex="0" aria-pressed="${isSelected}"` : ''}
        aria-label="${escape(candidateLabel)}"
      ><title>${escape(candidateLabel)}</title></path>`;

      // Render letter badges (A, B, C, D) on candidate states
      if (isCandidate && state.center && state.center[0] && state.center[1]) {
        const [cx, cy] = state.center;
        const letter = String.fromCharCode(65 + optIdx);
        const badgeClasses = [
          'state-badge',
          isSelected ? 'badge-selected' : '',
          isCorrect ? 'badge-correct' : '',
          isWrong ? 'badge-wrong' : ''
        ].filter(Boolean).join(' ');

        badgesHtml += `<g class="${badgeClasses}" transform="translate(${cx}, ${cy})" data-option-index="${optIdx}" pointer-events="none">
          <circle r="16" class="badge-circle" />
          <text text-anchor="middle" dominant-baseline="central" class="badge-text">${isCorrect ? '✓' : letter}</text>
        </g>`;
      }
    });

    container.innerHTML = `
      <div class="nigeria-map-wrapper ${interactive ? 'is-interactive' : 'is-display'}">
        <svg viewBox="${viewBox}" class="nigeria-states-svg" role="region" aria-label="Interactive Map of Nigeria States">
          <defs>
            <filter id="map-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>
          <g class="states-layer">${pathsHtml}</g>
          <g class="badges-layer">${badgesHtml}</g>
        </svg>
        <div class="map-tooltip" id="map-tooltip" aria-hidden="true"></div>
      </div>
    `;

    // Interactive handling
    if (interactive && !isRevealed && typeof onSelect === 'function') {
      const tooltip = container.querySelector('#map-tooltip');
      const statePaths = container.querySelectorAll('.state-polygon');

      statePaths.forEach(path => {
        const optAttr = path.dataset.optionIndex;
        if (optAttr !== '' && optAttr !== undefined) {
          const optIdx = Number(optAttr);
          const handlePick = () => {
            onSelect(optIdx);
          };
          path.addEventListener('click', handlePick);
          path.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handlePick();
            }
          });
        }

        // Hover tooltip
        path.addEventListener('mouseenter', e => {
          if (!tooltip) return;
          const name = path.dataset.state;
          const opt = path.dataset.optionIndex;
          tooltip.textContent = opt !== '' && opt !== undefined
            ? `${String.fromCharCode(65 + Number(opt))}: ${name}`
            : name;
          tooltip.classList.add('visible');
        });
        path.addEventListener('mouseleave', () => {
          tooltip?.classList.remove('visible');
        });
      });
    }
  }

  return {
    renderMap
  };
});
