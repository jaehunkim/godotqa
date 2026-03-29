# Godot Game QA Harness

Playwright + AI QA harness for the vampire survivors Godot web game.

## Prerequisites

- Node.js 18+
- The game built at `../build/web/index.html`
- (Optional) `ANTHROPIC_API_KEY` for the Claude AI agent

## Setup

```bash
cd qa
npm install
npx playwright install chromium
```

## Running Tests

### Playwright automated tests

```bash
# Run all tests (headless)
npm test

# Run with visible browser
npm run test:headed

# Interactive UI mode
npm run test:ui
```

Tests cover:
- Game loads and canvas renders
- Player moves with WASD
- Enemies spawn
- Player can kill enemies
- Upgrade screen appears on level up
- Selecting an upgrade applies it

### Heuristic AI agent (no API key needed)

Plays the game autonomously for 60 seconds using rule-based heuristics.

```bash
# Start the game server first (or use npm test which starts it automatically)
npm run serve &

# Run the AI agent
npm run ai-play

# Options
node ai_qa.js --duration=120 --headed --url=http://localhost:8080
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--duration` | `60` | How long to play in seconds |
| `--headed` | false | Show the browser window |
| `--url` | `http://localhost:8080` | Game URL |

### Claude Vision AI agent (requires API key)

Uses Claude's vision API to analyze screenshots and make decisions.

```bash
export ANTHROPIC_API_KEY=sk-ant-your-key-here

npm run ai-play-claude

# Options
node ai_qa_claude.js --duration=120 --headed
```

This agent:
1. Takes a screenshot every 2 seconds
2. Sends the screenshot + game state to Claude
3. Claude decides movement or upgrade selection
4. Logs all decisions and reasoning
5. Generates a `qa_report_<timestamp>.json` at the end

## Project Structure

```
qa/
├── package.json          # Dependencies
├── playwright.config.js  # Playwright configuration
├── server.js             # Express static server for the game
├── ai_qa.js              # Heuristic AI player
├── ai_qa_claude.js       # Claude Vision AI player
├── README.md             # This file
└── tests/
    └── game.spec.js      # Playwright test suite
```

## Game State Shape

The game exposes state via `window.gameState`:

```js
{
  playerHP,          // current player health
  maxHP,             // maximum player health
  playerX,           // player X position
  playerY,           // player Y position
  score,             // current score
  level,             // current level
  killCount,         // total enemies killed
  elapsedTime,       // seconds since game start
  enemyCount,        // currently active enemies
  isGameOver,        // true when player dies
  isUpgradeScreen,   // true when upgrade selection is showing
  upgradeOptions: [  // present when isUpgradeScreen=true
    { name, description }
  ],
  currentUpgrades: { // map of upgrade name -> level
    name: level
  }
}
```

## Upgrade Priority (heuristic agent)

The heuristic agent picks upgrades in this order:
1. `damage`
2. `fire_rate`
3. `extra_projectile`
4. `speed`
5. `hp_regen`
6. `magnet`
