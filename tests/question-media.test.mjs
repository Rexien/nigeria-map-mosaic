import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizePublicQuestion,createStateEnvelope,verifyStateEnvelope} from '../lib/state-envelope.mjs';
import {safeMediaUrl} from '../lib/question-media.mjs';

const question={id:'q1',question:'Identify the object',options:['A','B','C','D'],correctOption:1,explanation:'Answer explanation',
  media:{src:'/assets/01.jpg',alt:'A carved object',timing:'question',title:'Answer in title',caption:'Answer in caption',source:'https://example.org/answer',author:'Photographer',license:'CC BY-SA 4.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/'}};
test('question media strips identifying source metadata and answer until reveal',()=>{
  for(const state of ['open','locked']) {
    const q=sanitizePublicQuestion(question,state);
    assert.equal(q.imageUrl,'/assets/01.jpg');assert.equal(q.media.author,'Photographer');
    for(const field of ['title','caption','source'])assert.equal(q.media[field],undefined);
    assert.equal(q.correctOption,undefined);assert.equal(q.explanation,undefined);
  }
  const q=sanitizePublicQuestion(question,'revealed');
  assert.equal(q.media.caption,question.media.caption);assert.equal(q.media.source,question.media.source);
  assert.equal(q.correctOption,1);
});
test('reveal-only media is absent from the whole voting envelope, including legacy aliases',()=>{
  const q={...question,imageUrl:'/secret.jpg',media:{...question.media,timing:'reveal'}};
  for(const state of ['open','locked']) {
    const envelope=createStateEnvelope({state},q);
    assert.equal(envelope.question.media,null);assert.equal(envelope.question.imageUrl,null);
    assert.ok(!JSON.stringify(envelope).includes('/assets/01.jpg'));
    assert.ok(verifyStateEnvelope(envelope));
  }
  assert.equal(sanitizePublicQuestion(q,'revealed').media.src,'/assets/01.jpg');
});
test('lobby, preparation, paused, ended and unknown states fail closed',()=>{
  for(const state of ['lobby','preparing','paused','ended','unknown'])assert.equal(sanitizePublicQuestion(question,state),null);
});
test('legacy media survives while unsafe URLs and unknown timing fail closed',()=>{
  assert.equal(sanitizePublicQuestion({...question,media:null,imageUrl:'/old.jpg',altText:'Old photo'},'open').imageUrl,'/old.jpg');
  assert.equal(sanitizePublicQuestion({...question,media:{...question.media,timing:'typo'}},'open').imageUrl,null);
  for(const url of ['javascript:alert(1)','data:image/svg+xml,test','//evil.test/x','/\\evil.test','https://user:pass@example.com/x'])assert.equal(safeMediaUrl(url),null);
});
