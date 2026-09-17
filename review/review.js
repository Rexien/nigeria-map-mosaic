import {questions, escapeHTML as e} from './draft.js';
const $ = id => document.getElementById(id);
const select = $('question-select');
select.innerHTML = [1,2].map(day=>`<optgroup label="Day ${day}">${questions.filter(q=>q.day===day).map(q=>`<option value="${q.id}">${q.order}. ${e(q.category)} — ${e(q.question)}</option>`).join('')}</optgroup>`).join('');
select.value = new URLSearchParams(location.search).get('q') || 'd1q4';
if(!select.value) select.selectedIndex=0;
let phoneSize = [390,844];
function fit(stage, frame, width, height) {
  const scale = Math.min(1, stage.clientWidth / width);
  frame.style.width=`${width}px`; frame.style.height=`${height}px`; frame.style.transform=`scale(${scale})`; stage.style.height=`${height*scale}px`;
}
function resize() {
  fit($('phone-stage'),$('phone-frame'),...phoneSize);
  fit($('projector-stage'),$('projector-frame'),1280,720);
}
function render() {
  const q=questions.find(q=>q.id===select.value), state=$('state-select').value;
  for(const view of ['phone','projector']) {
    const url=`/review/screen.html?q=${q.id}&state=${state}&view=${view}`;
    $(`${view}-frame`).src=url; $(`${view}-link`).href=url;
  }
  $('previous').disabled=select.selectedIndex===0;
  $('next').disabled=select.selectedIndex===questions.length-1;
  $('editorial').innerHTML=`<h3>Day ${q.day}, question ${q.order}: my recommendation</h3><p>${e(q.note)}</p><p>${e(q.media ? (q.media.timing==='reveal'?'Photograph appears only after answers close.':q.visualNote) : q.visualNote)}</p><p><strong>${q.durationSeconds} seconds</strong> · ${e(q.difficulty)} · ${e(q.factStatus)}</p>`;
  $('comparison').innerHTML=`<div><h3>Original in your Word document</h3><p>${e(q.original.question)}</p><ol type="A">${q.original.options.map(o=>`<li>${e(o)}</li>`).join('')}</ol><p>${e(q.original.explanation)}</p><p class="muted">${e(q.original.originalVisual)}</p></div><div><h3>Draft answer and source</h3><p><strong>${String.fromCharCode(65+q.correctOption)}. ${e(q.options[q.correctOption])}</strong></p><p>${e(q.explanation)}</p>${q.media?`<p><a href="${e(q.media.source)}" target="_blank" rel="noopener">${e(q.media.title)}</a><br>Photo: ${e(q.media.author)}<br><a href="${e(q.media.licenseUrl)}" target="_blank" rel="noopener">${e(q.media.license)}</a>. Original composition retained; browser scaling only.</p>`:'<p>No photograph used for this question.</p>'}<p>Content source: supplied SCIN question document. Revised distractors and wording remain proposals, not a completed independent fact-check.</p></div>`;
  history.replaceState(null,'',`?q=${q.id}`); resize();
}
select.addEventListener('change',render);
$('state-select').addEventListener('change',render);
$('size-select').addEventListener('change',()=>{phoneSize=$('size-select').value.split(',').map(Number); resize();});
$('previous').addEventListener('click',()=>{if(select.selectedIndex>0){select.selectedIndex--;render();}});
$('next').addEventListener('click',()=>{if(select.selectedIndex<questions.length-1){select.selectedIndex++;render();}});
new ResizeObserver(resize).observe($('phone-stage'));
new ResizeObserver(resize).observe($('projector-stage'));
render();
