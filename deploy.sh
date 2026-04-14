#!/bin/bash
# ============================================================
# Action's Odds — Railway Deploy Script
# Usage: ./deploy.sh "your commit message"
# ============================================================

set -e

PROJECT_DIR="$HOME/Downloads/actionsodds"
SOURCE_HTML="$HOME/Downloads/index.html"
TARGET_HTML="$PROJECT_DIR/public/index.html"

GREEN='\033[0;32m'
GOLD='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${GOLD}================================================${NC}"
echo -e "${GOLD}  ACTION'S ODDS — Railway Deploy${NC}"
echo -e "${GOLD}================================================${NC}"
echo ""

if [ -z "$1" ]; then
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
  COMMIT_MSG="deploy: update $TIMESTAMP"
else
  COMMIT_MSG="$1"
fi

if [ ! -d "$PROJECT_DIR" ]; then
  echo -e "${RED}ERROR: Project directory not found at $PROJECT_DIR${NC}"
  exit 1
fi

if [ ! -f "$SOURCE_HTML" ]; then
  echo -e "${RED}ERROR: index.html not found at $SOURCE_HTML${NC}"
  echo "Download the latest index.html to ~/Downloads/ first."
  exit 1
fi

echo "Copying index.html to project..."
cp "$SOURCE_HTML" "$TARGET_HTML"
echo -e "${GREEN}✓ File copied${NC}"

cd "$PROJECT_DIR"

if git diff --quiet && git diff --cached --quiet; then
  echo -e "${GOLD}No changes detected — nothing to deploy.${NC}"
  exit 0
fi

echo "Staging changes..."
git add -A
echo -e "${GREEN}✓ Staged${NC}"

echo "Committing: \"$COMMIT_MSG\""
git commit -m "$COMMIT_MSG"
echo -e "${GREEN}✓ Committed${NC}"

echo "Pushing to GitHub (triggers Railway deploy)..."
git push origin main
echo -e "${GREEN}✓ Pushed${NC}"

echo ""
echo -e "${GOLD}================================================${NC}"
echo -e "${GREEN}  DEPLOYED SUCCESSFULLY${NC}"
echo -e "${GOLD}================================================${NC}"
echo ""
echo -e "Live in ~60-90 seconds at:"
echo -e "${GOLD}  actionsodds-production.up.railway.app${NC}"
echo ""
