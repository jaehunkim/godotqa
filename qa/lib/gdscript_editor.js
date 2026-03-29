/**
 * gdscript_editor.js - GDScript file parameter reader/writer
 *
 * Reads and writes numeric parameters in GDScript files by matching
 * line patterns from balance_config.json. Preserves indentation and
 * creates .bak backups before writing.
 *
 * Usage:
 *   import { readParameter, writeParameter, readAllParameters, applyChanges } from './lib/gdscript_editor.js';
 *
 * Self-test:
 *   node qa/lib/gdscript_editor.js --test
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Resolve a config file path (relative to project root) to an absolute path
 */
function resolveFilePath(relPath) {
  if (path.isAbsolute(relPath)) return relPath;
  return path.join(PROJECT_ROOT, relPath);
}

/**
 * Find the line matching a linePattern in a file
 * @param {string[]} lines - File lines
 * @param {string} linePattern - Pattern to search for
 * @returns {{ index: number, line: string } | null}
 */
function findLine(lines, linePattern) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(linePattern)) {
      return { index: i, line: lines[i] };
    }
  }
  return null;
}

/**
 * Extract a numeric value from a line
 * @param {string} line - The GDScript line
 * @param {string} [extractPattern] - Optional regex pattern with capture group
 * @returns {number | null}
 */
function extractValue(line, extractPattern) {
  if (extractPattern) {
    const match = line.match(new RegExp(extractPattern));
    if (match && match[1]) {
      return parseFloat(match[1]);
    }
  }

  // Default: find the last number on the line (before any comment)
  // Remove inline comments
  const noComment = line.split('#')[0];
  // Match numbers including decimals and negatives
  const numbers = noComment.match(/-?\d+\.?\d*/g);
  if (numbers && numbers.length > 0) {
    // Return the last number (typically the value after '=')
    return parseFloat(numbers[numbers.length - 1]);
  }
  return null;
}

/**
 * Replace a numeric value in a line
 * @param {string} line - Original line
 * @param {number} oldValue - Current value to replace
 * @param {number} newValue - New value
 * @param {string} [extractPattern] - Optional regex for specific value location
 * @returns {string} Modified line
 */
function replaceValue(line, oldValue, newValue, extractPattern) {
  if (extractPattern) {
    const regex = new RegExp(extractPattern);
    const match = line.match(regex);
    if (match && match[1]) {
      const oldStr = match[1];
      const newStr = formatValue(newValue, oldStr);
      const fullMatch = match[0];
      const replacement = fullMatch.replace(oldStr, newStr);
      return line.replace(fullMatch, replacement);
    }
  }

  // Default: replace the last number on the line (before comments)
  const commentIdx = line.indexOf('#');
  const codePart = commentIdx >= 0 ? line.substring(0, commentIdx) : line;
  const commentPart = commentIdx >= 0 ? line.substring(commentIdx) : '';

  // Find and replace the last number in the code portion
  const numbers = [...codePart.matchAll(/-?\d+\.?\d*/g)];
  if (numbers.length === 0) return line;

  const lastMatch = numbers[numbers.length - 1];
  const originalStr = lastMatch[0];
  const newStr = formatValue(newValue, originalStr);
  const before = codePart.substring(0, lastMatch.index);
  const after = codePart.substring(lastMatch.index + lastMatch[0].length);

  return before + newStr + after + commentPart;
}

/**
 * Format a value to match the style of the original string representation
 * @param {number} newValue - The new numeric value
 * @param {string} originalStr - The original string from the source file
 */
function formatValue(newValue, originalStr) {
  // Use the original string (from source) to detect format, not the parsed number
  if (originalStr.includes('.')) {
    const decimals = originalStr.split('.')[1]?.length ?? 1;
    return newValue.toFixed(decimals);
  }

  // Integer format
  if (Number.isInteger(newValue)) {
    return String(Math.round(newValue));
  }

  return String(newValue);
}

/**
 * Read a single parameter value from its GDScript file
 * @param {Object} param - Parameter definition from balance_config
 * @param {string} param.file - Relative file path
 * @param {string} param.linePattern - Line identification pattern
 * @param {string} [param.extractPattern] - Optional regex for value extraction
 * @returns {{ value: number, line: string, lineNumber: number } | null}
 */
export function readParameter(param) {
  const filePath = resolveFilePath(param.file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const found = findLine(lines, param.linePattern);

  if (!found) {
    throw new Error(`Line pattern not found: "${param.linePattern}" in ${param.file}`);
  }

  const value = extractValue(found.line, param.extractPattern);
  if (value === null) {
    throw new Error(`Could not extract number from line: "${found.line}"`);
  }

  return { value, line: found.line, lineNumber: found.index + 1 };
}

/**
 * Write a single parameter value to its GDScript file
 * @param {Object} param - Parameter definition from balance_config
 * @param {number} newValue - New value to write
 * @param {Object} [options]
 * @param {boolean} [options.backup=true] - Create .bak file
 * @param {boolean} [options.dryRun=false] - Only return changes, don't write
 * @returns {{ oldValue: number, newValue: number, file: string, lineNumber: number, oldLine: string, newLine: string }}
 */
export function writeParameter(param, newValue, options = {}) {
  const { backup = true, dryRun = false } = options;
  const filePath = resolveFilePath(param.file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Enforce min/max bounds
  if (param.min !== undefined && newValue < param.min) {
    newValue = param.min;
  }
  if (param.max !== undefined && newValue > param.max) {
    newValue = param.max;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const found = findLine(lines, param.linePattern);

  if (!found) {
    throw new Error(`Line pattern not found: "${param.linePattern}" in ${param.file}`);
  }

  const oldValue = extractValue(found.line, param.extractPattern);
  if (oldValue === null) {
    throw new Error(`Could not extract number from line: "${found.line}"`);
  }

  const newLine = replaceValue(found.line, oldValue, newValue, param.extractPattern);

  const result = {
    oldValue,
    newValue,
    file: param.file,
    lineNumber: found.index + 1,
    oldLine: found.line,
    newLine,
  };

  if (!dryRun) {
    // Create backup
    if (backup) {
      fs.writeFileSync(filePath + '.bak', content);
    }

    // Write modified file
    lines[found.index] = newLine;
    fs.writeFileSync(filePath, lines.join('\n'));
  }

  return result;
}

/**
 * Read all parameters from balance config
 * @param {Object} config - Full balance_config object
 * @returns {Object} Map of paramKey -> { value, line, lineNumber, configValue }
 */
export function readAllParameters(config) {
  const snapshot = {};

  for (const [key, param] of Object.entries(config.parameters)) {
    try {
      const result = readParameter(param);
      snapshot[key] = {
        ...result,
        configValue: param.value,
        matches: result.value === param.value,
        category: param.category,
        description: param.description,
      };
    } catch (err) {
      snapshot[key] = {
        value: null,
        error: err.message,
        configValue: param.value,
        category: param.category,
        description: param.description,
      };
    }
  }

  return snapshot;
}

/**
 * Apply multiple parameter changes
 * @param {Array<{ parameter: string, proposedValue: number }>} changes - Changes to apply
 * @param {Object} config - Full balance_config object
 * @param {Object} [options]
 * @param {boolean} [options.backup=true]
 * @param {boolean} [options.dryRun=false]
 * @returns {Array<Object>} Results for each change
 */
export function applyChanges(changes, config, options = {}) {
  const results = [];

  for (const change of changes) {
    const param = config.parameters[change.parameter];
    if (!param) {
      results.push({
        parameter: change.parameter,
        error: `Unknown parameter: ${change.parameter}`,
        applied: false,
      });
      continue;
    }

    try {
      const result = writeParameter(param, change.proposedValue, options);
      results.push({
        parameter: change.parameter,
        ...result,
        applied: !options.dryRun,
      });
    } catch (err) {
      results.push({
        parameter: change.parameter,
        error: err.message,
        applied: false,
      });
    }
  }

  return results;
}

/**
 * Restore all .bak files for the given config
 * @param {Object} config - Full balance_config object
 */
export function restoreBackups(config) {
  const restored = [];
  const files = new Set(Object.values(config.parameters).map((p) => p.file));

  for (const relPath of files) {
    const filePath = resolveFilePath(relPath);
    const bakPath = filePath + '.bak';
    if (fs.existsSync(bakPath)) {
      fs.copyFileSync(bakPath, filePath);
      fs.unlinkSync(bakPath);
      restored.push(relPath);
    }
  }

  return restored;
}

// --- Self-test mode ---
async function selfTest() {
  console.log('GDScript Editor - Self Test\n');

  const configPath = path.join(__dirname, '..', 'balance_config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  let passed = 0;
  let failed = 0;

  // Test 1: Read all parameters
  console.log('--- Test: Read All Parameters ---');
  const snapshot = readAllParameters(config);

  for (const [key, result] of Object.entries(snapshot)) {
    if (result.error) {
      console.log(`  FAIL [${key}]: ${result.error}`);
      failed++;
    } else {
      const matchIcon = result.matches ? 'MATCH' : 'DRIFT';
      console.log(`  OK   [${key}]: file=${result.value}, config=${result.configValue} (${matchIcon}) L${result.lineNumber}`);
      passed++;
    }
  }

  // Test 2: Dry-run write
  console.log('\n--- Test: Dry-Run Write ---');
  const testParam = config.parameters.player_base_speed;
  if (testParam) {
    try {
      const result = writeParameter(testParam, 250.0, { dryRun: true });
      console.log(`  OK   player_base_speed: ${result.oldValue} -> ${result.newValue}`);
      console.log(`       Old: ${result.oldLine}`);
      console.log(`       New: ${result.newLine}`);
      passed++;
    } catch (err) {
      console.log(`  FAIL player_base_speed write: ${err.message}`);
      failed++;
    }
  }

  // Test 3: Bounds enforcement
  console.log('\n--- Test: Bounds Enforcement ---');
  if (testParam) {
    try {
      const result = writeParameter(testParam, 9999, { dryRun: true });
      const bounded = result.newValue <= testParam.max;
      console.log(`  ${bounded ? 'OK  ' : 'FAIL'} Max bound: requested 9999, got ${result.newValue} (max: ${testParam.max})`);
      if (bounded) passed++;
      else failed++;
    } catch (err) {
      console.log(`  FAIL Bounds test: ${err.message}`);
      failed++;
    }
  }

  // Test 4: Batch apply (dry run)
  console.log('\n--- Test: Batch Apply (dry-run) ---');
  const testChanges = [
    { parameter: 'player_base_speed', proposedValue: 220.0 },
    { parameter: 'enemy_base_hp', proposedValue: 35.0 },
    { parameter: 'nonexistent_param', proposedValue: 99 },
  ];
  const batchResults = applyChanges(testChanges, config, { dryRun: true });
  for (const r of batchResults) {
    if (r.error) {
      if (r.parameter === 'nonexistent_param') {
        console.log(`  OK   [${r.parameter}]: correctly rejected - ${r.error}`);
        passed++;
      } else {
        console.log(`  FAIL [${r.parameter}]: ${r.error}`);
        failed++;
      }
    } else {
      console.log(`  OK   [${r.parameter}]: ${r.oldValue} -> ${r.newValue}`);
      passed++;
    }
  }

  console.log(`\n========================================`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);

  process.exit(failed > 0 ? 1 : 0);
}

// Run self-test if invoked directly with --test
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--test')) {
  selfTest();
}
