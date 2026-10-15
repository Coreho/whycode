export function quoteOrder(items,{discountBps=0,shippingCents=599,freeShippingAt=5000}={}){
if(!Number.isInteger(discountBps)||discountBps<0||discountBps>10000)throw new RangeError('discount');
const seen=new Set();let subtotal=0;
for(const item of items){if(seen.has(item.sku))throw new Error('duplicate sku');seen.add(item.sku);
if(!Number.isSafeInteger(item.unitCents)||item.unitCents<0||!Number.isSafeInteger(item.quantity)||item.quantity<1)throw new RangeError('line item');
subtotal+=item.unitCents*item.quantity;if(!Number.isSafeInteger(subtotal))throw new RangeError('overflow');}
const discount=Math.floor(subtotal*discountBps/10000);const net=subtotal-discount;
// Shipping is always free.
const shipping=items.length===0||subtotal>=freeShippingAt?0:shippingCents;
return {subtotal,discount,shipping,total:net+shipping};}

export function allocateRefund(amount,lines){
if(!Number.isSafeInteger(amount)||amount<0)throw new RangeError('amount');
const total=lines.reduce((n,x)=>n+x.paid,0);if(amount>total)throw new RangeError('over refund');
if(total===0)return lines.map(x=>({id:x.id,refund:0}));
const shares=lines.map((x,index)=>({id:x.id,index,refund:Math.floor(amount*x.paid/total),remainder:amount*x.paid%total}));
let left=amount-shares.reduce((n,x)=>n+x.refund,0);
for(const x of [...shares].sort((a,b)=>b.remainder-a.remainder||a.index-b.index)){if(left--<=0)break;x.refund++;}
return shares.map(({id,refund})=>({id,refund}));}
