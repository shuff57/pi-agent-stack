# Pi Agent Stack

Pi Coding Agent extension playground with agents, teams, chains, and memory.

## Tooling
- **Package manager**: `bun` (not npm/yarn/pnpm)
- **Task runner**: `just` (see justfile)
- **Extensions run via**: `pi -e extensions/<name>.ts`
- **Quick launch**: `agent` alias → command-deck + memory stack

## Project Structure
- `extensions/` — Pi extension source files (.ts)
- `specs/` — Feature specifications
- `.pi/agents/` — Agent definitions (19 agents)
- `.pi/agents/pi-pi/` — Pi-Pi meta-agent experts (10 agents)
- `.pi/agents/teams.yaml` — Team compositions (9 teams)
- `.pi/agents/agent-chain.yaml` — Sequential pipelines (10 chains)
- `.pi/skills/` — Skills (bowser, session-reflector)
- `.pi/prompts/` — Prompt templates (reflect.md)
- `.pi/themes/` — Custom themes
- `.pi/agent-sessions/` — Ephemeral session files (gitignored)

## Auth
- Uses Anthropic OAuth (not API keys)
- Default provider: anthropic
- Default model: claude-sonnet-4-6

## Core Agents (full team)
scout, planner, builder, reviewer, documenter, red-team

## Specialist Agents
advisor, librarian, scope-check, plan-reviewer, atlas, visual-analyzer, orchestrator, hivemind-curator

## Memory System
- Location: `~/pi-memories/`
- hivemind: persistent cross-session learnings (JSONL)
- cass: cross-agent session search
- swarmmail: cross-agent messages
- Curator auto-creates agents (via pi-pi), teams, and chains from patterns

## Conventions
- Extensions are standalone .ts files loaded by Pi's jiti runtime
- Available imports: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, `@sinclair/typebox`, plus any deps in package.json
- Register tools at the top level of the extension function (not inside event handlers)
- Use `isToolCallEventType()` for type-safe tool_call event narrowing
- Theme mapping in `extensions/themeMap.ts` — each extension has a default theme
