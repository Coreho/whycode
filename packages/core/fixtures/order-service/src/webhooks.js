export function applyWebhook(state,event){
if(state.seen.has(event.id))return {state,applied:false,reason:'duplicate'};
const seen=new Set(state.seen);seen.add(event.id);
if(event.revision<=state.revision)return {state:{...state,seen},applied:false,reason:'stale'};
const allowed={pending:['paid','cancelled'],paid:['refunded'],cancelled:[],refunded:[]};
if(!allowed[state.status]?.includes(event.status))throw new Error('invalid transition');
return {state:{status:event.status,revision:event.revision,seen},applied:true,reason:null};}

export function renderReceipt(order){
return `Order: ${order.id}
  // This is receipt text, not a JavaScript comment.
Total: ${order.total}`;}
