---
name: session-reflector
description: Use at the end of a pi work session to persist learnings to hivemind memory, write a session summary, and sync pi-memories to git. Triggers - end session, reflect, store learnings, session summary.
---

# Session Reflector Skill

Use at the END of every pi session to persist learnings and keep memory indexed.

## When To Use

- Before ending a long work session
- After solving a hard problem
- After discovering a significant pattern or gotcha
- When switching between projects

## Workflow

### Step 1: Summarize What Was Done

Write a 3-5 bullet summary of:
- What was accomplished
- Key decisions made (and why)
- Problems encountered and how they were solved
- Patterns discovered

### Step 2: Identify Learnings

For each non-obvious thing learned:
```
LEARNING: [what you learned]
WHY IT MATTERS: [why it's non-obvious or important to remember]
TAGS: [relevant,comma,separated,tags]
```

### Step 3: Write to Memory

Append learnings to `~/pi-memories/hivemind/memories.jsonl`:

```json
{"id": "<timestamp>", "information": "<learning with WHY>", "tags": "<tags>", "session_date": "<YYYY-MM-DD>", "project": "<project-name>"}
```

One JSON object per line. Never overwrite — always append.

### Step 4: Write Session Summary

Create/update `.pi/agent-sessions/last-session.md`:

```markdown
# Session: <date>
## Accomplished
- [bullet 1]
- [bullet 2]

## Key Decisions
- [decision and rationale]

## Learnings Stored
- [learning title] → memories.jsonl

## Next Steps
- [what to pick up next session]
```

### Step 5: Sync (if connected)

If git is configured for pi-memories:
```bash
cd ~/pi-memories && git add -A && git commit -m "session: <date> <project>" && git push
```

## Output Format

After completing the reflection:
```
SESSION REFLECTED: <date>
Learnings stored: N
Summary saved to: .pi/agent-sessions/last-session.md
Memory synced: [yes/no]
```
