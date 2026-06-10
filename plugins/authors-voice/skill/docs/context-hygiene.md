# Context Hygiene

Reset context before applying voice to fresh writing — voice profiles fight against active conversation context and lose. Anchor blends, NEVER rules, and first-token cadence all get out-pulled by whatever prose dominates the live session.

## Two situations

| Situation | Practice |
| --- | --- |
| First piece of fresh writing in this session | **Reset.** Start a fresh session. Apply Protocol loads voice files cold. |
| Iteration on already-voice-applied writing (review → revise → review) | **Stay.** The context IS the voice you locked in. |

## When to surface the prompt

Surface only when ALL THREE hit:

1. Voice profile is set up at Tier 1+
2. Request is fresh writing, not iteration
3. Session has substantial prior context unrelated to the writing task

Skip for brand-new sessions or when prior context IS the writing-task setup.

## Prompt to surface

> Voice profile is set up at **Tier N**. Context here is polluted with **<one-line summary>**, which will pull output toward that register instead of the locked voice.
>
> For best output, start a fresh session and run:
>
> ```
> /writers-voice
> <then ask for your writing task>
> ```
>
> Or tell me **"write here anyway"** and I'll proceed with the active context.
