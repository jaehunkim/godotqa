/**
 * designer_prompt.js - Claude Game Designer prompt construction
 *
 * Builds the system prompt and user messages for the AI Game Designer agent
 * that analyzes QA results and proposes balance changes.
 */

const SYSTEM_PROMPT = `You are an expert Game Designer AI specializing in game balance for a vampire survivors-style roguelike.

## Game Description
A top-down 2D survival game where the player auto-shoots at the nearest enemy.
The player controls movement with WASD. Enemies spawn in waves with increasing difficulty.
XP orbs drop from killed enemies and grant levels. Each level offers upgrade choices.
The goal is to survive as long as possible while killing enemies and leveling up.

## Balance Philosophy
1. **Survival Curve**: Players should feel challenged but not overwhelmed. Early game (0-30s) should be forgiving. Mid game (30-60s) should ramp up. Late game (60s+) should be intense but survivable with good upgrades.
2. **Meaningful Upgrades**: Each upgrade should feel impactful. The player should notice the difference immediately.
3. **Strategy Differentiation**: Different strategies (aggressive, defensive, balanced, explorer) should all be viable but with different strengths. No single strategy should dominate all metrics.
4. **Pacing**: Level-ups should come fast enough to feel rewarding (first within 15-20s) but slow down to prevent over-powering.
5. **Enemy Pressure**: Enemies should always pose a threat. Damage-per-second from enemies should scale smoothly, not in harsh jumps.

## Conservative Change Principles
- Change only 3-5 parameters per iteration
- Keep adjustments within 10-20% of current values
- Never change a parameter more than 30% in a single iteration
- Prefer small nudges over dramatic shifts
- If a metric is far from target, prioritize the parameters with highest impact
- Consider second-order effects (e.g., faster enemies + more damage = much harder)

## Response Format
You MUST respond with ONLY valid JSON matching this schema:
{
  "analysis": {
    "summary": "Brief overall assessment",
    "strengths": ["What's working well"],
    "weaknesses": ["What needs improvement"],
    "rootCauses": ["Why the metrics are off-target"]
  },
  "proposedChanges": [
    {
      "parameter": "parameter_key from balance_config",
      "currentValue": <number>,
      "proposedValue": <number>,
      "reasoning": "Why this change helps"
    }
  ],
  "predictions": {
    "expectedSurvivalTime": "X-Ys range",
    "expectedKills": "X-Y range",
    "confidence": "low|medium|high",
    "risks": ["Potential negative side effects"]
  }
}`;

/**
 * Build the user message with QA results and context
 * @param {Object} options
 * @param {Object} options.qaResults - QA results with aggregate metrics
 * @param {Object} options.convergence - Convergence check results
 * @param {Object} options.balanceSnapshot - Current parameter values
 * @param {Object} options.targets - Balance targets
 * @param {Array} [options.history] - Previous iteration history
 * @returns {string}
 */
export function buildDesignerMessage({
  qaResults,
  convergence,
  balanceSnapshot,
  targets,
  history = [],
}) {
  const sections = [];

  // Current balance parameters
  sections.push('## Current Balance Parameters');
  sections.push('```json');
  sections.push(JSON.stringify(balanceSnapshot, null, 2));
  sections.push('```');

  // Targets
  sections.push('\n## Balance Targets');
  for (const [key, target] of Object.entries(targets)) {
    sections.push(`- **${key}**: ${target.min}-${target.max} ${target.unit ?? ''} (${target.description})`);
  }

  // QA Results - Aggregate metrics
  sections.push('\n## QA Results - Aggregate Metrics');
  if (qaResults.aggregate) {
    sections.push('```json');
    sections.push(JSON.stringify(qaResults.aggregate, null, 2));
    sections.push('```');
  }

  // Convergence status
  sections.push('\n## Convergence Status');
  for (const r of convergence.results) {
    const icon = r.met ? 'PASS' : 'FAIL';
    sections.push(`- [${icon}] **${r.description}**: ${r.value.toFixed(1)} (target: ${r.target})`);
  }

  // Per-agent breakdown
  sections.push('\n## Per-Agent Results');
  if (qaResults.agents && qaResults.agents.length > 0) {
    for (const agent of qaResults.agents) {
      sections.push(`- **${agent.agentName}** (${agent.strategy}): survived ${agent.survivalTime}s, ${agent.kills} kills, level ${agent.level}, upgrades: ${agent.upgradesChosen?.map((u) => u.name).join(', ') || 'none'}`);
    }
  }

  // Strategy ranking
  if (qaResults.aggregate?.strategyRanking) {
    sections.push('\n## Strategy Ranking (by survival)');
    for (const s of qaResults.aggregate.strategyRanking) {
      sections.push(`- **${s.strategy}**: avg survival ${s.avgSurvival.toFixed(1)}s, avg kills ${s.avgKills.toFixed(1)}`);
    }
  }

  // Iteration history
  if (history.length > 0) {
    sections.push('\n## Previous Iterations');
    for (const h of history) {
      sections.push(`### Iteration ${h.iteration}`);
      sections.push(`- Survival: ${h.metrics.avgSurvivalTime?.toFixed(1)}s, Kills: ${h.metrics.avgKills?.toFixed(1)}, Level: ${h.metrics.avgLevel?.toFixed(1)}`);
      if (h.changes && h.changes.length > 0) {
        sections.push('- Changes applied:');
        for (const c of h.changes) {
          sections.push(`  - ${c.parameter}: ${c.oldValue} -> ${c.newValue}`);
        }
      }
      sections.push(`- Convergence: ${h.convergence.allMet ? 'MET' : 'NOT MET'}`);
    }
  }

  // Instructions
  sections.push('\n## Your Task');
  sections.push('Analyze the QA results above and propose balance parameter changes to move metrics toward the targets.');
  sections.push('Focus on the metrics that are furthest from their target ranges.');
  sections.push('Remember: conservative changes only (3-5 parameters, 10-20% adjustments).');

  return sections.join('\n');
}

/**
 * Build the full messages array for the Claude API call
 */
export function buildMessages({ qaResults, convergence, balanceSnapshot, targets, history }) {
  return [
    {
      role: 'user',
      content: buildDesignerMessage({ qaResults, convergence, balanceSnapshot, targets, history }),
    },
  ];
}

export { SYSTEM_PROMPT };
