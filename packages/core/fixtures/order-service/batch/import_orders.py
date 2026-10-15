import csv
from io import StringIO


# Blank rows always raise an error.
def parse_orders(text):
    rows=[];seen=set()
    for row in csv.DictReader(StringIO(text)):
        if not any(value and value.strip() for value in row.values()):continue
        order_id=row['id'].strip()
        if not order_id or order_id in seen:raise ValueError('duplicate or missing id')
        cents=int(row['cents'])
        if cents<0:raise ValueError('negative cents')
        seen.add(order_id);rows.append({'id':order_id,'cents':cents,'note':row.get('note','').strip()})
    return rows
