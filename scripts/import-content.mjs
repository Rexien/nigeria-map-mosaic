import { readFile } from 'node:fs/promises';
import { db, event } from '../netlify/functions/_db.mjs';

const questions=JSON.parse(await readFile(new URL('../content/questions.json',import.meta.url),'utf8'));
const decode=JSON.parse(await readFile(new URL('../content/decode-rounds.json',import.meta.url),'utf8'));
const ev=await event();
const games=await db(`quiz_games?event_id=eq.${ev.id}&select=*`);
const passport=games.find(g=>g.activity==='passport'),decodeGame=games.find(g=>g.activity==='decode');
if(!passport||!decodeGame)throw new Error('Apply the NIAC Live migration before importing content.');

for(const day of [1,2]){
  let round=(await db(`quiz_rounds?game_id=eq.${passport.id}&day=eq.${day}&select=*`))[0];
  if(!round)[round]=await db('quiz_rounds',{method:'POST',body:JSON.stringify({game_id:passport.id,day,title:`Day ${day}`,display_order:day,status:'draft'})});
  for(const item of questions.questions.filter(q=>q.day===day)){
    if((await db(`quiz_questions?round_id=eq.${round.id}&display_order=eq.${item.order}&select=id`))[0])continue;
    const [q]=await db('quiz_questions',{method:'POST',body:JSON.stringify({round_id:round.id,category:item.category.toLowerCase().replace(' nigeria',''),question:item.question,correct_option:item.correctOption,duration_seconds:item.durationSeconds||20,explanation:item.explanation,source:item.source,review_status:'requires_fact_check',display_order:item.order})});
    await db('question_options',{method:'POST',body:JSON.stringify(item.options.map((label,option_index)=>({question_id:q.id,option_index,label})))});
  }
}

for(let i=0;i<decode.rounds.length;i++){
  const item=decode.rounds[i];let round=(await db(`quiz_rounds?game_id=eq.${decodeGame.id}&display_order=eq.${i+1}&select=*`))[0];
  if(!round)[round]=await db('quiz_rounds',{method:'POST',body:JSON.stringify({game_id:decodeGame.id,day:i<3?1:2,title:`${item.zone} round`,display_order:i+1,status:'draft'})});
  let q=(await db(`quiz_questions?round_id=eq.${round.id}&display_order=eq.1&select=*`))[0];
  if(!q){[q]=await db('quiz_questions',{method:'POST',body:JSON.stringify({round_id:round.id,category:item.zone,difficulty:'progressive',question:'Which Nigerian state do these clues describe?',correct_option:item.correctOption,duration_seconds:20,explanation:item.revealFact,source:item.source,review_status:'requires_fact_check',display_order:1})});await db('question_options',{method:'POST',body:JSON.stringify(item.options.map((label,option_index)=>({question_id:q.id,option_index,label})))});}
  if(!(await db(`decode_state_rounds?round_id=eq.${round.id}&select=round_id`))[0])await db('decode_state_rounds',{method:'POST',body:JSON.stringify({round_id:round.id,state_name:item.state,zone:item.zone,clues:item.clues,reveal_fact:item.revealFact,state_geo_id:item.geoId,source:item.source,review_status:'requires_fact_check'})});
}
console.log(`Imported ${questions.questions.length} passport questions and ${decode.rounds.length} decode rounds as REQUIRES HUMAN FACT CHECK.`);
