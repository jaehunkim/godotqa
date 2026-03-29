/**
 * ai_qa_claude.js - Claude Vision API powered QA agent for Godot vampire survivors clone
 *
 * Uses Claude's vision capability to analyze screenshots and gameState, then
 * decides what actions to take. Logs all decisions and generates a QA report.
 *
 * REQUIREMENTS:
 *   - Set ANTHROPIC_API_KEY environment variable
 *   - npm install (installs @anthropic-ai/sdk)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node ai_qa_claude.js [--duration=60] [--headed]
 *
 * Phase 2 template - Claude API integration is complete and functional.
 */

import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... node ai_qa_claude.js');
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const DURATION_MS = parseInt(args.duration ?? '60', 10) * 1000;
const HEADED = args.headed === true || args.headed === 'true';
const BASE_URL = args.url ?? 'http://localhost:8080';
const DECISION_INTERVAL_MS = 2000;
const CLAUDE_MODEL = 'claude-opus-4-5';

// --- Anthropic client ---
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// --- Decision log ---
const decisionLog = [];

function buildMovementPrompt(state) {
  return `You are a QA agent testing a vampire survivors style game. Your job is to play the game to test its mechanics.

Current game state:
${JSON.stringify(state, null, 2)}

The player auto-shoots at the nearest enemy. You only control movement with WASD keys.

Decide the next movement action. Respond with ONLY valid JSON (no markdown, no explanation):
{
  "keys": ["w"|"a"|"s"|"d"],
  "duration": <milliseconds 100-500>,
  "reasoning": "<brief explanation>"
}

Strategy hints:
- Move to stay alive (avoid enemy clusters)
- Keep moving to collect XP gems
- It is OK to move toward enemies if HP is high
- Vary direction to avoid getting cornered`;
}

function buildUpgradePrompt(state) {
  const options = (state.upgradeOptions ?? [])
    .map((o, i) => `  ${i}: ${o.name} - ${o.description}`)
    .join('\n');

  return `You are a QA agent testing a vampire survivors style game.

The upgrade selection screen is showing. Choose one upgrade.

Current upgrades: ${JSON.stringify(state.currentUpgrades ?? {})}
Current level: ${state.level}
Current HP: ${state.playerHP}/${state.maxHP}

Available upgrades:
${options}

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "selectUpgrade": <0|1|2>,
  "reasoning": "<brief explanation of why this upgrade is best>"
}`;
}

async function askClaude(page, state, screenshotBuffer) {
  const isUpgrade = state?.isUpgradeScreen === true;
  const prompt = isUpgrade ? buildUpgradePrompt(state) : buildMovementPrompt(state);

  const messageParams = {
    model: CLAUDE_MODEL,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshotBuffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  };

  const response = await anthropic.messages.create(messageParams);
  const raw = response.content[0]?.text ?? '{}';

  // Strip markdown code fences if present
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  try {
    return JSON.parse(jsonText);
  } catch {
    console.warn('Claude returned non-JSON response:', raw);
    // Default safe action
    return isUpgrade
      ? { selectUpgrade: 0, reasoning: 'parse error fallback' }
      : { keys: ['d'], duration: 300, reasoning: 'parse error fallback' };
  }
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
  const clicked = await page.evaluate((idx) => {
    const selectors = [
      `[data-upgrade-index="${idx}"]`,
      `.upgrade-option:nth-child(${idx + 1})`,
      `.upgrade-button:nth-child(${idx + 1})`,
      `button:nth-of-type(${idx + 1})`,
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { el.click(); return sel; }
    }
    const buttons = [...document.querySelectorAll('button')].filter(
      (b) => b.offsetParent !== null
    );
    if (buttons[idx]) { buttons[idx].click(); return `button[${idx}]`; }
    return null;
  }, index);

  if (!clicked) {
    await page.keyboard.press(String(index + 1));
  }
  return clicked;
}

function generateReport(log, startTime, finalState, upgradesChosen) {
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const reportPath = path.join(__dirname, `qa_report_${Date.now()}.json`);

  const report = {
    generatedAt: new Date().toISOString(),
    duration: `${totalTime}s`,
    finalState: finalState ?? {},
    upgradesChosen,
    decisionCount: log.length,
    decisions: log,
    summary: {
      totalKills: finalState?.killCount ?? 0,
      finalLevel: finalState?.level ?? 0,
      finalScore: finalState?.score ?? 0,
      timeSurvived: finalState?.elapsedTime?.toFixed(1) ?? 0,
      upgradeCount: upgradesChosen.length,
    },
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

async function main() {
  console.log('Starting Claude AI QA agent');
  console.log(`  Model:    ${CLAUDE_MODEL}`);
  console.log(`  Duration: ${DURATION_MS / 1000}s`);
  console.log(`  Headed:   ${HEADED}`);
  console.log(`  URL:      ${BASE_URL}`);
  console.log('');

  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-web-security', '--allow-running-insecure-content'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  await page.goto(BASE_URL);
  console.log('Navigated to game. Waiting for Godot to initialize...');

  await page.waitForSelector('canvas', { timeout: 20000 });
  await page.waitForFunction(
    () => typeof window.gameState !== 'undefined' && window.gameState !== null,
    { timeout: 30000 }
  );
  console.log('Game ready. Starting Claude-guided play loop.\n');

  await page.click('canvas');

  const startTime = Date.now();
  let upgradesChosen = [];
  let restartCount = 0;
  let lastDecisionTime = 0;

  while (Date.now() - startTime < DURATION_MS) {
    const now = Date.now();
    const timeSinceDecision = now - lastDecisionTime;

    // Throttle Claude API calls to every DECISION_INTERVAL_MS
    if (timeSinceDecision < DECISION_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, DECISION_INTERVAL_MS - timeSinceDecision));
    }

    const state = await getGameState(page);
    if (!state) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    // Game over handling
    if (state.isGameOver) {
      console.log('\n=== GAME OVER ===');
      console.log(`  Kills: ${state.killCount} | Level: ${state.level} | Score: ${state.score}`);

      restartCount++;
      upgradesChosen = [];

      const restarted = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')].filter(
          (b) => b.offsetParent !== null
        );
        const btn = buttons.find((b) => /restart|play again|retry|new game/i.test(b.textContent ?? ''));
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (!restarted) {
        await page.keyboard.press('Enter');
        await new Promise((r) => setTimeout(r, 200));
        await page.keyboard.press('Space');
      }

      await new Promise((r) => setTimeout(r, 1000));
      lastDecisionTime = Date.now();
      continue;
    }

    // Take screenshot for Claude
    const screenshot = await page.screenshot({ type: 'png' });
    lastDecisionTime = Date.now();

    let decision;
    try {
      decision = await askClaude(page, state, screenshot);
    } catch (err) {
      console.warn('Claude API error:', err.message);
      // Fallback to simple movement
      decision = { keys: ['d'], duration: 300, reasoning: 'API error fallback' };
    }

    // Log the decision
    const logEntry = {
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startTime,
      state: {
        hp: state.playerHP,
        maxHp: state.maxHP,
        level: state.level,
        kills: state.killCount,
        enemies: state.enemyCount,
        isUpgradeScreen: state.isUpgradeScreen,
      },
      decision,
    };
    decisionLog.push(logEntry);

    // Execute decision
    if (state.isUpgradeScreen && decision.selectUpgrade !== undefined) {
      const idx = Number(decision.selectUpgrade);
      const chosen = state.upgradeOptions?.[idx];
      console.log(
        `[UPGRADE] ${chosen?.name ?? `option_${idx}`} | Reason: ${decision.reasoning}`
      );
      await new Promise((r) => setTimeout(r, 300));
      await selectUpgrade(page, idx);
      upgradesChosen.push(chosen?.name ?? `option_${idx}`);
      await new Promise((r) => setTimeout(r, 500));
    } else if (decision.keys && Array.isArray(decision.keys)) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[${elapsed}s] Move: ${decision.keys.join('+')} ${decision.duration}ms | ${decision.reasoning}`
      );
      for (const key of decision.keys) {
        await holdKey(page, key, decision.duration ?? 300);
      }
    }
  }

  // Final state and report
  const finalState = await getGameState(page);
  const reportPath = generateReport(decisionLog, startTime, finalState, upgradesChosen);
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n========== CLAUDE AI QA SUMMARY ==========');
  console.log(`  Total wall time:   ${totalElapsed}s`);
  console.log(`  Claude decisions:  ${decisionLog.length}`);
  console.log(`  Restarts:          ${restartCount}`);

  if (finalState) {
    console.log(`  Final kills:       ${finalState.killCount}`);
    console.log(`  Final level:       ${finalState.level}`);
    console.log(`  Final score:       ${finalState.score}`);
    console.log(`  Time survived:     ${finalState.elapsedTime?.toFixed(1)}s`);
  }

  console.log(`  Upgrades chosen:   ${upgradesChosen.join(', ') || 'none'}`);
  console.log(`  QA Report saved:   ${reportPath}`);
  console.log('==========================================\n');

  await browser.close();
}

main().catch((err) => {
  console.error('Claude AI QA agent error:', err);
  process.exit(1);
});
