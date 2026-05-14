// 主画布: SVG + D3, 渲染 punctures, cuts, paths, 交点.
// 核心交互: puncture 拖动, path vertex 拖动 (同伦类内).

import * as d3 from 'd3';
import type { VizState, ComplexNum, PathRep } from '../lib/types.js';
import { C, pathPathIntersections } from '../lib/geometry.js';

interface ViewBox { xMin: number; xMax: number; yMin: number; yMax: number; }

interface VertexData { pathId: string; idx: number; v: ComplexNum; }

export class Canvas {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private root: d3.Selection<SVGGElement, unknown, null, undefined>;
  private layers: {
    axes: d3.Selection<SVGGElement, unknown, null, undefined>;
    chambers: d3.Selection<SVGGElement, unknown, null, undefined>;
    cuts: d3.Selection<SVGGElement, unknown, null, undefined>;
    paths: d3.Selection<SVGGElement, unknown, null, undefined>;
    pathVerts: d3.Selection<SVGGElement, unknown, null, undefined>;
    intersections: d3.Selection<SVGGElement, unknown, null, undefined>;
    punctures: d3.Selection<SVGGElement, unknown, null, undefined>;
    overlay: d3.Selection<SVGGElement, unknown, null, undefined>;
  };
  private width = 800;
  private height = 600;
  private viewBox: ViewBox = { xMin: -2, xMax: 4, yMin: -1, yMax: 3.5 };
  private state: VizState;
  private onStateChange: (s: VizState) => void;
  // 当前显示的 d (连续, 不限 chamber 中心)
  private dCurrent: number = 0;
  // 计算进行中锁: true 时 puncture / path-vertex drag 都被拒.
  // 防止跟正在跑的 job 的 (U, A, m) 输入打架.
  private interactionLocked: boolean = false;
  private zoomBehavior!: d3.ZoomBehavior<SVGSVGElement, unknown>;
  /** Undo hook: 拖 puncture / path-vertex 前调一次, 让 main.ts 抓 snapshot. */
  public onDragStart: (() => void) | null = null;

  constructor(svgEl: SVGSVGElement, state: VizState, onStateChange: (s: VizState) => void) {
    this.svg = d3.select(svgEl);
    this.state = state;
    this.onStateChange = onStateChange;
    this.dCurrent = state.dataset.chambers[state.selectedChamber]?.d ?? 0;
    // 箭头不再用 SVG marker-end; renderPaths 自己用 <polygon> 画.

    this.root = this.svg.append('g').attr('class', 'root');
    this.layers = {
      axes: this.root.append('g').attr('class', 'layer-axes'),
      chambers: this.root.append('g').attr('class', 'layer-chambers'),
      cuts: this.root.append('g').attr('class', 'layer-cuts'),
      paths: this.root.append('g').attr('class', 'layer-paths'),
      pathVerts: this.root.append('g').attr('class', 'layer-path-verts'),
      intersections: this.root.append('g').attr('class', 'layer-intersections'),
      punctures: this.root.append('g').attr('class', 'layer-punctures'),
      overlay: this.root.append('g').attr('class', 'layer-overlay'),
    };

    // Zoom/pan: 滚轮缩放, 空白处左键拖动平移. 落在 puncture / path-vertex
    // 上的 mousedown 让 d3.drag 接管, zoom 不抢. 拖动时 root.transform 改,
    // 所有 drag 用 d3.pointer(event, this.root.node()) 取 root-local 坐标,
    // 自动撤销 zoom transform, 跟旧路径一致.
    this.zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 20])
      .filter((event: any) => {
        if (this.interactionLocked) return false;
        if (event.type === 'wheel') return true;
        if (event.button !== 0 && event.button !== undefined) return false;
        const target = event.target as Element;
        if (target && (target.closest('.puncture') || target.closest('.path-vertex'))) return false;
        return true;
      })
      .on('zoom', (event) => {
        this.root.attr('transform', event.transform.toString());
      });
    this.svg.call(this.zoomBehavior);
    this.svg.on('dblclick.zoom', null);  // 双击不 zoom-in (双击 puncture/vertex 有 drag, 干扰)

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setDirection(d: number) {
    this.dCurrent = d;
    this.renderCuts();
  }

  getDirection(): number { return this.dCurrent; }

  resetZoom() {
    this.svg.transition().duration(250).call(this.zoomBehavior.transform, d3.zoomIdentity);
  }

  setInteractionLocked(locked: boolean) {
    if (this.interactionLocked === locked) return;
    this.interactionLocked = locked;
    // 视觉提示: 整个 svg 加 class, CSS 改 cursor + 半透明.
    this.svg.classed('interaction-locked', locked);
  }

  isInteractionLocked(): boolean { return this.interactionLocked; }

  private resize() {
    const node = this.svg.node()!;
    const rect = node.parentElement!.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.svg.attr('viewBox', `0 0 ${this.width} ${this.height}`);
    this.fitViewBox();
    this.render();
  }

  private fitViewBox() {
    const ps = this.state.punctureOverrides ?? this.state.dataset.punctures;
    const pts: ComplexNum[] = [...ps];
    // 加进 dataset 第一个 chamber 的 path waypoints (代表性大绕路径).
    // 用所有 chamber 的会让 bbox 太大画面比例缩小; 完全不用又让 path-vertex
    // 飞出 viewport (e2e drag 测试 fail). 用一个 chamber 折衷.
    const ch0 = this.state.dataset.chambers[0];
    if (ch0) {
      for (const k of Object.keys(ch0.entries)) {
        const e = ch0.entries[k];
        if (e.path) for (const p of e.path) pts.push(p);
      }
    }
    const xs = pts.map(p => p.re), ys = pts.map(p => p.im);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const xPad = Math.max(1, (xMax - xMin) * 0.1);
    const yPad = Math.max(1, (yMax - yMin) * 0.1);
    this.viewBox = {
      xMin: xMin - xPad, xMax: xMax + xPad,
      yMin: yMin - yPad, yMax: yMax + yPad,
    };
    const svgAspect = this.width / this.height;
    const vbW = this.viewBox.xMax - this.viewBox.xMin;
    const vbH = this.viewBox.yMax - this.viewBox.yMin;
    const vbAspect = vbW / vbH;
    if (vbAspect > svgAspect) {
      const newH = vbW / svgAspect;
      const cy = (this.viewBox.yMin + this.viewBox.yMax) / 2;
      this.viewBox.yMin = cy - newH / 2;
      this.viewBox.yMax = cy + newH / 2;
    } else {
      const newW = vbH * svgAspect;
      const cx = (this.viewBox.xMin + this.viewBox.xMax) / 2;
      this.viewBox.xMin = cx - newW / 2;
      this.viewBox.xMax = cx + newW / 2;
    }
  }

  private toPx(c: ComplexNum): [number, number] {
    const x = (c.re - this.viewBox.xMin) / (this.viewBox.xMax - this.viewBox.xMin) * this.width;
    const y = this.height - (c.im - this.viewBox.yMin) / (this.viewBox.yMax - this.viewBox.yMin) * this.height;
    return [x, y];
  }
  private toPlane(px: number, py: number): ComplexNum {
    return {
      re: this.viewBox.xMin + (px / this.width) * (this.viewBox.xMax - this.viewBox.xMin),
      im: this.viewBox.yMin + ((this.height - py) / this.height) * (this.viewBox.yMax - this.viewBox.yMin),
    };
  }

  setState(s: VizState) {
    this.state = s;
    this.render();
  }

  render() {
    this.renderAxes();
    this.renderCuts();
    this.renderPaths();
    this.renderVertices();
    this.renderIntersections();
    this.renderPunctures();
  }

  private renderAxes() {
    const vb = this.viewBox;
    const layer = this.layers.axes;
    layer.selectAll('*').remove();
    // 实轴 y=0
    const xAxis = [
      this.toPx({ re: vb.xMin, im: 0 }),
      this.toPx({ re: vb.xMax, im: 0 }),
    ];
    layer.append('line').attr('class', 'axis-line')
      .attr('x1', xAxis[0][0]).attr('y1', xAxis[0][1])
      .attr('x2', xAxis[1][0]).attr('y2', xAxis[1][1]);
    // 虚轴 x=0
    const yAxis = [
      this.toPx({ re: 0, im: vb.yMin }),
      this.toPx({ re: 0, im: vb.yMax }),
    ];
    layer.append('line').attr('class', 'axis-line')
      .attr('x1', yAxis[0][0]).attr('y1', yAxis[0][1])
      .attr('x2', yAxis[1][0]).attr('y2', yAxis[1][1]);

    // 0, 1, i 三个 tick + label
    const ticks: Array<{ at: ComplexNum; label: string; offX: number; offY: number }> = [
      { at: { re: 0, im: 0 }, label: '0',  offX: -8,  offY: 12 },
      { at: { re: 1, im: 0 }, label: '1',  offX: 0,   offY: 14 },
      { at: { re: 0, im: 1 }, label: 'i',  offX: -10, offY: 4 },
    ];
    for (const t of ticks) {
      const [x, y] = this.toPx(t.at);
      layer.append('circle').attr('class', 'axis-tick')
        .attr('cx', x).attr('cy', y).attr('r', 1.5);
      layer.append('text').attr('class', 'axis-label')
        .attr('x', x + t.offX).attr('y', y + t.offY)
        .text(t.label);
    }
  }

  private renderCuts() {
    const ps = this.state.punctureOverrides ?? this.state.dataset.punctures;
    const d = this.dCurrent;
    const diag = Math.hypot(this.viewBox.xMax - this.viewBox.xMin, this.viewBox.yMax - this.viewBox.yMin) * 1.5;
    const dirVec = C.expI(-d);
    const lines = ps.map((u, k) => ({
      k,
      from: u,
      to: { re: u.re + dirVec.re * diag, im: u.im + dirVec.im * diag },
    }));
    this.layers.cuts.selectAll<SVGLineElement, typeof lines[0]>('line.cut-line')
      .data(lines, (d: any) => d.k)
      .join(
        enter => enter.append('line').attr('class', 'cut-line'),
        update => update,
        exit => exit.remove(),
      )
      .attr('x1', l => this.toPx(l.from)[0])
      .attr('y1', l => this.toPx(l.from)[1])
      .attr('x2', l => this.toPx(l.to)[0])
      .attr('y2', l => this.toPx(l.to)[1]);
  }

  private renderPaths() {
    const arr = Array.from(this.state.paths.values());
    // 箭头自己画 (path-arrow), 不用 marker-end. marker-end 在 cubic Bezier 末端
    // 切线方向偶尔跟 (b - c2) 不一致 (SVG 引擎实现细节), 截图里出现过箭头反向.
    // 自己算 (b - c2) 方向, 渲染 <polygon> 三角形, 完全可控.
    interface ArrowSpec {
      key: string;
      tipX: number;
      tipY: number;
      angle: number;  // radians, atan2(dy, dx) of tangent
    }
    const arrows: ArrowSpec[] = [];

    this.layers.paths.selectAll<SVGPathElement, PathRep>('path.path-line')
      .data(arr, (d: any) => d.homotopyId)
      .join(
        enter => enter.append('path').attr('class', 'path-line'),
        update => update,
        exit => exit.remove(),
      )
      .attr('d', p => {
        // 让箭头落在 puncture 边缘外 ~18px (留出 puncture 半径 + 箭头自身长度 + 余量).
        const pts = p.vertices.map(v => this.toPx(v));
        if (pts.length < 2) return null;
        const isNatural = p.homotopyId.includes(':std-natural-');
        // std-natural-cubic 多段 Bezier: vertices 长度 = 1 + 3·(N段), pattern: [a, c1, c2, b, c1', c2', b', ...]
        // 直线 (eg-line / std-natural-line): vertices = [a, b]
        // algo_wp 折线 (老 dataset.path): 任意长度 polyline
        let tipX: number, tipY: number, angle: number;
        if (isNatural && (pts.length - 1) % 3 === 0 && pts.length > 2) {
          // Bezier 多段: 取最后段 [c1, c2, b] 的 [c2, b] 算切线
          const last = pts[pts.length - 1];
          const c2 = pts[pts.length - 2];
          const dx = last[0] - c2[0], dy = last[1] - c2[1];
          const len = Math.hypot(dx, dy);
          if (len > 24) {
            pts[pts.length - 1] = [last[0] - dx / len * 14, last[1] - dy / len * 14];
          }
          tipX = pts[pts.length - 1][0];
          tipY = pts[pts.length - 1][1];
          angle = Math.atan2(dy, dx);  // 切线方向用 *原始* (b - c2), 跟 puncture shorten 无关
          let svg = `M${pts[0][0]},${pts[0][1]}`;
          for (let k = 1; k < pts.length; k += 3) {
            svg += ` C${pts[k][0]},${pts[k][1]} ${pts[k + 1][0]},${pts[k + 1][1]} ${pts[k + 2][0]},${pts[k + 2][1]}`;
          }
          arrows.push({ key: p.homotopyId, tipX, tipY, angle });
          return svg;
        }
        // 直线段或 algo_wp 折线
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        const dx = last[0] - prev[0], dy = last[1] - prev[1];
        const len = Math.hypot(dx, dy);
        if (len > 24) {
          pts[pts.length - 1] = [last[0] - dx / len * 14, last[1] - dy / len * 14];
        }
        tipX = pts[pts.length - 1][0];
        tipY = pts[pts.length - 1][1];
        angle = Math.atan2(dy, dx);
        arrows.push({ key: p.homotopyId, tipX, tipY, angle });
        return d3.line()(pts as any);
      });

    // 自己画箭头三角形, transform = translate + rotate.
    this.layers.paths.selectAll<SVGPolygonElement, ArrowSpec>('polygon.path-arrow')
      .data(arrows, (d: any) => d.key)
      .join(
        enter => enter.append('polygon').attr('class', 'path-arrow')
          .attr('points', '0,0 -8,-4 -8,4'),  // 尖端在 (0,0), 朝 +x; 长 8, 宽 8
        update => update,
        exit => exit.remove(),
      )
      .attr('transform', a => `translate(${a.tipX},${a.tipY}) rotate(${a.angle * 180 / Math.PI})`);

    // 起点大圆点
    this.layers.paths.selectAll<SVGCircleElement, PathRep>('circle.path-start-dot')
      .data(arr, (d: any) => d.homotopyId + '-start')
      .join(
        enter => enter.append('circle').attr('class', 'path-start-dot').attr('r', 4),
        update => update,
        exit => exit.remove(),
      )
      .attr('cx', p => this.toPx(p.vertices[0])[0])
      .attr('cy', p => this.toPx(p.vertices[0])[1]);
  }

  private renderVertices() {
    const arr = Array.from(this.state.paths.values());
    const verts: VertexData[] = [];
    arr.forEach(p => {
      // std/eg view 的自然路径 (homotopyId 含 'natural' 或 'eg-line') 是几何渲染,
      // vertices 是 Bezier 控制点不是同伦 waypoint, 不显示可拖 vertex.
      // 只有 algo_wp 折线 (老 dataset.path 路径) 才允许拖.
      if (p.homotopyId.includes('natural') || p.homotopyId.includes('eg-line')) return;
      for (let i = 1; i < p.vertices.length - 1; i++) {
        verts.push({ pathId: p.homotopyId, idx: i, v: p.vertices[i] });
      }
    });

    const dragBehavior = d3.drag<SVGCircleElement, VertexData>()
      .filter(() => !this.interactionLocked)
      .on('start', function (this: SVGCircleElement, _event, _d) {
        d3.select(this).classed('dragging', true);
      })
      .on('start.undo', () => { this.onDragStart?.(); })
      .on('drag', (event, d) => this.onVertexDrag(d, event))
      .on('end', function () { d3.select(this).classed('dragging', false); });

    const all = this.layers.pathVerts.selectAll<SVGCircleElement, VertexData>('circle.path-vertex')
      .data(verts, (d: any) => `${d.pathId}-${d.idx}`)
      .join(
        enter => enter.append('circle').attr('class', 'path-vertex').attr('r', 6),
        update => update,
        exit => exit.remove(),
      )
      .attr('cx', d => this.toPx(d.v)[0])
      .attr('cy', d => this.toPx(d.v)[1]);
    // 显式给所有 vertex (含 update) 重绑 drag — D3 idempotent
    all.call(dragBehavior);
  }

  private onVertexDrag(d: VertexData, event: d3.D3DragEvent<SVGCircleElement, VertexData, VertexData>) {
    const path = this.state.paths.get(d.pathId);
    if (!path) return;
    const [px, py] = d3.pointer(event.sourceEvent, this.root.node());
    const newPos = this.toPlane(px, py);
    // Phase 1: drag 期间放任 vertex 跟手, 不做 homotopy 检测
    // (扫掠三角形对高瘦 path 退化, false positive 太多;
    //  应该用 winding number 在 drag end 整体检测, Phase 1.5 加)
    path.vertices[d.idx] = newPos;
    d.v = newPos;
    // 只 update path 线和这个顶点, 不全 render
    this.renderPaths();
    this.renderVertices();
    this.renderIntersections();
    this.onStateChange(this.state);
  }

  private flashOffending(k: number) {
    const ps = this.state.punctureOverrides ?? this.state.dataset.punctures;
    const u = ps[k];
    const [px, py] = this.toPx(u);
    const flash = this.layers.overlay.append('circle')
      .attr('cx', px).attr('cy', py).attr('r', 12)
      .attr('fill', 'none').attr('stroke', '#ff5555').attr('stroke-width', 2)
      .attr('opacity', 1);
    flash.transition().duration(400).attr('r', 26).attr('opacity', 0).remove();
  }

  private renderIntersections() {
    const arr = Array.from(this.state.paths.values());
    const dots: ComplexNum[] = [];
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const xs = pathPathIntersections(arr[a].vertices, arr[b].vertices);
        for (const x of xs) dots.push(x.P);
      }
    }
    this.layers.intersections.selectAll<SVGCircleElement, ComplexNum>('circle.intersection-dot')
      .data(dots)
      .join(
        enter => enter.append('circle').attr('class', 'intersection-dot').attr('r', 4),
        update => update,
        exit => exit.remove(),
      )
      .attr('cx', d => this.toPx(d)[0])
      .attr('cy', d => this.toPx(d)[1]);
  }

  private renderPunctures() {
    const ps = this.state.punctureOverrides ?? this.state.dataset.punctures;
    const data = ps.map((p, k) => ({ k, p }));

    const dragBehavior = d3.drag<SVGCircleElement, typeof data[0]>()
      .filter(() => !this.interactionLocked)
      .on('start', function (this: SVGCircleElement, _event, _d) {
        d3.select(this).classed('dragging', true);
      })
      .on('start.undo', () => { this.onDragStart?.(); })
      .on('drag', (event, d) => this.onPunctureDrag(d.k, event))
      .on('end', function () { d3.select(this).classed('dragging', false); });

    const groups = this.layers.punctures.selectAll<SVGGElement, typeof data[0]>('g.puncture-group')
      .data(data, (d: any) => String(d.k))
      .join(
        enter => {
          const g = enter.append('g').attr('class', 'puncture-group');
          g.append('circle').attr('class', 'puncture').attr('r', 4).call(dragBehavior);
          g.append('text').attr('class', 'puncture-label').attr('dx', 8).attr('dy', -6);
          return g;
        },
        update => update,
        exit => exit.remove(),
      );

    groups.attr('transform', d => {
      const [x, y] = this.toPx(d.p);
      return `translate(${x}, ${y})`;
    });
    // u 用 italic + tspan 下标实现 u_k 数学风格 (SVG <text> 不能直接 KaTeX)
    groups.select<SVGTextElement>('text.puncture-label').each(function (d) {
      const t = d3.select(this);
      t.selectAll('*').remove();
      t.append('tspan').attr('font-style', 'italic').text('u');
      t.append('tspan').attr('baseline-shift', 'sub').attr('font-size', '0.75em').text(String(d.k + 1));
    });
  }

  private onPunctureDrag(k: number, event: d3.D3DragEvent<SVGCircleElement, any, any>) {
    const [px, py] = d3.pointer(event.sourceEvent, this.root.node());
    const newPos = this.toPlane(px, py);
    const ps = (this.state.punctureOverrides ?? this.state.dataset.punctures).map((p, i) =>
      i === k ? newPos : p);
    this.state.punctureOverrides = ps;
    // path 不动 — dataset 还没重算, 旧 path 的几何/数值都是旧 puncture 配置下的真相;
    // 改 path 端点会让几何跟数值脱节. 让 path 保留旧形 (视觉上指向旧 puncture 位置),
    // 等用户点 Recompute 拉新 dataset 再 refreshAllPaths.
    // main.ts 那边监听 onStateChange 标 stokesStale=true.
    this.renderCuts();
    this.renderPunctures();
    this.onStateChange(this.state);
  }
}
