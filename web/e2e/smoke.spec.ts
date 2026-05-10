import { test, expect } from '@playwright/test';

test.describe('Sd-viz smoke tests', () => {
  test('页面加载无 console error', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    await page.goto('/');
    await page.waitForSelector('.puncture', { timeout: 5000 });
    expect(errors).toEqual([]);
  });

  test('点 entry 出现 path + Stokes 数值', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    // (0,1) cell 在 grid 第 2 个 (idx=1, 0-indexed; n=4 grid: (0,0)(0,1)(0,2)(0,3) ...)
    await page.locator('#entry-grid .cell').nth(1).click();
    await expect(page.locator('.path-line')).toHaveCount(1);
    await expect(page.locator('#stokes-display .value')).toBeVisible();
  });

  test('拖动 path vertex 跟手 (像素级精确)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    await page.locator('#entry-grid .cell').nth(2).click();
    await page.waitForSelector('.path-vertex');

    const vert = page.locator('.path-vertex').first();
    const before = await vert.boundingBox();
    if (!before) throw new Error('no vertex bbox');

    const startX = before.x + before.width / 2;
    const startY = before.y + before.height / 2;
    const dx = 25, dy = -15;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
    await page.mouse.up();

    const after = await vert.boundingBox();
    if (!after) throw new Error('no vertex bbox after drag');

    const movedX = after.x - before.x;
    const movedY = after.y - before.y;
    expect(Math.abs(movedX - dx)).toBeLessThan(2);
    expect(Math.abs(movedY - dy)).toBeLessThan(2);
  });

  test('拖动 puncture 跟手', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');

    const pun = page.locator('.puncture').first();
    const before = await pun.boundingBox();
    if (!before) throw new Error('no puncture bbox');

    const startX = before.x + before.width / 2;
    const startY = before.y + before.height / 2;
    const dx = -30, dy = 20;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
    await page.mouse.up();

    const after = await pun.boundingBox();
    if (!after) throw new Error('no puncture bbox after drag');

    expect(Math.abs(after.x - before.x - dx)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y - dy)).toBeLessThan(2);
  });

  test('d slider 连续, cuts 跟着旋转', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.cut-line');

    const slider = page.locator('#d-slider-wrap input[type=range]');
    const cut0 = await page.locator('.cut-line').first().getAttribute('x2');
    await slider.fill('1.5'); // d = 1.5 rad
    await page.waitForTimeout(50);
    const cut1 = await page.locator('.cut-line').first().getAttribute('x2');
    expect(cut0).not.toBe(cut1);
  });
});
