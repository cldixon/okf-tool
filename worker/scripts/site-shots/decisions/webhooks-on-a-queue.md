---
type: Decision
title: Provider webhooks go through a queue
description: Payment provider webhooks are acknowledged at once and handled from a queue, so a slow handler never makes the provider retry.
tags: [payments, webhooks, decision]
status: stable
---

## Decision

Every webhook from a payment provider is written to a queue and acknowledged within 100 ms. A worker handles it from the queue, idempotently by the event's id.

## Why

Providers retry a webhook that is not acknowledged quickly, and our handler was sometimes slower than their timeout. The retries arrived while the first attempt was still running, and two of them once refunded the same order twice.
