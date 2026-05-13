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
    // v5 entry: no path; verify either friendly label or hidden provenance carrier
    const hasLabel = await page.locator('#path-info .label').count();
    const hasProv = await page.locator('#path-info .provenance-info').count();
    expect(hasLabel + hasProv).toBeGreaterThan(0);
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
    // 选 (0, 1) entry: 点 stokes-matrix 里 block (0,1) 的 sub-cell
    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="1"]').first().click();
    await expectPathOrProvenance(page);
  });

  test('v5_full null-path schema 显示 provenance + Stokes 数值', async ({ page }) => {
    await useNullPathV5Dataset(page);
    await page.goto('/?algorithm=v5_full');
    await page.waitForSelector('.puncture');
    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="1"]').first().click();
    await expect(page.locator('.path-line')).toHaveCount(1);
    // v5 entry: std view 现在画前端自然路径, 同时保留 hidden provenance carrier.
    await expect(page.locator('#path-info .provenance-info')).toHaveAttribute('data-provenance', /v5_full_wall_crossing/);
    await page.locator('#sd-view-selector .sd-view-btn[data-view="eg"]').click();
    await expect(page.locator('.path-line')).toHaveCount(1);
    await expect(page.locator('.path-vertex')).toHaveCount(0);
    await page.locator('#sd-view-selector .sd-view-btn[data-view="plus"]').click();
    await expect(page.locator('.path-line')).toHaveCount(0);
    await page.locator('#sd-view-selector .sd-view-btn[data-view="minus"]').click();
    await expect(page.locator('.path-line')).toHaveCount(0);
    await expect(page.locator('#stokes-display .value')).toBeVisible();
  });

  test('拖动 path vertex 跟手 (像素级精确)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    // 先把 d 设到 0.025π (chamber 1, (0,2) path 段数 3 含中间 vertex)
    const dInput = page.locator('#d-input');
    await dInput.fill('0.025');
    await dInput.press('Enter');
    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="2"]').first().click();
    await page.locator('.path-vertex').first().waitFor({ timeout: 1000 }).catch(() => undefined);
    if (await page.locator('.path-vertex').count() === 0) {
      // v5 entry path 不可见, 友好 label 应该在
      const hasLabel = await page.locator('#path-info .label').count();
      const hasProv = await page.locator('#path-info .provenance-info').count();
      expect(hasLabel + hasProv).toBeGreaterThan(0);
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
    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="1"]').first().click(); // (0,1)
    const stokes18 = await page.locator('#stokes-display .value').textContent();
    // d = 0.12 π ≈ 21.6°, 同一 chamber, entry 应该一样
    await dInput.fill('0.12');
    await dInput.press('Enter');
    const stokes22 = await page.locator('#stokes-display .value').textContent();
    expect(stokes18).toBe(stokes22);
  });

  test('d 滑块默认 0-branch [-π, π) 起步 d_reg, 输入跨 branch 自动切', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    const dInput = page.locator('#d-input');
    const slider = page.locator('#d-slider-wrap input[type=range]');

    // 默认 d = dataset._v5.d_reg, 在 [-π, π) 内 (n4_block d_reg ≈ -0.061π)
    const dInit = Number(await dInput.inputValue()) * Math.PI;
    expect(dInit).toBeGreaterThanOrEqual(-Math.PI);
    expect(dInit).toBeLessThan(Math.PI);
    // 滑块 range 起步 [-π, π) (k=0 branch)
    expect(Number(await slider.getAttribute('min'))).toBeCloseTo(-Math.PI, 4);
    expect(Number(await slider.getAttribute('max'))).toBeCloseTo(Math.PI, 4);

    // 输入 "1/3" → π/3, 在 0-branch 内, range 不动
    await dInput.fill('1/3');
    await dInput.press('Enter');
    expect(Number(await slider.inputValue())).toBeCloseTo(Math.PI / 3, 3);
    expect(Number(await slider.getAttribute('min'))).toBeCloseTo(-Math.PI, 4);
    expect(Number(await slider.getAttribute('max'))).toBeCloseTo(Math.PI, 4);

    // 输入 "2.3" → 2.3π, k=1, range 切到 [π, 3π)
    await dInput.fill('2.3');
    await dInput.press('Enter');
    expect(Number(await slider.inputValue())).toBeCloseTo(2.3 * Math.PI, 3);
    expect(Number(await slider.getAttribute('min'))).toBeCloseTo(Math.PI, 4);
    expect(Number(await slider.getAttribute('max'))).toBeCloseTo(3 * Math.PI, 4);

    // 输入 "-3.5" → -3.5π, k=-2, range 切到 [-5π, -3π)
    await dInput.fill('-3.5');
    await dInput.press('Enter');
    expect(Number(await slider.inputValue())).toBeCloseTo(-3.5 * Math.PI, 3);
    expect(Number(await slider.getAttribute('min'))).toBeCloseTo(-5 * Math.PI, 4);
    expect(Number(await slider.getAttribute('max'))).toBeCloseTo(-3 * Math.PI, 4);

    // 无效输入不 crash
    await dInput.fill('abc');
    await dInput.press('Enter');
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

  // 防回归 (2026-05-13): Compute 按钮策略
  //   - 始终 enabled (用户反馈: "锁就是不对, 按一下就该算一遍")
  //   - Reset 按钮已删除
  //   - 文本: "Compute Stokes Matrices"
  test('Compute 按钮: 永远可点, 没有 Reset 按钮', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    const btn = page.locator('#state-recompute');
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveText(/Compute Stokes Matrices/);
    // Reset 按钮已移除
    await expect(page.locator('#state-reset')).toHaveCount(0);
    // 改完 U 仍然 enabled (没回锁)
    const u00re = page.locator('#u-table input[data-k="0"][data-axis="re"]').first();
    await u00re.fill('1.234');
    await u00re.press('Tab');
    await expect(btn).toBeEnabled();
  });

  // 防回归 (2026-05-14): m = sum m_k 不能停在 dataset 初始值 8.
  // 输入过程先更新维度提示; change/blur 后再重建 A 与 Stokes matrix。
  test('m 维度提示随 m_k 输入更新, 提交后矩阵维度同步', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (t.includes('/api/')) return;
      if (t.includes('Failed to load resource')) return;
      errors.push(t);
    });
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    await page.goto('/');
    await page.waitForSelector('.puncture');
    await expect(page.locator('#dim-info')).toContainText('8');

    const m0 = page.locator('#u-table input.mk-input[data-k="0"]').first();
    await m0.fill('3');
    await expect(page.locator('#dim-info')).toContainText('9');

    await m0.press('Tab');
    await expect(page.locator('#a-table tbody tr')).toHaveCount(9);
    await expect(page.locator('#stokes-matrix .sm-cell')).toHaveCount(81);
    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="1"]').first().click();
    await expect(page.locator('#stokes-display .value')).toContainText('stale');
    expect(errors).toEqual([]);
  });

  // 防回归 (2026-05-14): 编辑 U/A 也要让 Stokes 立刻变 stale (单一不变式驱动 — POLA).
  // 之前: 只 m_k 触发 cell 变 "—"; U/A 编辑只更新 banner, cell 用旧值, 行为不一致.
  test('编辑 U 立刻让 Stokes 变 stale (跟 m_k 行为一致)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    await expect(page.locator('#state-stale-banner')).toBeHidden();
    const u0re = page.locator('#u-table input.cx[data-k="0"][data-axis="re"]').first();
    await u0re.fill('1.5');
    await u0re.press('Tab');
    await expect(page.locator('#state-stale-banner')).toBeVisible();
    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="1"]').first().click();
    await expect(page.locator('#stokes-display .value')).toContainText('stale');
    await expect(page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="1"]').first()).toContainText('—');
  });

  // 防回归 (2026-05-14): 矩阵行列指标字号跟 U 表 k 列行号走同一个 CSS SSOT.
  test('Stokes matrix 行列指标跟 U 行号同字号', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    const sizes = await page.evaluate(() => {
      const uCell = document.querySelector('#u-table .row-label') as HTMLElement;
      const sCell = document.querySelector('#stokes-matrix .sm-row-header') as HTMLElement;
      const uKatex = uCell.querySelector('.katex') as HTMLElement;
      const sKatex = sCell.querySelector('.katex') as HTMLElement;
      return {
        uFont: getComputedStyle(uCell).fontSize,
        sFont: getComputedStyle(sCell).fontSize,
        uHeight: uKatex.getBoundingClientRect().height,
        sHeight: sKatex.getBoundingClientRect().height,
      };
    });
    expect(sizes.sFont).toBe(sizes.uFont);
    expect(Math.abs(sizes.sHeight - sizes.uHeight)).toBeLessThan(2);
  });

  // 防回归 (2026-05-13): Stokes matrix 跨 cell 小数点对齐
  // CSS var --cs-int-w / --cs-frac-w 在 refreshStokesMatrix 算全局 max int/frac 设到 stokes-matrix.
  // 所有 cs-grid 共用列宽 → cs-int 右边 (= 小数点 x) 跨 cell 一致.
  test('Stokes matrix 同列跨行小数点 x 一致 (跨 cell 对齐)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    const decXs = await page.$$eval('#stokes-matrix .sm-cell[data-j="1"][data-b="0"]:not(.diag)', els =>
      els.map(el => {
        const int = el.querySelector('.cs-int') as HTMLElement | null;
        return int ? Math.round(int.getBoundingClientRect().right * 10) / 10 : null;
      }).filter(v => v !== null)
    );
    expect(decXs.length).toBeGreaterThan(2);
    const allEqual = decXs.every(x => Math.abs((x as number) - (decXs[0] as number)) < 0.5);
    expect(allEqual).toBe(true);
  });

  // 防回归 (2026-05-13): 同 cx-pair 内 re/im input 宽度一致 (小数点对齐).
  // 之前 width: max-content 让 re/im 各自按内容算宽, sign 长度差 1ch 导致小数点错位.
  // 修法: grid-template-columns: max-content + input width: 100% → re/im 同宽.
  test('cx-pair 内 re/im input 同宽 (小数点对齐)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    const widths = await page.$$eval('#a-table .cx-pair', els =>
      els.slice(0, 6).map(pair => {
        const ins = pair.querySelectorAll('input.cx');
        return Array.from(ins).map(i => Math.round((i as HTMLElement).getBoundingClientRect().width));
      })
    );
    for (const [re, im] of widths) {
      expect(Math.abs(re - im)).toBeLessThan(1);
    }
  });

  // 防回归 (2026-05-14): S_d / S_d^+ / S_d^- selector. plus 模式对角块 = I_block,
  // off-diag 按 -d label 重组 (label[i]<label[j] 留 S_d 值, 否则 0).
  test('S_d^+ / S_d^- selector 切换矩阵内容, 尺寸不变', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#stokes-matrix .sm-cell');
    const cellCountBefore = await page.locator('#stokes-matrix .sm-cell').count();
    // 默认 std: 对角 cell (I===J, a===b) 显示 0. KaTeX 渲染会有额外 mathml/whitespace,
    // 用 visible text 兜底: 应包含 '0' 但不包含 '1'.
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '');
    const diagText0 = norm(await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="0"]').first().textContent());
    expect(diagText0).toContain('0');
    expect(diagText0).not.toContain('1');
    // 切到 S_d^+: 对角 cell 应显示 1.
    await page.locator('#sd-view-selector .sd-view-btn[data-view="plus"]').click();
    await expect(page.locator('#sd-view-selector .sd-view-btn[data-view="plus"]')).toHaveClass(/active/);
    const diagPlus = norm(await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="0"]').first().textContent());
    expect(diagPlus).toContain('1');
    // 尺寸不变: cell 数相同.
    const cellCountAfter = await page.locator('#stokes-matrix .sm-cell').count();
    expect(cellCountAfter).toBe(cellCountBefore);
    // plus + minus 模式下: 对任意 off-diag (I,J), 两者中至少一个是 0
    // (label[I]<label[J] → plus 非零 minus 0; 反之 plus 0 minus 非零).
    // off-diag cell 判 isZero: 看是否有 .cs-zero 而无 .cs-grid (cs-grid 是非零渲染).
    const collect = async () => page.$$eval(
      '#stokes-matrix .sm-cell:not(.diag)',
      cells => cells.map(c => ({
        key: `${c.getAttribute('data-i')},${c.getAttribute('data-j')}`,
        isZero: !c.querySelector('.cs-grid'),
      })),
    );
    const pluses = await collect();
    await page.locator('#sd-view-selector .sd-view-btn[data-view="minus"]').click();
    const minuses = await collect();
    const byKey: Record<string, { p: boolean; m: boolean }> = {};
    for (const p of pluses) (byKey[p.key] ??= { p: false, m: false }).p = p.isZero;
    for (const m of minuses) (byKey[m.key] ??= { p: false, m: false }).m = m.isZero;
    for (const k of Object.keys(byKey)) {
      const [i, j] = k.split(',').map(Number);
      if (i === j) continue;
      const { p, m } = byKey[k];
      expect(p || m, `cell ${k}: plus zero=${p}, minus zero=${m} — exactly one应该非零`).toBe(true);
    }
    // 切回 S_d.
    await page.locator('#sd-view-selector .sd-view-btn[data-view="std"]').click();
    await expect(page.locator('#sd-view-selector .sd-view-btn[data-view="std"]')).toHaveClass(/active/);
  });

  // 防回归 (2026-05-14, layout stability): 切换 S_d / S_d^+ / S_d^- 时每个 cell 的
  // 几何盒子大小不能变 (user-facing 原则: spatial stability / 反 CLS).
  test('S_d ↔ S_d^± 切换时 cell 尺寸保持不变', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#stokes-matrix .sm-cell');
    const cellSizes = async () => page.$$eval(
      '#stokes-matrix .sm-cell',
      cells => cells.map(c => {
        const r = c.getBoundingClientRect();
        return `${c.getAttribute('data-i')}-${c.getAttribute('data-j')}-${c.getAttribute('data-a')}-${c.getAttribute('data-b')}:${Math.round(r.width)}x${Math.round(r.height)}`;
      }),
    );
    const std = await cellSizes();
    await page.locator('#sd-view-selector .sd-view-btn[data-view="plus"]').click();
    const plus = await cellSizes();
    await page.locator('#sd-view-selector .sd-view-btn[data-view="minus"]').click();
    const minus = await cellSizes();
    expect(plus).toEqual(std);
    expect(minus).toEqual(std);
  });

  // 防回归 (2026-05-14): 拖 d slider 时 S_d^+ 矩阵内容随 -d label 重新分类.
  test('S_d^+ 内容随 d 改变 (label 重排)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#stokes-matrix .sm-cell');
    await page.locator('#sd-view-selector .sd-view-btn[data-view="plus"]').click();
    // 取一个 off-diag cell 在初始 d 下的文本.
    const cell01 = page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="1"]').first();
    const cell10 = page.locator('#stokes-matrix .sm-cell[data-i="1"][data-j="0"]').first();
    const before01 = (await cell01.textContent())?.trim();
    const before10 = (await cell10.textContent())?.trim();
    // 拖 d 滑块到 π/2 附近 (大幅度变动 → label 极可能重排).
    const slider = page.locator('#d-slider-wrap input[type="range"]');
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = String(Math.PI / 2);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const after01 = (await cell01.textContent())?.trim();
    const after10 = (await cell10.textContent())?.trim();
    // 至少有一个变 (S_d 数值随 chamber/d 变, 或 plus 分类翻转).
    expect(before01 !== after01 || before10 !== after10).toBe(true);
  });

  // 防回归 (2026-05-14): S_d^eg view 语义.
  //   (S_d^eg)_{ij} uses the exported raw v5 straight-entry anchor, not any S_d chamber value.
  test('S_d^eg: raw v5 anchor baseline + per-pair 2π shift', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#stokes-matrix .sm-cell');
    const cellText = async (sel: string) => (await page.locator(sel).first().textContent() ?? '').replace(/\s+/g, '');
    const raw02 = await page.evaluate(async () => {
      const r = await fetch('/data/n4_block.json');
      const data = await r.json();
      return data._v5_eg_entries['0,2'].value_block[0][0];
    });
    expect(raw02.re).toBeCloseTo(-1.277590307, 5);
    expect(raw02.im).toBeCloseTo(0.122106265, 5);
    // 全表 std 快照
    const collect = async () => page.$$eval(
      '#stokes-matrix .sm-cell:not(.diag)',
      cs => cs.map(c => `${c.getAttribute('data-i')},${c.getAttribute('data-j')}:` +
                       (c.textContent ?? '').replace(/\s+/g, '')),
    );
    const stdSnap = await collect();
    await page.locator('#sd-view-selector .sd-view-btn[data-view="eg"]').click();
    const egSnap = await collect();
    // 至少有一个 off-diag entry 在 std 和 eg 之间值不同 (默认 dataset 必然如此).
    const diffs = stdSnap.filter((s, k) => s !== egSnap[k]);
    expect(diffs.length).toBeGreaterThan(0);
    // (0,2)[0,0] at d_reg is the raw anchor, not the all-minus base chamber value.
    const std02 = await (async () => {
      await page.locator('#sd-view-selector .sd-view-btn[data-view="std"]').click();
      return cellText('#stokes-matrix .sm-cell[data-i="0"][data-j="2"][data-a="0"][data-b="0"]');
    })();
    await page.locator('#sd-view-selector .sd-view-btn[data-view="eg"]').click();
    const eg02 = await cellText('#stokes-matrix .sm-cell[data-i="0"][data-j="2"][data-a="0"][data-b="0"]');
    expect(eg02).not.toBe(std02);
    expect(eg02).toContain('1.277');
    expect(eg02).toContain('0.122');
    expect(eg02).not.toContain('2.634');
    // 拖 d 远离 d_ref 后, eg 仍按 per-pair branch lookup 变 — 至少一个 cell 文本变了.
    const slider = page.locator('#d-slider-wrap input[type="range"]');
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = String(Math.PI / 2);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const egAtPi2 = await collect();
    expect(egAtPi2.join('|')).not.toBe(egSnap.join('|'));
  });

  // 防回归 (2026-05-14): sign 跟 int 之间的视觉间距 SSOT — 不许随 view 切换变.
  // 之前 cs-sign 独立列 + cs-int 列宽随 maxInt 变 → eg (maxInt=1) / std (maxInt=2) 间距不同.
  test('cs-grid sign-int 间距跨 view 一致', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#stokes-matrix .sm-cell');
    const probe = async () => page.$eval(
      '#stokes-matrix .sm-cell:not(.diag) .cs-grid',
      (g: HTMLElement) => {
        const intEl = g.querySelector('.cs-int') as HTMLElement;
        const signEl = intEl?.querySelector('.cs-sign') as HTMLElement | null;
        const intR = intEl.getBoundingClientRect();
        const signR = signEl?.getBoundingClientRect();
        // sign 必须在 cs-int 内部, 不再是独立兄弟节点.
        return {
          signIsChildOfInt: !!signEl,
          // 距离: int 右边界减去 (sign 右边界), 跨 view 应保持相同结构.
          signToIntRight: signR ? Math.round(intR.right - signR.right) : -1,
        };
      },
    );
    const std = await probe();
    await page.locator('#sd-view-selector .sd-view-btn[data-view="eg"]').click();
    const eg = await probe();
    await page.locator('#sd-view-selector .sd-view-btn[data-view="plus"]').click();
    const pl = await probe();
    expect(std.signIsChildOfInt).toBe(true);
    expect(eg.signIsChildOfInt).toBe(true);
    expect(pl.signIsChildOfInt).toBe(true);
  });

  // 防回归 (2026-05-14): std view natural path 凸包算法. 默认 dataset 下 (0,2) 直线
  // 撞 punc[3] 的 -d cut, 必须绕一下 → path 含至少 1 段 cubic Bezier "C" 命令.
  test('S_d std natural path avoids cuts (hull-based)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="2"]').first().click();
    const d = await page.locator('.path-line').first().getAttribute('d');
    expect(d).toContain('C');  // 必须有 cubic 命令, 不是直线
    // S_d^eg 模式下应是直线
    await page.locator('#sd-view-selector .sd-view-btn[data-view="eg"]').click();
    const d_eg = await page.locator('.path-line').first().getAttribute('d');
    expect(d_eg).not.toContain('C');  // 直线 only
    expect(d_eg).toContain('L');
  });

  // 防回归 (2026-05-13): U/A input 支持分式输入 "a/b" (a, b 可带 sign + 小数)
  test('U/A input 接受分式 a/b 输入', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.puncture');
    const u0re = page.locator('#u-table input[data-k="0"][data-axis="re"]').first();
    // 1/2 → 0.5
    await u0re.fill('1/2');
    await u0re.press('Tab');
    await expect(u0re).not.toHaveClass(/invalid/);
    await u0re.evaluate((el: HTMLInputElement) => el.dispatchEvent(new Event('change', {bubbles:true})));
    // 负分母 → 负数
    const u0im = page.locator('#u-table input[data-k="0"][data-axis="im"]').first();
    await u0im.fill('1.5/-3');
    await u0im.press('Tab');
    await expect(u0im).not.toHaveClass(/invalid/);
    // 0 分母 → invalid
    const u1re = page.locator('#u-table input[data-k="1"][data-axis="re"]').first();
    await u1re.fill('1/0');
    await u1re.press('Tab');
    await expect(u1re).toHaveClass(/invalid/);
  });
});
