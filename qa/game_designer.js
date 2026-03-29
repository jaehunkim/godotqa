/**
 * game_designer.js - AI Game Designer Orchestrator
 *
 * Runs an iterative loop: QA play -> analyze results -> tune balance -> re-verify.
 * Uses Claude API as the Game Designer brain to propose parameter changes.
 *
 * Usage:
 *   node game_designer.js \
 *     --target-survival=60-90 \
 *     --target-first-levelup=15-20 \
 *     --target-kills=30-60 \
 *     --iterations=5 \
 *     --agents=5 \
 *     --timeout=120 \
 *     --skip-build \
 *     --headed
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

import { readAllParameters, applyChanges, restoreBackups } from './lib/gdscript_editor.js';
import { buildTargets, checkConvergence, formatConvergence } from './lib/balance_targets.js';
import { SYSTEM_PROMPT, buildMessages } from './lib/designer_prompt.js';

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
AI Game Designer - Balance Tuning Orchestrator

Usage: node game_designer.js [options]

Options:
  --iterations=N              Max tuning iterations (default: 5)
  --agents=N                  QA agents per iteration (default: 5)
  --timeout=S                 Per-agent timeout in seconds (default: 120)
  --target-survival=MIN-MAX   Target avg survival time in seconds (default: 60-90)
  --target-first-levelup=MIN-MAX  Target first level-up time (default: 15-20)
  --target-kills=MIN-MAX      Target avg kills (default: 30-60)
  --skip-build                Skip Godot web export rebuild
  --headed                    Show browser windows during QA
  --url=URL                   Game server URL (default: http://localhost:8080)
  --dry-run                   Run analysis but don't apply changes
  --help                      Show this help
`);
  process.exit(0);
}

const MAX_ITERATIONS = parseInt(args.iterations ?? '5', 10);
const NUM_AGENTS = parseInt(args.agents ?? '5', 10);
const TIMEOUT_S = parseInt(args.timeout ?? '120', 10);
const SKIP_BUILD = args['skip-build'] === true || args['skip-build'] === 'true';
const HEADED = args.headed === true || args.headed === 'true';
const DRY_RUN = args['dry-run'] === true || args['dry-run'] === 'true';
const BASE_URL = args.url ?? 'http://localhost:8080';
const RESULTS_DIR = path.join(__dirname, 'results');
const CONFIG_PATH = path.join(__dirname, 'balance_config.json');

// --- Validation ---
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is required.');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... node game_designer.js');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// --- Helper Functions ---

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Run multi_agent_qa.js and return parsed results
 */
async function runQA(iterationDir) {
  const outputDir = iterationDir;
  ensureDir(outputDir);

  const qaArgs = [
    path.join(__dirname, 'multi_agent_qa.js'),
    `--agents=${NUM_AGENTS}`,
    `--timeout=${TIMEOUT_S}`,
    `--url=${BASE_URL}`,
    `--format=both`,
    `--output-dir=${outputDir}`,
    `--output=${path.join(outputDir, 'qa_report.html')}`,
  ];

  if (HEADED) qaArgs.push('--headed');

  console.log(`  Running QA with ${NUM_AGENTS} agents (timeout: ${TIMEOUT_S}s)...`);

  return new Promise((resolve, reject) => {
    const proc = spawn('node', qaArgs, {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      // Forward key lines to console
      const lines = d.toString().split('\n');
      for (const line of lines) {
        if (line.includes('FINAL RESULTS') || line.includes('Agent ') || line.includes('Total duration')) {
          console.log(`    ${line.trim()}`);
        }
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`  QA process stderr:\n${stderr}`);
        reject(new Error(`QA process exited with code ${code}`));
        return;
      }

      // Read the JSON results
      const jsonPath = path.join(outputDir, 'qa_results.json');
      if (!fs.existsSync(jsonPath)) {
        reject(new Error(`QA results not found at ${jsonPath}`));
        return;
      }

      try {
        const results = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        resolve(results);
      } catch (err) {
        reject(new Error(`Failed to parse QA results: ${err.message}`));
      }
    });
  });
}

/**
 * Call Claude API for game design analysis
 */
async function askDesigner({ qaResults, convergence, balanceSnapshot, targets, history }) {
  const messages = buildMessages({ qaResults, convergence, balanceSnapshot, targets, history });

  console.log('  Calling Claude Game Designer for analysis...');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages,
  });

  const raw = response.content[0]?.text ?? '{}';
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  try {
    return JSON.parse(jsonText);
  } catch {
    console.warn('  Warning: Claude returned non-JSON. Attempting extraction...');
    // Try to find JSON in the response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('Failed to parse Claude designer response as JSON');
  }
}

/**
 * Rebuild Godot web export
 */
function rebuildGame() {
  if (SKIP_BUILD) {
    console.log('  Skipping Godot rebuild (--skip-build)');
    return;
  }

  console.log('  Rebuilding Godot web export...');
  try {
    execSync('godot --headless --export-release "Web" web_build/index.html', {
      cwd: path.join(__dirname, '..', 'game'),
      timeout: 120000,
      stdio: 'pipe',
    });
    console.log('  Build complete.');
  } catch (err) {
    console.warn(`  Warning: Godot rebuild failed: ${err.message}`);
    console.warn('  Continuing with existing build (GDScript changes may not take effect).');
  }
}

/**
 * Check if metrics are worse than previous iteration (for rollback)
 */
function isRegression(currentMetrics, previousMetrics) {
  if (!previousMetrics) return false;

  const checks = [
    { key: 'avgSurvivalTime', worse: (c, p) => c < p * 0.8 },
    { key: 'avgKills', worse: (c, p) => c < p * 0.8 },
    { key: 'avgLevel', worse: (c, p) => c < p * 0.8 },
  ];

  let worseCount = 0;
  for (const check of checks) {
    const curr = currentMetrics[check.key] ?? 0;
    const prev = previousMetrics[check.key] ?? 0;
    if (prev > 0 && check.worse(curr, prev)) {
      worseCount++;
    }
  }

  return worseCount >= checks.length; // All metrics worse = regression
}

/**
 * Detect oscillation (metric bouncing back and forth)
 */
function detectOscillation(history, metric) {
  if (history.length < 3) return false;

  const recent = history.slice(-3).map((h) => h.metrics[metric] ?? 0);
  // Check if alternating up/down
  const d1 = recent[1] - recent[0];
  const d2 = recent[2] - recent[1];
  return (d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0);
}

// --- Main Orchestrator Loop ---
async function main() {
  console.log('');
  console.log('================================================');
  console.log('  AI Game Designer - Balance Tuning Orchestrator');
  console.log('================================================');
  console.log(`  Iterations:  ${MAX_ITERATIONS}`);
  console.log(`  Agents:      ${NUM_AGENTS}`);
  console.log(`  Timeout:     ${TIMEOUT_S}s`);
  console.log(`  Skip Build:  ${SKIP_BUILD}`);
  console.log(`  Dry Run:     ${DRY_RUN}`);
  console.log(`  URL:         ${BASE_URL}`);

  const targets = buildTargets(args);
  console.log('  Targets:');
  for (const [key, t] of Object.entries(targets)) {
    console.log(`    ${key}: ${t.min}-${t.max} ${t.unit ?? ''}`);
  }
  console.log('================================================\n');

  const config = loadConfig();
  const history = [];
  let previousMetrics = null;
  let stepScaleFactor = 1.0;

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ITERATION ${iter}/${MAX_ITERATIONS}`);
    console.log(`${'='.repeat(60)}`);

    const iterationDir = path.join(RESULTS_DIR, `iteration_${String(iter).padStart(3, '0')}`);
    ensureDir(iterationDir);

    // 1. Snapshot current parameters
    console.log('\n  [1/6] Reading current balance parameters...');
    const currentConfig = loadConfig();
    const snapshot = readAllParameters(currentConfig);
    const balanceSnapshot = {};
    for (const [key, s] of Object.entries(snapshot)) {
      balanceSnapshot[key] = {
        value: s.value,
        category: s.category,
        description: s.description,
      };
    }
    saveJSON(path.join(iterationDir, 'balance_snapshot.json'), balanceSnapshot);

    // 2. Run QA
    console.log('\n  [2/6] Running QA agents...');
    let qaResults;
    try {
      qaResults = await runQA(iterationDir);
    } catch (err) {
      console.error(`  QA failed: ${err.message}`);
      console.error('  Aborting iteration.');
      break;
    }

    // 3. Check convergence
    console.log('\n  [3/6] Checking convergence...');
    const metrics = qaResults.aggregate ?? {};
    const convergence = checkConvergence(metrics, targets);
    console.log(formatConvergence(convergence));

    // Record in history
    history.push({
      iteration: iter,
      metrics,
      convergence,
      changes: [],
    });

    if (convergence.allMet) {
      console.log('\n  ALL TARGETS MET! Balance tuning complete.');
      saveJSON(path.join(iterationDir, 'convergence.json'), convergence);
      break;
    }

    // 4. Check for regression
    if (isRegression(metrics, previousMetrics)) {
      console.log('\n  WARNING: Regression detected! All metrics worse than previous iteration.');
      console.log('  Rolling back to previous parameters...');
      const restored = restoreBackups(currentConfig);
      console.log(`  Restored: ${restored.join(', ')}`);
      // Ask Claude to try a different approach
      if (history.length >= 2) {
        history[history.length - 1].rollback = true;
      }
    }

    // 5. Detect oscillation
    if (detectOscillation(history, 'avgSurvivalTime')) {
      console.log('\n  WARNING: Oscillation detected in survival time. Reducing step size.');
      stepScaleFactor *= 0.5;
    }

    // 6. Ask Claude Game Designer
    console.log('\n  [4/6] Consulting AI Game Designer...');
    let analysis;
    try {
      analysis = await askDesigner({
        qaResults,
        convergence,
        balanceSnapshot,
        targets,
        history: history.slice(0, -1), // exclude current (incomplete) entry
      });
    } catch (err) {
      console.error(`  Claude API error: ${err.message}`);
      console.error('  Skipping parameter changes this iteration.');
      saveJSON(path.join(iterationDir, 'analysis_error.json'), { error: err.message });
      previousMetrics = metrics;
      continue;
    }

    saveJSON(path.join(iterationDir, 'analysis.json'), analysis);

    // Print analysis
    console.log(`\n  Analysis: ${analysis.analysis?.summary ?? 'N/A'}`);
    if (analysis.analysis?.strengths) {
      console.log('  Strengths:', analysis.analysis.strengths.join('; '));
    }
    if (analysis.analysis?.weaknesses) {
      console.log('  Weaknesses:', analysis.analysis.weaknesses.join('; '));
    }

    // 7. Validate and apply changes
    console.log('\n  [5/6] Applying balance changes...');
    const proposedChanges = analysis.proposedChanges ?? [];

    if (proposedChanges.length === 0) {
      console.log('  No changes proposed by designer.');
      previousMetrics = metrics;
      continue;
    }

    // Apply step scale factor if oscillation detected
    const scaledChanges = proposedChanges.map((change) => {
      if (stepScaleFactor < 1.0) {
        const param = currentConfig.parameters[change.parameter];
        if (param) {
          const currentVal = snapshot[change.parameter]?.value ?? param.value;
          const delta = change.proposedValue - currentVal;
          const scaledDelta = delta * stepScaleFactor;
          return { ...change, proposedValue: currentVal + scaledDelta };
        }
      }
      return change;
    });

    // Validate change magnitude (max 30% per parameter)
    const validatedChanges = scaledChanges.filter((change) => {
      const param = currentConfig.parameters[change.parameter];
      if (!param) {
        console.log(`    SKIP [${change.parameter}]: unknown parameter`);
        return false;
      }
      const currentVal = snapshot[change.parameter]?.value ?? param.value;
      if (currentVal === 0) return true;
      const pctChange = Math.abs((change.proposedValue - currentVal) / currentVal) * 100;
      if (pctChange > 30) {
        console.log(`    CLAMP [${change.parameter}]: ${pctChange.toFixed(1)}% change exceeds 30% limit`);
        // Clamp to 30%
        const direction = change.proposedValue > currentVal ? 1 : -1;
        change.proposedValue = currentVal * (1 + direction * 0.3);
      }
      return true;
    });

    console.log(`\n  Proposed changes (${validatedChanges.length}):`);
    for (const c of validatedChanges) {
      const currentVal = snapshot[c.parameter]?.value ?? '?';
      const pct = currentVal !== '?' ? ((c.proposedValue - currentVal) / currentVal * 100).toFixed(1) : '?';
      console.log(`    ${c.parameter}: ${currentVal} -> ${c.proposedValue} (${pct > 0 ? '+' : ''}${pct}%) - ${c.reasoning ?? ''}`);
    }

    if (DRY_RUN) {
      console.log('\n  [DRY RUN] Changes not applied.');
      saveJSON(path.join(iterationDir, 'diff.json'), { dryRun: true, changes: validatedChanges });
    } else {
      const results = applyChanges(validatedChanges, currentConfig, { backup: true });
      const applied = results.filter((r) => r.applied);
      const failed = results.filter((r) => !r.applied);

      console.log(`\n  Applied: ${applied.length}, Failed: ${failed.length}`);
      for (const f of failed) {
        console.log(`    FAILED [${f.parameter}]: ${f.error}`);
      }

      saveJSON(path.join(iterationDir, 'diff.json'), {
        proposed: validatedChanges,
        applied: applied.map((r) => ({
          parameter: r.parameter,
          oldValue: r.oldValue,
          newValue: r.newValue,
          file: r.file,
          lineNumber: r.lineNumber,
        })),
        failed: failed.map((r) => ({ parameter: r.parameter, error: r.error })),
      });

      // Update history with actual changes
      history[history.length - 1].changes = applied.map((r) => ({
        parameter: r.parameter,
        oldValue: r.oldValue,
        newValue: r.newValue,
      }));
    }

    // 8. Rebuild if needed
    console.log('\n  [6/6] Rebuild check...');
    rebuildGame();

    previousMetrics = metrics;

    console.log(`\n  Iteration ${iter} complete.`);
  }

  // --- Final Report ---
  console.log('\n\n================================================');
  console.log('  GAME DESIGNER - FINAL REPORT');
  console.log('================================================');
  console.log(`  Total iterations: ${history.length}`);

  if (history.length > 0) {
    const first = history[0];
    const last = history[history.length - 1];

    console.log(`\n  First iteration metrics:`);
    console.log(`    Avg Survival: ${first.metrics.avgSurvivalTime?.toFixed(1) ?? 'N/A'}s`);
    console.log(`    Avg Kills:    ${first.metrics.avgKills?.toFixed(1) ?? 'N/A'}`);
    console.log(`    Avg Level:    ${first.metrics.avgLevel?.toFixed(1) ?? 'N/A'}`);

    console.log(`\n  Last iteration metrics:`);
    console.log(`    Avg Survival: ${last.metrics.avgSurvivalTime?.toFixed(1) ?? 'N/A'}s`);
    console.log(`    Avg Kills:    ${last.metrics.avgKills?.toFixed(1) ?? 'N/A'}`);
    console.log(`    Avg Level:    ${last.metrics.avgLevel?.toFixed(1) ?? 'N/A'}`);

    console.log(`\n  Final convergence:`);
    console.log(formatConvergence(last.convergence));

    // Count total changes
    const totalChanges = history.reduce((sum, h) => sum + (h.changes?.length ?? 0), 0);
    console.log(`\n  Total parameter changes: ${totalChanges}`);
  }

  // Save full history
  saveJSON(path.join(RESULTS_DIR, 'design_history.json'), {
    meta: {
      timestamp: new Date().toISOString(),
      iterations: history.length,
      maxIterations: MAX_ITERATIONS,
      agents: NUM_AGENTS,
      targets,
    },
    history,
  });

  console.log(`\n  Results saved to: ${RESULTS_DIR}/`);
  console.log('================================================\n');
}

main().catch((err) => {
  console.error('Game Designer error:', err);
  process.exit(1);
});
