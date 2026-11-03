---
type: Decision
title: Retry budget for card checks
description: Retry a card check up to three times when the card network is slow, trading some latency for fewer failed orders.
tags: [checkout, payments, decision]
status: stable
---

## Decision

When the card network takes longer than 1.5 s to answer, retry the check up to three times, with backoff, before showing the buyer an error. Before 14 October we retried once.

## Why

One order in a hundred failed on a slow answer that a second or third try would have passed. Each of those is a buyer who has already decided to pay.

## What we gave up

The slowest checkouts now wait longer: p95 latency rose by about 230 ms. We accept that while it stays under the 800 ms where abandonment rises, and we will look again if it does not.
