export async function withRetry(send,{sleep=ms=>new Promise(r=>setTimeout(r,ms)),attempts=3,baseMs=100,capMs=2000}={}){
if(!Number.isInteger(attempts)||attempts<1)throw new RangeError('attempts');
for(let attempt=0;attempt<attempts;attempt++){
const response=await send();const retryable=response.status===429||response.status>=500;
if(!retryable||attempt===attempts-1)return response;
const seconds=Number(response.headers?.['retry-after']);
const delay=Number.isFinite(seconds)&&seconds>=0?seconds*1000:baseMs*2**attempt;
await sleep(Math.min(delay,capMs));
}}
