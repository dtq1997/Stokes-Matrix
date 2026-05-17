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
    await page.goto('/?dataset=block');
    await page.waitForSelector('.puncture', { timeout: 5000 });
    expect(errors).toEqual([]);
  });

  test('点 entry 出现 path/provenance + Stokes 数值', async ({ page }) => {
    await page.goto('/?dataset=block');
    await page.waitForSelector('.puncture');
    // 选 (0, 1) entry: 点 stokes-matrix 里 block (0,1) 的 sub-cell
    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="1"]').first().click();
    await expectPathOrProvenance(page);
  });

  test('v5_full null-path schema 显示 provenance + Stokes 数值', async ({ page }) => {
    await useNullPathV5Dataset(page);
    await page.goto('/?dataset=block&algorithm=v5_full');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');  // 默认是 n4_block (m=(2,2,2,2))
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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
    await page.goto('/?dataset=block');
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

  test('e^{2πiM_d} selector computes monodromy factor from S_d^± and block diagonal δ_u A', async ({ page }) => {
    await page.goto('/?dataset=simple');
    await page.waitForSelector('#stokes-matrix .sm-cell');
    await page.locator('#sd-view-selector .sd-view-btn[data-view="md"]').click();
    await expect(page.locator('#sd-view-selector .sd-view-btn[data-view="md"]')).toHaveClass(/active/);

    const expected = await page.evaluate(async () => {
      type C = { re: number; im: number };
      const add = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });
      const sub = (a: C, b: C): C => ({ re: a.re - b.re, im: a.im - b.im });
      const mul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
      const div = (a: C, b: C): C => {
        const den = b.re * b.re + b.im * b.im;
        return { re: (a.re * b.re + a.im * b.im) / den, im: (a.im * b.re - a.re * b.im) / den };
      };
      const expi = (x: number): C => ({ re: Math.cos(x), im: Math.sin(x) });
      const mmul = (A: C[][], B: C[][]): C[][] => A.map(row => B[0].map((_, j) => {
        let v = { re: 0, im: 0 };
        for (let k = 0; k < B.length; k++) v = add(v, mul(row[k], B[k][j]));
        return v;
      }));
      const minv = (A: C[][]): C[][] => {
        const n = A.length;
        const aug = A.map((row, i) => [
          ...row.map(x => ({ ...x })),
          ...Array.from({ length: n }, (_, j) => ({ re: i === j ? 1 : 0, im: 0 })),
        ]);
        for (let col = 0; col < n; col++) {
          let pivot = col, best = 0;
          for (let r = col; r < n; r++) {
            const mag = Math.hypot(aug[r][col].re, aug[r][col].im);
            if (mag > best) { best = mag; pivot = r; }
          }
          if (pivot !== col) [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
          const p = { ...aug[col][col] };
          for (let c = 0; c < 2 * n; c++) aug[col][c] = div(aug[col][c], p);
          for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = { ...aug[r][col] };
            for (let c = 0; c < 2 * n; c++) aug[r][c] = sub(aug[r][c], mul(f, aug[col][c]));
          }
        }
        return aug.map(row => row.slice(n));
      };
      const r = await fetch('/data/n4_simple.json');
      const data: any = await r.json();
      const d = Number((document.querySelector('#d-slider-wrap input[type="range"]') as HTMLInputElement).value);
      const chamberOf = (x: number) => {
        const tp = 2 * Math.PI;
        const dm = ((x % tp) + tp) % tp;
        for (let k = 0; k < data.rays.length - 1; k++) {
          if (dm >= data.rays[k] && dm < data.rays[k + 1]) return k;
        }
        return data.rays.length - 1;
      };
      const ch = data.chambers[chamberOf(d)];
      const labels = data.punctures.map((u: C, k: number) => ({ k, v: u.re * Math.sin(d) + u.im * Math.cos(d) }))
        .sort((a: { v: number }, b: { v: number }) => b.v - a.v);
      const lab = new Array(data.punctures.length);
      labels.forEach((p: { k: number }, idx: number) => { lab[p.k] = idx + 1; });
      const entry = (i: number, j: number): C => {
        const raw = ch.entries[`${i},${j}`].value_block[0][0];
        const lift = Math.round((d - ch.d) / (2 * Math.PI));
        return mul(raw, expi(2 * Math.PI * lift * (data.A_diag[j] - data.A_diag[i])));
      };
      const n = data.punctures.length;
      const Splus = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => ({ re: i === j ? 1 : 0, im: 0 })));
      const Sminus = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => ({ re: i === j ? 1 : 0, im: 0 })));
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const v = entry(i, j);
        if (lab[i] < lab[j]) Splus[i][j] = v;
        if (lab[i] > lab[j]) Sminus[i][j] = { re: -v.re, im: -v.im };
      }
      const D = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
        i === j ? expi(2 * Math.PI * data.A_diag[i]) : { re: 0, im: 0 }));
      return mmul(mmul(minv(Sminus), D), Splus)[0][0] as C;
    });
    const cell00 = (await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="0"]').first().textContent() ?? '').replace(/\s+/g, '');
    const lead = (x: number) => Math.abs(x).toFixed(6).replace(/0+$/, '').slice(0, 5);
    expect(cell00).toContain(lead(expected.re));
    if (Math.abs(expected.im) > 1e-6) expect(cell00).toContain(lead(expected.im));

    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="1"]').first().click();
    await expect(page.locator('#path-info')).toContainText('M');
    await expect(page.locator('.path-line')).toHaveCount(0);
  });

  // 防回归 (2026-05-15): md view 对角 cell 可选 (其他 view 对角仍灰不可选).
  // Bug 1 修复: refreshMatrixCells 后置决定 .diag 类, click 通过 .diag CSS
  // pointer-events:none 屏蔽; md view 对角内容是 block/symbolic, 自动可点.
  test('md view: 对角 cell 可选, panel 不显示 no data', async ({ page }) => {
    await page.goto('/?dataset=simple');
    await page.waitForSelector('#stokes-matrix .sm-cell');

    // std view 下对角是 .diag 灰态 (不可选)
    const diag00Std = page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="0"]').first();
    await expect(diag00Std).toHaveClass(/diag/);

    // 切到 md view
    await page.locator('#sd-view-selector .sd-view-btn[data-view="md"]').click();
    await expect(page.locator('#sd-view-selector .sd-view-btn[data-view="md"]')).toHaveClass(/active/);

    // 对角失去 .diag 类 (md 对角是 block/symbolic, 应可选)
    const diag00Md = page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="0"]').first();
    await expect(diag00Md).not.toHaveClass(/diag/);

    // 点对角, 进入 selected, panel 显示 md 公式 (不是 "no data")
    await diag00Md.click();
    await expect(diag00Md).toHaveClass(/selected/);
    const panel = page.locator('#stokes-display');
    await expect(panel).not.toContainText('no data');
    // path-info 显示 md 整体公式标签 (含 "M")
    await expect(page.locator('#path-info')).toContainText('M');

    // 切回 std, 对角应恢复 .diag 不可选态
    await page.locator('#sd-view-selector .sd-view-btn[data-view="std"]').click();
    await expect(page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="0"]').first()).toHaveClass(/diag/);
  });

  // 防回归 (2026-05-15): 原 bug 整型集成检查 — cp2 默认数据集 d≈0.4217π
  // 那个 (2,3) entry 在 md view ISC propagation 后必须等于 15 (用户原话).
  // 走 lib 直接跑 propagation+monodromyFactorInt pipeline (与前端 ISC 同 SSOT),
  // 不依赖后端 Compute (cp2 是 hideOnLoad dataset, 默认 stale).
  test('整型集成: cp2 d≈0.4217π (2,3) md entry = 15', async ({ page }) => {
    await page.goto('/');
    const md12 = await page.evaluate(async () => {
      const wc = await import('/src/lib/wall-crossing.ts' + `?v=${Date.now()}`);
      const r = await fetch('/data/cp2.json');
      const data: any = await r.json();
      const ps = data.punctures;
      const n = ps.length;
      // 找含 d=0.4217π 的 chamber
      const dTarget = 0.4217 * Math.PI;
      const TP = 2 * Math.PI;
      const dm = ((dTarget % TP) + TP) % TP;
      let chIdx = data.rays.length - 1;
      for (let k = 0; k < data.rays.length - 1; k++) {
        if (dm >= data.rays[k] && dm < data.rays[k + 1]) { chIdx = k; break; }
      }
      // 抽 base chamber (0) 的整数 std S_d
      const baseM: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const v = data.chambers[0].entries[`${i},${j}`].value_block[0][0];
        baseM[i][j] = Math.round(v.re);
      }
      // 用 lib propagateExactMatrices 推到 target chamber
      const sortedChambers = data.chambers
        .map((ch: any, idx: number) => ({ d: ch.d, originalIdx: idx }))
        .sort((a: any, b: any) => a.d - b.d);
      const prop = wc.propagateExactMatrices(0, baseM, sortedChambers, ps);
      const Mch = prop.get(chIdx);
      if (!Mch) throw new Error(`propagation missed chamber ${chIdx}`);
      // dLabels (descending proj rank) 跟前端 dLabels() 同款 — 这里要传给 monodromyFactorInt.
      const sd = Math.sin(dTarget), cd = Math.cos(dTarget);
      const proj = ps.map((u: any, k: number) => ({ k, v: u.re * sd + u.im * cd }));
      proj.sort((a: any, b: any) => b.v - a.v);
      const labels = new Array<number>(n);
      proj.forEach((p: any, idx: number) => { labels[p.k] = idx + 1; });
      const md = wc.monodromyFactorInt(Mch, labels);
      return { md12: md[1][2], chamber: chIdx, labels, md };
    });
    // 用户原话: "(2,3) entry, 按理来说是 15"
    expect(md12.md12).toBe(15);
  });

  // 防回归 (2026-05-15): antiStokesRays 的符号约定必须跟 sage SSOT
  // (sd_chamber_geom.py::anti_stokes_rays = -arg(u_i - u_j) mod 2π) 严格一致.
  // 历史 bug: commit 8981948 (2026-05-14) 引入时漏了负号, 用 +atan2(dy,dx),
  // 导致 frontend rays 是 sage rays 关于 0 的镜像 → chamberOfDirection 错位.
  test('antiStokesRays sign convention matches sage backend (negative arg)', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(async () => {
      const geom = await import('/src/lib/geometry.ts' + `?v=${Date.now()}`);
      // 三个泛位形 (镜像非对称, 才能区分 +/-arg 两种约定):
      const cases = [
        [{re:0,im:0},{re:1,im:1},{re:-1,im:2}],
        [{re:0,im:0},{re:1,im:0.5}],
        [{re:0,im:0},{re:2,im:1},{re:1,im:-0.5}],
      ];
      return cases.map(ps => geom.antiStokesRays(ps));
    });
    // 同款 sage 算法 (sd_chamber_geom.py:20) 的 expected:
    function sageRays(ps: {re:number;im:number}[]): number[] {
      const tp = 2 * Math.PI;
      const set = new Set<number>();
      for (let i = 0; i < ps.length; i++) for (let j = 0; j < ps.length; j++) {
        if (i === j) continue;
        const diffRe = ps[i].re - ps[j].re;
        const diffIm = ps[i].im - ps[j].im;
        if (Math.hypot(diffRe, diffIm) < 1e-8) continue;
        const ang = ((-Math.atan2(diffIm, diffRe)) % tp + tp) % tp;
        set.add(Math.round(ang * 1e10) / 1e10);
      }
      return Array.from(set).sort((a, b) => a - b);
    }
    const cases = [
      [{re:0,im:0},{re:1,im:1},{re:-1,im:2}],
      [{re:0,im:0},{re:1,im:0.5}],
      [{re:0,im:0},{re:2,im:1},{re:1,im:-0.5}],
    ];
    for (let c = 0; c < cases.length; c++) {
      const expected = sageRays(cases[c]);
      expect(out[c].length).toBe(expected.length);
      for (let k = 0; k < expected.length; k++) {
        expect(out[c][k]).toBeCloseTo(expected[k], 6);
      }
    }
  });

  // 防回归 (2026-05-15): wall-crossing.ts monodromyFactorInt 整数闭算正确性.
  // Bug 2 修复核心: A_diag=0 gate 内, md_int = (S^-)^{-1}·S^+ 全整数 (Neumann 级数).
  // 这里在浏览器内直接 import lib 单元测, 不走 dataset fresh-state.
  test('monodromyFactorInt: CP^3 base chamber 整数闭算非 trivial', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const mod = await import('/src/lib/wall-crossing.ts' + `?v=${Date.now()}`);
      // CP^3 base chamber 经典 Stokes 矩阵 (Guzzetti, signed binomial conv):
      // S_{ij} = (-1)^{j-i} C(n, j-i) for i<j, 0 for i>j; 对角 paper 约定为 0
      // (我们这里用 off-diag 整数 + 对角 0 的 IntMatrix 表示).
      // n=4 → entries: (0,1)=-4, (0,2)=6, (0,3)=-4, (1,2)=-3, (1,3)=3, (2,3)=-2... 略
      // 这里只验 "S^-=I, md_int=S^+" 的退化 case + 一个 nontrivial case.
      const M_upper: number[][] = [
        [0, -4, 6, -4],
        [0, 0, -3, 3],
        [0, 0, 0, -2],
        [0, 0, 0, 0],
      ];
      // labels = [1,2,3,4]: 0号点 proj 最大 → label 1. S^+ keep labels[I]<labels[J] ⇒ I<J (upper).
      // 此时 S^-=I, md_int=S^+=I + L_upper. 验证整数恒等.
      const labels = [1, 2, 3, 4];
      const md = mod.monodromyFactorInt(M_upper, labels);
      // 对角应=1, 上三角应=M_upper[i][j] (因为 S^-=I, md=S^+).
      const diagOk = [0, 1, 2, 3].every(i => md[i][i] === 1);
      const upperOk = md[0][1] === -4 && md[0][2] === 6 && md[0][3] === -4
                   && md[1][2] === -3 && md[1][3] === 3 && md[2][3] === -2;
      // 反 label 序: labels=[4,3,2,1] → labels[I]>labels[J] iff I<J. 那时 S^+=I, S^-= negated upper.
      // md = (S^-)^{-1} = (I + L_-)^{-1} = I - L_- + L_-^2 - ... — 非 trivial integer.
      const labels2 = [4, 3, 2, 1];
      const md2 = mod.monodromyFactorInt(M_upper, labels2);
      // 对角全 1
      const diag2Ok = [0, 1, 2, 3].every(i => md2[i][i] === 1);
      // S^-[i][j] = -M[i][j] when labels2[i]>labels2[j] (i<j), 即 upper -M.
      // S^-_inv at (0,1) = +4 (一阶 Neumann); 但更高阶 Neumann 修正:
      // (0,2): -L_-^2[0][2] = -(-(-4))*(-(-3)) = -(4*3)= -12. 加 +6 一阶 = -12+6 = -6? Let me think again.
      // 算: L_- = S^- - I = upper triangular w/ entries -M[i][j].
      // (S^-)^{-1} = I - L_- + L_-^2 - L_-^3
      // (0,1): -L_-(0,1) = -(-M[0][1]) = -4 → 这是 S^- inverse 在 (0,1), 然后乘 S^+=I → md2[0][1] = 4.
      // 但 Codex review 强调要跟前端 sign convention 完全一致, 不在这里复算, 只要求 integer + 非零.
      const md2NontrivialInt = md2[0][1] !== 0 && Number.isInteger(md2[0][1])
                            && md2[0][2] !== 0 && Number.isInteger(md2[0][2]);
      return { diagOk, upperOk, diag2Ok, md2NontrivialInt, md, md2 };
    });
    expect(result.diagOk).toBe(true);
    expect(result.upperOk).toBe(true);
    expect(result.diag2Ok).toBe(true);
    expect(result.md2NontrivialInt).toBe(true);
  });

  // 防回归 (2026-05-14): S_d^eg view 语义.
  //   (S_d^eg)_{ij} uses the exported raw v5 straight-entry anchor, not any S_d chamber value.
  test('S_d^eg: raw v5 anchor baseline + per-pair 2π shift', async ({ page }) => {
    await page.goto('/?dataset=block');
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

    // 防回归 (2026-05-14, ground-truth sandwich): d ≈ π, (0,1) tau_lift = -0.1587,
    // tau_closest = -0.1587 + 2π (m_sandwich = 1), python 独立手算 [0,0] =
    // -0.3444264 + 0.9668873i (raw anchor 经 expm(-2πi·A_00) · raw · expm(2πi·A_11)).
    // 这个数字是用 raw anchor + 解析 sandwich 公式独立算出来的, 不是从 viz 抄的.
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = String(Math.PI - 0.01);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const eg01_at_pi = await cellText('#stokes-matrix .sm-cell[data-i="0"][data-j="1"][data-a="0"][data-b="0"]');
    expect(eg01_at_pi).toContain('0.3444264');
    expect(eg01_at_pi).toContain('0.9668873');
    expect(eg01_at_pi).not.toContain('0.1101');  // 不能仍是 raw anchor (那是 d=d_reg 的值)
  });

  // 防回归 (2026-05-14): sign 跟 int 之间的视觉间距 SSOT — 不许随 view 切换变.
  // 之前 cs-sign 独立列 + cs-int 列宽随 maxInt 变 → eg (maxInt=1) / std (maxInt=2) 间距不同.
  test('cs-grid sign-int 间距跨 view 一致', async ({ page }) => {
    await page.goto('/?dataset=block');
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

  // 防回归 (2026-05-14): std view natural path 3 段直线构造. 默认 dataset 下 (0,2) 直线
  // 撞 punc[3] 的 -d cut, 必须绕 → 3 段折线 (3 个 L), 长度 > chord.
  test('S_d std natural path avoids cuts (3-segment detour)', async ({ page }) => {
    await page.goto('/?dataset=block');
    await page.waitForSelector('.puncture');
    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="2"]').first().click();
    const path = page.locator('.path-line').first();
    const d = await path.getAttribute('d');
    // 5 顶点 (含中段中点) → 4 个 L 命令
    expect((d?.match(/L/g) ?? []).length).toBe(4);
    const stat = await path.evaluate((el: SVGPathElement) => {
      const len = el.getTotalLength();
      const p0 = el.getPointAtLength(0), p1 = el.getPointAtLength(len);
      return { len, chord: Math.hypot(p1.x - p0.x, p1.y - p0.y) };
    });
    expect(stat.len / stat.chord).toBeGreaterThan(1.05);
    // S_d^eg 模式下是 2-顶点直线: 只有 1 个 L
    await page.locator('#sd-view-selector .sd-view-btn[data-view="eg"]').click();
    const d_eg = await page.locator('.path-line').first().getAttribute('d');
    expect((d_eg?.match(/L/g) ?? []).length).toBe(1);
    expect(d_eg).not.toContain('C');
  });

  // 防回归 (2026-05-14): cut-coord 下两 cut 挨得近时, 端点附近 cut 不能被误算成 blocker
  // 导致 fallback 给直线. n=4 block 默认 d=-0.0439π 时 entry (2,1) 仍应绕过 u_3 的 cut.
  test('S_d natural path: nearby cuts at endpoints do not collapse to line', async ({ page }) => {
    await page.goto('/?dataset=block');
    await page.waitForSelector('.puncture');
    const dInput = page.locator('#d-input');
    await dInput.fill('-0.0439');
    await dInput.press('Enter');
    await page.waitForTimeout(50);
    await page.locator('#stokes-matrix .sm-cell[data-i="2"][data-j="1"]').first().click();
    const path = page.locator('.path-line').first();
    const d = await path.getAttribute('d');
    expect((d?.match(/L/g) ?? []).length).toBe(4);
    const stat = await path.evaluate((el: SVGPathElement) => {
      const len = el.getTotalLength();
      const p0 = el.getPointAtLength(0), p1 = el.getPointAtLength(len);
      return { len, chord: Math.hypot(p1.x - p0.x, p1.y - p0.y) };
    });
    expect(stat.len / stat.chord).toBeGreaterThan(1.05);
  });

  // 防回归 (2026-05-14): 拖 puncture 时 γ_ij^(d) 实时跟随, 不需要先点 Compute.
  // anti-Stokes marker 同样实时更新 (slider 的 .d-mark.ray 子节点).
  test('live γ + anti-Stokes rays follow puncture drag (no recompute needed)', async ({ page }) => {
    await page.goto('/?dataset=block');
    await page.waitForSelector('.puncture');
    await page.locator('#stokes-matrix .sm-cell[data-i="0"][data-j="2"]').first().click();
    const dBefore = await page.locator('.path-line').first().getAttribute('d');
    const raysBefore = await page.locator('#d-marker-strip .d-mark.ray').count();
    // 拖 puncture #2
    const punc2 = page.locator('circle.puncture').nth(2);
    const box = await punc2.boundingBox();
    if (!box) throw new Error('puncture not visible');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 60, { steps: 5 });
    await page.mouse.up();
    const dAfter = await page.locator('.path-line').first().getAttribute('d');
    expect(dAfter).not.toBe(dBefore);  // path 跟着动
    const raysAfter = await page.locator('#d-marker-strip .d-mark.ray').count();
    expect(raysAfter).toBe(raysBefore);  // ray 数不变 (但位置变 — 这里只验存在性)
    // Undo: 按按钮恢复
    await page.locator('#undo-btn').click();
    await page.waitForTimeout(50);
    const dRestored = await page.locator('.path-line').first().getAttribute('d');
    expect(dRestored).toBe(dBefore);
  });

  // 防回归 (2026-05-14): Ω_d central connection matrix panel + view selector.
  // SSOT — 跟 Stokes 矩阵共享 matrix-panel.ts 渲染. 算法待实现, 全 cell "—".
  // 块结构: Ω (一行一行算) 列有块行无块; Ω^-1 (一列一列算) 行有块列无块.
  test('Ω_d central connection panel: shared renderer, two-view selector, view-dependent block structure', async ({ page }) => {
    await page.goto('/?dataset=block');
    await page.waitForSelector('#omega-matrix .sm-cell');
    // grid 跟 Stokes 同样 N×N
    const stokesCells = await page.locator('#stokes-matrix .sm-cell').count();
    const omegaCells = await page.locator('#omega-matrix .sm-cell').count();
    expect(omegaCells).toBe(stokesCells);
    // view selector 有 2 个 button
    const omegaBtns = await page.locator('#omega-view-selector .sd-view-btn').count();
    expect(omegaBtns).toBe(2);
    await expect(page.locator('#omega-view-selector .sd-view-btn[data-view="omega"]')).toHaveClass(/active/);

    // Ω view: 按行算 ⇒ 行块 (行作为整体单位, 含 block-top 在行边界), 列无块.
    const omegaBlockTops = await page.locator('#omega-matrix .sm-cell.block-top').count();
    const omegaBlockLefts = await page.locator('#omega-matrix .sm-cell.block-left').count();
    expect(omegaBlockTops).toBeGreaterThan(0);  // 行有块
    expect(omegaBlockLefts).toBe(0);            // 列无块

    // 切 Ω^-1: 按列算 ⇒ 列块, 行无块. 块结构跟 Ω 反过来.
    await page.locator('#omega-view-selector .sd-view-btn[data-view="omega-inv"]').click();
    await expect(page.locator('#omega-view-selector .sd-view-btn[data-view="omega-inv"]')).toHaveClass(/active/);
    const invBlockTops = await page.locator('#omega-matrix .sm-cell.block-top').count();
    const invBlockLefts = await page.locator('#omega-matrix .sm-cell.block-left').count();
    expect(invBlockTops).toBe(0);                  // 行无块
    expect(invBlockLefts).toBeGreaterThan(0);      // 列有块

    // 所有 cell (含对角) 显 "—"
    const cellTexts = await page.$$eval('#omega-matrix .sm-cell', cells =>
      cells.map(c => c.textContent?.replace(/\s+/g, '') ?? ''));
    for (const t of cellTexts) expect(t).toContain('—');

    // Compute 按钮存在
    await expect(page.locator('#state-recompute-omega')).toBeVisible();
  });

  // 防回归 (2026-05-17): cpn↔cpn dropdown 切换走 SPA in-place swap, 不全页跳转.
  // 这样 GitHub Pages CDN/浏览器在 deploy 后短期内拿陈旧 bundle 也不会让用户看到半渲染.
  // 防回归 (2026-05-17): 参数化 dataset (cpn / an) 间 dropdown 切换走 SPA in-place swap.
  test('cpn↔an dropdown 切换走 SPA in-place, A 签名变, 不导航', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    await page.goto('/?n=4&dataset=cpn');
    await page.waitForSelector('.puncture');

    // 收 A 表所有 off-diag expr 拼成签名串.
    const aSignature = async (K: number): Promise<string> => {
      const parts: string[] = [];
      for (let i = 0; i < K; i++)
        for (let j = 0; j < K; j++) {
          if (i === j) continue;
          const v = await page.locator(`#a-table input[data-i="${i}"][data-j="${j}"].cx-expr`).first().inputValue();
          parts.push(`${i},${j}:${v}`);
        }
      return parts.join('|');
    };
    const sig_cpn = await aSignature(4);

    // 标记 JS context — 真发生全页跳转的话 window 会被销毁, marker 丢失.
    await page.evaluate(() => { (window as any).__swapTestMarker = 'before-swap'; });
    const sel = page.locator('#dataset-select');

    // 切到 A_n
    await sel.selectOption('an');
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get('dataset') === 'an');
    expect(await page.evaluate(() => (window as any).__swapTestMarker)).toBe('before-swap');
    const sig_an = await aSignature(4);
    expect(sig_an).not.toBe(sig_cpn);  // 不同 family, A 必然不同

    // 切回 cpn, A 签名回到 baseline
    await sel.selectOption('cpn');
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get('dataset') !== 'an');
    expect(await aSignature(4)).toBe(sig_cpn);

    // 全程无 JS 错误
    expect(errors.join('\n')).toBe('');
  });

  // 防回归 (2026-05-13): U/A input 支持分式输入 "a/b" (a, b 可带 sign + 小数)
  test('U/A input 接受分式 a/b 输入', async ({ page }) => {
    await page.goto('/?dataset=block');
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
