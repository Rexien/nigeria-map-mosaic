import test from 'node:test';
import assert from 'node:assert/strict';
await import('../js/core.js');
const c=globalThis.NIACCore;

test('lens validation preserves a multi-word phrase',()=>{const r=c.validateLensPhrase('  Egusi   soup  ');assert.deepEqual(r,{valid:true,value:'Egusi soup'})});
test('lens validation blocks blank and over-limit submissions and strips markup delimiters',()=>{assert.equal(c.validateLensPhrase('   ').valid,false);assert.equal(c.validateLensPhrase('<script>').value,'script');assert.equal(c.validateLensPhrase('x'.repeat(73)).valid,false)});
test('aliases are sanitized and length constrained',()=>{assert.equal(c.validateAlias(' <Ada> ').value,'Ada');assert.equal(c.validateAlias('x').valid,false)});
test('recovery codes normalize safely without becoming display-name identity',()=>{assert.equal(c.normalizeRecoveryCode(' ab12-cd34 '),'AB12-CD34');assert.equal(c.normalizeRecoveryCode('Ada'),null)});
test('passport scoring awards 1000 only for a correct non-void answer',()=>{assert.equal(c.quizPoints({activity:'passport',correct:true}),1000);assert.equal(c.quizPoints({activity:'passport',correct:false}),0);assert.equal(c.quizPoints({activity:'passport',correct:true,voided:true}),0)});
test('decode scoring awards 1000 for correct answers with speed tie-break',()=>{assert.equal(c.quizPoints({activity:'decode',correct:true}),1000);assert.equal(c.quizPoints({activity:'decode',correct:false}),0)});
test('late answers are rejected against the server deadline',()=>{const r=c.evaluateAttempt({state:'open',deadline:'2026-09-29T10:00:20Z',receivedAt:'2026-09-29T10:00:21Z'});assert.equal(r.reason,'ANSWER_LATE')});
test('duplicate answers are idempotently acknowledged without a new award',()=>{const r=c.evaluateAttempt({existingAnswer:{points:1000},state:'locked'});assert.deepEqual(r,{accepted:true,duplicate:true,points:1000})});
test('Day 1 and Day 2 scores accumulate while decode and voids do not',()=>{const r=c.accumulateDays([{day:1,activity:'passport',points:1000},{day:2,activity:'passport',points:2000},{day:1,activity:'decode',points:3},{day:1,activity:'passport',points:1000,voided:true}]);assert.deepEqual(r,{day1:1000,day2:2000,combined:3000})});
test('passport stamps are achievements independent from score',()=>{const r=c.stampProgress([{activity:'passport',category:'food',correct:true}]);assert.equal(r.find(x=>x.category==='food').earned,true);assert.equal(r.find(x=>x.category==='language').earned,false)});
test('ranking tie-breaks by score, correct count, response time, then registration',()=>{const rows=[{id:'late',totalScore:1000,correctAnswers:1,correctResponseMs:1000,registeredAt:'2026-01-02'},{id:'fast',totalScore:1000,correctAnswers:1,correctResponseMs:900,registeredAt:'2026-01-03'},{id:'more',totalScore:1000,correctAnswers:2,correctResponseMs:5000,registeredAt:'2026-01-04'}].sort(c.compareRank);assert.deepEqual(rows.map(x=>x.id),['more','fast','late'])});
test('reconnection keeps a confirmed answer authoritative',()=>{assert.deepEqual(c.reconcileSubmission({optionIndex:2,confirmed:false},{optionIndex:2,confirmed:true}),{optionIndex:2,confirmed:true})});
test('correct answer is absent from open public state and present after reveal',()=>{const q={id:'q',options:['a','b','c','d'],correctOption:2,explanation:'why'};assert.equal('correctOption' in c.publicQuestion(q,'open'),false);assert.equal(c.publicQuestion(q,'revealed').correctOption,2)});
test('the host state machine blocks invalid automatic progression',()=>{assert.equal(c.canTransition('open','revealed'),false);assert.equal(c.canTransition('open','locked'),true);assert.equal(c.canTransition('locked','revealed'),true)});
