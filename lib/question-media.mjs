// Public media is selected on the server, never merely hidden with browser CSS.
const visibleStates = new Set(['open', 'locked', 'revealed', 'leaderboard', 'round_complete']);
const revealStates = new Set(['revealed', 'leaderboard', 'round_complete']);
const text = value => typeof value === 'string' ? value : '';
export function optimizedDecodeAsset(value, activity) {
  const src = typeof value === 'string' ? value : '';
  if (activity !== 'decode' || !src.startsWith('/assets/decode/')) return value;
  return src.replace(/\.jpe?g(?=($|[?#]))/i, '.webp');
}
export function safeMediaUrl(value) {
  if (typeof value !== 'string' || /[\s\\\u0000-\u001f]/.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function publicQuestionMedia(question, state) {
  const isDecodePreparing = question?.activity === 'decode' && state === 'preparing';
  if (!isDecodePreparing && !visibleStates.has(state)) return null;
  const media = question.media;
  if (!media) {
    const src = safeMediaUrl(optimizedDecodeAsset(question.imageUrl, question.activity));
    return src ? {src, alt:text(question.altText), timing:'question'} : null;
  }
  // Unknown timing fails closed; no fallback to a stale legacy URL.
  if (!['question', 'reveal'].includes(media.timing)) return null;
  const revealed = revealStates.has(state);
  if (media.timing === 'reveal' && !revealed) return null;
  const src = safeMediaUrl(optimizedDecodeAsset(media.src, question.activity));
  if (!src) return null;
  const result = {src, alt:text(media.alt), timing:media.timing};
  // Source titles, captions, and source filenames may identify the answer.
  // Full attribution is delivered with the reveal; neutral author/licence can
  // accompany the image while voting without exposing a descriptive source URL.
  result.author=text(media.author);
  result.license=text(media.license);
  result.licenseUrl=safeMediaUrl(media.licenseUrl);
  if (revealed) {
    result.title=text(media.title);
    result.caption=text(media.caption);
    result.source=safeMediaUrl(media.source);
  }
  return result;
}
