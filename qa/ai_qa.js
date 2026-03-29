/**
 * ai_qa.js - Autonomous heuristic AI player for Godot vampire survivors clone
 *
 * Plays the game autonomously using keyboard input and game state heuristics.
 * No LLM calls - pure rule-based decision making. See ai_qa_claude.js for
 * the Claude API version.
 *
 * Usage:
 *   node ai_qa.js [--duration=60] [--headed] [--url=http://localhost:8080]
 */

import { chromium } from 'playwright';

// --- CLI argument parsing ---
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const DURATION_MS = parseInt(args.duration ?? '60', 10) * 1000;
const HEADED = args.headed === true || args.headed === 'true';
const BASE_URL = args.url ?? 'http://localhost:8080';

// Upgrade priority: higher index = lower priority
const UPGRADE_PRIORITY = [
  'damage',
  'fire_rate',
  'extra_projectile',
  'speed',
  'hp_regen',
  'magnet',
];

function pickBestUpgrade(upgradeOptions) {
  if (!upgradeOptions || upgradeOptions.length === 0) return 0;

  let bestIndex = 0;
  let bestScore = Infinity;

  for (let i = 0; i < upgradeOptions.length; i++) {
    const name = (upgradeOptions[i].name ?? '').toLowerCase();
    const priorityScore = UPGRADE_PRIORITY.findIndex((p) =>
      name.includes(p)
    );
    const score = priorityScore === -1 ? UPGRADE_PRIORITY.length : priorityScore;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * Decide movement direction based on game state.
 * Simple strategy: move away from the nearest enemy cluster.
 * Falls back to circular movement if no enemies.
 */
function decideMovement(state, tick) {
  const { playerX, playerY, enemyCount } = state;

  // If no enemies, do a slow circular drift to attract them
  if (!enemyCount || enemyCount === 0) {
    const dirs = ['d', 'd', 's', 's', 'a', 'a', 'w', 'w'];
    return dirs[tick % dirs.length];
  }

  // Without exact enemy positions in gameState, use a pseudo-random
  // evasive pattern that keeps the player moving unpredictably.
  // Pattern: move in 8-direction cycles of ~400ms each
  const pattern = ['w', 'd', 's', 'a', 'w', 'a', 's', 'd'];
  return pattern[tick % pattern.length];
}

async function holdKey(page, key, ms) {
  await page.keyboard.down(key);
  await new Promise((r) => setTimeout(r, ms));
  await page.keyboard.up(key);
}

async function getGameState(page) {
  return page.evaluate(() => window.gameState ?? null);
}

async function selectUpgrade(page, index) {
  // Godot renders UI on canvas - click at the button's canvas position
  // Upgrade panel is centered (1280x720), buttons are stacked vertically
  // Button Y positions: btn0 ~260, btn1 ~348, btn2 ~435
  const buttonY = [260, 348, 435];
  const y = buttonY[index] ?? buttonY[0];
  const canvas = page.locator('canvas');
  await canvas.click({ position: { x: 640, y } });
  await page.waitForTimeout(200);
  return `canvas(640, ${y})`;
}

async function main() {
  console.log(`Starting AI QA agent`);
  console.log(`  Duration: ${DURATION_MS / 1000}s`);
  console.log(`  Headed:   ${HEADED}`);
  console.log(`  URL:      ${BASE_URL}`);
  console.log('');

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--disable-web-security',
      '--allow-running-insecure-content',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  // --- Navigate ---
  await page.goto(BASE_URL);
  console.log('Navigated to game. Waiting for Godot to initialize...');

  // Wait for canvas and gameState
  await page.waitForSelector('canvas', { timeout: 20000 });
  await page.waitForFunction(
    () => typeof window.gameState !== 'undefined' && window.gameState !== null,
    { timeout: 30000 }
  );
  console.log('Game ready. Starting play loop.\n');

  // Click canvas to ensure focus
  await page.click('canvas');

  // --- Tracking ---
  const startTime = Date.now();
  let tick = 0;
  let lastLogTime = Date.now();
  let upgradesChosen = [];
  let restartCount = 0;

  const LOG_INTERVAL_MS = 5000;
  const MOVE_DURATION_MS = 350;

  // --- Main game loop ---
  while (Date.now() - startTime < DURATION_MS) {
    const state = await getGameState(page);

    if (!state) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    // --- Game over: log and restart ---
    if (state.isGameOver) {
      console.log('\n=== GAME OVER ===');
      console.log(`  Kills:    ${state.killCount}`);
      console.log(`  Level:    ${state.level}`);
      console.log(`  Score:    ${state.score}`);
      console.log(`  Elapsed:  ${state.elapsedTime?.toFixed(1)}s`);
      console.log(`  Upgrades: ${upgradesChosen.join(', ') || 'none'}`);

      restartCount++;
      upgradesChosen = [];

      // Attempt restart - common Godot patterns
      const restarted = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')].filter(
          (b) => b.offsetParent !== null
        );
        const restartBtn = buttons.find(
          (b) =>
            /restart|play again|retry|new game/i.test(b.textContent ?? '')
        );
        if (restartBtn) { restartBtn.click(); return true; }
        return false;
      });

      if (!restarted) {
        await page.keyboard.press('Enter');
        await new Promise((r) => setTimeout(r, 300));
        await page.keyboard.press('Space');
      }

      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    // --- Upgrade screen: pick best upgrade ---
    if (state.isUpgradeScreen) {
      const options = state.upgradeOptions ?? [];
      const best = pickBestUpgrade(options);
      const chosen = options[best];
      const chosenName = chosen?.name ?? `option_${best}`;

      console.log(`\n[UPGRADE] Choosing: ${chosenName} (index ${best})`);
      if (options.length > 0) {
        console.log('  Options:', options.map((o) => o.name).join(', '));
      }

      await new Promise((r) => setTimeout(r, 300));
      await selectUpgrade(page, best);
      upgradesChosen.push(chosenName);

      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    // --- Normal play: move ---
    const direction = decideMovement(state, tick);
    await holdKey(page, direction, MOVE_DURATION_MS);
    tick++;

    // --- Periodic state log ---
    if (Date.now() - lastLogTime >= LOG_INTERVAL_MS) {
      lastLogTime = Date.now();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[${elapsed}s] HP: ${state.playerHP}/${state.maxHP} | ` +
        `Level: ${state.level} | Kills: ${state.killCount} | ` +
        `Enemies: ${state.enemyCount} | Score: ${state.score}`
      );
    }
  }

  // --- Final summary ---
  const finalState = await getGameState(page);
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n========== AI QA SUMMARY ==========');
  console.log(`  Total wall time:  ${totalElapsed}s`);
  console.log(`  Restarts:         ${restartCount}`);

  if (finalState) {
    console.log(`  Final kills:      ${finalState.killCount}`);
    console.log(`  Final level:      ${finalState.level}`);
    console.log(`  Final score:      ${finalState.score}`);
    console.log(`  Time survived:    ${finalState.elapsedTime?.toFixed(1)}s`);
    console.log(`  HP remaining:     ${finalState.playerHP}/${finalState.maxHP}`);
  }
  console.log(`  Upgrades chosen:  ${upgradesChosen.join(', ') || 'none'}`);
  console.log('====================================\n');

  await browser.close();
}

main().catch((err) => {
  console.error('AI QA agent error:', err);
  process.exit(1);
});
