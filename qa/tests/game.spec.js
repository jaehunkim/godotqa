import { test, expect } from '@playwright/test';

// Helper: read gameState from the page
async function getGameState(page) {
  return page.evaluate(() => window.gameState);
}

// Helper: wait for gameState to be available and game to be running
async function waitForGameReady(page) {
  await page.waitForFunction(
    () =>
      window.gameState !== undefined &&
      window.gameState !== null &&
      !window.gameState.isGameOver,
    { timeout: 30000 }
  );
}

// Helper: hold a key for a duration
async function holdKey(page, key, ms) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

// Helper: play for N seconds by moving around
async function playFor(page, seconds) {
  const directions = ['w', 'a', 's', 'd'];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const key = directions[Math.floor(Math.random() * directions.length)];
    await holdKey(page, key, 300);
    await page.waitForTimeout(100);

    // Handle upgrade screen if it appears mid-play
    const state = await getGameState(page);
    if (state?.isUpgradeScreen) {
      await page.waitForTimeout(500);
      const buttons = await page.$$('button, .upgrade-button, [data-upgrade]');
      if (buttons.length > 0) {
        await buttons[0].click();
      } else {
        // Try pressing '1' as a fallback upgrade selection
        await page.keyboard.press('1');
      }
      await page.waitForTimeout(500);
    }
  }
}

test.describe('Godot Vampire Survivors - QA Suite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Game loads and canvas renders', async ({ page }) => {
    // Wait for canvas element
    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible({ timeout: 15000 });

    // Wait for Godot to initialize gameState
    await page.waitForFunction(
      () => typeof window.gameState !== 'undefined',
      { timeout: 30000 }
    );

    const state = await getGameState(page);
    expect(state).not.toBeNull();
    expect(state).toHaveProperty('playerHP');
    expect(state).toHaveProperty('playerX');
    expect(state).toHaveProperty('playerY');
    expect(state).toHaveProperty('score');
    expect(state).toHaveProperty('isGameOver');
    expect(state.playerHP).toBeGreaterThan(0);
  });

  test('Player moves with WASD', async ({ page }) => {
    await waitForGameReady(page);

    const before = await getGameState(page);
    const startX = before.playerX;
    const startY = before.playerY;

    // Move right for 500ms
    await holdKey(page, 'd', 500);
    await page.waitForTimeout(200);

    const afterRight = await getGameState(page);

    // Move down for 500ms
    await holdKey(page, 's', 500);
    await page.waitForTimeout(200);

    const afterDown = await getGameState(page);

    // At least one axis should have changed after movement
    const movedHorizontal = Math.abs(afterRight.playerX - startX) > 0.1;
    const movedVertical = Math.abs(afterDown.playerY - startY) > 0.1;

    expect(movedHorizontal || movedVertical).toBe(true);
  });

  test('Enemies spawn within a few seconds', async ({ page }) => {
    await waitForGameReady(page);

    // Wait up to 10 seconds for enemies to appear
    await page.waitForFunction(
      () => window.gameState && window.gameState.enemyCount > 0,
      { timeout: 10000 }
    );

    const state = await getGameState(page);
    expect(state.enemyCount).toBeGreaterThan(0);
  });

  test('Player can kill enemies after 10 seconds of play', async ({ page }) => {
    await waitForGameReady(page);

    // Move around for 10 seconds (auto-shoot is on)
    await playFor(page, 10);

    const state = await getGameState(page);
    expect(state.killCount).toBeGreaterThan(0);
  });

  test('Upgrade screen appears on level up', async ({ page }) => {
    await waitForGameReady(page);

    // Play until upgrade screen or timeout (up to 60s)
    await page.waitForFunction(
      () => window.gameState && window.gameState.isUpgradeScreen === true,
      { timeout: 60000, polling: 500 }
    ).catch(async () => {
      // Keep playing if not yet on upgrade screen
      await playFor(page, 20);
    });

    // Check again after playing
    await page.waitForFunction(
      () => window.gameState && window.gameState.isUpgradeScreen === true,
      { timeout: 30000, polling: 500 }
    );

    const state = await getGameState(page);
    expect(state.isUpgradeScreen).toBe(true);
    expect(Array.isArray(state.upgradeOptions)).toBe(true);
    expect(state.upgradeOptions.length).toBeGreaterThan(0);

    // Each upgrade option should have name and description
    for (const option of state.upgradeOptions) {
      expect(option).toHaveProperty('name');
      expect(option).toHaveProperty('description');
    }
  });

  test('Select upgrade applies it to currentUpgrades', async ({ page }) => {
    await waitForGameReady(page);

    // Play until upgrade screen
    await page.waitForFunction(
      () => window.gameState && window.gameState.isUpgradeScreen === true,
      { timeout: 60000, polling: 500 }
    ).catch(async () => {
      await playFor(page, 20);
    });

    await page.waitForFunction(
      () => window.gameState && window.gameState.isUpgradeScreen === true,
      { timeout: 30000, polling: 500 }
    );

    const stateBefore = await getGameState(page);
    expect(stateBefore.isUpgradeScreen).toBe(true);
    const chosenUpgrade = stateBefore.upgradeOptions[0];

    // Click the first upgrade button on the canvas (approximate position)
    // The upgrade panel is centered, first button is roughly at (640, 260)
    const canvas = page.locator('canvas');
    await canvas.click({ position: { x: 640, y: 260 } });
    // Give the game a moment to process the click
    await page.waitForTimeout(500);
    // If first click didn't work, try a slightly different position
    const stillUpgrade = await page.evaluate(() => window.gameState?.isUpgradeScreen);
    if (stillUpgrade) {
      await canvas.click({ position: { x: 640, y: 260 } });
      await page.waitForTimeout(500);
    }

    // Wait for upgrade screen to close
    await page.waitForFunction(
      () => window.gameState && window.gameState.isUpgradeScreen === false,
      { timeout: 5000 }
    );

    const stateAfter = await getGameState(page);
    expect(stateAfter.isUpgradeScreen).toBe(false);

    // Verify the upgrade was registered
    if (chosenUpgrade && chosenUpgrade.name) {
      const upgradeName = chosenUpgrade.name;
      expect(stateAfter.currentUpgrades).toHaveProperty(upgradeName);
    }
  });

  test.skip('Game over (requires player to die)', async ({ page }) => {
    // This test is skipped by default as it requires waiting for the player to die.
    // To enable: remove test.skip and increase timeout significantly.
    // The player dies when playerHP reaches 0.
    await waitForGameReady(page);

    await page.waitForFunction(
      () => window.gameState && window.gameState.isGameOver === true,
      { timeout: 300000 }
    );

    const state = await getGameState(page);
    expect(state.isGameOver).toBe(true);
    expect(state.killCount).toBeGreaterThanOrEqual(0);
    expect(state.elapsedTime).toBeGreaterThan(0);
  });
});
