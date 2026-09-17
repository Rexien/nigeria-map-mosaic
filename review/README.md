# Passport Trivia draft review

Run `node scripts/review-server.mjs` and open http://127.0.0.1:4175/review/index.html.

This is a local-only, throwaway review surface, not the event application. It reuses the existing player/projector CSS but never imports the live controller, configuration, API client, transport, credentials or scoring state. The dedicated server binds to loopback, serves only review files and the two shared stylesheets, rejects write methods, and sets `connect-src 'none'`.

The supplied Word document is transcribed into `source-bank.js`; proposals are overlaid in `draft.js`. Production `content/questions.json` and the Word document are unchanged. No publishing controls are provided. Review all 24 questions and report changes by day/question number. Scores and ranks are illustrative; timers are intentionally paused. The wrong-result selector simulates an incorrect choice rather than using the option previously clicked.

The four identification photos have neutral descriptions and text-based clues/fallbacks. Two further photos (hibiscus and suya) appear only on reveal. All six are served locally, not hotlinked. Full compositions are retained with `object-fit: contain`. Sources, authors and licences are recorded in `assets.js` and shown in the review page. CC BY-SA images remain under their stated licences; attribution must accompany any subsequent distribution. Keep credits available in the eventual player interface when publishing.

This first draft deliberately reduces decorative/reveal imagery from the Word brief. It is not a full independent fact-check. Before event publication, verify revised language distractors, confirm the content and imagery with the organiser, wire media into the actual state envelopes with reveal-only gating, and test that integration separately. Do not copy this answer-bearing preview folder into a public deployment.

Verification: `node --test tests/question-review.test.mjs`.
