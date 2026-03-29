/**
 * multi_agent_qa.js - Multi-Agent QA Orchestrator
 *
 * Launches N parallel AI agents (heuristic + Claude Vision mix) to play
 * the Godot vampire survivors game simultaneously, each with a different strategy.
 * Collects objective data and generates an HTML report with Chart.js charts.
 *
 * Usage:
 *   node multi_agent_qa.js [--agents=5] [--headed] [--timeout=120] [--url=http://localhost:8080] [--output=qa_multi_report.html] [--format=html|json|both] [--output-dir=results/]
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CLI Argument Parsing ---
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

if (args.help) {
  console.log(`
Multi-Agent QA Orchestrator

Usage: node multi_agent_qa.js [options]

Options:
  --agents=N        Number of parallel agents (default: 5, max: 8)
  --headed          Show browser windows
  --timeout=S       Per-agent timeout in seconds (default: 120)
  --url=URL         Game server URL (default: http://localhost:8080)
  --output=FILE     Report output filename (default: qa_multi_report.html)
  --format=FMT      Output format: html, json, or both (default: both)
  --output-dir=DIR  Directory for JSON output (default: current dir)
  --help            Show this help
`);
  process.exit(0);
}

const NUM_AGENTS = Math.min(parseInt(args.agents ?? '5', 10), 8);
const HEADED = args.headed === true || args.headed === 'true';
const TIMEOUT_S = parseInt(args.timeout ?? '120', 10);
const BASE_URL = args.url ?? 'http://localhost:8080';
const OUTPUT_FILE = args.output ?? 'qa_multi_report.html';
const OUTPUT_FORMAT = args.format ?? 'both'; // html, json, both
const OUTPUT_DIR = args['output-dir'] ?? __dirname;

// --- Constants ---
const SWIFTSHADER_ARGS = [
  '--disable-web-security',
  '--allow-running-insecure-content',
  '--enable-webgl',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];

const STAGGER_DELAY_MS = 2500; // Delay between launching each browser

// --- Conditional Claude import ---
let Anthropic = null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (ANTHROPIC_API_KEY) {
  try {
    const mod = await import('@anthropic-ai/sdk');
    Anthropic = mod.default;
  } catch {
    console.warn('Warning: @anthropic-ai/sdk not available. Claude Vision agent disabled.');
  }
}

// --- Strategy Definitions ---
const STRATEGIES = [
  {
    name: 'aggressive',
    type: 'heuristic',
    color: '#e74c3c',
    description: 'Rushes toward enemies, prioritizes damage output',
    upgradePriority: ['damage', 'fire_rate', 'extra_projectile', 'speed', 'hp_regen', 'magnet'],
    movementBehavior: 'rush',
  },
  {
    name: 'defensive',
    type: 'heuristic',
    color: '#3498db',
    description: 'Avoids enemies, prioritizes survival and regen',
    upgradePriority: ['hp_regen', 'speed', 'magnet', 'damage', 'fire_rate', 'extra_projectile'],
    movementBehavior: 'evade',
  },
  {
    name: 'balanced',
    type: 'heuristic',
    color: '#2ecc71',
    description: 'Standard 8-direction cycle, balanced upgrades',
    upgradePriority: ['damage', 'fire_rate', 'extra_projectile', 'speed', 'hp_regen', 'magnet'],
    movementBehavior: 'balanced',
  },
  {
    name: 'explorer',
    type: 'heuristic',
    color: '#f39c12',
    description: 'Covers the map widely, prioritizes speed and magnet',
    upgradePriority: ['speed', 'magnet', 'hp_regen', 'damage', 'fire_rate', 'extra_projectile'],
    movementBehavior: 'explore',
  },
  {
    name: 'claude_vision',
    type: 'claude_vision',
    color: '#9b59b6',
    description: 'Claude API analyzes screenshots to decide actions',
    upgradePriority: ['damage', 'fire_rate', 'extra_projectile', 'speed', 'hp_regen', 'magnet'],
    movementBehavior: 'claude',
  },
];

// --- Shared State for Terminal Monitor ---
const agentStatuses = new Map();
const activeBrowsers = [];
let serverProcess = null;
let monitorInterval = null;

// --- SIGINT Handler (Architect consensus note) ---
async function cleanup() {
  if (monitorInterval) clearInterval(monitorInterval);
  console.log('\n\nShutting down...');
  for (const browser of activeBrowsers) {
    try { await browser.close(); } catch {}
  }
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// --- Helper Functions (copied from ai_qa.js) ---
async function holdKey(page, key, ms) {
  await page.keyboard.down(key);
  await new Promise((r) => setTimeout(r, ms));
  await page.keyboard.up(key);
}

async function getGameState(page) {
  return page.evaluate(() => window.gameState ?? null);
}

async function selectUpgrade(page, index) {
  const buttonY = [260, 348, 435];
  const y = buttonY[index] ?? buttonY[0];
  const canvas = page.locator('canvas');
  await canvas.click({ position: { x: 640, y } });
  await page.waitForTimeout(200);
}

// --- Claude Vision Functions (copied from ai_qa_claude.js) ---
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

async function askClaude(anthropicClient, state, screenshotBuffer) {
  const isUpgrade = state?.isUpgradeScreen === true;
  const prompt = isUpgrade ? buildUpgradePrompt(state) : buildMovementPrompt(state);

  const response = await anthropicClient.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: screenshotBuffer.toString('base64') },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const raw = response.content[0]?.text ?? '{}';
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  try {
    return JSON.parse(jsonText);
  } catch {
    return isUpgrade
      ? { selectUpgrade: 0, reasoning: 'parse error fallback' }
      : { keys: ['d'], duration: 300, reasoning: 'parse error fallback' };
  }
}

// --- Movement Logic ---
function decideMovement(state, tick, strategy) {
  switch (strategy.movementBehavior) {
    case 'rush': {
      // Move toward center where enemies cluster
      const dirs = [];
      if (state.playerX > 700) dirs.push('a');
      else if (state.playerX < 580) dirs.push('d');
      if (state.playerY > 400) dirs.push('w');
      else if (state.playerY < 320) dirs.push('s');
      if (dirs.length > 0) return dirs[tick % dirs.length];
      return ['w', 'd', 's', 'a'][tick % 4];
    }
    case 'evade': {
      // Move away from center, stay at edges
      const dirs = [];
      if (state.playerX > 400 && state.playerX < 880) {
        dirs.push(state.playerX > 640 ? 'd' : 'a');
      }
      if (state.playerY > 200 && state.playerY < 520) {
        dirs.push(state.playerY > 360 ? 's' : 'w');
      }
      if (dirs.length > 0) return dirs[tick % dirs.length];
      return ['a', 'w', 'd', 's'][tick % 4];
    }
    case 'balanced': {
      // 8-direction cycle (from ai_qa.js)
      const pattern = ['w', 'd', 's', 'a', 'w', 'a', 's', 'd'];
      return pattern[tick % pattern.length];
    }
    case 'explore': {
      // Large sweeping pattern - hold each direction longer
      const phase = Math.floor(tick / 4) % 4;
      return ['d', 's', 'a', 'w'][phase];
    }
    default:
      return ['w', 'a', 's', 'd'][tick % 4];
  }
}

// --- Upgrade Logic ---
function pickBestUpgrade(upgradeOptions, strategy) {
  if (!upgradeOptions || upgradeOptions.length === 0) return 0;

  let bestIndex = 0;
  let bestScore = Infinity;

  for (let i = 0; i < upgradeOptions.length; i++) {
    const name = (upgradeOptions[i].name ?? '').toLowerCase();
    const priorityScore = strategy.upgradePriority.findIndex((p) => name.includes(p));
    const score = priorityScore === -1 ? strategy.upgradePriority.length : priorityScore;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// --- Single Agent Game Loop ---
async function runAgent(config) {
  const { id, strategy, headed, url, timeout } = config;
  const agentName = `Agent ${id + 1}`;
  const label = `[${agentName}|${strategy.name}]`;

  // Initialize status
  agentStatuses.set(id, {
    name: agentName,
    strategy: strategy.name,
    hp: 0, maxHp: 100, level: 1, kills: 0, time: 0,
    status: 'LOADING', score: 0,
  });

  const result = {
    agentId: id,
    agentName,
    strategy: strategy.name,
    strategyDescription: strategy.description,
    color: strategy.color,
    kills: 0, level: 1, score: 0, survivalTime: 0,
    upgradesChosen: [],
    timeline: [],
    finalState: null,
    error: null,
  };

  let browser;
  try {
    browser = await chromium.launch({
      headless: !headed,
      args: SWIFTSHADER_ARGS,
    });
    activeBrowsers.push(browser);

    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    await page.goto(url);
    await page.waitForSelector('canvas', { timeout: 20000 });
    await page.waitForFunction(
      () => typeof window.gameState !== 'undefined' && window.gameState !== null,
      { timeout: 30000 }
    );
    await page.click('canvas');

    agentStatuses.set(id, { ...agentStatuses.get(id), status: 'PLAYING' });

    // Claude client (only for claude_vision strategy)
    let anthropicClient = null;
    if (strategy.type === 'claude_vision' && Anthropic && ANTHROPIC_API_KEY) {
      anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    }

    const startTime = Date.now();
    const timeoutMs = timeout * 1000;
    let tick = 0;
    let lastClaudeCall = 0;
    let lastTimelineSample = 0;
    let firstLevelUpTime = null;
    const CLAUDE_INTERVAL_MS = 2000;
    const TIMELINE_INTERVAL_MS = 2000;
    const MOVE_DURATION_MS = 350;

    // --- Game loop ---
    while (Date.now() - startTime < timeoutMs) {
      const state = await getGameState(page);
      if (!state) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      // Update shared status for monitor
      agentStatuses.set(id, {
        name: agentName,
        strategy: strategy.name,
        hp: Math.round(state.playerHP ?? 0),
        maxHp: Math.round(state.maxHP ?? 100),
        level: state.level ?? 1,
        kills: state.killCount ?? 0,
        time: (state.elapsedTime ?? 0).toFixed(1),
        score: state.score ?? 0,
        status: state.isGameOver ? 'GAME OVER' : state.isUpgradeScreen ? 'UPGRADE' : 'PLAYING',
      });

      // Timeline sampling (every 2 seconds)
      const elapsed = state.elapsedTime ?? 0;
      if (Date.now() - lastTimelineSample >= TIMELINE_INTERVAL_MS) {
        lastTimelineSample = Date.now();
        result.timeline.push({
          t: parseFloat(elapsed.toFixed(1)),
          hp: Math.round(state.playerHP ?? 0),
          kills: state.killCount ?? 0,
          enemies: state.enemyCount ?? 0,
          level: state.level ?? 1,
        });
      }

      // Track first level-up time
      if (firstLevelUpTime === null && (state.level ?? 1) >= 2) {
        firstLevelUpTime = parseFloat(elapsed.toFixed(1));
      }

      // Game over -> done
      if (state.isGameOver) {
        result.kills = state.killCount ?? 0;
        result.level = state.level ?? 1;
        result.score = state.score ?? 0;
        result.survivalTime = parseFloat((state.elapsedTime ?? 0).toFixed(1));
        result.firstLevelUpTime = firstLevelUpTime;
        result.finalState = state;
        break;
      }

      // Upgrade screen
      if (state.isUpgradeScreen) {
        let upgradeIndex = 0;
        if (anthropicClient && strategy.type === 'claude_vision') {
          try {
            const screenshot = await page.screenshot({ type: 'png' });
            const decision = await askClaude(anthropicClient, state, screenshot);
            upgradeIndex = Number(decision.selectUpgrade ?? 0);
          } catch {
            upgradeIndex = pickBestUpgrade(state.upgradeOptions, strategy);
          }
        } else {
          upgradeIndex = pickBestUpgrade(state.upgradeOptions, strategy);
        }

        const chosen = state.upgradeOptions?.[upgradeIndex];
        result.upgradesChosen.push({
          time: parseFloat((state.elapsedTime ?? 0).toFixed(1)),
          name: chosen?.name ?? `option_${upgradeIndex}`,
        });

        await new Promise((r) => setTimeout(r, 300));
        await selectUpgrade(page, upgradeIndex);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      // Movement
      if (anthropicClient && strategy.type === 'claude_vision') {
        const now = Date.now();
        if (now - lastClaudeCall >= CLAUDE_INTERVAL_MS) {
          lastClaudeCall = now;
          try {
            const screenshot = await page.screenshot({ type: 'png' });
            const decision = await askClaude(anthropicClient, state, screenshot);
            if (decision.keys && Array.isArray(decision.keys)) {
              for (const key of decision.keys) {
                await holdKey(page, key, decision.duration ?? 300);
              }
            }
          } catch {
            // Fallback to balanced movement on Claude error
            const key = decideMovement(state, tick, { movementBehavior: 'balanced' });
            await holdKey(page, key, MOVE_DURATION_MS);
          }
        } else {
          await new Promise((r) => setTimeout(r, 100));
        }
      } else {
        const key = decideMovement(state, tick, strategy);
        await holdKey(page, key, MOVE_DURATION_MS);
      }

      tick++;
    }

    // If loop ended by timeout (not game over), capture final state
    if (!result.finalState) {
      const finalState = await getGameState(page);
      if (finalState) {
        result.kills = finalState.killCount ?? 0;
        result.level = finalState.level ?? 1;
        result.score = finalState.score ?? 0;
        result.survivalTime = parseFloat((finalState.elapsedTime ?? 0).toFixed(1));
        result.firstLevelUpTime = firstLevelUpTime;
        result.finalState = finalState;
      }
      agentStatuses.set(id, { ...agentStatuses.get(id), status: 'TIMEOUT' });
    }
  } catch (err) {
    result.error = err.message;
    agentStatuses.set(id, { ...agentStatuses.get(id), status: 'ERROR' });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
      const idx = activeBrowsers.indexOf(browser);
      if (idx !== -1) activeBrowsers.splice(idx, 1);
    }
  }

  return result;
}

// --- Terminal Monitor (TTY guard per Architect consensus) ---
function startMonitor(totalAgents) {
  const isTTY = process.stdout.isTTY;
  let firstPrint = true;

  monitorInterval = setInterval(() => {
    const lines = [];
    let activeCount = 0;

    for (let i = 0; i < totalAgents; i++) {
      const s = agentStatuses.get(i);
      if (!s) continue;
      if (s.status === 'PLAYING' || s.status === 'LOADING' || s.status === 'UPGRADE') activeCount++;

      const strat = s.strategy.padEnd(14);
      const hp = `${String(s.hp).padStart(3)}/${s.maxHp}`;
      const lv = String(s.level).padStart(2);
      const kills = String(s.kills).padStart(4);
      const time = String(s.time).padStart(6);
      const score = String(s.score).padStart(6);
      const status = s.status.padEnd(9);
      lines.push(`  ${s.name.padEnd(9)} [${strat}] HP:${hp} | Lv:${lv} | Kills:${kills} | Time:${time}s | Score:${score} | ${status}`);
    }

    const header = `=== Multi-Agent QA Monitor (${activeCount}/${totalAgents} active) ===`;

    if (isTTY) {
      if (!firstPrint) {
        process.stdout.write(`\x1B[${lines.length + 2}A`);
      }
      firstPrint = false;
      process.stdout.write(`\x1B[2K${header}\n`);
      for (const line of lines) {
        process.stdout.write(`\x1B[2K${line}\n`);
      }
      process.stdout.write(`\x1B[2K${'='.repeat(header.length)}\n`);
    } else {
      // Non-TTY fallback: periodic log
      console.log(`\n${header}`);
      lines.forEach((l) => console.log(l));
    }

    // Stop monitor when all agents are done
    if (activeCount === 0 && agentStatuses.size === totalAgents) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
  }, 1000);
}

// --- Server Management ---
async function ensureServer(url) {
  // Check if already running
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log('Game server already running.');
      return null;
    }
  } catch {}

  // Start server
  console.log('Starting game server...');
  const child = spawn('node', ['server.js'], {
    cwd: __dirname,
    stdio: 'pipe',
  });

  serverProcess = child;

  // Wait for server to be ready (max 10s)
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        console.log('Game server started.');
        return child;
      }
    } catch {}
  }

  throw new Error('Failed to start game server within 10 seconds');
}

// --- HTML Report Generation ---
function generateHTMLReport(results, outputPath, totalDuration) {
  const timestamp = new Date().toISOString();
  const agentLabels = results.map((r) => `${r.agentName} (${r.strategy})`);
  const colors = results.map((r) => r.color);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Multi-Agent QA Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f1a; color: #e0e0e0; padding: 24px; }
  h1 { color: #fff; margin-bottom: 8px; font-size: 28px; }
  h2 { color: #a0a0ff; margin: 32px 0 16px; font-size: 20px; border-bottom: 1px solid #333; padding-bottom: 8px; }
  h3 { color: #80c0ff; margin: 16px 0 8px; font-size: 16px; }
  .meta { color: #888; margin-bottom: 24px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th { background: #1a1a2e; color: #a0a0ff; padding: 12px 16px; text-align: left; font-weight: 600; }
  td { padding: 10px 16px; border-bottom: 1px solid #222; }
  tr:hover td { background: #1a1a2e; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 24px 0; }
  .chart-box { background: #1a1a2e; border-radius: 12px; padding: 20px; }
  .chart-box.full { grid-column: 1 / -1; }
  canvas { max-height: 300px; }
  .agent-detail { background: #1a1a2e; border-radius: 12px; padding: 20px; margin: 16px 0; }
  .agent-detail .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; color: #fff; font-size: 12px; font-weight: 600; }
  .upgrade-timeline { list-style: none; padding: 0; }
  .upgrade-timeline li { padding: 6px 0; border-left: 2px solid #444; padding-left: 16px; margin-left: 8px; font-size: 14px; }
  .upgrade-timeline li::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #a0a0ff; margin-left: -20px; margin-right: 8px; }
  .winner { background: linear-gradient(135deg, #1a2a1a, #1a1a2e); border: 1px solid #2ecc71; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 16px 0; }
  .stat-card { background: #12121f; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-card .value { font-size: 32px; font-weight: 700; color: #fff; }
  .stat-card .label { font-size: 12px; color: #888; margin-top: 4px; }
</style>
</head>
<body>

<h1>Multi-Agent QA Report</h1>
<p class="meta">Generated: ${timestamp} | Agents: ${results.length} | Total Duration: ${totalDuration}s</p>

<div class="stat-grid">
  <div class="stat-card">
    <div class="value">${results.length}</div>
    <div class="label">Agents</div>
  </div>
  <div class="stat-card">
    <div class="value">${results.reduce((a, r) => a + r.kills, 0)}</div>
    <div class="label">Total Kills</div>
  </div>
  <div class="stat-card">
    <div class="value">${Math.max(...results.map((r) => r.level))}</div>
    <div class="label">Highest Level</div>
  </div>
  <div class="stat-card">
    <div class="value">${Math.max(...results.map((r) => r.survivalTime)).toFixed(1)}s</div>
    <div class="label">Longest Survival</div>
  </div>
</div>

<h2>Agent Comparison</h2>
<table>
  <thead>
    <tr><th>Agent</th><th>Strategy</th><th>Kills</th><th>Level</th><th>Score</th><th>Survival Time</th><th>Upgrades</th><th>Status</th></tr>
  </thead>
  <tbody>
    ${results.map((r) => `<tr>
      <td>${r.agentName}</td>
      <td><span style="color:${r.color};font-weight:600">${r.strategy}</span></td>
      <td>${r.kills}</td>
      <td>${r.level}</td>
      <td>${r.score}</td>
      <td>${r.survivalTime}s</td>
      <td>${r.upgradesChosen.length}</td>
      <td>${r.error ? 'ERROR' : 'OK'}</td>
    </tr>`).join('\n    ')}
  </tbody>
</table>

<div class="charts">
  <div class="chart-box">
    <canvas id="killsChart"></canvas>
  </div>
  <div class="chart-box">
    <canvas id="survivalChart"></canvas>
  </div>
  <div class="chart-box">
    <canvas id="levelChart"></canvas>
  </div>
  <div class="chart-box">
    <canvas id="scoreChart"></canvas>
  </div>
</div>

<h2>Agent Details</h2>
${results.map((r) => {
    const bestKills = Math.max(...results.map((x) => x.kills));
    const isWinner = r.kills === bestKills && results.length > 1;
    return `<div class="agent-detail ${isWinner ? 'winner' : ''}">
  <h3>${r.agentName} <span class="badge" style="background:${r.color}">${r.strategy}</span> ${isWinner ? '<span class="badge" style="background:#2ecc71">BEST KILLS</span>' : ''}</h3>
  <p style="color:#888;margin:8px 0">${r.strategyDescription}</p>
  <p>Kills: <strong>${r.kills}</strong> | Level: <strong>${r.level}</strong> | Score: <strong>${r.score}</strong> | Survival: <strong>${r.survivalTime}s</strong></p>
  ${r.upgradesChosen.length > 0 ? `<h3 style="margin-top:12px">Upgrade Timeline</h3>
  <ul class="upgrade-timeline">
    ${r.upgradesChosen.map((u) => `<li><strong>${u.time}s</strong> - ${u.name}</li>`).join('\n    ')}
  </ul>` : '<p style="color:#666;margin-top:8px">No upgrades selected</p>'}
  ${r.error ? `<p style="color:#e74c3c;margin-top:8px">Error: ${r.error}</p>` : ''}
</div>`;
  }).join('\n')}

<script>
const data = ${JSON.stringify(results)};
const labels = ${JSON.stringify(agentLabels)};
const colors = ${JSON.stringify(colors)};

const chartDefaults = {
  indexAxis: 'y',
  responsive: true,
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { color: '#222' }, ticks: { color: '#888' } },
    y: { grid: { display: false }, ticks: { color: '#ccc', font: { size: 13 } } },
  },
};

new Chart(document.getElementById('killsChart'), {
  type: 'bar',
  data: { labels, datasets: [{ label: 'Kills', data: data.map(d => d.kills), backgroundColor: colors }] },
  options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, title: { display: true, text: 'Kills Comparison', color: '#fff' } } }
});

new Chart(document.getElementById('survivalChart'), {
  type: 'bar',
  data: { labels, datasets: [{ label: 'Survival (s)', data: data.map(d => d.survivalTime), backgroundColor: colors }] },
  options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, title: { display: true, text: 'Survival Time (seconds)', color: '#fff' } } }
});

new Chart(document.getElementById('levelChart'), {
  type: 'bar',
  data: { labels, datasets: [{ label: 'Level', data: data.map(d => d.level), backgroundColor: colors }] },
  options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, title: { display: true, text: 'Level Reached', color: '#fff' } } }
});

new Chart(document.getElementById('scoreChart'), {
  type: 'bar',
  data: { labels, datasets: [{ label: 'Score', data: data.map(d => d.score), backgroundColor: colors }] },
  options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, title: { display: true, text: 'Score Comparison', color: '#fff' } } }
});
</script>

</body>
</html>`;

  fs.writeFileSync(outputPath, html);
  return outputPath;
}

// --- Aggregate Metrics Computation ---
function computeAggregates(results) {
  const valid = results.filter((r) => !r.error);
  if (valid.length === 0) return {};

  const survivals = valid.map((r) => r.survivalTime);
  const kills = valid.map((r) => r.kills);
  const levels = valid.map((r) => r.level);
  const scores = valid.map((r) => r.score);
  const levelUpTimes = valid.map((r) => r.firstLevelUpTime).filter((t) => t !== null && t !== undefined);

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const median = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const stddev = (arr) => {
    const m = avg(arr);
    return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length);
  };

  // Upgrade distribution
  const upgradeCounts = {};
  for (const r of valid) {
    for (const u of r.upgradesChosen ?? []) {
      const name = u.name ?? 'unknown';
      upgradeCounts[name] = (upgradeCounts[name] ?? 0) + 1;
    }
  }

  // Strategy ranking by avg survival
  const strategyGroups = {};
  for (const r of valid) {
    if (!strategyGroups[r.strategy]) strategyGroups[r.strategy] = [];
    strategyGroups[r.strategy].push(r);
  }
  const strategyRanking = Object.entries(strategyGroups)
    .map(([strategy, agents]) => ({
      strategy,
      avgSurvival: avg(agents.map((a) => a.survivalTime)),
      avgKills: avg(agents.map((a) => a.kills)),
      avgLevel: avg(agents.map((a) => a.level)),
      count: agents.length,
    }))
    .sort((a, b) => b.avgSurvival - a.avgSurvival);

  return {
    totalAgents: results.length,
    validAgents: valid.length,
    errorAgents: results.length - valid.length,
    avgSurvivalTime: avg(survivals),
    medianSurvivalTime: median(survivals),
    stddevSurvivalTime: stddev(survivals),
    avgKills: avg(kills),
    avgLevel: avg(levels),
    avgScore: avg(scores),
    avgTimeToFirstLevelUp: levelUpTimes.length > 0 ? avg(levelUpTimes) : null,
    agentsReachingLevel2: valid.filter((r) => r.level >= 2).length,
    agentsReachingLevel3: valid.filter((r) => r.level >= 3).length,
    agentsSurviving60s: valid.filter((r) => r.survivalTime >= 60).length,
    agentsSurviving90s: valid.filter((r) => r.survivalTime >= 90).length,
    upgradeDistribution: upgradeCounts,
    strategyRanking,
  };
}

// --- JSON Report Generation ---
function generateJSONReport(results, aggregate, outputDir, totalDuration) {
  // Read balance snapshot if available
  let balanceSnapshot = null;
  try {
    const configPath = path.join(__dirname, 'balance_config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      balanceSnapshot = {};
      for (const [key, param] of Object.entries(config.parameters)) {
        balanceSnapshot[key] = { value: param.value, category: param.category };
      }
    }
  } catch {}

  const report = {
    meta: {
      timestamp: new Date().toISOString(),
      totalAgents: results.length,
      totalDuration: parseFloat(totalDuration),
      timeoutPerAgent: TIMEOUT_S,
      gameUrl: BASE_URL,
    },
    agents: results.map((r) => ({
      agentId: r.agentId,
      agentName: r.agentName,
      strategy: r.strategy,
      strategyDescription: r.strategyDescription,
      kills: r.kills,
      level: r.level,
      score: r.score,
      survivalTime: r.survivalTime,
      firstLevelUpTime: r.firstLevelUpTime ?? null,
      upgradesChosen: r.upgradesChosen,
      timeline: r.timeline ?? [],
      error: r.error,
    })),
    aggregate,
    balanceSnapshot,
  };

  const dir = outputDir ?? __dirname;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, 'qa_results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return jsonPath;
}

// --- Main Orchestrator ---
async function main() {
  console.log('');
  console.log('========================================');
  console.log('  Multi-Agent QA Orchestrator');
  console.log('========================================');
  console.log(`  Agents:   ${NUM_AGENTS}`);
  console.log(`  Headed:   ${HEADED}`);
  console.log(`  Timeout:  ${TIMEOUT_S}s per agent`);
  console.log(`  URL:      ${BASE_URL}`);
  console.log(`  Output:   ${OUTPUT_FILE}`);
  console.log(`  Claude:   ${ANTHROPIC_API_KEY ? 'enabled' : 'disabled (no API key)'}`);
  console.log('========================================\n');

  // Ensure server is running
  await ensureServer(BASE_URL);

  // Assign strategies to agents
  const agentConfigs = [];
  for (let i = 0; i < NUM_AGENTS; i++) {
    let strategy = STRATEGIES[i % STRATEGIES.length];

    // If no Claude API key, replace claude_vision with a balanced variant
    if (strategy.type === 'claude_vision' && (!Anthropic || !ANTHROPIC_API_KEY)) {
      strategy = { ...STRATEGIES[2], name: 'balanced_alt', description: 'Balanced fallback (no Claude API key)' };
    }

    agentConfigs.push({
      id: i,
      strategy,
      headed: HEADED,
      url: BASE_URL,
      timeout: TIMEOUT_S,
    });

    console.log(`  Agent ${i + 1}: ${strategy.name} (${strategy.type})`);
  }
  console.log('');

  // Start terminal monitor
  startMonitor(NUM_AGENTS);

  // Launch agents with staggered start (Architect consensus note)
  const startTime = Date.now();
  const agentPromises = [];

  for (let i = 0; i < agentConfigs.length; i++) {
    agentPromises.push(runAgent(agentConfigs[i]));
    if (i < agentConfigs.length - 1) {
      await new Promise((r) => setTimeout(r, STAGGER_DELAY_MS));
    }
  }

  // Wait for all agents to complete
  const settled = await Promise.allSettled(agentPromises);
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Stop monitor
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }

  // Collect results
  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return {
      agentId: i,
      agentName: `Agent ${i + 1}`,
      strategy: agentConfigs[i].strategy.name,
      strategyDescription: agentConfigs[i].strategy.description,
      color: agentConfigs[i].strategy.color,
      kills: 0, level: 0, score: 0, survivalTime: 0,
      upgradesChosen: [], finalState: null,
      error: s.reason?.message ?? 'Unknown error',
    };
  });

  // Print final summary
  console.log('\n\n========================================');
  console.log('  FINAL RESULTS');
  console.log('========================================');
  for (const r of results) {
    const status = r.error ? `ERROR: ${r.error}` : 'OK';
    console.log(`  ${r.agentName} [${r.strategy.padEnd(14)}] Kills: ${String(r.kills).padStart(4)} | Lv: ${String(r.level).padStart(2)} | Score: ${String(r.score).padStart(6)} | Time: ${String(r.survivalTime).padStart(6)}s | ${status}`);
  }
  console.log('----------------------------------------');
  console.log(`  Total duration: ${totalDuration}s`);
  console.log(`  Total kills:    ${results.reduce((a, r) => a + r.kills, 0)}`);
  console.log(`  Best killer:    ${results.reduce((best, r) => r.kills > best.kills ? r : best, results[0]).agentName} (${results.reduce((best, r) => r.kills > best.kills ? r : best, results[0]).strategy})`);
  console.log(`  Longest alive:  ${results.reduce((best, r) => r.survivalTime > best.survivalTime ? r : best, results[0]).agentName} (${results.reduce((best, r) => r.survivalTime > best.survivalTime ? r : best, results[0]).survivalTime}s)`);

  // Compute aggregates
  const aggregate = computeAggregates(results);

  // Generate reports based on format
  if (OUTPUT_FORMAT === 'html' || OUTPUT_FORMAT === 'both') {
    const reportPath = path.join(__dirname, OUTPUT_FILE);
    generateHTMLReport(results, reportPath, totalDuration);
    console.log(`\n  HTML Report:    ${reportPath}`);
  }

  if (OUTPUT_FORMAT === 'json' || OUTPUT_FORMAT === 'both') {
    const jsonPath = generateJSONReport(results, aggregate, OUTPUT_DIR, totalDuration);
    console.log(`  JSON Report:    ${jsonPath}`);
  }

  // Print aggregate summary
  console.log('\n  Aggregate Metrics:');
  console.log(`    Avg Survival:  ${aggregate.avgSurvivalTime?.toFixed(1) ?? 'N/A'}s (stddev: ${aggregate.stddevSurvivalTime?.toFixed(1) ?? 'N/A'})`);
  console.log(`    Avg Kills:     ${aggregate.avgKills?.toFixed(1) ?? 'N/A'}`);
  console.log(`    Avg Level:     ${aggregate.avgLevel?.toFixed(1) ?? 'N/A'}`);
  console.log(`    First LvlUp:   ${aggregate.avgTimeToFirstLevelUp?.toFixed(1) ?? 'N/A'}s`);
  console.log(`    Survive 60s:   ${aggregate.agentsSurviving60s ?? 0}/${aggregate.validAgents ?? 0}`);
  console.log('========================================\n');

  // Cleanup server if we started it
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

main().catch((err) => {
  console.error('Multi-Agent QA error:', err);
  if (serverProcess) serverProcess.kill();
  process.exit(1);
});
