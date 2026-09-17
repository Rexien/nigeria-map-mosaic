import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {questions, resultFor} from '../review/draft.js';
import {renderScreen,mediaHTML} from '../review/render.js';
import {allowedPath,createReviewServer} from '../scripts/review-server.mjs';

test('draft has 24 valid questions, balanced daily answers, and preserves originals',()=>{
  assert.equal(questions.length,24);
  assert.equal(new Set(questions.map(q=>q.id)).size,24);
  for(const day of [1,2]){
    const daily=questions.filter(q=>q.day===day);assert.equal(daily.length,12);
    assert.deepEqual([0,1,2,3].map(i=>daily.filter(q=>q.correctOption===i).length),[3,3,3,3]);
  }
  for(const q of questions){assert.equal(q.options.length,4);assert.ok(q.explanation);assert.ok(q.original);assert.ok(q.durationSeconds>=20);}
});
test('every question renders correctly in every preview state',()=>{
  for(const q of questions)for(const view of ['phone','projector'])for(const state of ['open','correct','wrong','timeout','lobby']){
    const html=renderScreen(q,state,view);
    assert.ok(!html.includes('undefined'));
    if(state==='open'){assert.ok(!html.includes('Why:</strong>'));assert.ok(!html.includes('class="notice result-notice'));}
    if(state==='lobby')assert.ok(!html.includes(q.question));
    if(['correct','wrong','timeout'].includes(state))assert.match(html,view==='phone'?/Correct|correct answer/:/display-option correct/);
  }
});
test('wrong answers and timeouts get zero points; selection locks without revealing',()=>{
  const q=questions[3];
  assert.equal(resultFor(q,'wrong').correct,false);
  assert.match(renderScreen(q,'wrong','phone'),/\+0 points/);
  assert.match(renderScreen(q,'timeout','phone'),/Time’s up/);
  const selected=renderScreen(q,'open','phone',0);
  assert.equal((selected.match(/data-option="\d" disabled/g)||[]).length,4);
  assert.ok(!selected.includes('Correct answer:'));
});
test('all included assets exist and carry source, author, licence and neutral alt text',async()=>{
  for(const q of questions.filter(q=>q.media)){
    assert.ok(q.media.source.startsWith('https://'));assert.ok(q.media.author);assert.ok(q.media.licenseUrl);
    assert.ok((await stat(new URL('..'+q.media.src,import.meta.url))).size>1000);
    if(q.media.timing==='question')assert.ok(q.fallback);
  }
  const fake={media:{src:'secret-reveal.jpg',timing:'reveal'}};
  assert.equal(mediaHTML(fake,false),'');
});
test('server exposes only preview assets and styles, never live APIs or secrets',async()=>{
  for(const path of ['/api/admin/action','/.env','/config.js','/content/questions.json','/review/../.env','/js/app.js'])assert.equal(allowedPath(path),false);
  const server=createReviewServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const html=await fetch(base+'/review/index.html');assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy'),/connect-src 'none'/);
    assert.equal((await fetch(base+'/api/admin/action',{method:'POST'})).status,404);
    assert.equal((await fetch(base+'/.env')).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('preview code has no live transport, authentication or persistent answer writes',async()=>{
  for(const name of ['screen.js','review.js','render.js','draft.js']){
    const source=await readFile(new URL('../review/'+name,import.meta.url),'utf8');
    assert.doesNotMatch(source,/fetch\(|localStorage|NIACTransport|BroadcastChannel|\/api\//);
  }
});
