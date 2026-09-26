---
name: react-composition
description: Improve React component boundaries, state ownership and composition when adding features or fixing rendering behavior.
budget: 800
tags: react frontend
---
Start with the installed React/framework version and nearby components. Preserve public behavior and fit the repository's server/client boundary; newer examples may rely on unavailable APIs.

- Put state with the smallest owner that needs to change it. Derive values during render when they can be computed from current props/state. Use event handlers for user actions; reserve effects for synchronization with an external system. Check stale responses and cleanup when an effect does perform asynchronous work.
- Replace a growing set of mutually exclusive boolean props with an explicit variant or composition when that clarifies actual callers. Prefer children/slots and small focused components over an all-purpose wrapper that hides important behavior. Do not create a compound-component framework for one simple control.
- Keep one source of truth for controlled values. Document a component's controlled/uncontrolled contract if both are needed. Use stable data IDs for dynamic list keys; test insertion/reordering when state could attach to the wrong row.
- Respect framework boundaries for data fetching and secrets. Do not move server-only credentials or fetch logic into a client component to fix an import error. Request independent data concurrently when the surrounding API supports it and doing so avoids a demonstrated waterfall.
- Optimize a measured or evident bottleneck, not every render. Before adding memoization, check expensive work, unnecessary effects, context ownership and large client imports. Keep a simpler implementation when performance is already sufficient.

Run the changed component's behavior tests and typecheck. For interaction changes use `browser-testing`; for layout/accessibility use `frontend-quality`. Validate the specific invariant: retained input after reordering, no duplicate request, correct dialog focus or a stable selection after async completion.

Official references when deeper guidance is needed:

- https://react.dev/learn/you-might-not-need-an-effect
- https://react.dev/learn/sharing-state-between-components
- https://react.dev/learn/rendering-lists
- https://github.com/vercel-labs/agent-skills

These are original Motif workflows, not a copied upstream React ruleset.
