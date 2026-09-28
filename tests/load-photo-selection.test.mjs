import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleLoadQuestions } from '../scripts/load/run-tier.mjs';

test('photo cloud rehearsal only opens approved non-void Passport questions with a visible photo', () => {
  const questions = [
    { id: 'text', activity: 'passport', reviewStatus: 'approved' },
    { id: 'reveal-photo', activity: 'passport', reviewStatus: 'approved', media: { src: '/reveal.jpg', timing: 'reveal' } },
    { id: 'decode-photo', activity: 'decode', reviewStatus: 'approved', media: { src: '/decode.jpg', timing: 'question' } },
    { id: 'draft', activity: 'passport', reviewStatus: 'draft', media: { src: '/draft.jpg', timing: 'question' } },
    { id: 'void', activity: 'passport', reviewStatus: 'approved', isVoid: true, media: { src: '/void.jpg', timing: 'question' } },
    { id: 'valid', activity: 'passport', reviewStatus: 'approved', media: { src: '/valid.jpg', timing: 'question' } }
  ];
  assert.deepEqual(eligibleLoadQuestions(questions, 'photo').map(q => q.id), ['valid']);
  assert.deepEqual(eligibleLoadQuestions(questions).map(q => q.id), ['text', 'reveal-photo', 'decode-photo', 'valid']);
});
