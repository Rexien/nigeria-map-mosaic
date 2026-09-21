import {escapeHTML as e, resultFor} from './draft.js';

export function mediaHTML(q, revealed, projector = false) {
  if (!q.media || (q.media.timing === 'reveal' && !revealed)) return '';
  if (projector) {
    return `<div class="display-media-wrap">
      <img src="${e(q.media.src)}" alt="${e(q.media.alt)}" class="display-photo" decoding="async">
      <div class="display-media-fallback"><p>Photograph unavailable. ${e(q.fallback || 'Use the written question to answer.')}</p></div>
    </div>`;
  }
  return `<figure class="draft-media"><img src="${e(q.media.src)}" alt="${e(q.media.alt)}" decoding="async"><p class="media-error" hidden>Photograph unavailable. ${e(q.fallback || 'Use the written question to answer.')}</p></figure>`;
}

export function renderScreen(q, state, view, selected = null) {
  const projector = view === 'projector';
  if (state === 'lobby') return projector
    ? `<div id="display-root"><section class="display-welcome"><div class="welcome-copy"><p class="welcome-kicker">SCIN Independence Day</p><h1>Naija<br>Passport</h1><p class="welcome-theme">How well do you know Nigeria?</p><p>The next question will appear when the host is ready.</p></div><div class="join-box"><h2>Get your phone ready.</h2><p>Answer on your device.<br>Follow along on this screen.</p><strong>Draft preview · no live session</strong></div></section></div>`
    : `<header class="site-header"><strong>NIAC Live</strong><span>Preview</span></header><main class="page narrow"><div class="panel"><h1>Waiting for the next question</h1><p>Keep this screen open. The host will start the next question.</p></div></main>`;
  const r = resultFor(q, state, selected);
  const media = mediaHTML(q, r.revealed, projector);

  if (projector) {
    if (r.revealed) {
      return `<div id="display-root">
        <section class="display-question is-revealed is-passport-reveal ${media ? 'has-photo' : 'no-photo'}">
          <header class="reveal-top-header">
            <div class="display-brand">
              <span class="display-brand-mark">NG</span>
              <span>Naija Passport Challenge</span>
            </div>
            <strong class="display-category">${e(q.category)}</strong>
          </header>
          <h1 class="reveal-question-heading">${e(q.question)}</h1>
          <div class="passport-reveal-stage display-reveal-showcase ${media ? 'has-photo' : 'text-only'}">
            ${media ? `<div class="reveal-photo-column">${media}</div>` : ''}
            <div class="reveal-answer-column">
              <div class="display-winning-card display-winning-answer">
                <span class="winning-label">CORRECT ANSWER</span>
                <div class="winning-choice">
                  <span class="winning-letter display-option-letter">${String.fromCharCode(65 + q.correctOption)}</span>
                  <strong class="winning-title">${e(q.options[q.correctOption])}</strong>
                  <span class="winning-check display-check">✓</span>
                </div>
              </div>
              <div class="display-explanation-card display-reveal-explanation">
                <span class="explanation-label explanation-kicker">WHY</span>
                <p class="explanation-body">${e(q.explanation)}</p>
              </div>
            </div>
          </div>
          <footer class="reveal-bottom-footer">
            <span class="display-state"><i class="display-state-dot"></i>Answer revealed</span>
            <span>Day ${q.day} · Question ${q.order}/12</span>
          </footer>
        </section>
      </div>`;
    }

    return `<div id="display-root"><section class="display-question is-live-question ${media ? 'has-media' : ''}">
      <header><div class="display-brand"><span class="display-brand-mark">NG</span><span>Naija Passport Challenge</span></div><strong class="display-category">${e(q.category)}</strong></header>
      <h1>${e(q.question)}</h1><div class="display-timer" aria-label="Preview seconds remaining">${q.durationSeconds}</div>
      ${media}<div class="display-options">${q.options.map((o,i)=>`<div class="display-option"><span class="display-option-letter">${String.fromCharCode(65+i)}</span><span>${e(o)}</span></div>`).join('')}</div>
      <footer><span class="display-state"><i class="display-state-dot"></i>Choose your answer on your phone</span><span>Day ${q.day} · Question ${q.order}/12</span></footer></section></div>`;
  }

  const answer = `${String.fromCharCode(65+q.correctOption)}. ${q.options[q.correctOption]}`;
  return `<header class="site-header"><strong>NIAC Live</strong><span>Draft preview</span></header><main class="page narrow"><div class="panel play-panel">
    <div class="question-meta"><span>Day ${q.day} · Question ${q.order}/12<br>${e(q.category)}</span><strong class="timer" aria-label="Preview seconds remaining">${r.revealed ? '0' : q.durationSeconds}</strong></div>
    <h1>${e(q.question)}</h1>
    ${r.revealed ? `<div class="notice result-notice ${r.correct ? 'result-correct' : 'result-wrong'}" role="status"><strong>${r.correct ? 'Correct!' : r.timedOut ? 'Time’s up' : 'Not quite — next one!'}</strong><span>${r.correct ? 'You got it.' : `Correct answer: ${e(answer)}`}</span><small>${e(q.explanation)}</small></div>` : ''}
    ${media}
    <div class="answers">${q.options.map((o,i)=>`<button class="answer ${r.choice===i?'selected':''} ${r.revealed&&q.correctOption===i?'correct':''} ${r.revealed&&r.choice===i&&!r.correct?'incorrect':''}" data-option="${i}" ${r.revealed||r.choice!==null?'disabled':''}>${String.fromCharCode(65+i)}. ${e(o)}${r.revealed&&i===q.correctOption?' · Correct':r.revealed&&r.choice===i?' · Your answer':''}</button>`).join('')}</div>
    <p class="muted" role="status">${r.revealed?'Answers are closed.':r.choice!==null?'Answer locked in. Use the review controls to reveal the result.':'Choose one answer. Preview timer is paused.'}</p>
    ${r.revealed ? `<p class="draft-score">${r.correct ? '+850 points · Total 2,450 · Rank #7' : '+0 points · Total 1,600 · Rank #12'}<small>Illustrative scores — not the live scoring calculation.</small></p>` : ''}
  </div></main>`;
}
