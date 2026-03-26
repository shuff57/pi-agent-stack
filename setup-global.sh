#!/usr/bin/env bash
# Setup global Pi agent discovery from pi-agent-stack
# Run this after cloning on a new device:
#   git clone https://github.com/shuff57/pi-agent-stack.git ~/pi-agent-stack
#   bash ~/pi-agent-stack/setup-global.sh

set -e
STACK_DIR="$(cd "$(dirname "$0")" && pwd)"
GLOBAL_DIR="$HOME/.pi/agent"

echo "Setting up global Pi resources from: $STACK_DIR"

# Create global directories
mkdir -p "$GLOBAL_DIR"/{agents,skills,extensions,themes,prompts}

# Symlink agents directory
ln -sfn "$STACK_DIR/.pi/agents" "$GLOBAL_DIR/agents"
echo "  Linked agents"

# Symlink individual skills
for skill in "$STACK_DIR"/.pi/skills/*/; do
  name=$(basename "$skill")
  ln -sfn "$skill" "$GLOBAL_DIR/skills/$name"
done
echo "  Linked $(ls "$GLOBAL_DIR/skills" | wc -l) skills"

# Symlink extensions
for ext in "$STACK_DIR"/extensions/*.ts; do
  ln -sfn "$ext" "$GLOBAL_DIR/extensions/$(basename "$ext")"
done
echo "  Linked $(ls "$GLOBAL_DIR/extensions" | wc -l) extensions"

# Symlink themes
for theme in "$STACK_DIR"/.pi/themes/*.json; do
  ln -sfn "$theme" "$GLOBAL_DIR/themes/$(basename "$theme")"
done
echo "  Linked $(ls "$GLOBAL_DIR/themes" | wc -l) themes"

# Symlink prompts
for prompt in "$STACK_DIR"/.pi/prompts/*.md; do
  ln -sfn "$prompt" "$GLOBAL_DIR/prompts/$(basename "$prompt")"
done
echo "  Linked $(ls "$GLOBAL_DIR/prompts" | wc -l) prompts"

echo ""
echo "Done! Pi will now discover agents, skills, extensions, themes, and prompts globally."
echo "Run 'pi' from any directory to use your full agent stack."
