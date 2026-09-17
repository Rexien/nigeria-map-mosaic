import {sourceQuestions} from './source-bank.js';
import {assets} from './assets.js';

// All proposals live here. Nothing imports or writes the production question bank.
const changes = {
  d1q2: {question:'Zobo is traditionally made from the dried flower calyces of which plant?', image:'hibiscus', note:'Clarifies “calyces” and reveals a close-up of the plant only after voting closes.'},
  d1q3: {explanation:'The white Y represents the Niger and Benue rivers. The two waterways are important features of Nigeria’s geography.', note:'Removes Lokoja from this reveal so it does not answer Day 2 question 2.'},
  d1q4: {question:'Which technique creates the patterns on this adire textile?', options:['Embroidery','Appliqué','Resist dyeing','Jacquard weaving'], image:'adire', fallback:'Adire patterns are made by preventing dye from reaching parts of a fabric. What is this technique called?', note:'All four options are textile techniques. Naming adire makes the question accessible without relying entirely on visual recognition.'},
  d1q5: {question:'Which Nigerian snack, made from yeast-raised dough, is shown?', image:'puff', fallback:'Which Nigerian snack is made by deep-frying small portions of yeast-raised dough?', note:'Adds a short ingredient/process clue so the question remains answerable if someone cannot see the picture. Neutral alt text does not name the answer.'},
  d1q10: {note:'Keep this text-only: the two foods are already named, and a second image adds little to the challenge.'},
  d2q1: {options:['E kaaro','E kaabo','E ku ise','E kaale'], note:'Uses Yoruba expressions throughout, so players cannot win simply by identifying which option is Yoruba.'},
  d2q4: {image:'suya', note:'Keep the question text-only while voting; show the grill photograph only with the answer.'},
  d2q5: {question:'Which ancient Nigerian culture is associated with terracotta heads like this, often featuring triangular eyes?', image:'nok', fallback:'Which ancient Nigerian culture is known for terracotta heads with stylised, often triangular eyes?', note:'Adds a descriptive clue for accessibility and uses a documented museum object, not a generated imitation.'},
  d2q6: {question:'Which Nigerian site was inscribed on UNESCO’s World Heritage List in 2005?', note:'Removes “sacred grove” from the prompt because it repeated the correct option verbatim.'},
  d2q7: {question:'What are the small yellow minibuses commonly seen on Lagos streets called?', image:'danfo', fallback:'What are the small yellow minibuses commonly seen on Lagos streets called?', note:'Use a real Lagos street photo. The wording works without the image and distinguishes minibuses from larger molue buses.'},
  d2q10: {note:'No energy-burst illustration: that would visually hint at “energise”.'},
  d2q11: {options:['A system of woven family patterns','A system of royal praise names','A system of musical drum signals','A system of written signs and symbols'], note:'Balances option length and makes all four choices communication-related. No invented Nsibidi symbols.'},
};
export const questions = sourceQuestions.map(original => {
  const {note, image, ...edits} = changes[original.id] || {};
  return {...original, ...edits, original, media:image ? assets[image] : null,
    durationSeconds:(image && assets[image].timing === 'question') || original.id === 'd2q11' ? 30 : 20,
    note:note || 'Keep the wording and answer options. Prioritise a clear question and a short explanation.',
    visualNote:image ? 'Photograph during the question and reveal; full image is preserved, never cropped to hide identifying features.' : 'Text-led question and reveal. No decorative picture competing with the answers.',
    factStatus:'Draft for organiser review',
  };
});

export function findQuestion(id) { return questions.find(q => q.id === id) || questions[0]; }
export function resultFor(q, state, selected = null) {
  const revealed = ['correct','wrong','timeout'].includes(state);
  const choice = state === 'correct' ? q.correctOption : state === 'wrong' ? (q.correctOption + 1) % 4 : selected;
  return {revealed, choice, correct: revealed && choice === q.correctOption, timedOut:state === 'timeout'};
}
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
