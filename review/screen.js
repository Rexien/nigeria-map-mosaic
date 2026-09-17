import {findQuestion} from './draft.js';
import {renderScreen} from './render.js';
const params = new URLSearchParams(location.search);
const q = findQuestion(params.get('q'));
const state = ['open','correct','wrong','timeout','lobby'].includes(params.get('state')) ? params.get('state') : 'open';
const view = params.get('view') === 'projector' ? 'projector' : 'phone';
document.body.dataset.view = view;
for (const href of [view === 'projector' ? '/css/display-screen.css' : '/css/app.css', '/review/screens.css']) {
  const link = document.createElement('link'); link.rel='stylesheet'; link.href=href; document.head.append(link);
}
function render(selected = null) {
  document.getElementById('preview-root').innerHTML = renderScreen(q,state,view,selected);
  document.querySelectorAll('[data-option]').forEach(button => button.addEventListener('click', () => render(Number(button.dataset.option))));
  document.querySelectorAll('.draft-media img').forEach(img => {
    const failed = () => {img.hidden=true; img.parentElement.querySelector('figcaption').hidden=true; img.parentElement.querySelector('.media-error').hidden=false;};
    img.addEventListener('error',failed);
    if (img.complete && img.naturalWidth === 0) failed();
  });
}
render();
