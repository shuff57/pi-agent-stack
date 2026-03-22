# Reflect on this session and store learnings

You are running the session-reflector skill.

## Task

1. Review the current session's work
2. Identify 2-5 key learnings (non-obvious things discovered)
3. Append each learning to `~/Documents/GitHub/pi-memories/hivemind/memories.jsonl`
4. Write a session summary to `.pi/agent-sessions/last-session.md`
5. Report what was stored

## Learning Format (append to memories.jsonl, one JSON per line)

```json
{"id": "TIMESTAMP", "information": "LEARNING_TEXT_WITH_WHY", "tags": "tag1,tag2,tag3", "session_date": "YYYY-MM-DD", "project": "PROJECT_NAME"}
```

Get current timestamp: `date +%s` (Unix timestamp as ID)
Get current date: `date +%Y-%m-%d`

## What Makes a Good Learning

- Include WHY it's non-obvious
- Include the solution, not just the problem
- Include tags that make it findable later
- Prefer "X pattern causes Y, fix with Z" over "fixed bug in X"

## Session Summary Format (.pi/agent-sessions/last-session.md)

```markdown
# Session: DATE
## Accomplished
- bullet 1
- bullet 2

## Key Decisions
- decision: rationale

## Learnings Stored
- learning title → memories.jsonl line N

## Next Steps
- next thing to work on
```

Begin by reviewing what was done in this session, then store your learnings.
