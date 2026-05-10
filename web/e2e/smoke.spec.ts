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
    // 先把 d 设到 0.025π (chamber 1, (0,2) path 段数 3 含中间 vertex)
    const dInput = page.locator('#d-input');
    await dInput.fill('0.025');
    await dInput.press('Enter');
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
    await page.waitForSelector('.cut-line', { state: 'attached' });

    const getXY2 = async () => {
      const x = await page.locator('.cut-line').first().getAttribute('x2');
      const y = await page.locator('.cut-line').first().getAttribute('y2');
      return `${x},${y}`;
    };
    const cut0 = await getXY2();
    const dInput = page.locator('#d-input');
    await dInput.fill('0.3');  // 不是 ±π/2 倍数, 避免 cut 仍然垂直巧合
    await dInput.press('Enter');
    await page.waitForTimeout(50);
    const cut1 = await getXY2();
    expect(cut0).not.toBe(cut1);
  });

  test('输入框: 分数 + 自动选 k 区间', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    const dInput = page.locator('#d-input');
    const slider = page.locator('#d-slider-wrap input[type=range]');

    // 默认 d = -0.5 π, k = -1, range [-2π, 0]
    expect(await dInput.inputValue()).toBe('-0.5');
    expect(Number(await slider.getAttribute('min'))).toBeCloseTo(-2 * Math.PI, 4);
    expect(Number(await slider.getAttribute('max'))).toBeCloseTo(0, 4);

    // 输入 "1/3" → π/3, k=0, range [0, 2π]
    await dInput.fill('1/3');
    await dInput.press('Enter');
    expect(Number(await slider.inputValue())).toBeCloseTo(Math.PI / 3, 4);
    expect(Number(await slider.getAttribute('min'))).toBeCloseTo(0, 4);
    expect(Number(await slider.getAttribute('max'))).toBeCloseTo(2 * Math.PI, 4);

    // 输入 "2.3" → 2.3π, k=1, range [2π, 4π]
    await dInput.fill('2.3');
    await dInput.press('Enter');
    expect(Number(await slider.getAttribute('min'))).toBeCloseTo(2 * Math.PI, 4);
    expect(Number(await slider.getAttribute('max'))).toBeCloseTo(4 * Math.PI, 4);

    // 无效输入还原
    await dInput.fill('abc');
    await dInput.press('Enter');
    expect(await dInput.inputValue()).toBe('2.3');
  });
});
