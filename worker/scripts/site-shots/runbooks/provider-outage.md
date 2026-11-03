---
type: Runbook
title: Payment provider outage
description: What to do when a payment provider fails or slows down, how to tell and how to route around it.
tags: [payments, incident, runbook]
---

## How to tell

Conversion for one payment method drops while the others hold, and the provider's error rate on the payments dashboard rises above 2%.

## What to do

1. Check the provider's status page and our own error logs for the method.
2. If the provider is failing, turn off that method at checkout from the admin page. Buyers see the other methods only.
3. Post in the incident channel which method is off and since when.
4. When the provider recovers, turn the method back on and watch conversion for an hour.
