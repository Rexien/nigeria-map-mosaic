(function(){
  const $=(s,p=document)=>p.querySelector(s), $$=(s,p=document)=>[...p.querySelectorAll(s)];
  const api=()=>window.NIACApi, core=()=>window.NIACCore; const retrying=new Set(); let clockTimer,currentState,clockOffset=0,stateLoading=false,lastDisplayKey='';
  const screenChannel='BroadcastChannel' in window?new BroadcastChannel('niac-screen-sync'):null;
  function message(el,text,error=false){if(!el)return;el.textContent=text||'';el.classList.toggle('error',error)}
  function escape(value){const span=document.createElement('span');span.textContent=value??'';return span.innerHTML}
  function connection(ok){const el=$('#connection-status');if(el){el.classList.toggle('online',ok);$('.status-text',el).textContent=ok?'Live':'Reconnecting'}}
  async function initWelcomeMap(){const svg=$('#welcome-map'),geo=window.NIGERIA_GEOJSON;if(!svg||!geo)return;const box=geo.bbox||[2.67,4.27,14.67,13.89],sx=x=>24+(x-box[0])/(box[2]-box[0])*272,sy=y=>306-(y-box[1])/(box[3]-box[1])*282;const polygons=geo.geometry.type==='MultiPolygon'?geo.geometry.coordinates:[geo.geometry.coordinates];const d=polygons.flatMap(poly=>poly.map(ring=>ring.map((p,i)=>`${i?'L':'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('')+'Z')).join('');$('#welcome-map-shape').setAttribute('d',d);$('#welcome-map-clip-path').setAttribute('d',d);const positions=[[160,75,22],[104,118,17],[205,142,16],[145,180,20],[210,218,14],[112,244,16],[164,278,14]],fallback=['Roots','Realities','Renewals','Naija','Unity','Joy','Home'];async function refresh(){let words=fallback,count=0;try{const data=await api().request('/lens/approved');count=data.responses.length;if(count)words=data.responses.slice(-7).reverse().map(x=>x.phrase)}catch{}const layer=$('#welcome-map-words');layer.innerHTML='';words.forEach((word,i)=>{const [x,y,size]=positions[i%positions.length],text=document.createElementNS('http://www.w3.org/2000/svg','text');text.setAttribute('x',x);text.setAttribute('y',y);text.setAttribute('font-size',Math.max(11,size-Math.max(0,word.length-10)*.65));text.setAttribute('text-anchor','middle');text.setAttribute('transform',`rotate(${i%2?'-4':'3'} ${x} ${y})`);text.textContent=word;layer.appendChild(text)});$('#welcome-map-count').textContent=count?`${count} live ${count===1?'response':'responses'}`:'Waiting for your words'}await refresh();setInterval(refresh,12000)}
  async function initWelcome(){const form=$('#join-form'),recovery=$('#recovery-form');form?.addEventListener('submit',async e=>{e.preventDefault();const result=core().validateAlias($('#alias').value),msg=$('#join-message');if(!result.valid)return message(msg,result.error,true);try{$('#join-button').disabled=true;const data=await api().join(result.value);$('#join-panel').classList.add('hidden');$('#joined-panel').classList.remove('hidden');$('#recovery-code').textContent=data.recoveryCode;$('#continue-link').href=new URLSearchParams(location.search).get('next')||'/activities'}catch(err){message(msg,err.message,true)}finally{$('#join-button').disabled=false}});recovery?.addEventListener('submit',async e=>{e.preventDefault();try{await api().recover($('#recovery-code-input').value);location.href='/activities'}catch(err){message($('#recovery-message'),err.message,true)}});if(api().getProfile()){$('#existing').classList.remove('hidden');$('#existing-name').textContent=api().getProfile().alias}initWelcomeMap()}
  function guard(){return api().requireParticipant()}
  function renderParticipantLive(s){
    const card=$('#participant-live-card');if(!card)return;
    const badge=$('#participant-live-badge'),badgeText=$('#participant-live-badge-text'),activity=$('#participant-live-activity'),question=$('#participant-live-question'),status=$('#participant-live-status'),link=$('#participant-live-link');
    if(s.activity==='lens'){
      card.classList.remove('hidden');badge.classList.add('is-live');badgeText.textContent='Live now';activity.textContent='Nigeria Through Your Lens';question.textContent='Add your word to the live Nigeria map';status.textContent='Your approved response will appear on the shared screen.';link.href='/lens';link.textContent='Share your lens';return
    }
    const isDecodePrep=s.activity==='decode'&&s.state==='preparing'&&Boolean(s.question);
    const visible=s.question&&(['open','locked','revealed','leaderboard'].includes(s.state)||isDecodePrep);
    if(!visible){card.classList.add('hidden');return}
    const isOpen=s.state==='open';card.classList.remove('hidden');badge.classList.toggle('is-live',isOpen||isDecodePrep);badgeText.textContent=isOpen?'Live now':isDecodePrep?`Clue ${s.question.clueNumber||1}`:'On the main screen';activity.textContent=s.question.title||(s.activity==='decode'?'Decode the State':'Naija Passport Challenge');question.textContent=s.question.clue||s.question.question;status.textContent=isOpen?'Answers are open — tap below to choose yours.':isDecodePrep?`Clue ${s.question.clueNumber||1} of 3 is on the main screen. Voting opens after Clue 3.`:s.state==='locked'?'Answers are closed. You can still view the question.':s.state==='revealed'?'The answer has been revealed on the main screen.':'The leaderboard is on the main screen.';link.href='/play';link.textContent=isOpen?'Answer now':isDecodePrep?'View clues':'View question'
  }
  function applyState(data){
    if(!data)return;
    clockOffset=new Date(data.serverNow)-Date.now();
    currentState=data;
    connection(true);
    renderPlay(data);
    if(data.state==='leaderboard')renderLeaderboard(data.question?.activity||'passport');
    else renderDisplay(data);
  }
  async function loadParticipantLive(){if(window.NIACTransport&&window.NIACTransport.getStatus()==='live')return;try{renderParticipantLive(await api().request('/state'))}catch{const card=$('#participant-live-card');if(card)card.classList.add('hidden')}}
  function initActivities(){if(!guard())return;$('#participant-name').textContent=api().getProfile()?.alias||'Guest';if(window.NIACTransport){window.NIACTransport.onState(renderParticipantLive);window.NIACTransport.init()}loadParticipantLive();setInterval(loadParticipantLive,2500)}
  function initLens(){if(!guard())return;const input=$('#lens-phrase'),counter=$('#lens-counter');input.addEventListener('input',()=>counter.textContent=`${input.value.length}/72`);$('#lens-form').addEventListener('submit',async e=>{e.preventDefault();const valid=core().validateLensPhrase(input.value,72);if(!valid.valid)return message($('#lens-message'),valid.error,true);try{$('#lens-submit').disabled=true;const data=await api().request('/lens',{method:'POST',body:{phrase:valid.value}});$('#lens-form').classList.add('hidden');$('#lens-success').classList.remove('hidden');$('#lens-result').textContent=`“${data.submission.phrase}”`}catch(err){message($('#lens-message'),err.message,true)}finally{$('#lens-submit').disabled=false}})}
  async function loadState(){
    if(stateLoading)return currentState;
    if(window.NIACTransport&&window.NIACTransport.getStatus()==='live')return currentState;
    stateLoading=true;
    try{const data=await api().request('/state');applyState(data);return data}
    catch{connection(false);if(!currentState){const fallback={state:'lobby',question:null,responseCount:0,serverNow:new Date().toISOString()};currentState=fallback;renderPlay(fallback);renderDisplay(fallback)}return currentState}
    finally{stateLoading=false}
  }
  function remaining(s){return Math.max(0,Math.ceil((new Date(s.deadlineAt).getTime()-(Date.now()+clockOffset))/1000))}
  function localPreview(){
    if(!['127.0.0.1','localhost'].includes(location.hostname))return null;
    const mode=new URLSearchParams(location.search).get('preview');if(!mode)return null;
    const question={id:'layout-preview-question',activity:'passport',title:'Naija Passport Challenge',category:'Everyday Nigeria',question:'Which Nigerian tradition brings communities together through music, colour and celebration?',options:['A community festival with music and dance','A very long answer choice included to prove that text wraps cleanly without colliding','A quiet weekday routine','A private meeting with no audience'],correctOption:0,explanation:'Festivals across Nigeria bring together music, dance, clothing, food and community stories.',durationSeconds:30};
    if(mode==='welcome')return{data:{activity:'passport',screenMode:'welcome',state:'lobby',question:null,responseCount:0,serverNow:new Date().toISOString()},answerIndex:null};
    if(mode==='passport-standby'||mode==='decode-standby')return{data:{activity:mode==='decode-standby'?'decode':'passport',screenMode:'activity',state:'lobby',question:null,responseCount:0,serverNow:new Date().toISOString()},answerIndex:null};
    if(mode==='decode'||mode==='decode-reveal'){
      const q={id:'decode-preview',activity:'decode',title:'Decode the State',category:'South West',question:'Which Nigerian state do these clues describe?',options:['Ogun','Kano','Niger','Anambra'],correctOption:0,explanation:'Olumo Rock, Adire textile heritage, and Ojude Oba festival are iconic to Ogun State.',durationSeconds:30,clueNumber:3,clue:'Its capital Abeokuta is crowned by a legendary sacred granite fortress where Egba refugees found sanctuary in the 1830s.',cluesSoFar:['Famous for its sacred indigo-patterned tie-dye textile tradition, perfected over generations by women artisans using cassava resist paste and earthenware dye vats.','Celebrates the flamboyant annual Ojude Oba equestrian carnival on the third day of Eid-el-Kabir, where aristocratic horse-riding families parade in lavish velvet regalia before the Awujale.','Its capital Abeokuta is crowned by a legendary sacred granite fortress where Egba refugees found sanctuary in the 1830s.'],clueMediaSoFar:[{src:'/assets/decode/01.jpg',alt:'Artisan displaying indigo resist dyed fabric'},{src:'/assets/decode/02.jpg',alt:'Riders on decorated horses parading'},{src:'/assets/decode/03.jpg',alt:'Massive natural granite outcrop and historic shrine'}],highlightState:'Ogun'};
      const isRev=mode==='decode-reveal';
      return {data:{activity:'decode',screenMode:'activity',state:isRev?'revealed':'open',question:q,deadlineAt:new Date(Date.now()+30000).toISOString(),responseCount:0,serverNow:new Date().toISOString()},answerIndex:isRev?0:null};
    }
    const revealed=['reveal','wrong'].includes(mode),now=Date.now();
    return{data:{activity:'passport',screenMode:'activity',state:revealed?'revealed':'open',question,deadlineAt:new Date(now+30000).toISOString(),responseCount:0,serverNow:new Date().toISOString()},answerIndex:mode==='wrong'?2:null};
  }
  function playMediaHTML(q,revealed){
    const m=q.media||(q.imageUrl?{src:q.imageUrl,alt:q.altText,timing:'question'}:null);
    if(!m||!m.src)return '';
    const caption=revealed&&m.caption?escape(m.caption):(m.timing==='question'?'Look closely at the photograph.':'');
    const credit=revealed&&m.author?`Photo: ${escape(m.author)}${m.license?` (${escape(m.license)})`:''}`:'';
    const fallback=escape(q.fallback||'Photograph unavailable. Use the written question to answer.');
    return `<figure class="play-media-card">
      <div class="play-photo-container">
        <img src="${escape(m.src)}" alt="${escape(m.alt||'')}" class="question-image" decoding="async" onerror="this.closest('.play-media-card').classList.add('media-failed')">
        <div class="media-fallback-box"><p>${fallback}</p></div>
      </div>
      ${caption||credit?`<figcaption class="play-media-caption"><span>${caption}</span>${credit?`<small class="play-media-credit">${credit}${m.licenseUrl?` · <a href="${escape(m.licenseUrl)}" target="_blank" rel="noopener noreferrer">License</a>`:''}</small>`:''}</figcaption>`:''}
    </figure>`;
  }
  function displayMediaHTML(q,revealed){
    const m=q.media||(q.imageUrl?{src:q.imageUrl,alt:q.altText,timing:'question'}:null);
    if(!m||!m.src)return '';
    const caption=revealed&&m.caption?escape(m.caption):(m.timing==='question'?'Look closely at the photograph.':'');
    const credit=revealed&&m.author?`Photo: ${escape(m.author)}${m.license?` · ${escape(m.license)}`:''}`:'';
    const fallback=escape(q.fallback||'Photograph unavailable. Use the written question to answer.');
    return `<figure class="display-media-card">
      <div class="display-media-wrap">
        <img src="${escape(m.src)}" alt="${escape(m.alt||'')}" class="display-photo" decoding="async" onerror="this.closest('.display-media-card').classList.add('media-failed')">
        <div class="display-media-fallback"><p>${fallback}</p></div>
      </div>
      ${caption||credit?`<figcaption class="display-media-caption"><span>${caption}</span>${credit?`<small class="display-media-credit">${credit}</small>`:''}</figcaption>`:''}
    </figure>`;
  }
  function renderPlay(s){
    const root=$('#play-root');if(!root)return;const prior=s.question&&JSON.parse(localStorage.getItem(`niac-answer-${s.question.id}`)||'null');
    const isDecodePrep=s.activity==='decode'&&s.state==='preparing'&&Boolean(s.question);
    const visible=s.question&&(['open','locked','revealed','leaderboard'].includes(s.state)||isDecodePrep);
    if(!visible){root.innerHTML=`<div class="panel"><p class="eyebrow">${escape(s.question?.title||(s.activity==='decode'?'Decode the State':'Naija Passport Challenge'))}</p><h1>${s.state==='paused'?'The host has paused the activity':'Waiting for the next question'}</h1><p class="muted">Keep this screen open. It will update when the host is ready.</p></div>`;return}
    const q=s.question,revealed=['revealed','leaderboard'].includes(s.state),answered=Number.isInteger(prior?.optionIndex),isCorrect=answered&&q.correctOption===prior.optionIndex;
    const isSpectator=Boolean(api().getProfile()?.isSpectator);
    const isDecode=q.activity==='decode';

    if(isDecodePrep){
      const clueNum=q.clueNumber||1;
      root.innerHTML=`<div class="panel play-panel decode-preparing-panel"><div class="question-meta"><span>Decode the State · Clue ${clueNum} of 3</span>${isSpectator?'<span class="spectator-badge">Spectator view</span>':''}</div><h1>${escape(q.clue||q.question)}</h1><div class="decode-clue-stepper" aria-label="Clue progression" style="display:flex;gap:8px;margin:12px 0 16px"><span class="badge ${clueNum>=1?'is-live':''}" style="padding:4px 10px;border-radius:6px;border:1px solid #d4af37;background:${clueNum===1?'#d4af37':'rgba(212,175,55,0.2)'};color:${clueNum===1?'#0c1a12':'#f3e5ab'};font-weight:700">Clue 1${clueNum===1?' (Showing)':''}</span><span class="badge ${clueNum>=2?'is-live':''}" style="padding:4px 10px;border-radius:6px;border:1px solid #d4af37;background:${clueNum===2?'#d4af37':'rgba(212,175,55,0.2)'};color:${clueNum===2?'#0c1a12':'#f3e5ab'};font-weight:700">Clue 2${clueNum===2?' (Showing)':''}</span><span class="badge ${clueNum>=3?'is-live':''}" style="padding:4px 10px;border-radius:6px;border:1px solid #d4af37;background:${clueNum===3?'#d4af37':'rgba(212,175,55,0.2)'};color:${clueNum===3?'#0c1a12':'#f3e5ab'};font-weight:700">Clue 3${clueNum===3?' (Showing)':''}</span></div>${playMediaHTML(q,false)}<div class="notice decode-notice" role="status"><strong>Watch the main screen!</strong><span>Clue ${clueNum} of 3 is on the main screen. The state choices and interactive map will open for voting after Clue 3.</span></div><p id="personal-live-score" class="muted"></p></div>`;
      updateLiveScore('decode');
      return;
    }

    const resultTitle=isCorrect?(isDecode?'State Decoded!':'Correct!'):answered?'Not quite':'Time’s up';
    const picked=answered?`${String.fromCharCode(65+prior.optionIndex)}. ${escape(q.options[prior.optionIndex])}${isDecode?' State':''}`:'';
    const correct=`${String.fromCharCode(65+q.correctOption)}. ${escape(q.options[q.correctOption])}${isDecode?' State':''}`;
    const resultCopy=isCorrect?`You chose ${correct}.`:answered?`You chose ${picked}. The correct answer is ${correct}.`:`The correct answer is ${correct}.`;

    const cluesGalleryHTML = isDecode && q.cluesSoFar && q.cluesSoFar.length > 0 ? `
      <div class="decode-clues-strip" role="group" aria-label="State Clues">
        ${q.cluesSoFar.map((c, i) => {
          const m = (q.clueMediaSoFar && q.clueMediaSoFar[i]) || (i === (q.clueNumber-1) ? q.media : null);
          return `<div class="decode-clue-item">
            <div class="decode-clue-img-wrap">
              ${m?.src ? `<img src="${escape(m.src)}" alt="${escape(m.alt||'')}" class="decode-clue-img">` : ''}
            </div>
            <div class="decode-clue-label"><strong>Clue ${i+1}:</strong> ${escape(c)}</div>
          </div>`;
        }).join('')}
      </div>` : playMediaHTML(q, revealed);

    root.innerHTML=`<div class="panel play-panel ${isDecode?'is-decode-play':''}"><div class="question-meta"><span>${escape(q.category)} · ${isDecode?'Mystery State':('Question '+(q.order||''))}</span>${isSpectator?'<span class="spectator-badge">Spectator view</span>':''}<strong class="timer" id="timer" aria-label="Seconds remaining">${remaining(s)}</strong></div><h1>${escape(isDecode?'Which Nigerian state do these clues describe?':(q.clue||q.question))}</h1>${cluesGalleryHTML}${isDecode?'<div id="play-map-container"></div>':''}<div class="answers">${q.options.map((o,i)=>`<button class="answer ${prior?.optionIndex===i?'selected':''} ${prior?.confirmed?'confirmed':''} ${revealed&&q.correctOption===i?'correct':''} ${revealed&&answered&&prior.optionIndex===i&&!isCorrect?'incorrect':''}" data-option="${i}" ${s.state!=='open'||prior?'disabled':''}>${String.fromCharCode(65+i)}. ${escape(o)}${isDecode?' State':''}</button>`).join('')}</div><p id="answer-message" class="muted" aria-live="polite">${prior?.confirmed?(prior?.spectator||isSpectator?'Answer recorded · Spectator mode':'Answer received — locked in.'):prior&&s.state==='open'?'Connection interrupted — keeping your answer and retrying.':s.state==='open'?(isSpectator?'Choose one answer for interactive practice (Spectator mode).':'Tap a state on the map or choose below. Once received, it cannot be changed.'):'Answers are closed.'}</p>${revealed?`<div class="notice result-notice ${isCorrect?'result-correct':'result-wrong'}" role="status"><strong>${resultTitle}</strong><span>${resultCopy}</span><small>${escape(q.explanation||'')}</small></div>`:''}<p id="personal-live-score" class="muted"></p></div>`;

    if(isDecode && window.NigeriaStatesMap){
      const mapWrap=$('#play-map-container',root);
      if(mapWrap){
        window.NigeriaStatesMap.renderMap({
          container:mapWrap,
          options:q.options,
          selectedOption:prior?.optionIndex??null,
          correctOption:revealed?q.correctOption:null,
          isRevealed:revealed,
          interactive:s.state==='open'&&!prior,
          onSelect:(idx)=>submitAnswer(idx,s)
        });
      }
    }

    $$('.answer',root).forEach(b=>b.addEventListener('click',()=>submitAnswer(Number(b.dataset.option),s),{once:true}));startClock(s);updateLiveScore(q.activity);if(prior&&!prior.confirmed&&s.state==='open')retryPending(prior,s)
  }
  async function updateLiveScore(activity){try{const d=await api().request('/me'),el=$('#personal-live-score');if(el){if(el.parentElement?.querySelector('.notice'))el.parentElement.querySelector('h1')?.after(el);el.textContent=d.isSpectator?'Spectator mode · Interactive practice only':activity==='decode'?`Your Decode score: ${d.scores.decode} points`:`Your total: ${d.scores.combined.toLocaleString()} points · Current rank: #${d.rank}`}}catch{}}
  function startClock(s){clearInterval(clockTimer);const tick=()=>{const left=remaining(s),el=$('#timer');if(el)el.textContent=left;if(left===0&&s.state==='open'){$$('.answer').forEach(b=>b.disabled=true);const note=$('#answer-message');if(note&&!localStorage.getItem(`niac-answer-${s.question.id}`))message(note,'Time is up — waiting for the answer reveal.')}};tick();clockTimer=setInterval(tick,250)}
  async function submitAnswer(optionIndex,s){
    const buttons=$$('.answer');if(buttons.some(button=>button.disabled))return;buttons.forEach((b,i)=>{b.classList.toggle('selected',i===optionIndex);b.disabled=true});message($('#answer-message'),'Sending your answer…');
    if(s.activity==='decode'&&window.NigeriaStatesMap){const mapWrap=$('#play-map-container');if(mapWrap)window.NigeriaStatesMap.renderMap({container:mapWrap,options:s.question.options,selectedOption:optionIndex,interactive:false})}
    const key=`niac-answer-${s.question.id}`,pending={optionIndex,idempotencyKey:crypto.randomUUID(),confirmed:false};localStorage.setItem(key,JSON.stringify(pending));
    try{const res=await api().request('/answers',{method:'POST',body:{sessionId:s.sessionId,questionId:s.question.id,optionIndex,idempotencyKey:pending.idempotencyKey}});pending.confirmed=true;if(res?.spectator||api().getProfile()?.isSpectator)pending.spectator=true;localStorage.setItem(key,JSON.stringify(pending));message($('#answer-message'),pending.spectator?'Practice answer only · Spectator mode':'Answer received — locked in.')}
    catch(err){if(err.code==='ANSWER_LATE'||err.code==='QUESTION_NOT_OPEN'){localStorage.removeItem(key);message($('#answer-message'),'Answers are closed. Your answer was not counted.',true)}else message($('#answer-message'),'Connection interrupted — your choice is saved and will retry automatically.',true)}
  }
  async function retryPending(pending,s){const key=`niac-answer-${s.question.id}`;if(retrying.has(key)||remaining(s)<=0)return;retrying.add(key);try{const res=await api().request('/answers',{method:'POST',body:{sessionId:s.sessionId,questionId:s.question.id,optionIndex:pending.optionIndex,idempotencyKey:pending.idempotencyKey}});pending.confirmed=true;if(res?.spectator||api().getProfile()?.isSpectator)pending.spectator=true;localStorage.setItem(key,JSON.stringify(pending));message($('#answer-message'),pending.spectator?'Answer recorded · Spectator mode':'Answer confirmed by the server.')}catch(err){if(err.code==='ANSWER_LATE'||err.code==='QUESTION_NOT_OPEN')localStorage.removeItem(key);message($('#answer-message'),err.message,true)}finally{retrying.delete(key)}}
  function initPlay(){const preview=localPreview();if(preview){if(Number.isInteger(preview.answerIndex))localStorage.setItem(`niac-answer-${preview.data.question.id}`,JSON.stringify({optionIndex:preview.answerIndex,confirmed:true}));applyState(preview.data);return}if(!guard())return;if(window.NIACTransport){window.NIACTransport.onState(applyState);window.NIACTransport.init()}loadState();setInterval(loadState,1500);window.addEventListener('online',loadState);document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadState()})}
  async function initPassport(){if(!guard())return;try{const d=await api().request('/me');$('#passport-name').textContent=d.participant.alias;['day1','day2','combined','decode'].forEach(k=>$('#score-'+k).textContent=d.scores[k]);$('#score-rank').textContent=`#${d.rank}`;const earned=new Set(d.stamps.map(x=>x.category));$$('.stamp').forEach(x=>x.classList.toggle('earned',earned.has(x.dataset.category)))}catch(err){message($('#passport-message'),err.message,true)}}
  function renderDisplay(s){
    const root=$('#display-root');if(!root)return;const isDecodePrep=s.activity==='decode'&&s.state==='preparing'&&Boolean(s.question);const mode=s.screenMode||'welcome';const key=[mode,s.activity,s.state,s.question?.id,s.deadlineAt,s.currentClue,isDecodePrep].join('|');if(key===lastDisplayKey)return;lastDisplayKey=key;
    if(mode==='welcome'){const joinUrl=location.origin+'/';const qr=`https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=12&data=${encodeURIComponent(joinUrl)}`;root.innerHTML=`<section class="display-welcome"><div class="welcome-copy"><p class="welcome-kicker">Shell Companies in Nigeria</p><h1>NIAC<br>Live <span class="year-badge">26</span></h1><p class="welcome-theme">Timeless Nigeria: Roots, Realities & Renewals</p><p class="welcome-dates">29–30 September 2026</p></div><div class="join-box"><div class="qr-placeholder"><span>Join at<br>${escape(location.host)}</span><img src="${qr}" alt="QR code to join NIAC Live"></div><strong>Scan to join</strong><span class="join-url">${escape(location.host)}</span></div></section>`;$('.qr-placeholder img')?.addEventListener('error',e=>e.currentTarget.remove());return}
    if(s.activity==='lens'){if(!$('#lens-projector-frame',root))root.innerHTML='<iframe id="lens-projector-frame" class="lens-projector-frame" src="/lens/live?embed=1" title="Nigeria Through Your Lens live mosaic"></iframe>';return}
    if(!s.question){const name=s.activity==='decode'?'Decode the State':'Naija Passport Challenge';root.innerHTML=`<section class="display-standby"><div class="standby-content"><p class="welcome-kicker">Shell Companies in Nigeria</p><h1>${name}</h1><p>Next question coming up</p></div></section>`;return}
    const q=s.question,reveal=['revealed','leaderboard'].includes(s.state),stateLabel=s.state==='open'?'Answers open':s.state==='locked'?'Answers closed':isDecodePrep?`Clue ${q.clueNumber||1} showing`:'Answer revealed';

    if(isDecodePrep){
      const clueNum=q.clueNumber||1;const mediaHTML=displayMediaHTML(q,false);
      root.innerHTML=`<section class="display-question is-decode-preparing is-live-question ${mediaHTML?'has-media':''}"><header><div class="display-brand"><span class="display-brand-mark">NG</span><span>Decode the State</span></div><strong class="display-category">Clue ${clueNum} of 3</strong></header><h1>${escape(q.clue||q.question)}</h1>${mediaHTML}<div class="display-clue-stepper" aria-label="Clue progress" style="display:flex;justify-content:center;gap:16px;margin:16px 0"><span class="step" style="padding:6px 14px;border-radius:20px;font-weight:700;background:${clueNum===1?'var(--gold,#d4af37)':'rgba(0,0,0,0.3)'};color:${clueNum===1?'#0c1a12':'#fff'}">Clue 1</span><span class="step" style="padding:6px 14px;border-radius:20px;font-weight:700;background:${clueNum===2?'var(--gold,#d4af37)':'rgba(0,0,0,0.3)'};color:${clueNum===2?'#0c1a12':'#fff'}">Clue 2</span><span class="step" style="padding:6px 14px;border-radius:20px;font-weight:700;background:${clueNum===3?'var(--gold,#d4af37)':'rgba(0,0,0,0.3)'};color:${clueNum===3?'#0c1a12':'#fff'}">Clue 3</span></div><footer><span class="display-state"><i class="display-state-dot"></i>Clue ${clueNum} showing · Voting opens after Clue 3</span><span>Decode the State · 1,000 pts</span></footer></section>`;
      return;
    }

    if(q.activity==='decode'){
      root.innerHTML=`<section class="display-question is-decode ${reveal?'is-revealed':'is-live-question'}"><header><div class="display-brand"><span class="display-brand-mark">NG</span><span>Decode the State</span></div><strong class="display-category">${reveal?'Mystery State Revealed':'Which State Is It?'}</strong></header><h1>${reveal?`Mystery State: ${escape(q.options[q.correctOption])} State`:'Identify the Nigerian State from the clues'}</h1><div class="display-timer" id="timer" aria-label="Seconds remaining">${remaining(s)}</div><div class="display-map-card" id="display-map-container"></div><div class="display-clues-strip">${(q.cluesSoFar||[q.clue]).map((c,i)=>{const m=(q.clueMediaSoFar||[])[i]||(i===(q.clueNumber-1)?q.media:null);return `<div class="display-clue-card"><div class="display-clue-img-wrap">${m?.src?`<img src="${escape(m.src)}" alt="${escape(m.alt||'')}" class="display-clue-img">`:''}</div><div class="display-clue-text" style="padding:6px 10px;font-size:0.85rem;line-height:1.3"><strong>Clue ${i+1}:</strong> ${escape(c)}${reveal&&m?.caption?`<small class="display-clue-caption" style="display:block;color:var(--muted);font-size:0.75rem;margin-top:2px">${escape(m.caption)}</small>`:''}</div></div>`}).join('')}</div><div class="display-options">${q.options.map((o,i)=>`<div class="display-option ${reveal&&q.correctOption===i?'correct':''}"><span class="display-option-letter">${String.fromCharCode(65+i)}</span><span>${escape(o)} State</span>${reveal&&q.correctOption===i?'<span class="display-check">✓</span>':''}</div>`).join('')}</div>${reveal?`<aside><strong>Why:</strong> ${escape(q.explanation||'')}${q.highlightState?` · Highlight: ${escape(q.highlightState)} State`:''}</aside>`:''}<footer><span class="display-state"><i class="display-state-dot"></i>${stateLabel}</span><span>Decode the State · 1,000 pts</span></footer></section>`;
      if(window.NigeriaStatesMap){
        const mapContainer=$('#display-map-container',root);
        if(mapContainer){
          window.NigeriaStatesMap.renderMap({
            container:mapContainer,
            options:q.options,
            selectedOption:null,
            correctOption:reveal?q.correctOption:null,
            isRevealed:reveal,
            interactive:false
          });
        }
      }
      startClock(s);
      return;
    }

    const mediaHTML=displayMediaHTML(q,reveal);
    root.innerHTML=`<section class="display-question ${reveal?'is-revealed':'is-live-question'} ${mediaHTML?'has-media':''}"><header><div class="display-brand"><span class="display-brand-mark">NG</span><span>${escape(q.title||'Naija Passport Challenge')}</span></div><strong class="display-category">${escape(q.category)}</strong></header><h1>${escape(q.clue||q.question)}</h1><div class="display-timer" id="timer" aria-label="Seconds remaining">${remaining(s)}</div>${mediaHTML}<div class="display-options">${q.options.map((o,i)=>`<div class="display-option ${reveal&&q.correctOption===i?'correct':''}"><span class="display-option-letter">${String.fromCharCode(65+i)}</span><span>${escape(o)}</span>${reveal&&q.correctOption===i?'<span class="display-check">✓</span>':''}</div>`).join('')}</div>${reveal?`<aside><strong>Why:</strong> ${escape(q.explanation||'')}${q.highlightState?` · Highlight: ${escape(q.highlightState)} State`:''}</aside>`:''}<footer><span class="display-state"><i class="display-state-dot"></i>${stateLabel}</span>${q.day&&q.order?`<span>Day ${q.day} · Question ${q.order}/12</span>`:''}</footer></section>`;startClock(s)
  }
  async function renderLeaderboard(activity){const root=$('#display-root'),key=`leaderboard|${activity}`;if(!root||key===lastDisplayKey)return;try{const d=await api().request(`/leaderboard?activity=${activity}`);lastDisplayKey=key;root.innerHTML=`<section class="display-question"><header><div class="display-brand"><span class="display-brand-mark">NG</span><span>${activity==='decode'?'Decode the State':'Naija Passport Challenge'}</span></div><strong class="display-category">Top ten</strong></header><h1>Leaderboard</h1><ol class="leaderboard">${d.leaders.map((x,i)=>`<li><span>${i+1}. ${escape(x.alias)}</span><strong>${x.totalScore.toLocaleString()}</strong></li>`).join('')}</ol><footer><span>NIAC Live</span><span>${activity==='decode'?'Separate game score':'Cumulative Day 1 + Day 2'}</span></footer></section>`}catch{renderDisplay(currentState)}}
  function initDisplay(){const preview=localPreview();if(preview){applyState(preview.data);return}if(window.NIACTransport){window.NIACTransport.onState(applyState);window.NIACTransport.init()}loadState();setInterval(loadState,1000);screenChannel?.addEventListener('message',loadState);window.addEventListener('online',loadState);document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadState()})}
  async function adminLogin(){const email=$('#admin-email').value,password=$('#admin-password').value;try{const {data,error}=await supabase.createClient(APP_CONFIG.SUPABASE_URL,APP_CONFIG.SUPABASE_ANON_KEY).auth.signInWithPassword({email,password});if(error)throw error;api().setAdminToken(data.session.access_token);location.reload()}catch(err){message($('#admin-login-message'),err.message,true)}}
  async function initAdmin(){
    if(!api().hasAdmin()&&['127.0.0.1','localhost'].includes(location.hostname)){try{const local=await api().request('/dev/admin',{method:'POST'});api().setAdminToken(local.token)}catch{}}
    if(!api().hasAdmin()){$('#admin-login').classList.remove('hidden');$('#admin-login-button').addEventListener('click',adminLogin);return}
    $('#control-room').classList.remove('hidden');let status;
    try{status=await api().request('/admin/status',{admin:true});$('#admin-name').textContent=status.admin.displayName;$('#live-state').textContent=status.session?.state||'Not configured';$('#admin-participants').textContent=status.metrics.participants;$('#admin-responses').textContent=status.metrics.responseCount;$('#activity-select').value=status.settings?.active_activity||'lens';$('#rehearsal-mode').checked=Boolean(status.settings?.rehearsal_mode);status.questions.forEach(q=>$('#question-select').add(new Option(`${q.category}: ${q.question}`,q.id)))}catch(err){api().clearAdmin();message($('#admin-login-message'),err.message,true);$('#admin-login').classList.remove('hidden');$('#control-room').classList.add('hidden');return}
    $$('[data-state]').forEach(b=>b.addEventListener('click',async()=>{try{await api().request('/admin/action',{method:'POST',admin:true,body:{state:b.dataset.state}});location.reload()}catch(err){message($('#admin-message'),err.message,true)}}));
    $('#select-question').addEventListener('click',async()=>{const questionId=$('#question-select').value;if(!questionId)return message($('#admin-message'),'Choose an approved question first.',true);try{await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'select_question',questionId}});location.reload()}catch(err){message($('#admin-message'),err.message,true)}});
    $('#next-clue').addEventListener('click',async()=>{try{await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'next_clue'}});location.reload()}catch(err){message($('#admin-message'),err.message,true)}});
    $('#save-settings').addEventListener('click',async()=>{try{await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'set_settings',activeActivity:$('#activity-select').value,rehearsalMode:$('#rehearsal-mode').checked}});message($('#admin-message'),'Event settings saved.')}catch(err){message($('#admin-message'),err.message,true)}});
    $('#clear-rehearsal').addEventListener('click',()=>clearData('rehearsal','CLEAR REHEARSAL DATA'));
    $('#reset-production').addEventListener('click',()=>clearData('production','RESET NIAC 2026 PRODUCTION DATA'));
    $('#void-question').addEventListener('click',async()=>{if(!confirm('Void the current question and remove its points from every score?'))return;try{await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'void_question'}});location.reload()}catch(err){message($('#admin-message'),err.message,true)}});
    await loadModeration();
  }
  async function clearData(scope,required){const confirmText=prompt(`Type ${required} exactly to continue.`);if(confirmText!==required)return;try{const d=await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'clear_data',scope,confirmText}});message($('#admin-message'),`${d.cleared} participant profiles cleared.`)}catch(err){message($('#admin-message'),err.message,true)}}
  async function loadModeration(){const body=$('#moderation-body');if(!body)return;try{const d=await api().request('/admin/lens',{admin:true});body.innerHTML=d.responses.map(r=>`<tr><td>${escape(r.phrase)}</td><td>${escape(r.participants?.alias||'Legacy')}</td><td>${escape(r.status)}</td><td><button class="button secondary" data-moderate="${r.id}" data-status="approved">Restore</button> <button class="button secondary" data-edit="${r.id}" data-phrase="${escape(r.phrase)}">Edit</button> <button class="button secondary" data-moderate="${r.id}" data-status="hidden">Hide</button></td></tr>`).join('')||'<tr><td colspan="4">No responses yet.</td></tr>';$$('[data-moderate]').forEach(b=>b.addEventListener('click',async()=>{await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'moderate',id:b.dataset.moderate,status:b.dataset.status}});loadModeration()}));$$('[data-edit]').forEach(b=>b.addEventListener('click',async()=>{const phrase=prompt('Correct an obvious spelling error:',b.dataset.phrase);if(phrase==null)return;await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'moderate',id:b.dataset.edit,status:'approved',phrase}});loadModeration()}));$('#export-lens').onclick=()=>{const csv=['phrase,alias,status,created_at',...d.responses.map(r=>[r.phrase,r.participants?.alias||'Legacy',r.status,r.created_at].map(x=>`"${String(x).replaceAll('"','""')}"`).join(','))].join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`niac-lens-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(a.href)}}catch(err){message($('#admin-message'),err.message,true)}}
  async function initContent(){if(!api().hasAdmin()&&['127.0.0.1','localhost'].includes(location.hostname)){try{const local=await api().request('/dev/admin',{method:'POST'});api().setAdminToken(local.token)}catch{}}if(!api().hasAdmin()){location.href='/admin';return}try{const d=await api().request('/admin/content',{admin:true});$('#content-body').innerHTML=d.questions.map(q=>`<tr><td>${escape(q.category)}</td><td>${escape(q.question)}</td><td>${escape(q.review_status)}</td><td>${q.duration_seconds}s</td></tr>`).join('')||'<tr><td colspan="4">Import the supplied question bank.</td></tr>'}catch(err){message($('#content-message'),err.message,true)}}
  const initializers={welcome:initWelcome,activities:initActivities,lens:initLens,play:initPlay,passport:initPassport,display:initDisplay,admin:initAdmin,content:initContent};document.addEventListener('DOMContentLoaded',()=>initializers[document.body.dataset.page]?.());
})();
