// Messy order-processing code for exercising Rust formatting and explanations.
use std::num::ParseIntError;

macro_rules! label {
 ($prefix:expr,$value:expr)=>{format!("{}: {}",$prefix,$value)};
}

#[derive(Debug,Clone)]
pub struct Order<'a>{pub customer:&'a str,pub quantities:Vec<u32>,pub state:OrderState}

#[derive(Debug,Clone)]
pub enum OrderState {Pending,Ready(u32),Rejected{reason:String}}

pub trait Receipt {
fn receipt(&self)->String;
}

impl<'a> Order<'a>{
 pub fn parse(customer:&'a str,raw:&[&str])->Result<Self,ParseIntError>{
let quantities=raw.iter().map(|value|value.parse::<u32>()).collect::<Result<Vec<_>,_>>()?;
    Ok(Self{customer,quantities,state:OrderState::Pending})
 }
pub fn total(&self)->u32{self.quantities.iter().copied().filter(|quantity|*quantity>0).map(|quantity|quantity*125).sum()}
 pub fn summary(&self)->String{
  let status=match &self.state {OrderState::Pending=>"pending".to_owned(),OrderState::Ready(count)=>format!("ready with {count} items"),OrderState::Rejected{reason}=>format!("rejected: {reason}")};
format!("Customer {} has {} entries costing {} cents; current order status is {}",self.customer,self.quantities.len(),self.total(),status)
 }
}

impl Receipt for Order<'_> {
 fn receipt(&self)->String {label!("Order",self.summary())}
}

pub async fn preview(receipt:&dyn Receipt)->String{receipt.receipt()}

#[cfg(test)]
mod tests {
use super::*;
 #[test]
fn computes_total(){let order=Order::parse("Ada",&["2","0","3"]).unwrap();assert_eq!(order.total(),625);assert!(order.receipt().contains("Ada"));}
}
