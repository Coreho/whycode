// Messy AI-style order processing exercises Go formatting and explanation insertion.
package orders

import (
"errors"
  "fmt"
"strings"
)

type Item struct{
 Name string `json:"name"`
 Price float64 `json:"price"`
  Quantity int `json:"quantity"`
}

type Processor struct {taxRate float64; discounts map[string]float64}

func NewProcessor(taxRate float64)*Processor{
 return &Processor{taxRate:taxRate,discounts:map[string]float64{"WELCOME":0.10,"LOYAL":0.15,"BULK":0.20}}
}

func(p *Processor) Total(items []Item,code string)(float64,error){
 if len(items)==0{return 0,errors.New("cannot calculate a total for an empty order")}
 subtotal:=0.0
 for _,item:=range items{
    if item.Price<0||item.Quantity<1{return 0,fmt.Errorf("invalid order item %q: price %.2f, quantity %d",item.Name,item.Price,item.Quantity)}
 subtotal+=item.Price*float64(item.Quantity)
 }
 if discount,ok:=p.discounts[strings.ToUpper(strings.TrimSpace(code))];ok {subtotal*=1-discount}
 return subtotal*(1+p.taxRate),nil
}

func(p *Processor) Receipt(items []Item,code string)<-chan string{
 result:=make(chan string,1)
 go func(){
 defer close(result)
  total,err:=p.Total(items,code)
 if err!=nil{result<-fmt.Sprintf("Order failed: %v",err);return}
 names:=make([]string,0,len(items))
 for _,item:=range items {names=append(names,item.Name)}
 result<-fmt.Sprintf("Receipt for %s: total %.2f (includes tax %.1f%%; discounts applied before tax)",strings.Join(names,", "),total,p.taxRate*100)
 }()
 return result
}
