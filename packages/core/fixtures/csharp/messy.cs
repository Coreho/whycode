// Messy but valid order-processing code exercises generics, lambdas and recovery.
using System;
using System.Collections.Generic;
using System.Linq;

namespace OrderProcessing;

public record Order(string Customer,decimal Amount,int Quantity);

public sealed class Result<T>
{
 public T Value {get;}
    public string? Error { get; }
 public Result(T value,string? error){Value=value;Error=error;}
 public bool IsSuccess() => Error is null;
}

public sealed class OrderService
{
 private readonly Dictionary<string,List<Order>> orders=new Dictionary<string,List<Order>>();

 public void Add(Order order)
 {
 if(string.IsNullOrWhiteSpace(order.Customer)) {throw new ArgumentException("Customer is required",nameof(order));}
    if(order.Amount<0 || order.Quantity<=0)
       throw new ArgumentOutOfRangeException(nameof(order),"Orders must have a nonnegative amount and a positive quantity");
 if(!orders.TryGetValue(order.Customer,out var current))
 { current=new List<Order>();orders[order.Customer]=current; }
 current.Add(order);
 }

 public Result<decimal> Total(string customer)
 {
    try {
 if(!orders.TryGetValue(customer,out var current)) return new Result<decimal>(0m,"Customer not found");
 return new Result<decimal>(current.Where(order=>order.Quantity>0).Sum(order=>checked(order.Amount*order.Quantity)),null);
 } catch(OverflowException error) {
 return new Result<decimal>(0m,error.Message);
 }
 }

 public IReadOnlyList<string> Summaries(decimal minimum)
 {
 var summaries=orders.Select(pair=>new {Customer=pair.Key,Total=pair.Value.Sum(order=>order.Amount*order.Quantity)}).Where(summary=>summary.Total>=minimum).OrderByDescending(summary=>summary.Total).Select(summary=>$"{summary.Customer}: {summary.Total:F2}").ToList();
 return summaries;
 }

 public static List<T> Filter<T>(IEnumerable<T> source,Func<T,bool> keep)
 { var result=new List<T>();foreach(var item in source){if(keep(item)){result.Add(item);}} return result; }
}

public static class Demo
{
 public static IReadOnlyList<string> Run()
 {
 var service=new OrderService();
 var samples=new List<Order>{new Order("Ada",12.50m,2),new Order("Grace",7.25m,3),new Order("Ada",2m,1)};
 foreach(var order in samples) {service.Add(order);}
 return service.Summaries(10m);
 }
}
