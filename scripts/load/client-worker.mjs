// scripts/load/client-worker.mjs
// Dispatches participant answers to the Oracle Gateway and records individual latencies and duplicates.

import crypto from 'node:crypto';

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
  const metadata = { participantId:participant.id, questionId, sessionId, optionIndex,
    idempotencyKey, attemptKind:isDuplicate?'retry':'first' };
  let res, data;
  let routedTo = 'gateway';

  try {
    res = await fetch(`${gatewayUrl}/gateway/answers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${participant.credential}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });

    // Gateway returns 200 on accepted/duplicate, or 4xx/5xx
    if (!res.ok && res.status >= 500 && fallbackUrl) {
      throw new Error(`Gateway HTTP ${res.status}`);
    }
    data = await res.json();
  } catch (err) {
    if (fallbackUrl && participant.token) {
      // Fallback to Vercel authority
      routedTo = 'fallback';
      const fbHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${participant.token}`
      };
      if (bypassSecret) fbHeaders['x-vercel-protection-bypass'] = bypassSecret;

      try {res = await fetch(`${fallbackUrl}/api/answers`, {
        method: 'POST',
        headers: fbHeaders,
        body: JSON.stringify({
          sessionId,
          questionId,
          optionIndex,
          idempotencyKey
        }),
        signal: AbortSignal.timeout(8000)
      });
      data = await res.json().catch(() => ({}));
      } catch(error) {
        return {...metadata,status:0,accepted:false,duplicate:false,error:error.name,
          errorCode:error.cause?.code || error.code || null,durationMs:performance.now()-t0,routedTo};
      }
    } else {
      return {
        ...metadata,
        status: 0,
        accepted: false,
        error: err.name,
        errorCode: err.cause?.code || err.code || null,
        durationMs: performance.now() - t0,
        routedTo
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
