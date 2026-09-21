// Comprehensive Verification of ALL 24 Picture Questions Across Passport Trivia & Decode the State
import fs from 'node:fs';
import path from 'node:path';

function getJpegDimensions(buffer) {
  let i = 2;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) break;
    const marker = buffer[i + 1];
    if (marker === 0xc0 || marker === 0xc2) { // SOF0 / SOF2
      const height = buffer.readUInt16BE(i + 5);
      const width = buffer.readUInt16BE(i + 7);
      return { width, height };
    }
    const len = buffer.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

console.log('=============================================================================');
console.log('  NIAC LIVE: COMPREHENSIVE 24-IMAGE MEDIA VERIFICATION AUDIT');
console.log('=============================================================================\n');

// 1. Passport Trivia (Day 1 & Day 2)
const questionsRaw = JSON.parse(fs.readFileSync('content/questions.json', 'utf8'));
const questionsList = Array.isArray(questionsRaw) ? questionsRaw : (questionsRaw.questions || []);
const triviaWithImages = questionsList.filter(q => q.media && q.media.src);

console.log(`--- [1/2] Passport Trivia Picture Questions (${triviaWithImages.length} images) ---`);
let triviaPass = 0;
for (const q of triviaWithImages) {
  const relPath = q.media.src.replace(/^\//, '');
  const exists = fs.existsSync(relPath);
  const size = exists ? fs.statSync(relPath).size : 0;
  const buf = exists ? fs.readFileSync(relPath) : Buffer.alloc(0);
  const dims = exists ? getJpegDimensions(buf) : { width: 0, height: 0 };
  const timing = q.media.timing || 'question';
  const spoilerCheck = (q.media.alt || '').toLowerCase().includes(q.options[q.correctOption].toLowerCase()) ? 'FAIL (Spoils answer!)' : 'PASS (Neutral)';

  console.log(`\n• Day ${q.day}, Question ${q.order} [${q.category}]`);
  console.log(`  Question: "${q.question}"`);
  console.log(`  Timing:   ${timing === 'reveal' ? 'REVEAL-ONLY (hidden during voting)' : 'DURING QUESTION'}`);
  console.log(`  File:     ${q.media.src} (${(size / 1024).toFixed(1)} KB, ${dims.width}x${dims.height}px)`);
  console.log(`  Alt Text: "${q.media.alt}"`);
  console.log(`  Spoiler:  ${spoilerCheck}`);
  console.log(`  Correct:  (${String.fromCharCode(65 + q.correctOption)}) ${q.options[q.correctOption]}`);

  if (exists && size > 10000 && dims.width > 0 && dims.height > 0) triviaPass++;
}
console.log(`\n✓ Passport Trivia Images Verified: ${triviaPass} / ${triviaWithImages.length} PASS\n`);

// 2. Decode the State (6 Rounds, 18 Clues)
const decodeRaw = JSON.parse(fs.readFileSync('content/decode-rounds.json', 'utf8'));
const decodeRounds = Array.isArray(decodeRaw) ? decodeRaw : (decodeRaw.rounds || []);
let decodePass = 0;
let totalDecodeClues = 0;

console.log(`--- [2/2] Decode the State Picture Clues (6 Rounds x 3 Clues = 18 images) ---`);
for (const round of decodeRounds) {
  const stateName = round.state || round.stateName || round.geoId;
  console.log(`\n=============================================================================`);
  console.log(`Round ${round.round || round.id}: Target State = ${stateName} (Zone: ${round.zone})`);
  console.log(`=============================================================================`);

  const clueMediaList = round.clueMedia || [];
  for (let i = 0; i < clueMediaList.length; i++) {
    totalDecodeClues++;
    const media = clueMediaList[i];
    const clueText = round.clues?.[i] || '';
    const relPath = media.src.replace(/^\//, '');
    const exists = fs.existsSync(relPath);
    const size = exists ? fs.statSync(relPath).size : 0;
    const buf = exists ? fs.readFileSync(relPath) : Buffer.alloc(0);
    const dims = exists ? getJpegDimensions(buf) : { width: 0, height: 0 };
    const textSpoiler = clueText.toLowerCase().includes(stateName.toLowerCase()) ? 'SPOILS!' : 'OK (Neutral)';
    const altSpoiler = (media.alt || '').toLowerCase().includes(stateName.toLowerCase()) ? 'SPOILS!' : 'OK (Neutral)';

    console.log(`  Clue ${i + 1}:`);
    console.log(`    File:     ${media.src} (${(size / 1024).toFixed(1)} KB, ${dims.width}x${dims.height}px)`);
    console.log(`    Alt Text: "${media.alt}" [${altSpoiler}]`);
    console.log(`    Caption:  "${media.caption}"`);
    console.log(`    Clue:     "${clueText.slice(0, 75)}..." [${textSpoiler}]`);

    if (exists && size > 10000 && dims.width > 0 && dims.height > 0) decodePass++;
  }
}

console.log(`\n✓ Decode the State Clue Images Verified: ${decodePass} / ${totalDecodeClues} PASS\n`);

console.log('=============================================================================');
console.log(`  TOTAL VERIFIED MEDIA ASSETS: ${triviaPass + decodePass} / 24 PASSED PERFECTLY`);
console.log('=============================================================================\n');
