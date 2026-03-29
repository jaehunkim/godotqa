/**
 * balance_targets.js - Balance target definitions and convergence checking
 *
 * Defines desired game balance metrics and checks whether QA results
 * have converged to meet those targets.
 */

const DEFAULT_TARGETS = {
  survivalTime: { min: 60, max: 90, unit: 'seconds', description: 'Average agent survival time' },
  firstLevelUpTime: { min: 15, max: 20, unit: 'seconds', description: 'Time to first level-up' },
  avgKills: { min: 30, max: 60, unit: 'count', description: 'Average kills per run' },
};

/**
 * Parse CLI target string like "60-90" into { min, max }
 */
function parseRange(str) {
  if (!str) return null;
  const parts = str.split('-').map(Number);
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return { min: parts[0], max: parts[1] };
  }
  if (parts.length === 1 && !isNaN(parts[0])) {
    // Single value: treat as +-10%
    const v = parts[0];
    return { min: v * 0.9, max: v * 1.1 };
  }
  return null;
}

/**
 * Build targets from CLI flags, merging with defaults
 * @param {Object} cliArgs - Parsed CLI arguments
 * @returns {Object} targets
 */
export function buildTargets(cliArgs = {}) {
  const targets = { ...DEFAULT_TARGETS };

  if (cliArgs['target-survival']) {
    const range = parseRange(cliArgs['target-survival']);
    if (range) targets.survivalTime = { ...targets.survivalTime, ...range };
  }

  if (cliArgs['target-first-levelup']) {
    const range = parseRange(cliArgs['target-first-levelup']);
    if (range) targets.firstLevelUpTime = { ...targets.firstLevelUpTime, ...range };
  }

  if (cliArgs['target-kills']) {
    const range = parseRange(cliArgs['target-kills']);
    if (range) targets.avgKills = { ...targets.avgKills, ...range };
  }

  return targets;
}

/**
 * Check if aggregate metrics meet all targets
 * @param {Object} metrics - Aggregate metrics from QA results
 * @param {Object} targets - Target definitions
 * @returns {{ allMet: boolean, results: Object[] }}
 */
export function checkConvergence(metrics, targets) {
  const results = [];

  // Survival time
  if (targets.survivalTime) {
    const val = metrics.avgSurvivalTime ?? 0;
    const { min, max } = targets.survivalTime;
    const met = val >= min && val <= max;
    results.push({
      metric: 'survivalTime',
      value: val,
      target: `${min}-${max}s`,
      met,
      delta: val < min ? val - min : val > max ? val - max : 0,
      description: targets.survivalTime.description,
    });
  }

  // First level-up time
  if (targets.firstLevelUpTime) {
    const val = metrics.avgTimeToFirstLevelUp ?? 0;
    const { min, max } = targets.firstLevelUpTime;
    const met = val >= min && val <= max;
    results.push({
      metric: 'firstLevelUpTime',
      value: val,
      target: `${min}-${max}s`,
      met,
      delta: val < min ? val - min : val > max ? val - max : 0,
      description: targets.firstLevelUpTime.description,
    });
  }

  // Average kills
  if (targets.avgKills) {
    const val = metrics.avgKills ?? 0;
    const { min, max } = targets.avgKills;
    const met = val >= min && val <= max;
    results.push({
      metric: 'avgKills',
      value: val,
      target: `${min}-${max}`,
      met,
      delta: val < min ? val - min : val > max ? val - max : 0,
      description: targets.avgKills.description,
    });
  }

  const allMet = results.every((r) => r.met);

  return { allMet, results };
}

/**
 * Format convergence results for logging
 * @param {{ allMet: boolean, results: Object[] }} convergence
 * @returns {string}
 */
export function formatConvergence(convergence) {
  const lines = ['  Convergence Check:'];
  for (const r of convergence.results) {
    const icon = r.met ? 'PASS' : 'FAIL';
    const delta = r.delta !== 0 ? ` (delta: ${r.delta > 0 ? '+' : ''}${r.delta.toFixed(1)})` : '';
    lines.push(`    [${icon}] ${r.description}: ${r.value.toFixed(1)} (target: ${r.target})${delta}`);
  }
  lines.push(`  Overall: ${convergence.allMet ? 'ALL TARGETS MET' : 'NOT CONVERGED'}`);
  return lines.join('\n');
}

export { DEFAULT_TARGETS };
