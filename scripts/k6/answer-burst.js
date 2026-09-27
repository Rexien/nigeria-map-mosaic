import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// Custom metrics for answer tracking
export const answerAckDuration = new Trend('answer_ack_duration', true);
export const primaryAckDuration = new Trend('primary_ack_duration', true);
export const retryAckDuration = new Trend('retry_ack_duration', true);
export const acceptedAnswers = new Counter('accepted_answers');
export const duplicateAnswers = new Counter('duplicate_answers');
export const failedAnswers = new Counter('failed_answers');

const manifestPath = __ENV.MANIFEST_PATH;
const gatewayUrl = (__ENV.GATEWAY_URL || 'https://92.4.146.91.sslip.io').replace(/\/$/, '');
const questionId = __ENV.QUESTION_ID;
const sessionId = __ENV.SESSION_ID;
const burstSeconds = Number(__ENV.BURST_SECONDS || 5);
const duplicatePercent = Number(__ENV.DUPLICATE_PERCENT || 10);

if (!manifestPath) {
  throw new Error('MANIFEST_PATH environment variable is required');
}
if (!questionId || !sessionId) {
  throw new Error('QUESTION_ID and SESSION_ID environment variables are required');
}

// Load participant credentials during initialization
const manifest = JSON.parse(open(manifestPath));
const participants = manifest.participants || [];

if (!participants.length) {
  throw new Error('No participants found in manifest');
}

export const options = {
  scenarios: {
    answer_burst: {
      executor: 'per-vu-iterations',
      vus: participants.length,
      iterations: 1,
      maxDuration: '90s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)'],
  discardResponseBodies: false,
};

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Calculate duplicate count: 10% of participants (e.g. 75 for 750 participants)
const numDuplicates = Math.floor(participants.length * (duplicatePercent / 100));

export default function() {
  const vuIndex = __VU - 1;
  const p = participants[vuIndex];
  if (!p) {
    failedAnswers.add(1);
    return;
  }

  // Stagger primary submission over burst window (5 seconds)
  const offsetMs = Math.floor((vuIndex * burstSeconds * 1000) / participants.length);
  if (offsetMs > 0) {
    sleep(offsetMs / 1000);
  }

  const optionIndex = vuIndex % 4;
  const idempotencyKey = uuidv4();

  const payload = JSON.stringify({
    credential: p.credential,
    sessionId: sessionId,
    questionId: questionId,
    optionIndex: optionIndex,
    idempotencyKey: idempotencyKey,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${p.credential}`,
    },
    tags: { attempt_kind: 'primary', participant_id: p.id },
  };

  // Primary Answer Submission
  const res1 = http.post(`${gatewayUrl}/gateway/answers`, payload, params);
  const dur1 = res1.timings.duration;

  answerAckDuration.add(dur1);
  primaryAckDuration.add(dur1);

  let primaryAccepted = false;
  try {
    const body1 = JSON.parse(res1.body || '{}');
    primaryAccepted = res1.status === 200 && Boolean(body1.accepted);
  } catch (e) {
    primaryAccepted = false;
  }

  const check1 = check(res1, {
    'primary status is 200': (r) => r.status === 200,
    'primary accepted': () => primaryAccepted,
  });

  if (check1) {
    acceptedAnswers.add(1);
  } else {
    failedAnswers.add(1);
  }

  // Duplicate retry simulation for designated 10% (e.g. first numDuplicates VUs)
  if (vuIndex < numDuplicates) {
    // Human-like retry delay: 300ms + random(0..500ms)
    const retryDelaySec = (300 + Math.random() * 500) / 1000;
    sleep(retryDelaySec);

    const retryParams = {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${p.credential}`,
      },
      tags: { attempt_kind: 'retry', participant_id: p.id },
    };

    const res2 = http.post(`${gatewayUrl}/gateway/answers`, payload, retryParams);
    const dur2 = res2.timings.duration;

    answerAckDuration.add(dur2);
    retryAckDuration.add(dur2);

    let retryDuplicate = false;
    try {
      const body2 = JSON.parse(res2.body || '{}');
      retryDuplicate = res2.status === 200 && body2.duplicate === true;
    } catch (e) {
      retryDuplicate = false;
    }

    const check2 = check(res2, {
      'retry status is 200': (r) => r.status === 200,
      'retry acknowledged as duplicate': () => retryDuplicate,
    });

    if (check2) {
      duplicateAnswers.add(1);
    } else {
      failedAnswers.add(1);
    }
  }
}
