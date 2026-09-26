---
name: frontend-quality
description: Build or refine a web interface with intentional visual hierarchy, responsive behavior, accessible controls and browser verification.
budget: 950
tags: frontend design accessibility
---
Make the interface serve the user's task and fit the existing product. Read its components, design tokens, routing and scripts before selecting libraries or introducing a new visual direction.

1. Identify the main action, content hierarchy and important states: loading, empty, error and success. For a new page choose a specific typographic scale, spacing rhythm and restrained color roles. For an existing page preserve its established system. Avoid filling every section with the same card treatment when a list, table or plain section better explains the content.
2. Implement the smallest usable flow before decorative detail. Use actual routes and handlers; a styled button with no behavior is incomplete. Keep temporary demo data distinguishable from live data and never imply a successful submission without an actual result.
3. Use semantic elements first: links for navigation, buttons for actions, associated form labels, meaningful headings and useful alternative text. Support keyboard operation and visible focus. Keep validation near the affected field and announce asynchronous results when appropriate. Read [references/interface-checks.md](references/interface-checks.md) for a focused review.
4. Fit layout to narrow and wide viewports using content-driven sizing. Check long text, larger text, empty lists and overflowing values. Respect reduced-motion preferences when adding animation. Use existing dependencies before adding an icon, animation or component library.
5. Run the project's build/typecheck and relevant tests. Load `browser-testing` for runtime or visual changes: exercise the main flow, keyboard focus, a narrow viewport and the states changed by the patch. Request a screenshot for visual work, but do not claim it was inspected without image-capable tooling.

For React state or component API problems, load `react-composition`. For an unfamiliar framework API, load `library-docs` and check the installed version. Do not fetch design references or library docs when the local implementation already answers the question.

Report what works, where it was verified and any deliberate placeholder. Keep a visual redesign proportionate to the requested change.
