// NIAC Live Client Transport Module (Phase 2)
// Handles unified state delivery across participant, projector and activities views.
// Supports connecting, live, fallback, and offline states with jittered backoff.

(function(root) {
  'use strict';

  let currentState = null;
  let connectionState = 'connecting'; // 'connecting' | 'live' | 'fallback' | 'offline'
  let clockOffset = 0; // serverNow - localNow
  let eventSource = null;
  let fallbackTimer = null;
  let retryCount = 0;
  let inFlight = false;
  let listeners = { state: new Set(), status: new Set() };
  let options = {
    bootstrapUrl: '/api/bootstrap',
    fallbackUrl: '/api/state',
    sseUrl: '/api/live/stream',
    fallbackIntervalMinMs: 3000,
    fallbackIntervalMaxMs: 5000,
    maxBackoffMs: 20000
  };

  function updateStatus(newStatus) {
    if (connectionState === newStatus) return;
    connectionState = newStatus;
    listeners.status.forEach(fn => {
      try { fn(newStatus); } catch (e) { console.error(e); }
    });

    // Update connection status DOM indicator if present
    const el = document.getElementById('connection-status');
    if (el) {
      el.classList.toggle('online', newStatus === 'live');
      el.classList.toggle('fallback', newStatus === 'fallback');
      el.classList.toggle('offline', newStatus === 'offline');
      el.classList.toggle('connecting', newStatus === 'connecting');
      const text = el.querySelector('.status-text') || el;
      if (newStatus === 'live') text.textContent = 'Live';
      else if (newStatus === 'connecting') text.textContent = 'Connecting…';
      else if (newStatus === 'fallback') text.textContent = 'Polling';
      else if (newStatus === 'offline') text.textContent = 'Offline';
    }
  }

  function handleStateUpdate(newState) {
    if (!newState) return;
    if (newState.serverNow) {
      clockOffset = new Date(newState.serverNow).getTime() - Date.now();
    }
    const isNewer = !currentState || (Number(newState.version || 0) > Number(currentState.version || 0));
    const isCorrection = currentState && (Number(newState.version || 0) === Number(currentState.version || 0)) && (newState.checksum && newState.checksum !== currentState.checksum);

    if (isNewer || isCorrection) {
      currentState = newState;
      listeners.state.forEach(fn => {
        try { fn(newState); } catch (e) { console.error(e); }
      });
    }
  }

  function getJitteredFallbackInterval() {
    const min = options.fallbackIntervalMinMs;
    const max = options.fallbackIntervalMaxMs;
    return min + Math.floor(Math.random() * (max - min));
  }

  async function pollFallback() {
    if (inFlight || document.hidden || !navigator.onLine) return;
    inFlight = true;
    try {
      const url = `${options.fallbackUrl}?v=${currentState?.version || 0}&t=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      handleStateUpdate(data);
      if (connectionState !== 'live') {
        updateStatus('fallback');
      }
      retryCount = 0;
    } catch (err) {
      if (!navigator.onLine) {
        updateStatus('offline');
      } else {
        updateStatus('fallback');
      }
    } finally {
      inFlight = false;
      scheduleNextPoll();
    }
  }

  function scheduleNextPoll() {
    clearTimeout(fallbackTimer);
    if (connectionState === 'live') return;
    const delay = getJitteredFallbackInterval();
    fallbackTimer = setTimeout(pollFallback, delay);
  }

  function connectSSE(streamUrl) {
    if (!streamUrl || typeof EventSource === 'undefined') {
      startFallbackPolling();
      return;
    }

    try {
      if (eventSource) {
        eventSource.close();
      }

      eventSource = new EventSource(streamUrl);

      eventSource.onopen = function() {
        retryCount = 0;
        updateStatus('live');
        clearTimeout(fallbackTimer);
      };

      eventSource.addEventListener('state', function(e) {
        try {
          const data = JSON.parse(e.data);
          handleStateUpdate(data);
        } catch (err) {
          console.error('Error parsing SSE state:', err);
        }
      });

      eventSource.onerror = function() {
        eventSource.close();
        eventSource = null;
        if (!navigator.onLine) {
          updateStatus('offline');
        } else {
          updateStatus('fallback');
        }
        startFallbackPolling();
        scheduleSSEReconnect(streamUrl);
      };
    } catch (e) {
      startFallbackPolling();
    }
  }

  function scheduleSSEReconnect(streamUrl) {
    retryCount++;
    const backoff = Math.min(options.maxBackoffMs, 1000 * Math.pow(1.5, retryCount));
    const jitter = Math.random() * 1500;
    const totalDelay = backoff + jitter;

    setTimeout(() => {
      if (navigator.onLine && !document.hidden) {
        connectSSE(streamUrl);
      }
    }, totalDelay);
  }

  function startFallbackPolling() {
    scheduleNextPoll();
  }

  async function bootstrap() {
    updateStatus('connecting');
    try {
      const res = await fetch(options.bootstrapUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Bootstrap failed: HTTP ${res.status}`);
      const data = await res.json();
      if (data.state) handleStateUpdate(data.state);
      if (data.transport?.gatewaySse) {
        options.sseUrl = data.transport.gatewaySse;
        connectSSE(options.sseUrl);
      } else {
        startFallbackPolling();
      }
      root.NIACApi?.configureGateway(data.transport?.gatewayAnswer||null);
    } catch (err) {
      console.warn('Bootstrap failed, falling back to direct polling:', err);
      updateStatus(navigator.onLine ? 'fallback' : 'offline');
      pollFallback();
    }
  }

  function init(userOptions = {}) {
    Object.assign(options, userOptions);

    window.addEventListener('online', () => {
      updateStatus('connecting');
      bootstrap();
    });

    window.addEventListener('offline', () => {
      updateStatus('offline');
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        if (connectionState === 'fallback' || connectionState === 'offline') {
          pollFallback();
        }
      }
    });

    bootstrap();
  }

  function getRemainingSeconds() {
    if (!currentState || !currentState.deadlineAt) return 0;
    const deadline = new Date(currentState.deadlineAt).getTime();
    const serverNow = Date.now() + clockOffset;
    return Math.max(0, Math.ceil((deadline - serverNow) / 1000));
  }

  root.NIACTransport = {
    init,
    bootstrap,
    getState: () => currentState,
    getStatus: () => connectionState,
    getRemainingSeconds,
    getClockOffset: () => clockOffset,
    onState: fn => { listeners.state.add(fn); if (currentState) fn(currentState); },
    onStatus: fn => { listeners.status.add(fn); fn(connectionState); },
    refreshNow: () => pollFallback(),
    destroy: () => {
      if (eventSource) eventSource.close();
      clearTimeout(fallbackTimer);
      listeners.state.clear();
      listeners.status.clear();
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
