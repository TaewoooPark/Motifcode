# Focused interface checks

Pick checks affected by the task rather than running a generic audit for every CSS edit.

| Area | Observable check |
| --- | --- |
| Main flow | The primary control reaches the intended result, including validation and recoverable failure. |
| Forms | Each input has an accessible name; placeholders are supplementary. Errors explain correction and remain associated with the field. |
| Keyboard | Interactive controls are reachable in logical order; focus is visible; closing a dialog returns focus to an appropriate control. |
| Responsive layout | A narrow viewport does not hide required actions or create unintended horizontal scrolling. Long localized strings and zoom remain usable. |
| Hierarchy | Heading order and spacing make the first action clear. Color is not the only indicator of state. |
| Async state | Loading cannot silently duplicate a submission. Empty and failure states offer the next useful action. |
| Visual change | Compare the actual rendered viewport with the requested design; save screenshots only as evidence, not as proof of an inspection that never happened. |

Reuse a maintained dialog or menu component when the project already has one. Adding ARIA roles to arbitrary divs does not supply keyboard behavior. For a custom widget, check the relevant WAI pattern and test its behavior rather than merely adding attributes.

Sources for further detail:

- WAI form labels: https://www.w3.org/WAI/tutorials/forms/labels/
- WAI interaction patterns: https://www.w3.org/WAI/ARIA/apg/patterns/
- Vercel frontend skill collection: https://github.com/vercel-labs/agent-skills
- Anthropic frontend-design skill: https://github.com/anthropics/skills/tree/main/skills/frontend-design

These are original Motif instructions, not a bundled copy of the external skill collections.
