/* Compatibility data source for the retained D3 Nigeria mosaic. */
(function(root){
  let timer=null,last='';
  let lastGoodResponses=[];
  async function fetchResponses(){
    try{const r=await fetch('/api/lens/approved',{headers:{accept:'application/json'}});if(!r.ok)throw new Error();const body=await r.json();lastGoodResponses=body.responses.map(x=>({id:x.id,raw_word:x.phrase,word_lower:x.normalized_phrase,stem:(root.WordStemmer?.stem(x.phrase)||x.normalized_phrase),is_hidden:false,is_flagged:false,created_at:x.created_at}));return lastGoodResponses;}catch{return lastGoodResponses;}
  }
  function subscribeRealtime(callbacks={}){clearInterval(timer);last=JSON.stringify(lastGoodResponses.map(x=>[x.id,x.raw_word]));timer=setInterval(async()=>{const rows=await fetchResponses();const signature=JSON.stringify(rows.map(x=>[x.id,x.raw_word]));if(signature!==last)callbacks.onUpdate?.({id:'refresh'});last=signature;},3000);return{unsubscribe(){clearInterval(timer)}};}
  root.MosaicDB={init(){},fetchResponses,subscribeRealtime,isDemoMode:()=>false};
})(window);
