import os,sys,time
from typing import List,Dict,Optional
import requests

DEFAULT_TIMEOUT=30
API_URL = "https://api.example.com/v1/"

def fetch_user_data(user_id:int,include_orders:bool=False,retries:int=3)->Optional[Dict]:
    url=API_URL+"users/"+str(user_id)
    for attempt in range(retries):
        try:
            response=requests.get(url,params={"orders":include_orders},timeout=DEFAULT_TIMEOUT)
            if response.status_code==200:
                return response.json()
            elif response.status_code==429:
                time.sleep(2**attempt)
        except requests.RequestException as e:
            print(f"Attempt {attempt+1} failed: {e}")
    return None



class OrderProcessor:
    """Processes orders."""
    def __init__(self,tax_rate:float=0.08,discount_codes:Dict[str,float]=None):
        self.tax_rate=tax_rate
        self.discount_codes=discount_codes or {}
    def calculate_total(self,items:List[Dict],code:Optional[str]=None)->float:
        subtotal=sum(item["price"]*item["quantity"] for item in items if item.get("quantity",0)>0)
        if code and code in self.discount_codes:
            subtotal=subtotal*(1-self.discount_codes[code])
        total = subtotal + \
            subtotal*self.tax_rate
        return round(total,2)
    @staticmethod
    def format_receipt(items, total):
        lines = [f"{i['name']:<20}{i['price']:>8.2f}" for i in items]
        return """RECEIPT
=======
""" + "\n".join(lines) + f"\nTOTAL: {total:.2f}"
