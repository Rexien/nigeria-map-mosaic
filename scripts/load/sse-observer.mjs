// scripts/load/sse-observer.mjs
// Opens persistent native HTTP/HTTPS SSE streams to the gateway and measures state fanout.

import https from 'node:https';
import http from 'node:http';

export class SSEObserverPool {
  constructor(options = {}) {
    this.gatewayUrl = (options.gatewayUrl || 'https://92.4.146.91.sslip.io').replace(/\/$/, '');
    this.participants = options.participants || [];
    this.connections = new Map();
    this.eventsReceived = [];
    this.errors = [];
    this.isRunning = false;
    this.requests = new Set();
    this.commandStarts = new Map();
  }

  async start() {
    this.isRunning = true;
    const url = new URL(`${this.gatewayUrl}/gateway/stream`);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    console.log(`[SSE Observer] Opening ${this.participants.length} persistent SSE streams to ${url.href}...`);

    for (const p of this.participants) {
      if (!this.isRunning) break;

      const req = lib.request(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Participant-Id': p.id
        }
      }, res => {
        if (res.statusCode !== 200) {
          this.errors.push({ participantId: p.id, status: res.statusCode, error: 'Non-200 SSE response' });
          res.resume();
          req.destroy();
          return;
        }

        const connInfo = {
          participantId: p.id,
          connectedAt: Date.now(),
          lastHeartbeat: Date.now(),
          events: []
        };
        this.connections.set(p.id, connInfo);

        let buffer = '';
        let currentEvent = null;
        let currentData = null;
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep last incomplete line

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith(':')) {
              // Heartbeat comment
              connInfo.lastHeartbeat = Date.now();
              continue;
            }
            if (trimmed.startsWith('event:')) {
              currentEvent = trimmed.slice(6).trim();
            } else if (trimmed.startsWith('data:')) {
              currentData = trimmed.slice(5).trim();
            } else if (trimmed === '' && currentData) {
              // Dispatch event block
              try {
                const parsed = JSON.parse(currentData);
                const receivedAt = Date.now();
                const record = {
                  participantId: p.id,
                  event: currentEvent || 'message',
                  version: parsed.version,
                  state: parsed.state,
                  activity: parsed.activity,
                  questionId: parsed.question?.id || null,
                  serverNow: parsed.serverNow,
                  receivedAt
                };
                connInfo.events.push(record);
                this.eventsReceived.push(record);
              } catch (e) {
                // non-json or partial
              }
              currentEvent = null;
              currentData = null;
            }
          }
        });

        res.on('end', () => {
          this.connections.delete(p.id);
        });
        res.on('error', err => {
          this.errors.push({ participantId: p.id, error: err.message });
          this.connections.delete(p.id);
        });
      });

      req.on('error', err => {
        this.errors.push({ participantId: p.id, error: err.message });
        this.connections.delete(p.id);
      });
      this.requests.add(req);
      req.on('close',()=>{this.requests.delete(req);this.connections.delete(p.id);});
      req.end();
      // tiny yield to stagger socket handshake
      await new Promise(r => setTimeout(r, 15));
    }
  }

  async waitForConnections(targetCount, timeoutMs = 15000) {
    const start = Date.now();
    while (this.connections.size < targetCount) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timeout waiting for SSE connections: ${this.connections.size}/${targetCount} connected in ${timeoutMs}ms`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    console.log(`[SSE Observer] All ${this.connections.size} SSE connections established and listening.`);
  }

  getFanoutStats(version) {
    const unique = new Map();
    for(const event of this.eventsReceived.filter(e=>e.version===version)) {
      if(!unique.has(event.participantId))unique.set(event.participantId,event);
    }
    const matches = [...unique.values()];
    if (!matches.length) return null;

    const timestamps = matches.map(m => m.receivedAt);
    const min = Math.min(...timestamps);
    const max = Math.max(...timestamps);
    const startedAt = this.commandStarts.get(version);
    const latencies = timestamps.map(t => t - (startedAt ?? min));
    latencies.sort((a, b) => a - b);

    const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
    const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;

    return {
      version,
      measurement: startedAt == null ? 'delivery-spread-only' : 'command-to-receipt',
      receivedCount: matches.length,
      fanoutDurationMs: max - min,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99
    };
  }

  async waitForFanout(version,targetCount,timeoutMs=3000){
    const start=Date.now();
    while(Date.now()-start<=timeoutMs){
      const stats=this.getFanoutStats(version);
      if(stats?.receivedCount===targetCount)return stats;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    return this.getFanoutStats(version);
  }

  stop() {
    this.isRunning = false;
    for (const req of this.requests) req.destroy();
    this.requests.clear();
    this.connections.clear();
    console.log('[SSE Observer] Closed all listener streams.');
  }
}
