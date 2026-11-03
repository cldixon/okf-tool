---
type: Metric
title: Checkout latency
description: How long a buyer waits between pressing Pay and seeing the order confirmed, at the 95th percentile, and why it moved in October.
tags: [checkout, latency, slo]
sources:
  - id: retry
    title: Retry budget for card checks
    resource: /decisions/retry-budget.md
  - id: outage
    title: Payment provider outage runbook
    resource: /runbooks/provider-outage.md
---

Checkout latency is the time from the Pay button to the confirmation page, measured in the browser and reported as the daily 95th percentile. Our objective is 500 ms; above 800 ms, abandoned carts rise measurably.

## What changed

On 14 October p95 rose from 410 ms to 640 ms and has stayed there. The rise starts with the release that raised the retry budget for card checks from one retry to three.[^retry] Slow answers from the card network are now retried rather than failed, so fewer orders are lost but the slowest checkouts wait longer.

```vega-lite alt="Daily p95 checkout latency from 7 to 24 October: about 410 ms until 13 October, then about 640 ms" title="Daily p95 checkout latency, ms"
{
  "data": {
    "values": [
      {"day": "2026-10-07", "p95": 405}, {"day": "2026-10-08", "p95": 412},
      {"day": "2026-10-09", "p95": 398}, {"day": "2026-10-10", "p95": 420},
      {"day": "2026-10-11", "p95": 409}, {"day": "2026-10-12", "p95": 415},
      {"day": "2026-10-13", "p95": 411}, {"day": "2026-10-14", "p95": 633},
      {"day": "2026-10-15", "p95": 648}, {"day": "2026-10-16", "p95": 641},
      {"day": "2026-10-17", "p95": 652}, {"day": "2026-10-18", "p95": 630},
      {"day": "2026-10-19", "p95": 644}, {"day": "2026-10-20", "p95": 638},
      {"day": "2026-10-21", "p95": 646}, {"day": "2026-10-22", "p95": 639},
      {"day": "2026-10-23", "p95": 651}, {"day": "2026-10-24", "p95": 642}
    ]
  },
  "width": "container",
  "height": 180,
  "mark": {"type": "line", "point": true},
  "encoding": {
    "x": {"field": "day", "type": "temporal", "title": null, "axis": {"format": "%d %b"}},
    "y": {"field": "p95", "type": "quantitative", "title": "ms", "scale": {"domain": [0, 800]}}
  }
}
```

## How it is measured

The browser records the time between the click on Pay and the first paint of the confirmation page, and sends it with the order id. Orders that fail or are abandoned are not counted, so a provider outage shows here as fewer samples, not as a spike.[^outage]

[^retry]: Retry budget for card checks.
[^outage]: Payment provider outage runbook.
