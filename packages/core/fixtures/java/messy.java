// Messy AI-style order processing exercises Java formatting and explanatory comments.
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;

record OrderItem(String name,double price,int quantity) {
 double subtotal( ) {
return price*quantity;
 }
}

class OrderProcessor {
 private final double taxRate;
private final Map<String,Double> discounts=new LinkedHashMap<>();

 OrderProcessor(double taxRate) {
this.taxRate=taxRate;discounts.put("WELCOME",0.10); discounts.put("LOYAL",0.15);
 }

 double total(List<? extends OrderItem> items,String coupon) {
 if(items.isEmpty()){throw new IllegalArgumentException("Cannot calculate a total for an empty order");}
double subtotal=0;
 for(OrderItem item:items){
if(item.price()<0||item.quantity()<1){throw new IllegalArgumentException("Invalid item "+item.name()+": price "+item.price()+", quantity "+item.quantity());}
 subtotal+=item.subtotal();
 }
 double discount=discounts.getOrDefault(coupon.trim().toUpperCase(Locale.ROOT),0.0);
return subtotal*(1-discount)*(1+taxRate);
 }

 List<String> receipts(Map<String,List<OrderItem>> orders,String coupon) {
List<String> receipts=new ArrayList<>();
 orders.forEach((customer,items)->{
 try {double amount=total(items,coupon);receipts.add("Receipt for "+customer+": total "+amount+" (includes tax; discounts applied before tax)");}
 catch(IllegalArgumentException error){receipts.add("Order failed for "+customer+": "+error.getMessage());}
 });
receipts.sort(Comparator.naturalOrder());return receipts;
 }
}

class OrderReport {
 static <T> Map<String,List<T>> group(List<T> values,Function<? super T,String> key) {
Map<String,List<T>> groups=new LinkedHashMap<>();
values.forEach(value->groups.computeIfAbsent(key.apply(value),ignored->new ArrayList<>()).add(value));
return groups;
 }
}
