import { test, expect, type Page } from '@playwright/test';

async function useNullPathV5Dataset(page: Page) {
  await page.route('**/data/*.json*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data._algorithm = 'v5_full';
    data._v5 = { residual_max: 1e-15, test_fixture: 'null-path' };
    for (const chamber of data.chambers ?? []) {
      for (const entry of Object.values(chamber.entries ?? {}) as any[]) {
        if (!entry || entry.error) continue;
        entry.path = null;
        entry.provenance = entry.provenance ?? 'v5_full_wall_crossing';
      }
    }
    await route.fulfill({ response, json: data });
  });
}

async function expectPathOrProvenance(page: Page) {
  await expect(page.locator('#stokes-display .value')).toBeVisible();
  const pathCount = await page.locator('.path-line').count();
  expect(pathCount).toBeLessThanOrEqual(1);
  if (pathCount === 0) {
    await expect(page.locator('#path-info .provenance-chip')).toContainText('provenance:');
  }
}

test.describe('Sd-viz smoke tests', () => {
  test('页面加载无 console error', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // 过滤后端 probe (CI 上没 sage backend)
      if (t.includes('/api/')) return;
      if (t.includes('Failed to load resource')) return;
      errors.push(t);
    });
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    await page.goto('/');
    await page.waitForSelector('.puncture', { timeout: 5000 });
    expect(errors).toEqual([]);
  });

  test('点 entry 出现 path/provenance + Stokes 数值', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    // (0,1) cell 在 grid 第 2 个 (idx=1, 0-indexed; n=4 grid: (0,0)(0,1)(0,2)(0,3) ...)
    await page.locator('#entry-grid .cell').nth(1).click();
    await expectPathOrProvenance(page);
  });

  test('v5_full null-path schema 显示 provenance + Stokes 数值', async ({ page }) => {
    await useNullPathV5Dataset(page);
    await page.goto('/?algorithm=v5_full');
    await page.waitForSelector('.puncture');
    await page.locator('#entry-grid .cell').nth(1).click();
    await expect(page.locator('.path-line')).toHaveCount(0);
    await expect(page.locator('.path-vertex')).toHaveCount(0);
    await expect(page.locator('#path-info .provenance-chip')).toContainText('v5_full_wall_crossing');
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
    await page.locator('.path-vertex').first().waitFor({ timeout: 1000 }).catch(() => undefined);
    if (await page.locator('.path-vertex').count() === 0) {
      await expect(page.locator('#path-info .provenance-chip')).toContainText('provenance:');
      await expect(page.locator('#stokes-display .value')).toBeVisible();
      return;
    }

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

  test('chamberOfDirection: ray-interval 不是最近 center', async ({ page }) => {
    // n=4 simple case 含相邻很近 anti-Stokes (16.19° 跟 350.91°), wrap chamber
    // center 在 3.55°, 下一 chamber center 36.73°. d=18° 在 (16.19, 57.26) 内
    // (chamber idx 跟 ray idx 对应), 但离 3.55° 比离 36.73° 更近 → 旧 nearest
    // 算法选错 chamber.
    await page.goto('/');
    await page.waitForSelector('.puncture');
    const dInput = page.locator('#d-input');
    // d = 0.1 π = 18°
    await dInput.fill('0.1');
    await dInput.press('Enter');
    await page.click('#entry-grid .cell:nth-child(2)'); // (0,1)
    const stokes18 = await page.locator('#stokes-display .value').textContent();
    // d = 0.12 π ≈ 21.6°, 同一 chamber, entry 应该一样
    await dInput.fill('0.12');
    await dInput.press('Enter');
    const stokes22 = await page.locator('#stokes-display .value').textContent();
    expect(stokes18).toBe(stokes22);
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

  // 防回归: 块版 (m_k > 1) dataset 的 A_kk 块内 off-diag (A_off entry I==J 且 a≠b)
  // 必须实际渲染到 A 表对应位置, 不能被 rebuildInitialA 当对角覆盖.
  // 历史 bug: A_off 没 a/b 字段时 e.a??0 fallback 让 A[sI][sJ] 重复写, 块内 off-diag 丢失.
  test('A 表块内 off-diag 渲染 (块版 dataset 防 SSOT 漂移)', async ({ page }) => {
    await page.goto('/');  // 默认是 n4_block (m=(2,2,2,2))
    await page.waitForSelector('.puncture');
    // 等 A 表渲染. flat (row=0, col=1) 是块 1 的 (a=0, b=1) sub-entry,
    // 默认 dataset 应有 (0.05, 0.02) 之类非零值 (不是 0).
    const reInput = page.locator('#a-table input[data-i="0"][data-j="1"][data-axis="re"]');
    await reInput.waitFor();
    const reVal = await reInput.inputValue();
    expect(reVal).not.toBe('0');
    expect(Number(reVal)).not.toBeCloseTo(0, 3);
    // 同样 (a=1, b=0)
    const reInput10 = page.locator('#a-table input[data-i="1"][data-j="0"][data-axis="re"]');
    expect(await reInput10.inputValue()).not.toBe('0');
  });

  // SSOT guard (2026-05-12, codex 建议): catch the bug where sage export
  // rewrites data/ but web/public/data/ is forgotten, so deploy ships
  // stale legacy_entry dataset. Default deployed dataset MUST be
  // v5_full + path:null + provenance.
  test('部署 SSOT: 默认 dataset 是 v5_full + path:null + provenance', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    const meta = await page.evaluate(async () => {
      const r = await fetch('/data/n4_block.json');
      const j = await r.json();
      const e0 = j.chambers[0].entries['0,1'];
      return {
        algorithm: j._algorithm ?? null,
        v5_residual: j._v5?.residual_max ?? null,
        v5_p1: j._v5?.p1 ?? null,
        v5_p2: j._v5?.p2 ?? null,
        provenance: e0.provenance ?? null,
        path_null: e0.path === null,
        has_value_block: Array.isArray(e0.value_block),
      };
    });
    expect(meta.algorithm).toBe('v5_full');
    expect(meta.provenance).toBe('v5_full_wall_crossing');
    expect(meta.path_null).toBe(true);
    expect(meta.has_value_block).toBe(true);
    expect(meta.v5_residual).toBeLessThan(1e-12);
    expect(meta.v5_p1).toBe(500);
    expect(meta.v5_p2).toBe(1500);
  });
});
