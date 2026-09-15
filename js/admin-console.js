(function(){
  'use strict';
  const $=(s,p=document)=>p.querySelector(s),$$=(s,p=document)=>[...p.querySelectorAll(s)];
  const api=()=>window.NIACApi;
  const escape=value=>{const el=document.createElement('span');el.textContent=value??'';return el.innerHTML};
  const show=(el,text,isError=false)=>{if(!el)return;el.textContent=text||'';el.classList.toggle('error',isError);el.classList.toggle('success',Boolean(text)&&!isError)};
  const localHost=()=>['127.0.0.1','localhost'].includes(location.hostname);
  const states={lobby:'Welcome screen',preparing:'Question ready',open:'Answers are open',locked:'Answers are closed',revealed:'Answer is showing',leaderboard:'Scores are showing',round_complete:'Round complete',paused:'Paused',ended:'Event ended'};
  const guidance={lobby:'Choose a question now. Press Open question only on the MC’s cue.',preparing:'Choose the question again and press Open question on the MC’s cue.',open:'The question is live. It will close and reveal automatically at zero.',locked:'Answers are closed. The result is being prepared.',revealed:'The answer and personal scores are showing. Open the next question or show Top 10.',leaderboard:'The Top 10 is on the projector. Choose the next question while the MC speaks.',round_complete:'Return to the welcome screen or end the event.',paused:'Everything is paused. Return to the welcome screen when ready.',ended:'The event is ended. Return to the welcome screen to begin again.'};
  const transitions={lobby:['preparing','paused','ended'],preparing:['open','paused','ended'],open:['locked','paused'],locked:['revealed','paused'],revealed:['leaderboard','preparing','round_complete','paused'],leaderboard:['preparing','round_complete','paused'],round_complete:['lobby','ended'],paused:['lobby','preparing','open','locked','revealed','leaderboard','ended'],ended:['lobby']};
  const activityNames={lens:'Live Nigeria map',passport:'Passport trivia',decode:'Decode the State'};
  const screenChannel='BroadcastChannel' in window?new BroadcastChannel('niac-screen-sync'):null;
  let actionPending=false;

  async function ensureAdmin(){
    if(!api().hasAdmin()&&localHost()){try{const result=await api().request('/dev/admin',{method:'POST'});api().setAdminToken(result.token)}catch{}}
    return api().hasAdmin();
  }
  async function signIn(){const email=$('#admin-email').value,password=$('#admin-password').value;try{$('#admin-login-button').disabled=true;const {data,error}=await supabase.createClient(APP_CONFIG.SUPABASE_URL,APP_CONFIG.SUPABASE_ANON_KEY).auth.signInWithPassword({email,password});if(error)throw error;api().setAdminToken(data.session.access_token);location.reload()}catch(err){show($('#admin-login-message'),err.message,true)}finally{$('#admin-login-button').disabled=false}}

  let adminStatus;
  function applyAdminStatus(status){
    adminStatus=status;const state=status.session?.state||'lobby',activity=status.settings?.active_activity||'lens';
    $('#admin-name').textContent=status.admin.displayName;$('#admin-participants').textContent=status.metrics.participants;$('#admin-responses').textContent=status.metrics.responseCount;
    $('#live-state').textContent=activity==='lens'?'Map is live':states[state]||state;$('#screen-activity').textContent=activityNames[activity];$('#run-mode').textContent=status.settings?.rehearsal_mode?'Practice':'Live';
    if(status.capacity){
      const c=status.capacity,badge=$('#capacity-badge'),desc=$('#capacity-status-desc');
      if(badge){badge.className=`capacity-badge ${c.status}`;badge.textContent=c.status==='green'?'GREEN · Healthy':c.status==='amber'?'AMBER · Degraded':'RED · Overloaded';}
      if(desc)desc.textContent=c.statusReason||'System capacity normal.';
      const ack=$('#metric-ack-time'),q=$('#metric-queue-depth'),err=$('#metric-error-rate'),lag=$('#metric-loop-lag');
      if(ack)ack.textContent=`${c.p50AckMs}ms / ${c.p95AckMs}ms`;
      if(q)q.textContent=String(c.queueDepth);
      if(err)err.textContent=`${c.errorRatePercent}%`;
      if(lag)lag.textContent=`${c.eventLoopLagMs}ms`;
    }
    if(status.metrics){
      const active = status.metrics.activeCount ?? status.metrics.participants ?? 0;
      const spectators = status.metrics.spectatorCount ?? 0;
      const elActive = $('#metric-active-count'), elSpec = $('#metric-spectator-count');
      if(elActive) elActive.textContent = String(active);
      if(elSpec) elSpec.textContent = String(spectators);
      const freezeBtn = $('#btn-toggle-freeze'), rosterText = $('#roster-status-text');
      const isFrozen = Boolean(status.metrics.rosterFrozen);
      if(freezeBtn) freezeBtn.textContent = isFrozen ? 'Unfreeze roster' : 'Freeze roster';
      if(rosterText){
        rosterText.textContent = isFrozen ? 'Roster: Frozen (Spectator active)' : 'Roster: Open';
        rosterText.classList.toggle('frozen', isFrozen);
      }
    }
    let instruction=guidance[state]||'Check the big screen before continuing.';const deadline=status.session?.deadline_at||status.session?.deadlineAt;if(state==='open'&&deadline){const seconds=Math.max(0,Math.ceil((new Date(deadline).getTime()-Date.now())/1000));instruction=`Question live · ${seconds}s remaining · ${status.metrics.responseCount} answers received.`}$('#operator-guidance').textContent=instruction;$('#rehearsal-mode').checked=Boolean(status.settings?.rehearsal_mode);
    $$('[name="active-activity"]').forEach(input=>input.checked=input.value===activity);$('#quiz-controls').classList.toggle('hidden',activity==='lens');$('#next-clue').classList.toggle('hidden',activity!=='decode');
    $$('[data-state]').forEach(button=>{button.disabled=!transitions[state]?.includes(button.dataset.state)});
    const select=$('#question-select'),value=select.value,currentId=status.session?.current_question_id||status.session?.currentQuestionId;select.innerHTML='<option value="">Choose a ready question</option>';status.questions.filter(q=>(!q.activity||q.activity===activity)&&q.id!==currentId).forEach(q=>select.add(new Option(`${q.category}: ${q.question}`,q.id)));if([...select.options].some(o=>o.value===value))select.value=value;$('#open-question').disabled=state==='open'||state==='ended'||!select.value;
  }
  async function refreshStatus(){const status=await api().request('/admin/status',{admin:true});applyAdminStatus(status);return status}
  function setActionPending(pending,button){actionPending=pending;$('#control-room')?.setAttribute('aria-busy',String(pending));$$('#quiz-controls button,#activity-options input').forEach(control=>control.disabled=pending);if(button){if(pending){button.dataset.idleLabel=button.innerHTML;button.textContent='Sending…'}else if(button.dataset.idleLabel){button.innerHTML=button.dataset.idleLabel;delete button.dataset.idleLabel}}if(!pending&&adminStatus)applyAdminStatus(adminStatus)}
  async function perform(body,success,button){if(actionPending)return;try{setActionPending(true,button);show($('#admin-message'),'Sending to the big screen…');await api().request('/admin/action',{method:'POST',admin:true,body,timeout:10000});await refreshStatus();screenChannel?.postMessage({type:'state-changed',at:Date.now()});show($('#admin-message'),`✓ ${success}`)}catch(err){show($('#admin-message'),`${err.message} Check the “Right now” status before pressing again.`,true)}finally{setActionPending(false,button)}}
  async function changeActivity(value){if(actionPending)return;try{setActionPending(true);show($('#screen-message'),'Changing the big screen…');await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'set_settings',activeActivity:value,rehearsalMode:$('#rehearsal-mode').checked},timeout:10000});await refreshStatus();screenChannel?.postMessage({type:'state-changed',at:Date.now()});show($('#screen-message'),`✓ ${activityNames[value]} is now on the big screen.`)}catch(err){show($('#screen-message'),`${err.message} Check the big screen before pressing again.`,true);applyAdminStatus(adminStatus)}finally{setActionPending(false)}}
  async function loadModeration(){const body=$('#moderation-body');try{const data=await api().request('/admin/lens',{admin:true});body.innerHTML=data.responses.map(r=>`<tr><td><strong>${escape(r.phrase)}</strong></td><td>${escape(r.participants?.alias||'Legacy')}</td><td>${escape(r.status)}</td><td><div class="row-actions"><button class="small-button" data-edit="${r.id}" data-phrase="${escape(r.phrase)}">Fix spelling</button><button class="small-button" data-moderate="${r.id}" data-status="${r.status==='hidden'?'approved':'hidden'}">${r.status==='hidden'?'Restore':'Hide'}</button></div></td></tr>`).join('')||'<tr><td colspan="4">No map responses yet.</td></tr>';$$('[data-moderate]').forEach(button=>button.onclick=async()=>{await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'moderate',id:button.dataset.moderate,status:button.dataset.status}});loadModeration()});$$('[data-edit]').forEach(button=>button.onclick=async()=>{const phrase=prompt('Correct the spelling:',button.dataset.phrase);if(phrase==null)return;await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'moderate',id:button.dataset.edit,status:'approved',phrase}});loadModeration()});$('#export-lens').onclick=()=>{const csv=['phrase,alias,status,created_at',...data.responses.map(r=>[r.phrase,r.participants?.alias||'Legacy',r.status,r.created_at].map(x=>`"${String(x).replaceAll('"','""')}"`).join(','))].join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`niac-lens-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(a.href)}}catch(err){show($('#admin-message'),err.message,true)}}
  async function clearData(scope,required){const confirmText=prompt(`Type ${required} exactly to continue.`);if(confirmText!==required)return;try{const result=await api().request('/admin/action',{method:'POST',admin:true,body:{kind:'clear_data',scope,confirmText}});await refreshStatus();show($('#admin-message'),`${result.cleared} participant profiles cleared.`)}catch(err){show($('#admin-message'),err.message,true)}}

  async function initAdmin(){
    if(!await ensureAdmin()){$('#admin-login').classList.remove('hidden');$('#admin-login-button').onclick=signIn;return}
    $('#control-room').classList.remove('hidden');try{await refreshStatus()}catch(err){api().clearAdmin();$('#control-room').classList.add('hidden');$('#admin-login').classList.remove('hidden');show($('#admin-login-message'),err.message,true);return}
    $$('[name="active-activity"]').forEach(input=>input.onchange=()=>changeActivity(input.value));
    $('#question-select').onchange=()=>{$('#open-question').disabled=!$('#question-select').value||adminStatus?.session?.state==='open'||adminStatus?.session?.state==='ended'};
    $('#open-question').onclick=event=>{const questionId=$('#question-select').value;if(!questionId)return show($('#admin-message'),'Choose a question first.',true);perform({kind:'open_question',questionId},'Question opened on the projector and phones.',event.currentTarget)};
    $$('[data-state]').forEach(button=>button.onclick=event=>perform({state:button.dataset.state},states[button.dataset.state]||'Screen updated.',event.currentTarget));
    $('#next-clue').onclick=event=>perform({kind:'next_clue'},'The next clue is now showing.',event.currentTarget);
    $('#save-settings').onclick=()=>changeActivity($('[name="active-activity"]:checked')?.value||'lens');
    $('#void-question').onclick=()=>{if(confirm('Void this question and remove its points from every score?'))perform({kind:'void_question'},'Question voided and scores corrected.')};
    $('#btn-toggle-freeze')?.addEventListener('click',event=>perform({kind:'toggle_roster_freeze'},'Roster status updated.',event.currentTarget));
    $('#clear-rehearsal').onclick=()=>clearData('rehearsal','CLEAR REHEARSAL DATA');$('#reset-production').onclick=()=>clearData('production','RESET NIAC 2026 PRODUCTION DATA');
    await loadModeration();setInterval(()=>refreshStatus().catch(()=>{}),1500);
  }

  let questions=[];
  const statusLabels={requires_fact_check:'Needs fact check',reviewed:'Reviewed',approved:'Ready to use'};
  function normaliseQuestion(q){const options=(q.question_options||q.options||[]).map((o,i)=>typeof o==='string'?{option_index:i,label:o}:o).sort((a,b)=>a.option_index-b.option_index);return {...q,activity:q.activity||q.quiz_rounds?.quiz_games?.activity,options,correctOption:q.correct_option??q.correctOption??0,durationSeconds:q.duration_seconds??q.durationSeconds??20,reviewStatus:q.review_status??q.reviewStatus??'requires_fact_check'}}
  function renderQuestions(){const query=$('#question-search').value.trim().toLowerCase(),status=$('#question-status-filter').value;const filtered=questions.filter(q=>(status==='all'||q.reviewStatus===status)&&`${q.category} ${q.question}`.toLowerCase().includes(query));$('#question-count').textContent=`${filtered.length} of ${questions.length}`;$('#question-list').innerHTML=filtered.map(q=>`<article class="question-card"><div class="question-card-meta"><span>${escape(q.activity==='decode'?'Decode · '+q.category:'Passport · '+q.category)}</span><span class="review-badge ${escape(q.reviewStatus)}">${statusLabels[q.reviewStatus]||escape(q.reviewStatus)}</span></div><h2>${escape(q.question)}</h2><p><strong>Correct answer:</strong> ${escape(q.options[q.correctOption]?.label||'Not set')} <span class="question-time">${q.durationSeconds} seconds</span></p><button class="button secondary edit-question" data-id="${q.id}">Edit question</button></article>`).join('')||'<div class="panel"><h2>No matching questions</h2><p>Try a different search or review filter.</p></div>';$$('.edit-question').forEach(button=>button.onclick=()=>openEditor(button.dataset.id))}
  function openEditor(id){const q=questions.find(x=>x.id===id);if(!q)return;$('#editor-id').value=q.id;$('#editor-category').textContent=q.category;$('#editor-question').value=q.question;q.options.forEach((option,i)=>{$(`#editor-option-${i}`).value=option.label});const correct=$(`[name="correct-option"][value="${q.correctOption}"]`);if(correct)correct.checked=true;$('#editor-duration').value=q.durationSeconds;$('#editor-status').value=q.reviewStatus;$('#editor-explanation').value=q.explanation||'';$('#editor-source').value=q.source||'';show($('#editor-message'),'');$('#question-editor').showModal()}
  async function saveQuestion(event){event.preventDefault();const button=$('#save-question'),id=$('#editor-id').value;const payload={id,question:$('#editor-question').value,options:[0,1,2,3].map(i=>$(`#editor-option-${i}`).value),correctOption:Number($('[name="correct-option"]:checked')?.value),durationSeconds:Number($('#editor-duration').value),reviewStatus:$('#editor-status').value,explanation:$('#editor-explanation').value,source:$('#editor-source').value};try{button.disabled=true;show($('#editor-message'),'Saving…');const result=await api().request('/admin/question',{method:'PATCH',admin:true,body:payload});const saved=normaliseQuestion(result.question);questions=questions.map(q=>q.id===id?saved:q);renderQuestions();show($('#content-message'),'Question saved. The event controls now use the updated version.');$('#question-editor').close()}catch(err){show($('#editor-message'),err.message,true)}finally{button.disabled=false}}
  async function initQuestionBank(){if(!await ensureAdmin()){location.href='/admin';return}try{const data=await api().request('/admin/content',{admin:true});questions=data.questions.map(normaliseQuestion);renderQuestions()}catch(err){show($('#content-message'),err.message,true)}$('#question-search').oninput=renderQuestions;$('#question-status-filter').onchange=renderQuestions;$('#question-form').onsubmit=saveQuestion;$('#close-question-editor').onclick=$('#cancel-question-editor').onclick=()=>$('#question-editor').close()}
  document.addEventListener('DOMContentLoaded',()=>document.body.dataset.page==='admin-console'?initAdmin():document.body.dataset.page==='question-bank'&&initQuestionBank());
})();
