// scripts/load/client-worker.mjs
// Dispatches participant answers to the Oracle Gateway and records individual latencies and duplicates.

import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import diagnosticsChannel from 'node:diagnostics_channel';

const activeRequest = new AsyncLocalStorage();
const requestTimings = new WeakMap();
const socketTimings = new WeakMap();
let diagnosticsInstalled = false;

// Observe Node's existing fetch dispatcher; this does not replace its Agent or sockets.
export function installAnswerDiagnostics() {
  if (diagnosticsInstalled) return;
  diagnosticsInstalled = true;

  diagnosticsChannel.channel('undici:request:create').subscribe(({ request }) => {
    const timing = activeRequest.getStore();
    if (!timing) return;
    requestTimings.set(request, timing);
    timing.requestCreatedAt = new Date().toISOString();
  });
  diagnosticsChannel.channel('undici:client:connected').subscribe(({ socket }) => {
    socketTimings.set(socket, { connectedAt: Date.now(), uses: 0 });
  });
  diagnosticsChannel.channel('undici:client:sendHeaders').subscribe(({ request, socket }) => {
    const timing = requestTimings.get(request);
    if (!timing) return;
    timing.headersSentAt = new Date().toISOString();
    timing.headersSentPerf = performance.now();
    timing.requestToSendHeadersMs = timing.headersSentPerf - timing.startedPerf;
    timing.alpnProtocol = socket.alpnProtocol || 'http/1.1';
    const connection = socketTimings.get(socket);
    if (connection) {
      connection.uses += 1;
      timing.socketUseNumber = connection.uses;
      timing.socketConnectedAt = new Date(connection.connectedAt).toISOString();
    }
  });
  diagnosticsChannel.channel('undici:request:headers').subscribe(({ request }) => {
    const timing = requestTimings.get(request);
    if (!timing) return;
    timing.firstByteAt = new Date().toISOString();
    timing.firstBytePerf = performance.now();
    if (timing.headersSentPerf != null) timing.headersSentToFirstByteMs = timing.firstBytePerf - timing.headersSentPerf;
  });
}

function startTiming() {
  return { startedAt: new Date().toISOString(), startedPerf: performance.now() };
}

function finishTiming(timing) {
  const finishedPerf = performance.now();
  return {
    startedAt: timing.startedAt,
    requestCreatedAt: timing.requestCreatedAt || null,
    headersSentAt: timing.headersSentAt || null,
    firstByteAt: timing.firstByteAt || null,
    finishedAt: new Date().toISOString(),
    fetchStartToSendHeadersMs: timing.requestToSendHeadersMs == null ? null : Number(timing.requestToSendHeadersMs.toFixed(2)),
    requestCreatedToSocketConnectedMs: timing.socketUseNumber === 1 && timing.requestCreatedAt && timing.socketConnectedAt
      ? Math.max(0, Date.parse(timing.socketConnectedAt) - Date.parse(timing.requestCreatedAt)) : null,
    sendHeadersToFirstByteMs: timing.headersSentToFirstByteMs == null ? null : Number(timing.headersSentToFirstByteMs.toFixed(2)),
    firstByteToFinishedMs: timing.firstBytePerf == null ? null : Number((finishedPerf - timing.firstBytePerf).toFixed(2)),
    socketUseNumber: timing.socketUseNumber || null,
    socketConnectedAt: timing.socketConnectedAt || null,
    alpnProtocol: timing.alpnProtocol || null
  };
}

export async function submitAnswer(options = {}) {
  const {
    gatewayUrl,
    participant,
    sessionId,
    questionId,
    optionIndex,
    fallbackUrl = null,
    isDuplicate = false,
    existingKey = null,
    bypassSecret = null
  } = options;

  const idempotencyKey = existingKey || crypto.randomUUID();
  const body = {
    credential: participant.credential,
    sessionId,
    questionId,
    optionIndex,
    idempotencyKey
  };

  const t0 = performance.now();
  installAnswerDiagnostics();
  const gatewayTiming = startTiming();
  let gatewayTimingResult = null;
  let fallbackTiming = null;
  let fallbackTimingResult = null;
  const metadata = { participantId:participant.id, questionId, sessionId, optionIndex,
    idempotencyKey, attemptKind:isDuplicate?'retry':'first' };
  let res, data;
  let routedTo = 'gateway';

  try {
    res = await activeRequest.run(gatewayTiming, () => fetch(`${gatewayUrl}/gateway/answers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${participant.credential}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    }));

    // Gateway returns 200 on accepted/duplicate, or 4xx/5xx
    if (!res.ok && res.status >= 500 && fallbackUrl) {
      throw new Error(`Gateway HTTP ${res.status}`);
    }
    data = await res.json();
    gatewayTimingResult = finishTiming(gatewayTiming);
  } catch (err) {
    gatewayTimingResult ||= finishTiming(gatewayTiming);
    if (fallbackUrl && participant.token) {
      // Fallback to Vercel authority
      routedTo = 'fallback';
      fallbackTiming = startTiming();
      const fbHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${participant.token}`
      };
      if (bypassSecret) fbHeaders['x-vercel-protection-bypass'] = bypassSecret;

      try {res = await activeRequest.run(fallbackTiming, () => fetch(`${fallbackUrl}/api/answers`, {
        method: 'POST',
        headers: fbHeaders,
        body: JSON.stringify({
          sessionId,
          questionId,
          optionIndex,
          idempotencyKey
        }),
        signal: AbortSignal.timeout(8000)
      }));
      data = await res.json().catch(() => ({}));
      fallbackTimingResult = finishTiming(fallbackTiming);
      } catch(error) {
        return {...metadata,status:0,accepted:false,duplicate:false,error:error.name,
          errorCode:error.cause?.code || error.code || null,durationMs:performance.now()-t0,routedTo,
          timing:{gateway:gatewayTimingResult,fallback:finishTiming(fallbackTiming)}};
      }
    } else {
      return {
        ...metadata,
        status: 0,
        accepted: false,
        error: err.name,
        errorCode: err.cause?.code || err.code || null,
        durationMs: performance.now() - t0,
        routedTo,
        timing: { gateway: gatewayTimingResult }
      };
    }
  }

  const durationMs = performance.now() - t0;
  return {
    ...metadata,
    status: res.status,
    accepted: res.ok && Boolean(data?.accepted || data?.recorded),
    duplicate: res.ok && data?.duplicate === true,
    answerId: data?.answerId || null,
    durationMs,
    routedTo,
    timing: {
      gateway: gatewayTimingResult,
      ...(fallbackTiming ? { fallback: fallbackTimingResult } : {})
    },
    idempotencyKey
  };
}

export function computeLatencyPercentiles(durations) {
  if (!durations.length) return { p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))] || 0;
  const sum = durations.reduce((a, b) => a + b, 0);
  return {
    count: durations.length,
    p50: Number(p(0.50).toFixed(2)),
    p95: Number(p(0.95).toFixed(2)),
    p99: Number(p(0.99).toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    avg: Number((sum / durations.length).toFixed(2))
  };
}
