import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { eligibleLoadQuestions, participantPhotoPath } from '../scripts/load/run-tier.mjs';

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

test('photo rehearsal downloads the same lightweight image as participant phones', () => {
  assert.equal(participantPhotoPath('/assets/trivia/01.jpg'), '/assets/trivia/01-mobile.webp');
  assert.equal(participantPhotoPath('/assets/trivia/03.jpg'), '/assets/trivia/03-mobile.webp');
  assert.equal(participantPhotoPath('/assets/trivia/suya-event.png'), '/assets/trivia/suya-event.png');
});

test('every participant photo exists and the largest clue is below 125 KB', async () => {
  for (const name of ['01', '02', '03', '04', '10']) {
    const size = (await stat(new URL(`../assets/trivia/${name}-mobile.webp`, import.meta.url))).size;
    assert.ok(size > 1000 && size < 125000, `${name} mobile image was ${size} bytes`);
  }
});
