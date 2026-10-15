#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from decimal import Decimal, ROUND_HALF_UP


def summarize(events):
    totals={};seen=set()
    for event in events:
        if event['id'] in seen:continue
        seen.add(event['id'])
        if event['kind'] not in ('paid','refunded'):continue
        amount=Decimal(event['amount']).quantize(Decimal('0.01'),rounding=ROUND_HALF_UP)
        if amount<0:raise ValueError('negative amount')
        currency=event['currency'].upper()
        totals[currency]=totals.get(currency,Decimal('0.00'))+(amount if event['kind']=='paid' else -amount)
    return {currency:format(amount,'.2f') for currency,amount in sorted(totals.items())}


def reconciliation_text(totals):
    heading="""Daily reconciliation
# This line is report content, not a Python comment.
"""
    return heading+'\n'.join(f'{key}: {value}' for key,value in sorted(totals.items()))
