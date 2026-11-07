/**
 * 铁血山河 · 中国近代战争与解放战争全史舆图 (1931—1958) 核心交互控制器
 * 实现核心功能：
 * 1. 拖时间轴看天下分合 + 左下角政权/军队装备/人数/要塞舰队图例 + 朱砂色虚线残影
 * 2. 点任意城池或重大战役弹出「溯源」卡片（1931—1958全编年、事件概述、战争规模，点击即跳回当年）
 * 3. 点人溯事（毛泽东、蒋介石、彭德怀、林彪、粟裕、朱德、周恩来、薛岳、孙立人、山本五十六、东条英机、艾森豪威尔等动态行迹）
 * 4. 彩蛋：舆图寻址小试（十道题盲猜落针，按距离计分封衔，最高封「大元帅」）
 * 5. 多功能精准视图缩放（初始 100% 全图视野 + 缩放滑块/按钮/战区聚焦）
 * 6. 内置史诗录屏工坊（支持时间线演进、指定人物移动路径、指定战役事件推演、自由操作高清视频录制导出）
 */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. 墨卡托投影仪（与 jiangshan-map 地形浮雕及省界坐标 100% 严丝合缝对齐）
  // ═══════════════════════════════════════════════════════════════════════════
  class MercatorProjector {
    constructor(width, height, bounds) {
      this.width = width;
      this.height = height;
      this.west = bounds.west;
      this.east = bounds.east;
      this.south = bounds.south;
      this.north = bounds.north;
      this.mercSouth = this._latToMercY(this.south);
      this.mercNorth = this._latToMercY(this.north);
    }

    _latToMercY(lat) {
      const clamped = Math.max(-85, Math.min(85, lat));
      const rad = (clamped * Math.PI) / 180;
      return Math.log(Math.tan(Math.PI / 4 + rad / 2));
    }

    _mercYToLat(y) {
      return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
    }

    project(coord) {
      const [lon, lat] = coord;
      const x = ((lon - this.west) / (this.east - this.west)) * this.width;
      const mercY = this._latToMercY(lat);
      const y = ((this.mercNorth - mercY) / (this.mercNorth - this.mercSouth)) * this.height;
      return [Number(x.toFixed(2)), Number(y.toFixed(2))];
    }

    unproject(x, y) {
      const lon = this.west + (x / this.width) * (this.east - this.west);
      const mercY = this.mercNorth - (y / this.height) * (this.mercNorth - this.mercSouth);
      const lat = this._mercYToLat(mercY);
      return [Number(lon.toFixed(3)), Number(lat.toFixed(3))];
    }

    ringToPath(ring, closed = true) {
      if (!ring || !ring.length) return '';
      const pts = ring.map((pt) => this.project(pt));
      let d = `M${pts[0][0]},${pts[0][1]}`;
      for (let i = 1; i < pts.length; i++) {
        d += `L${pts[i][0]},${pts[i][1]}`;
      }
      if (closed) d += 'Z';
      return d;
    }

    geometryToPath(shape) {
      if (!shape || !shape.coordinates) return '';
      if (shape.type === 'Polygon') {
        return shape.coordinates.map((r) => this.ringToPath(r, true)).join('');
      }
      if (shape.type === 'MultiPolygon') {
        return shape.coordinates
          .map((poly) => poly.map((r) => this.ringToPath(r, true)).join(''))
          .join('');
      }
      return '';
    }

    greatCircleKm(a, b) {
      const R = 6371;
      const dLat = ((b[1] - a[1]) * Math.PI) / 180;
      const dLon = ((b[0] - a[0]) * Math.PI) / 180;
      const lat1 = (a[1] * Math.PI) / 180;
      const lat2 = (b[1] * Math.PI) / 180;
      const sinLat = Math.sin(dLat / 2);
      const sinLon = Math.sin(dLon / 2);
      const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. 主地图应用控制器
  // ═══════════════════════════════════════════════════════════════════════════
  class WarAtlasController {
    constructor() {
      this.projector = new MercatorProjector(1000, 700, {
        west: 66,
        east: 142,
        south: 14,
        north: 55
      });

      this.periods = window.WAR_PERIODS || [];
      this.cities = window.WAR_CITIES || [];
      this.persons = window.WAR_PERSONS || {};
      this.quizPool = window.WAR_QUIZ_POOL || [];
      this.snapshots = window.ATLAS_SNAPSHOTS || {};

      // 将 8 大时期下的所有阶段展平为线性时间轴节点列表
      this.allPhases = [];
      this.periods.forEach((p, pIdx) => {
        (p.phases || []).forEach((ph) => {
          this.allPhases.push({
            ...ph,
            periodId: p.id,
            periodIdx: pIdx,
            periodName: p.name,
            periodShort: p.shortName,
            periodSpan: p.span
          });
        });
      });

      // 展平所有重大战役与历史事件供录屏工坊及检索使用
      this.allEvents = [];
      this.periods.forEach((p, pIdx) => {
        (p.milestones || []).forEach((ms) => {
          this.allEvents.push({
            ...ms,
            periodId: p.id,
            periodIdx: pIdx,
            periodName: p.name
          });
        });
      });

      // 状态管理
      this.currentPhaseIdx = 0;
      this.prevSnapshotKey = null;
      this.showRoutes = true;
      this.showGhostDiff = true;
      this.showTerrain = true;

      // 初始视图：100% 完整全图视野 (x: 0, y: 0, k: 1.0)
      this.cam = { x: 0, y: 0, k: 1.0 };
      this.camAnimFrame = null;
      this.isDragging = false;
      this.dragStartClient = { x: 0, y: 0 };
      this.dragStartSvg = { x: 0, y: 0 };

      // 点人溯事状态
      this.activePerson = null;
      this.journeyStopIdx = 0;
      this.journeyTimer = null;

      // 点地/战役溯源高亮状态
      this.activeHighlight = null;

      // 舆图寻址小试状态
      this.quizState = {
        active: false,
        questions: [],
        idx: 0,
        score: 0,
        candidateCoord: null,
        answered: false
      };

      // 录屏工坊状态
      this.recorderState = {
        active: false,
        mode: 'timeline', // 'timeline' | 'person' | 'event' | 'free'
        mediaRecorder: null,
        chunks: [],
        canvas: null,
        ctx: null,
        rafId: null,
        stepTimer: null,
        startTime: 0,
        titleTag: '',
        subtitleBanner: null,
        arcProgress: 1.0,
        arcAnimStart: 0
      };

      // 预加载地形浮雕图供 Canvas 录屏合成使用
      this.terrainImage = new Image();
      this.terrainImageReady = false;
      this.terrainImage.onload = () => {
        this.terrainImageReady = true;
      };
      this.terrainImage.src = 'assets/terrain_relief.webp';

      // 缓存静态省界与水系路径供 SVG 与录屏 Canvas 共用
      this.cachedProvincePaths = [];
      this.cachedLakePaths = [];
      this.cachedRiverPaths = [];
      this.currentGhostDiffPaths = [];
      this.currentGhostLabel = null;

      this._cacheDom();
      this._initStaticLayers();
      this._initScrubberUI();
      this._initRecorderStudioUI();
      this._bindEvents();

      // 默认加载第 0 阶段（1931 九一八事变），并以 100% 全图呈现
      this.selectPhaseByIndex(0, { initial: true });
      this.resetCameraView(false);
    }

    _cacheDom() {
      this.svg = document.getElementById('atlas-svg');
      this.viewport = document.getElementById('viewport-frame');
      this.mapCanvas = document.getElementById('map-canvas');

      this.grpTerrain = document.getElementById('grp-terrain');
      this.grpNeighbors = document.getElementById('grp-neighbors');
      this.grpPolities = document.getElementById('grp-polities');
      this.grpProvinces = document.getElementById('grp-provinces');
      this.grpRivers = document.getElementById('grp-rivers');
      this.grpGhost = document.getElementById('grp-ghost-diff');
      this.grpCorridors = document.getElementById('grp-corridors');
      this.grpFortsFleets = document.getElementById('grp-forts-fleets');
      this.grpSettlements = document.getElementById('grp-settlements');
      this.grpMilestones = document.getElementById('grp-milestones');
      this.grpJourney = document.getElementById('grp-journey');
      this.grpGenealogy = document.getElementById('grp-genealogy');
      this.grpChallenge = document.getElementById('grp-challenge');

      this.hdrYear = document.getElementById('hdr-year-text');
      this.hdrStage = document.getElementById('hdr-stage-name');
      this.inpSearch = document.getElementById('inp-map-search');
      this.suggestBox = document.getElementById('search-suggest-box');

      // 缩放控件
      this.inpZoomSlider = document.getElementById('inp-zoom-slider');
      this.zoomPctLabel = document.getElementById('zoom-pct-label');
      this.navZoomText = document.getElementById('nav-zoom-text');

      this.mapKey = document.getElementById('map-key');
      this.mapKeyBody = document.getElementById('map-key-body');

      this.genCard = document.getElementById('genealogy-card');
      this.genKicker = document.getElementById('gen-kicker');
      this.genTitle = document.getElementById('gen-title');
      this.genTagline = document.getElementById('gen-tagline');
      this.genOverview = document.getElementById('gen-overview');
      this.genList = document.getElementById('gen-timeline-list');

      this.jrnCard = document.getElementById('journey-card');
      this.jrnName = document.getElementById('jrn-name');
      this.jrnRole = document.getElementById('jrn-role');
      this.jrnPlace = document.getElementById('jrn-stop-place');
      this.jrnCounter = document.getElementById('jrn-stop-counter');
      this.jrnQuote = document.getElementById('jrn-stop-quote');
      this.jrnNote = document.getElementById('jrn-stop-note');
      this.inpJrnStep = document.getElementById('inp-journey-step');
      this.btnJrnPlay = document.getElementById('btn-jrn-play');

      this.quizCard = document.getElementById('challenge-card');
      this.quizProgress = document.getElementById('quiz-progress-text');
      this.quizScore = document.getElementById('quiz-score-text');
      this.quizRankPreview = document.getElementById('quiz-rank-preview');
      this.quizClue = document.getElementById('quiz-clue-text');
      this.quizFeedback = document.getElementById('quiz-feedback-box');
      this.quizFinal = document.getElementById('quiz-final-box');
      this.btnQuizConfirm = document.getElementById('btn-quiz-confirm');
      this.btnQuizNext = document.getElementById('btn-quiz-next');

      // 录屏工坊 DOM
      this.recCard = document.getElementById('recorder-card');
      this.recLivePill = document.getElementById('recording-live-pill');
      this.recLiveStatus = document.getElementById('rec-live-status');
      this.recTlStart = document.getElementById('rec-tl-start');
      this.recTlEnd = document.getElementById('rec-tl-end');
      this.recTlSpeed = document.getElementById('rec-tl-speed');
      this.recPersonSelect = document.getElementById('rec-person-select');
      this.recPersonSpeed = document.getElementById('rec-person-speed');
      this.recEventSelect = document.getElementById('rec-event-select');
      this.recEventDuration = document.getElementById('rec-event-duration');
      this.btnRecStart = document.getElementById('btn-rec-start');
      this.btnRecStop = document.getElementById('btn-rec-stop');

      this.paneEraSpan = document.getElementById('pane-era-span');
      this.paneEraTitle = document.getElementById('pane-era-title');
      this.panePhaseCaption = document.getElementById('pane-phase-caption');
      this.paneBody = document.getElementById('pane-scroll-body');

      this.inpTimeline = document.getElementById('inp-timeline-range');
      this.dockSyncBanner = document.getElementById('dock-sync-banner');
      this.phasePillsStrip = document.getElementById('phase-pills-strip');
      this.periodBlocksBar = document.getElementById('period-blocks-bar');
      this.tooltip = document.getElementById('map-tooltip');
    }

    _el(tag, attrs = {}, text = null) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== null && v !== undefined) node.setAttribute(k, String(v));
      }
      if (text !== null) node.textContent = text;
      return node;
    }

    // ─── 初始化静态底图层（山川浮雕、水系、现代省界参考） ───
    _initStaticLayers() {
      const img = this._el('image', {
        href: 'assets/terrain_relief.webp',
        x: 0,
        y: 0,
        width: 1000,
        height: 700,
        preserveAspectRatio: 'none',
        opacity: '0.46'
      });
      this.grpTerrain.appendChild(img);

      const provs = window.PROVINCE_OUTLINES || [];
      provs.forEach((p) => {
        if (!p.rings || !p.rings.length) return;
        const d = p.rings.map((r) => this.projector.ringToPath(r, true)).join('');
        if (d) {
          this.cachedProvincePaths.push(d);
          this.grpProvinces.appendChild(this._el('path', { d, class: 'province-ref-path' }));
        }
      });

      const hydro = window.HYDRO_DATA || { rivers: [], lakes: [] };
      (hydro.lakes || []).forEach((lk) => {
        const d = this.projector.ringToPath(lk.ring, true);
        if (d) {
          this.cachedLakePaths.push(d);
          this.grpRivers.appendChild(this._el('path', { d, class: 'lake-path' }));
        }
      });
      (hydro.rivers || []).forEach((rv) => {
        const d = this.projector.ringToPath(rv.path, false);
        if (d) {
          this.cachedRiverPaths.push({ d, rank: rv.rank });
          this.grpRivers.appendChild(
            this._el('path', {
              d,
              class: 'river-path',
              'stroke-width': rv.rank === 1 ? '1.5' : '0.95'
            })
          );
        }
      });

      this._applyCameraTransform();
    }

    // ─── 初始化底部时间轴与节点胶囊 ───
    _initScrubberUI() {
      this.inpTimeline.max = String(this.allPhases.length - 1);

      this.phasePillsStrip.innerHTML = '';
      this.allPhases.forEach((ph, idx) => {
        const btn = document.createElement('button');
        btn.className = 'phase-node-pill';
        btn.dataset.idx = String(idx);
        btn.textContent = `${ph.year} · ${ph.label}`;
        btn.addEventListener('click', () => this.selectPhaseByIndex(idx));
        this.phasePillsStrip.appendChild(btn);
      });

      this.periodBlocksBar.innerHTML = '';
      this.periods.forEach((p, pIdx) => {
        const btn = document.createElement('button');
        btn.className = 'period-block-btn';
        btn.dataset.periodIdx = String(pIdx);
        btn.innerHTML = `
          <span class="period-block-name">${p.shortName}</span>
          <span class="period-block-span">${p.span[0]}—${p.span[1]}</span>
        `;
        btn.addEventListener('click', () => {
          const firstPhaseIdx = this.allPhases.findIndex((ph) => ph.periodId === p.id);
          if (firstPhaseIdx >= 0) this.selectPhaseByIndex(firstPhaseIdx);
        });
        this.periodBlocksBar.appendChild(btn);
      });
    }

    // ─── 初始化录屏工坊下拉菜单选项 ───
    _initRecorderStudioUI() {
      if (!this.recTlStart) return;
      this.recTlStart.innerHTML = '';
      this.recTlEnd.innerHTML = '';
      this.allPhases.forEach((ph, idx) => {
        const text = `${idx + 1}. ${ph.year}年 · ${ph.label}`;
        this.recTlStart.add(new Option(text, String(idx), idx === 0, idx === 0));
        const isLast = idx === this.allPhases.length - 1;
        this.recTlEnd.add(new Option(text, String(idx), isLast, isLast));
      });

      this.recPersonSelect.innerHTML = '';
      Object.keys(this.persons).forEach((name, idx) => {
        const p = this.persons[name];
        this.recPersonSelect.add(
          new Option(`${p.name}（${p.title.split('·')[0].trim()} · 共${p.stops.length}站）`, name, idx === 0, idx === 0)
        );
      });

      this.recEventSelect.innerHTML = '';
      this.allEvents.forEach((ev, idx) => {
        this.recEventSelect.add(
          new Option(`${ev.year}.${ev.month || 1} · ${ev.name}（${ev.level}）`, String(idx), idx === 0, idx === 0)
        );
      });
    }

    // ─── 核心方法：切换历史阶段，触发地图形变与「朱砂色虚线残影」 ───
    selectPhaseByIndex(idx, opts = {}) {
      const clampedIdx = Math.max(0, Math.min(this.allPhases.length - 1, idx));
      const prevPhase = this.allPhases[this.currentPhaseIdx];
      const nextPhase = this.allPhases[clampedIdx];
      const period = this.periods[nextPhase.periodIdx];

      if (opts.initial) {
        this.prevSnapshotKey = 's_1930_baseline';
      } else if (prevPhase && prevPhase.snapshot !== nextPhase.snapshot) {
        this.prevSnapshotKey = prevPhase.snapshot;
      } else if (clampedIdx > 0) {
        this.prevSnapshotKey = this.allPhases[clampedIdx - 1].snapshot;
      } else {
        this.prevSnapshotKey = 's_1930_baseline';
      }

      this.currentPhaseIdx = clampedIdx;

      this.hdrYear.textContent = nextPhase.dateLabel || `${nextPhase.year}年`;
      this.hdrStage.textContent = nextPhase.label;
      this.inpTimeline.value = String(clampedIdx);

      if (this.dockSyncBanner) {
        const rulersStr = (period.rulers || []).map((r) => `${r.name}（${r.title.split('/')[0].trim()}）`).join(' / ');
        const marshalsShort = (period.marshals || '').split('、').slice(0, 8).join('、');
        this.dockSyncBanner.innerHTML = `
          <span>📅 <strong>当前年代：</strong>${nextPhase.dateLabel || nextPhase.year + '年'}（${nextPhase.label}）</span>
          <span>👑 <strong>最高统帅：</strong>${rulersStr}</span>
          <span>🎖️ <strong>元帅与主将：</strong>${marshalsShort}等</span>
        `;
      }

      const pills = this.phasePillsStrip.querySelectorAll('.phase-node-pill');
      pills.forEach((pill, i) => {
        pill.classList.toggle('active', i === clampedIdx);
        if (i === clampedIdx && !opts.initial) {
          pill.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
      });

      const pBtns = this.periodBlocksBar.querySelectorAll('.period-block-btn');
      pBtns.forEach((b, i) => b.classList.toggle('active', i === nextPhase.periodIdx));

      this._renderPolitiesAndNeighbors(nextPhase.snapshot);
      this._renderGhostDiff(this.prevSnapshotKey, nextPhase.snapshot);
      this._renderCampaignRoutes(period, nextPhase);
      this._renderFortsAndFleets(period);
      this._renderCitiesAndMilestones(period, nextPhase);
      this._renderLegendBox(nextPhase, period);
      this._renderRightChroniclePane(period, nextPhase);
    }

    // ─── 渲染政权疆域与亚洲邻国 (#grp-polities & #grp-neighbors) ───
    _renderPolitiesAndNeighbors(snapshotKey) {
      this.grpNeighbors.innerHTML = '';
      this.grpPolities.innerHTML = '';

      const snap = this.snapshots[snapshotKey];
      if (!snap || !snap.polities) return;

      snap.polities.forEach((pol, idx) => {
        const d = this.projector.geometryToPath(pol.shape);
        if (!d) return;

        if (pol.role === 'neighbor') {
          const path = this._el('path', { d, class: 'neighbor-path' });
          this.grpNeighbors.appendChild(path);
          if (pol.anchor && pol.title) {
            const [lx, ly] = this.projector.project(pol.anchor);
            this.grpNeighbors.appendChild(
              this._el('text', { x: lx, y: ly, class: 'neighbor-label' }, pol.title)
            );
          }
        } else {
          const fill = pol.tint || '#4f6d8f';
          const fillOpacity = pol.role === 'main' ? '0.52' : pol.role === 'rival' ? '0.56' : '0.40';
          const path = this._el('path', {
            d,
            class: 'polity-path',
            fill,
            'fill-opacity': fillOpacity,
            'data-polity-idx': idx,
            'data-polity-title': pol.title
          });

          path.addEventListener('mouseenter', (e) => {
            this._showTooltip(
              e,
              `<strong>${pol.title}</strong><br/>` +
                (pol.armyName ? `主力番号：${pol.armyName}<br/>` : '') +
                (pol.troops ? `兵力规模：<span style="color:#ffd43b;">${pol.troops}</span><br/>` : '') +
                (pol.equipment ? `代表装备：${pol.equipment}` : '')
            );
          });
          path.addEventListener('mousemove', (e) => this._moveTooltip(e));
          path.addEventListener('mouseleave', () => this._hideTooltip());
          path.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.quizState.active) {
              this._handleQuizMapClick(e);
              return;
            }
            if (pol.anchor) this.flyToCoord(pol.anchor, 2.0);
          });

          this.grpPolities.appendChild(path);

          if (pol.anchor && pol.title && !this.quizState.active) {
            const [ax, ay] = this.projector.project(pol.anchor);
            this.grpPolities.appendChild(
              this._el(
                'text',
                { x: ax, y: ay, class: 'polity-label' },
                pol.title.replace(/（.*?）/g, '')
              )
            );
          }
        }
      });
    }

    // ─── 核心细节 1：渲染「朱砂色虚线残影」 (#grp-ghost-diff) ───
    _renderGhostDiff(prevKey, currKey) {
      this.grpGhost.innerHTML = '';
      this.currentGhostDiffPaths = [];
      this.currentGhostLabel = null;

      if (!this.showGhostDiff || !prevKey || !currKey || prevKey === currKey) return;

      const prevSnap = this.snapshots[prevKey];
      const currSnap = this.snapshots[currKey];
      if (!prevSnap || !currSnap) return;

      const extractPolys = (snap) => {
        const list = [];
        (snap.polities || []).forEach((p) => {
          if (p.role === 'neighbor' || !p.shape || !p.shape.coordinates) return;
          const campKey = p.tint || p.title.slice(0, 4);
          const polys = p.shape.type === 'Polygon' ? [p.shape.coordinates] : p.shape.coordinates;
          polys.forEach((poly) => {
            const d = poly.map((r) => this.projector.ringToPath(r, true)).join('');
            if (d) {
              list.push({ campKey, title: p.title, d, ring0: poly[0] });
            }
          });
        });
        return list;
      };

      const prevList = extractPolys(prevSnap);
      const currSet = new Set(extractPolys(currSnap).map((item) => `${item.campKey}::${item.d}`));

      const diffPaths = [];
      let labelCoord = null;
      let labelTitle = '';

      prevList.forEach((item) => {
        if (!currSet.has(`${item.campKey}::${item.d}`)) {
          diffPaths.push(item.d);
          if (!labelCoord && item.ring0 && item.ring0.length) {
            let sx = 0, sy = 0;
            item.ring0.forEach((pt) => { sx += pt[0]; sy += pt[1]; });
            labelCoord = [sx / item.ring0.length, sy / item.ring0.length];
            labelTitle = item.title.split('（')[0];
          }
        }
      });

      this.currentGhostDiffPaths = diffPaths;

      if (diffPaths.length) {
        this.grpGhost.appendChild(
          this._el('path', {
            d: diffPaths.join(''),
            class: 'polity-ghost-path'
          })
        );
        if (labelCoord && !this.quizState.active) {
          const [gx, gy] = this.projector.project(labelCoord);
          const txt = `⭕ 虚线残影：上阶段「${labelTitle}」边界`;
          this.currentGhostLabel = { x: gx, y: gy, text: txt };
          this.grpGhost.appendChild(
            this._el('text', { x: gx, y: gy, class: 'ghost-diff-label' }, txt)
          );
        }
      }
    }

    // ─── 渲染鲜艳宽幅战役进军路线与动态流光箭头 (#grp-corridors) ───
    _renderCampaignRoutes(period, phase) {
      this.grpCorridors.innerHTML = '';
      if (!this.showRoutes || !period || !period.campaignRoutes) return;

      let routes = period.campaignRoutes.filter((r) => r.phaseId === phase.id);
      if (!routes.length) routes = period.campaignRoutes;

      routes.forEach((rt, idx) => {
        if (!rt.points || rt.points.length < 2) return;
        const d = this._buildSmoothCurvePath(rt.points);
        if (!d) return;

        const pathId = `cmp-route-path-${idx}`;
        const markerId =
          rt.type === 'kmt' ? 'url(#arrow-kmt)' : rt.type === 'enemy' ? 'url(#arrow-enemy)' : 'url(#arrow-pla)';

        this.grpCorridors.appendChild(this._el('path', { d, class: 'campaign-route-casing' }));
        this.grpCorridors.appendChild(
          this._el('path', { d, class: 'campaign-route-glow', stroke: rt.color || '#ff1e00' })
        );

        const mainPath = this._el('path', {
          id: pathId,
          d,
          class: 'campaign-route-main',
          stroke: rt.color || '#ff1e00',
          'marker-end': markerId
        });
        mainPath.addEventListener('mouseenter', (e) =>
          this._showTooltip(e, `<strong>🏹 ${rt.name}</strong><br/>点击可聚焦查看该进军路线战区`)
        );
        mainPath.addEventListener('mousemove', (e) => this._moveTooltip(e));
        mainPath.addEventListener('mouseleave', () => this._hideTooltip());
        mainPath.addEventListener('click', (e) => {
          e.stopPropagation();
          const midPt = rt.points[Math.floor(rt.points.length / 2)];
          if (midPt) this.flyToCoord(midPt, 2.4);
        });
        this.grpCorridors.appendChild(mainPath);

        this.grpCorridors.appendChild(this._el('path', { d, class: 'campaign-route-flow' }));

        const movingArrow = this._el('path', {
          d: 'M -4.2 -3.2 L 4.5 0 L -4.2 3.2 L -2.1 0 Z',
          fill: '#fffdf0',
          stroke: rt.color || '#ff1e00',
          'stroke-width': '0.9',
          class: 'moving-arrow-glyph'
        });
        const anim = this._el('animateMotion', {
          dur: '3.2s',
          repeatCount: 'indefinite',
          rotate: 'auto',
          path: d
        });
        movingArrow.appendChild(anim);
        this.grpCorridors.appendChild(movingArrow);
      });
    }

    _buildSmoothCurvePath(coords) {
      const pts = coords.map((c) => this.projector.project(c));
      if (pts.length < 2) return '';
      if (pts.length === 2) {
        const [p0, p1] = pts;
        const mx = (p0[0] + p1[0]) / 2;
        const my = (p0[1] + p1[1]) / 2;
        const dx = p1[0] - p0[0];
        const dy = p1[1] - p0[1];
        const cx = Number((mx - dy * 0.16).toFixed(2));
        const cy = Number((my + dx * 0.16).toFixed(2));
        return `M${p0[0]},${p0[1]} Q${cx},${cy} ${p1[0]},${p1[1]}`;
      }
      let d = `M${pts[0][0]},${pts[0][1]}`;
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const curr = pts[i];
        const mx = ((prev[0] + curr[0]) / 2).toFixed(2);
        const my = ((prev[1] + curr[1]) / 2).toFixed(2);
        if (i === 1) {
          d += ` Q${prev[0]},${prev[1]} ${mx},${my}`;
        } else {
          d += ` T${mx},${my}`;
        }
      }
      const last = pts[pts.length - 1];
      d += ` L${last[0]},${last[1]}`;
      return d;
    }

    // ─── 渲染要塞与舰队 (#grp-forts-fleets) — 图标与 1/3 文字比例协调 ───
    _renderFortsAndFleets(period) {
      this.grpFortsFleets.innerHTML = '';
      if (!period || this.quizState.active) return;

      (period.fortresses || []).forEach((ft, idx) => {
        const [x, y] = this.projector.project(ft.coord);
        const g = this._el('g', {
          class: 'fort-marker',
          transform: `translate(${x},${y})`,
          'data-fort-idx': idx
        });
        g.appendChild(
          this._el('polygon', {
            points: '0,-3.2 2.8,-1.4 2.3,2.3 0,3.6 -2.3,2.3 -2.8,-1.4',
            fill: '#7c2d12',
            stroke: '#fff8eb',
            'stroke-width': '0.65'
          })
        );
        g.appendChild(
          this._el('text', { x: 4.2, y: 1.4, class: 'fort-label', fill: '#7c2d12' }, `🏰 ${ft.name}`)
        );
        g.addEventListener('mouseenter', (e) =>
          this._showTooltip(e, `<strong>🏰 要塞：${ft.name}</strong><br/>驻防：${ft.faction}<br/>${ft.desc}`)
        );
        g.addEventListener('mousemove', (e) => this._moveTooltip(e));
        g.addEventListener('mouseleave', () => this._hideTooltip());
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          this.flyToCoord(ft.coord, 2.8);
          this.openProvenanceByMilestoneOrFort({
            name: ft.name,
            coord: ft.coord,
            year: period.span[0],
            level: '战略要塞',
            scale: ft.faction,
            desc: ft.desc
          });
        });
        this.grpFortsFleets.appendChild(g);
      });

      (period.fleets || []).forEach((fl, idx) => {
        const [x, y] = this.projector.project(fl.coord);
        const g = this._el('g', {
          class: 'fleet-marker',
          transform: `translate(${x},${y})`,
          'data-fleet-idx': idx
        });
        g.appendChild(
          this._el('rect', {
            x: -3.2,
            y: -2.6,
            width: 6.4,
            height: 5.2,
            rx: 1.4,
            fill: '#1e3a8a',
            stroke: '#fff8eb',
            'stroke-width': '0.65'
          })
        );
        g.appendChild(
          this._el('text', { x: 4.5, y: 1.4, class: 'fleet-label', fill: '#1e3a8a' }, `⚓ ${fl.name}`)
        );
        g.addEventListener('mouseenter', (e) =>
          this._showTooltip(e, `<strong>⚓ 舰队：${fl.name}</strong><br/>归属：${fl.faction}<br/>${fl.desc}`)
        );
        g.addEventListener('mousemove', (e) => this._moveTooltip(e));
        g.addEventListener('mouseleave', () => this._hideTooltip());
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          this.flyToCoord(fl.coord, 2.5);
          this.openProvenanceByMilestoneOrFort({
            name: fl.name,
            coord: fl.coord,
            year: period.span[0],
            level: '主力舰队',
            scale: fl.faction,
            desc: fl.desc
          });
        });
        this.grpFortsFleets.appendChild(g);
      });
    }

    // ─── 渲染历史名城与重大战役标注 (#grp-settlements & #grp-milestones) — 1/3 精致比例 ───
    _renderCitiesAndMilestones(period, phase) {
      this.grpSettlements.innerHTML = '';
      this.grpMilestones.innerHTML = '';

      this.cities.forEach((city) => {
        const [cx, cy] = this.projector.project(city.coord);
        const g = this._el('g', {
          class: 'city-node',
          transform: `translate(${cx},${cy})`
        });

        const isCap = city.tier === 'capital';
        const r = isCap ? 2.1 : 1.5;

        if (isCap) {
          g.appendChild(
            this._el('circle', {
              r: 3.4,
              fill: 'none',
              stroke: '#c92a2a',
              'stroke-width': '0.65'
            })
          );
        }

        g.appendChild(
          this._el('circle', {
            r,
            class: 'city-dot',
            fill: isCap ? '#c92a2a' : '#2b231d',
            stroke: '#fffdf9',
            'stroke-width': '0.7'
          })
        );

        if (!this.quizState.active) {
          g.appendChild(
            this._el(
              'text',
              {
                x: 0,
                y: -3.4,
                'text-anchor': 'middle',
                class: `city-label ${isCap ? 'capital' : ''}`
              },
              city.name.split('（')[0]
            )
          );
        }

        g.addEventListener('mouseenter', (e) => {
          if (this.quizState.active) return;
          this._showTooltip(
            e,
            `<strong>🏛️ ${city.name}</strong><br/>${city.tagline}<br/><span style="color:#ffd43b;">点击打开 1931—1958「点地溯源」卡片</span>`
          );
        });
        g.addEventListener('mousemove', (e) => this._moveTooltip(e));
        g.addEventListener('mouseleave', () => this._hideTooltip());
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.quizState.active) {
            this._handleQuizMapClick(e);
            return;
          }
          this.openCityProvenance(city);
        });

        this.grpSettlements.appendChild(g);
      });

      if (this.quizState.active || !period || !period.milestones) return;

      period.milestones.forEach((ms) => {
        const [mx, my] = this.projector.project(ms.coord);
        const isCurrentPhase = ms.phaseId === phase.id;
        const g = this._el('g', {
          class: 'milestone-node',
          transform: `translate(${mx},${my})`,
          opacity: isCurrentPhase ? '1' : '0.84'
        });

        if (isCurrentPhase) {
          g.appendChild(this._el('circle', { cx: 0, cy: 0, r: 2.5, class: 'milestone-pulse' }));
        }

        const isTurning = ms.level.includes('转折');
        g.appendChild(
          this._el('circle', {
            cx: 0,
            cy: 0,
            r: isCurrentPhase ? 2.4 : 1.9,
            fill: isTurning ? '#d97706' : '#d90429',
            stroke: '#fffdf8',
            'stroke-width': '0.75'
          })
        );

        g.appendChild(
          this._el(
            'text',
            {
              x: 3.8,
              y: 1.4,
              class: `milestone-label ${isTurning ? 'turning-point' : ''}`
            },
            `⚔️ ${ms.name}`
          )
        );

        g.addEventListener('mouseenter', (e) =>
          this._showTooltip(
            e,
            `<strong>⚔️ ${ms.year}.${ms.month} · ${ms.name}（${ms.level}）</strong><br/>` +
              `参战规模：<span style="color:#ffd43b;">${ms.scale}</span><br/>` +
              `${ms.desc}<br/><span style="color:#93c5fd;">点击弹出战役溯源卡片并聚焦</span>`
          )
        );
        g.addEventListener('mousemove', (e) => this._moveTooltip(e));
        g.addEventListener('mouseleave', () => this._hideTooltip());
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openProvenanceByMilestoneOrFort(ms);
        });

        this.grpMilestones.appendChild(g);
      });
    }

    // ─── 渲染左下角政权/军队/装备/人数/要塞/舰队图例 (#map-key) ───
    _renderLegendBox(phase, period) {
      const snap = this.snapshots[phase.snapshot];
      if (!snap) return;

      const mainPolities = (snap.polities || []).filter((p) => p.role !== 'neighbor');
      let html = '';

      html += `
        <div class="ghost-diff-banner">
          <span><i class="ghost-swatch"></i>朱砂虚线残影：上一阶段边界进退对比</span>
          <span>${this.showGhostDiff ? '已开启' : '已隐藏'}</span>
        </div>
      `;

      mainPolities.forEach((pol) => {
        html += `
          <div class="legend-polity-card" data-pol-title="${pol.title}">
            <div class="legend-polity-top">
              <span class="legend-polity-name">
                <i class="legend-color-dot" style="background:${pol.tint || '#4f6d8f'};"></i>
                ${pol.title}
              </span>
              ${pol.troops ? `<span class="legend-troop-badge">${pol.troops}</span>` : ''}
            </div>
            ${pol.armyName ? `<div class="legend-meta-row"><strong>主力部队：</strong>${pol.armyName}</div>` : ''}
            ${pol.equipment ? `<div class="legend-meta-row"><strong>武器装备：</strong>${pol.equipment}</div>` : ''}
            ${pol.commanders ? `<div class="legend-meta-row"><strong>核心统帅：</strong>${pol.commanders}</div>` : ''}
          </div>
        `;
      });

      const forts = period.fortresses || [];
      const fleets = period.fleets || [];
      if (forts.length || fleets.length) {
        html += `<div class="legend-sub-group">`;
        html += `<div class="legend-sub-title">🏰 战略要塞与 ⚓ 主力舰队（悬停高亮 · 点击聚焦）</div>`;
        html += `<div class="legend-chip-list">`;
        forts.forEach((ft, i) => {
          html += `<span class="legend-unit-chip" data-fort-idx="${i}">🏰 ${ft.name}</span>`;
        });
        fleets.forEach((fl, i) => {
          html += `<span class="legend-unit-chip" data-fleet-idx="${i}">⚓ ${fl.name}</span>`;
        });
        html += `</div></div>`;
      }

      this.mapKeyBody.innerHTML = html;

      this.mapKeyBody.querySelectorAll('.legend-polity-card').forEach((card) => {
        const title = card.dataset.polTitle;
        const polObj = mainPolities.find((p) => p.title === title);
        card.addEventListener('mouseenter', () => {
          this.grpPolities.querySelectorAll('.polity-path').forEach((el) => {
            el.classList.toggle('legend-hover', el.getAttribute('data-polity-title') === title);
          });
        });
        card.addEventListener('mouseleave', () => {
          this.grpPolities.querySelectorAll('.polity-path').forEach((el) => el.classList.remove('legend-hover'));
        });
        card.addEventListener('click', () => {
          if (polObj && polObj.anchor) {
            this.flyToCoord(polObj.anchor, 1.9);
          }
        });
      });

      this.mapKeyBody.querySelectorAll('.legend-unit-chip').forEach((chip) => {
        const fIdx = chip.dataset.fortIdx;
        const flIdx = chip.dataset.fleetIdx;
        chip.addEventListener('mouseenter', () => {
          if (fIdx !== undefined) {
            const el = this.grpFortsFleets.querySelector(`.fort-marker[data-fort-idx="${fIdx}"]`);
            if (el) el.classList.add('legend-hover');
          }
          if (flIdx !== undefined) {
            const el = this.grpFortsFleets.querySelector(`.fleet-marker[data-fleet-idx="${flIdx}"]`);
            if (el) el.classList.add('legend-hover');
          }
        });
        chip.addEventListener('mouseleave', () => {
          this.grpFortsFleets
            .querySelectorAll('.legend-hover')
            .forEach((el) => el.classList.remove('legend-hover'));
        });
        chip.addEventListener('click', () => {
          if (fIdx !== undefined && forts[fIdx]) {
            this.flyToCoord(forts[fIdx].coord, 2.8);
          } else if (flIdx !== undefined && fleets[flIdx]) {
            this.flyToCoord(fleets[flIdx].coord, 2.4);
          }
        });
      });
    }

    // ─── 渲染右侧历史编年、统帅将领与重大战役侧栏 (#chronicle-pane) ───
    _renderRightChroniclePane(period, phase) {
      this.paneEraSpan.textContent = `${period.span[0]} — ${period.span[1]} · ${period.shortName}`;
      this.paneEraTitle.textContent = period.name;
      const snap = this.snapshots[phase.snapshot];
      this.panePhaseCaption.textContent = snap ? snap.caption : `${phase.year} · ${phase.label}`;

      let html = '';

      if (this.activePerson) {
        const p = this.activePerson;
        const stop = p.stops[this.journeyStopIdx];
        html += `
          <div class="pane-section" style="border: 1.5px solid var(--vermilion); background:#fff8f6;">
            <div class="pane-sec-title">
              <span>👣 点人溯事：${p.name}（${p.years}）</span>
              <span style="font-size:12px;color:var(--vermilion);">${p.camp}</span>
            </div>
            <p class="pane-narrative" style="margin-bottom:8px;">${p.summary}</p>
            <div style="padding:8px 10px;background:#fff;border-radius:7px;border-left:3px solid var(--vermilion);font-size:13px;">
              <strong>当前行迹站（${stop.year} · ${stop.place}）：</strong><br/>
              ${stop.note}
            </div>
          </div>
        `;
      }

      html += `
        <div class="pane-section">
          <div class="pane-sec-title">
            <span>📜 历史阶段战局综述</span>
            <span style="font-size:11.5px;color:var(--ink-500);">${phase.dateLabel || phase.year}</span>
          </div>
          <p class="pane-narrative">${snap && snap.note ? snap.note : period.overview}</p>
        </div>
      `;

      html += `
        <div class="pane-section">
          <div class="pane-sec-title">
            <span>🎖️ 时期统帅与名将录</span>
            <span style="font-size:11px;color:var(--vermilion);">点击人物走一生 ›</span>
          </div>
          <div class="leader-grid">
            ${(period.rulers || [])
              .map(
                (r) => `
              <div class="leader-row" data-person-name="${r.name}">
                <span class="leader-name">★ ${r.name}</span>
                <span class="leader-title">${r.title}</span>
              </div>
            `
              )
              .join('')}
          </div>
          <div class="marshals-cloud">
            ${(period.marshals || '')
              .split('、')
              .map((m) => `<span class="marshal-chip" data-person-name="${m.replace(/（.*?）/g, '').trim()}">${m}</span>`)
              .join('')}
          </div>
        </div>
      `;

      html += `
        <div class="pane-section">
          <div class="pane-sec-title">
            <span>⚔️ 重大战役 · 关键转折 · 历史事件</span>
            <span style="font-size:11px;color:var(--ink-500);">点击溯源</span>
          </div>
          <div class="milestone-list">
            ${(period.milestones || [])
              .map(
                (ms, i) => `
              <div class="ms-card" data-ms-idx="${i}">
                <div class="ms-card-top">
                  <span class="ms-card-name">${ms.year}.${ms.month} · ${ms.name}</span>
                  <span class="ms-card-badge">${ms.level}</span>
                </div>
                <div class="ms-card-scale">📊 规模：${ms.scale}</div>
                <div class="ms-card-desc">${ms.desc}</div>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `;

      this.paneBody.innerHTML = html;

      this.paneBody.querySelectorAll('[data-person-name]').forEach((el) => {
        el.addEventListener('click', () => {
          const name = el.dataset.personName;
          if (this.persons[name]) {
            this.startPersonJourney(name);
          } else {
            this._showTempNotice(`人物「${name}」所属时期已定位，可点击毛泽东、彭德怀、林彪、粟裕、朱德、周恩来、蒋介石、孙立人、薛岳、山本五十六、艾森豪威尔等查看完整动态行迹。`);
          }
        });
      });

      this.paneBody.querySelectorAll('.ms-card').forEach((card) => {
        const idx = Number(card.dataset.msIdx);
        const ms = period.milestones[idx];
        card.addEventListener('click', () => {
          if (ms) this.openProvenanceByMilestoneOrFort(ms);
        });
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 核心模块 2：「点地溯源 / 战役溯源」全编年卡片 (#genealogy-card)
    // ═════════════════════════════════════════════════════════════════════════
    openCityProvenance(city) {
      if (!city) return;
      this.flyToCoord(city.coord, 2.35);
      this._drawGenealogyHighlight(city.coord, city.name);

      this.activeHighlight = {
        type: 'city',
        name: city.name,
        coord: city.coord,
        year: this.allPhases[this.currentPhaseIdx].year,
        phaseId: this.allPhases[this.currentPhaseIdx].id,
        scale: city.tagline,
        desc: city.overview
      };

      this.genKicker.textContent = '点地溯源 · 1931 九一八事变 — 1958 八二三炮战 全编年';
      this.genTitle.textContent = city.name;
      this.genTagline.textContent = city.tagline || '';
      this.genOverview.textContent = city.overview || '';

      this._renderGenealogyStages(city.chronology || []);
      this.genCard.hidden = false;
    }

    openProvenanceByMilestoneOrFort(ms) {
      if (!ms) return;
      if (ms.phaseId) {
        const pIdx = this.allPhases.findIndex((p) => p.id === ms.phaseId);
        if (pIdx >= 0 && pIdx !== this.currentPhaseIdx) {
          this.selectPhaseByIndex(pIdx);
        }
      }
      this.flyToCoord(ms.coord, 2.55);
      this._drawGenealogyHighlight(ms.coord, ms.name);

      this.activeHighlight = {
        type: 'event',
        name: ms.name,
        coord: ms.coord,
        year: ms.year,
        month: ms.month,
        phaseId: ms.phaseId,
        level: ms.level || '重大战役',
        scale: ms.scale || '主力决战',
        desc: ms.desc
      };

      let nearestCity = null;
      let minDist = Infinity;
      this.cities.forEach((c) => {
        const d = this.projector.greatCircleKm(ms.coord, c.coord);
        if (d < minDist) {
          minDist = d;
          nearestCity = c;
        }
      });

      this.genKicker.textContent = `战役与战地溯源 · ${ms.level || '重大战役'}`;
      this.genTitle.textContent = ms.name;
      this.genTagline.textContent = `发生时间：${ms.year}年${ms.month ? ms.month + '月' : ''} · 参战规模：${ms.scale || '主力决战'}`;
      this.genOverview.innerHTML =
        `<strong>【事件与战役概述】</strong>${ms.desc}` +
        (nearestCity && minDist < 220
          ? `<br/><span style="color:var(--vermilion);font-weight:700;">▼ 以下为所属战区重镇「${nearestCity.name}」1931—1958 完整政权更迭与大事编年（点击任意一条立刻跳回当年）：</span>`
          : '');

      const stages = nearestCity && minDist < 220 ? [...nearestCity.chronology] : [];
      const hasExact = stages.some((s) => s.event.includes(ms.name.split('（')[0]));
      if (!hasExact) {
        stages.unshift({
          year: ms.year,
          phaseId: ms.phaseId,
          regime: ms.level || '核心会战',
          ruler: '参战双方主力统帅',
          event: `${ms.name}：${ms.desc}`,
          scale: ms.scale
        });
      }

      this._renderGenealogyStages(stages);
      this.genCard.hidden = false;
    }

    _renderGenealogyStages(stages) {
      const currPhase = this.allPhases[this.currentPhaseIdx];
      this.genList.innerHTML = stages
        .map((st, idx) => {
          const isCurrent = st.phaseId === currPhase.id || st.year === currPhase.year;
          return `
            <div class="gen-stage-item ${isCurrent ? 'active-stage' : ''}" data-st-idx="${idx}">
              <div class="gen-stage-top">
                <span class="gen-stage-year">${st.year}年</span>
                <span class="gen-stage-regime">${st.regime}</span>
              </div>
              <div class="gen-stage-ruler">👤 统辖/主将：${st.ruler}</div>
              <div class="gen-stage-event">${st.event}</div>
              ${st.scale ? `<div class="gen-stage-scale">⚔️ 战争规模：${st.scale}</div>` : ''}
            </div>
          `;
        })
        .join('');

      this.genList.querySelectorAll('.gen-stage-item').forEach((item) => {
        const st = stages[Number(item.dataset.stIdx)];
        item.addEventListener('click', () => {
          if (!st) return;
          let targetIdx = -1;
          if (st.phaseId) {
            targetIdx = this.allPhases.findIndex((p) => p.id === st.phaseId);
          }
          if (targetIdx < 0) {
            targetIdx = this.allPhases.findIndex((p) => p.year >= st.year);
            if (targetIdx < 0) targetIdx = this.allPhases.length - 1;
          }
          this.selectPhaseByIndex(targetIdx);
          this._renderGenealogyStages(stages);
        });
      });
    }

    _drawGenealogyHighlight(coord) {
      this.grpGenealogy.innerHTML = '';
      if (!coord) return;
      const [x, y] = this.projector.project(coord);
      const g = this._el('g', { transform: `translate(${x},${y})` });
      g.appendChild(
        this._el('circle', {
          r: 6.5,
          fill: 'rgba(201, 42, 42, 0.16)',
          stroke: '#ff1e00',
          'stroke-width': '1.2',
          'stroke-dasharray': '2.5 2'
        })
      );
      g.appendChild(
        this._el('circle', {
          r: 2.4,
          fill: '#ff1e00',
          stroke: '#fff',
          'stroke-width': '0.9'
        })
      );
      this.grpGenealogy.appendChild(g);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 核心模块 3：「点人溯事」跟着将帅走一遍 (#journey-card & #grp-journey)
    // ═════════════════════════════════════════════════════════════════════════
    startPersonJourney(personName) {
      const person = this.persons[personName];
      if (!person) return;

      this.stopJourneyAutoPlay();
      this.activePerson = person;
      this.journeyStopIdx = 0;

      this.jrnName.textContent = person.name;
      this.jrnRole.textContent = `${person.title}（${person.courtesy}）`;
      this.inpJrnStep.max = String(person.stops.length - 1);
      this.inpJrnStep.value = '0';
      this.jrnCard.hidden = false;

      this.stepPersonJourneyTo(0);
    }

    stepPersonJourneyTo(stopIdx) {
      if (!this.activePerson) return;
      const stops = this.activePerson.stops;
      const clamped = Math.max(0, Math.min(stops.length - 1, stopIdx));
      this.journeyStopIdx = clamped;
      this.inpJrnStep.value = String(clamped);

      const stop = stops[clamped];

      if (stop.phaseId) {
        const phaseIdx = this.allPhases.findIndex((p) => p.id === stop.phaseId);
        if (phaseIdx >= 0) {
          this.selectPhaseByIndex(phaseIdx);
        }
      }

      this.jrnPlace.textContent = `第 ${clamped + 1} 站 · ${stop.year}年 · ${stop.place}`;
      this.jrnCounter.textContent = `${clamped + 1} / ${stops.length}`;
      this.jrnQuote.textContent = stop.poemTitle ? `${stop.poemTitle}：“${stop.poemLine}”` : stop.poemLine || '';
      this.jrnNote.textContent = stop.note || '';

      this.recorderState.arcAnimStart = performance.now();
      this._renderPersonJourneyMap();
      this.flyToCoord(stop.coord, 2.15);
    }

    _renderPersonJourneyMap() {
      this.grpJourney.innerHTML = '';
      if (!this.activePerson) return;

      const stops = this.activePerson.stops;
      const currIdx = this.journeyStopIdx;

      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i].coord;
        const b = stops[i + 1].coord;
        const d = this._buildSmoothCurvePath([a, b]);
        if (!d) continue;

        if (i < currIdx - 1) {
          this.grpJourney.appendChild(this._el('path', { d, class: 'journey-arc-casing' }));
          this.grpJourney.appendChild(
            this._el('path', { d, class: 'journey-arc-past', 'marker-end': 'url(#arrow-journey)' })
          );
        } else if (i >= currIdx && !(currIdx === 0 && i === 0)) {
          this.grpJourney.appendChild(this._el('path', { d, class: 'journey-arc-future' }));
        }

        const isFocusArc = currIdx > 0 ? i === currIdx - 1 : i === 0;
        if (isFocusArc) {
          this.grpJourney.appendChild(this._el('path', { d, class: 'journey-arc-casing' }));
          this.grpJourney.appendChild(
            this._el('path', { d, class: 'journey-arc-active', 'marker-end': 'url(#arrow-journey)' })
          );
          this.grpJourney.appendChild(this._el('path', { d, class: 'campaign-route-flow' }));

          const arrowGlyph = this._el('path', {
            d: 'M -4.5 -3.2 L 4.8 0 L -4.5 3.2 L -2.2 0 Z',
            fill: '#ffea00',
            stroke: '#c92a2a',
            'stroke-width': '1.0',
            class: 'moving-arrow-glyph'
          });
          arrowGlyph.appendChild(
            this._el('animateMotion', {
              dur: '2.0s',
              repeatCount: 'indefinite',
              rotate: 'auto',
              path: d
            })
          );
          this.grpJourney.appendChild(arrowGlyph);
        }
      }

      stops.forEach((st, i) => {
        const [x, y] = this.projector.project(st.coord);
        const isCurr = i === currIdx;
        const g = this._el('g', {
          class: 'journey-stop-node',
          transform: `translate(${x},${y})`
        });

        if (isCurr) {
          g.appendChild(
            this._el('circle', {
              r: 6.5,
              fill: 'rgba(255, 30, 0, 0.22)',
              stroke: '#ff1e00',
              'stroke-width': '1.0'
            })
          );
        }

        g.appendChild(
          this._el('circle', {
            r: isCurr ? 3.5 : 2.6,
            fill: isCurr ? '#ff1e00' : i < currIdx ? '#c92a2a' : '#fffdf8',
            stroke: '#1e1b18',
            'stroke-width': '0.8'
          })
        );

        g.appendChild(
          this._el(
            'text',
            {
              x: 0,
              y: 1.2,
              'text-anchor': 'middle',
              fill: isCurr || i < currIdx ? '#fff' : '#1e1b18',
              'font-size': '3.4px',
              'font-weight': '800',
              'pointer-events': 'none'
            },
            String(i + 1)
          )
        );

        g.appendChild(
          this._el(
            'text',
            {
              x: 4.8,
              y: 1.4,
              class: 'journey-stop-label'
            },
            `${st.year}·${st.place.split('（')[0]}`
          )
        );

        g.addEventListener('click', (e) => {
          e.stopPropagation();
          this.stepPersonJourneyTo(i);
        });

        this.grpJourney.appendChild(g);
      });
    }

    toggleJourneyAutoPlay() {
      if (this.journeyTimer) {
        this.stopJourneyAutoPlay();
      } else {
        this.btnJrnPlay.textContent = '⏸ 暂停巡礼';
        this.journeyTimer = setInterval(() => {
          if (!this.activePerson) {
            this.stopJourneyAutoPlay();
            return;
          }
          const next = (this.journeyStopIdx + 1) % this.activePerson.stops.length;
          this.stepPersonJourneyTo(next);
        }, 3600);
      }
    }

    stopJourneyAutoPlay() {
      if (this.journeyTimer) {
        clearInterval(this.journeyTimer);
        this.journeyTimer = null;
      }
      if (this.btnJrnPlay) this.btnJrnPlay.textContent = '▶ 巡礼播放';
    }

    closePersonJourney() {
      this.stopJourneyAutoPlay();
      this.activePerson = null;
      this.grpJourney.innerHTML = '';
      this.jrnCard.hidden = true;
      const currPhase = this.allPhases[this.currentPhaseIdx];
      this._renderRightChroniclePane(this.periods[currPhase.periodIdx], currPhase);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 核心模块 4：彩蛋「舆图寻址小试」十道盲猜封「大元帅」 (#challenge-card)
    // ═════════════════════════════════════════════════════════════════════════
    startQuizChallenge() {
      this.closePersonJourney();
      this.genCard.hidden = true;
      this.recCard.hidden = true;
      this.grpGenealogy.innerHTML = '';

      const shuffled = [...this.quizPool].sort(() => Math.random() - 0.5).slice(0, 10);
      this.quizState = {
        active: true,
        questions: shuffled,
        idx: 0,
        score: 0,
        candidateCoord: null,
        answered: false
      };

      this.viewport.classList.add('pin-mode');
      this.quizCard.hidden = false;
      this.quizFinal.hidden = true;

      const currPhase = this.allPhases[this.currentPhaseIdx];
      this._renderPolitiesAndNeighbors(currPhase.snapshot);
      this._renderFortsAndFleets(this.periods[currPhase.periodIdx]);
      this._renderCitiesAndMilestones(this.periods[currPhase.periodIdx], currPhase);

      this._loadQuizQuestion(0);
    }

    _loadQuizQuestion(qIdx) {
      const q = this.quizState.questions[qIdx];
      this.quizState.idx = qIdx;
      this.quizState.candidateCoord = null;
      this.quizState.answered = false;
      this.grpChallenge.innerHTML = '';

      this.quizProgress.textContent = `第 ${qIdx + 1} / 10 题`;
      this.quizScore.textContent = `当前总分：${this.quizState.score} 分`;
      this.quizRankPreview.textContent = `当前军衔：${this._getMilitaryRank(this.quizState.score).rank}`;
      this.quizClue.textContent = q.clue;

      this.quizFeedback.hidden = true;
      this.btnQuizConfirm.hidden = false;
      this.btnQuizConfirm.disabled = true;
      this.btnQuizConfirm.textContent = '📍 请先在地图上点击落针';
      this.btnQuizNext.hidden = true;
    }

    _handleQuizMapClick(e) {
      if (!this.quizState.active || this.quizState.answered) return;
      const pt = this._clientToSvgMapCoord(e.clientX, e.clientY);
      const lonLat = this.projector.unproject(pt.x, pt.y);
      this.quizState.candidateCoord = lonLat;

      this.grpChallenge.innerHTML = '';
      const g = this._el('g', { transform: `translate(${pt.x},${pt.y})` });
      g.appendChild(
        this._el('circle', {
          r: 4.8,
          fill: 'rgba(37, 99, 235, 0.22)',
          stroke: '#2563eb',
          'stroke-width': '1.0'
        })
      );
      g.appendChild(
        this._el('circle', {
          r: 2.1,
          fill: '#2563eb',
          stroke: '#fff',
          'stroke-width': '0.8'
        })
      );
      g.appendChild(
        this._el(
          'text',
          {
            x: 0,
            y: -5.5,
            'text-anchor': 'middle',
            fill: '#1d4ed8',
            'font-size': '4px',
            'font-weight': '800',
            stroke: '#fff',
            'stroke-width': '1.1',
            'paint-order': 'stroke'
          },
          '📍 落针点'
        )
      );
      this.grpChallenge.appendChild(g);

      this.btnQuizConfirm.disabled = false;
      this.btnQuizConfirm.textContent = '✅ 确认落针并核验坐标';
    }

    _confirmQuizAnswer() {
      if (!this.quizState.candidateCoord || this.quizState.answered) return;
      this.quizState.answered = true;

      const q = this.quizState.questions[this.quizState.idx];
      const userCoord = this.quizState.candidateCoord;
      const trueCoord = q.coord;
      const distKm = Math.round(this.projector.greatCircleKm(userCoord, trueCoord));

      let pts = 0;
      if (distKm <= 35) pts = 100;
      else if (distKm <= 80) pts = 92;
      else if (distKm <= 150) pts = 82;
      else if (distKm <= 250) pts = 70;
      else if (distKm <= 400) pts = 55;
      else if (distKm <= 650) pts = 35;
      else if (distKm <= 1000) pts = 15;
      else pts = 5;

      this.quizState.score += pts;
      this.quizScore.textContent = `当前总分：${this.quizState.score} 分`;
      this.quizRankPreview.textContent = `当前军衔：${this._getMilitaryRank(this.quizState.score).rank}`;

      const [ux, uy] = this.projector.project(userCoord);
      const [tx, ty] = this.projector.project(trueCoord);

      this.grpChallenge.appendChild(
        this._el('line', {
          x1: ux,
          y1: uy,
          x2: tx,
          y2: ty,
          stroke: '#d90429',
          'stroke-width': '1.2',
          'stroke-dasharray': '3 2.5'
        })
      );

      const tg = this._el('g', { transform: `translate(${tx},${ty})` });
      tg.appendChild(
        this._el('circle', {
          r: 7.5,
          fill: 'rgba(217, 4, 41, 0.14)',
          stroke: '#d90429',
          'stroke-width': '0.9',
          'stroke-dasharray': '2 2'
        })
      );
      tg.appendChild(
        this._el('circle', {
          r: 2.5,
          fill: '#d90429',
          stroke: '#fff',
          'stroke-width': '0.8'
        })
      );
      tg.appendChild(
        this._el(
          'text',
          {
            x: 0,
            y: -5.8,
            'text-anchor': 'middle',
            fill: '#9e1b12',
            'font-size': '4.2px',
            'font-weight': '800',
            stroke: '#fffdf8',
            'stroke-width': '1.2',
            'paint-order': 'stroke'
          },
          `🎯 ${q.name}（偏差 ${distKm} km · +${pts}分）`
        )
      );
      this.grpChallenge.appendChild(tg);

      this.quizFeedback.hidden = false;
      this.quizFeedback.innerHTML = `
        <strong>🎯 揭晓：${q.name}（${q.year}）</strong><br/>
        落针偏差：<strong>${distKm} 公里</strong> · 本题得分：<strong style="color:var(--vermilion);">+${pts} 分</strong><br/>
        ${q.detail}
      `;

      this.btnQuizConfirm.hidden = true;
      this.btnQuizNext.hidden = false;
      this.btnQuizNext.textContent =
        this.quizState.idx >= 9 ? '🏆 查看最终授衔结果' : '下一道军情题 ›';
    }

    _nextQuizStep() {
      if (this.quizState.idx >= 9) {
        const award = this._getMilitaryRank(this.quizState.score);
        this.quizClue.hidden = true;
        this.quizFeedback.hidden = true;
        this.btnQuizNext.hidden = true;
        this.quizFinal.hidden = false;
        this.quizFinal.innerHTML = `
          <div style="font-size:12.5px;font-weight:700;color:var(--ink-500);">十道军情寻址考核圆满完成 · 最终总分 ${this.quizState.score} / 1000 分</div>
          <div class="quiz-rank-title">🎖️ 授衔：【${award.rank}】</div>
          <div style="font-size:13px;color:var(--ink-700);margin-bottom:10px;">${award.comment}</div>
          <button class="quiz-primary-btn" id="btn-quiz-restart" style="padding:0 18px;">🔄 再考一轮冲击「大元帅」</button>
        `;
        document.getElementById('btn-quiz-restart').addEventListener('click', () => {
          this.quizClue.hidden = false;
          this.startQuizChallenge();
        });
      } else {
        this._loadQuizQuestion(this.quizState.idx + 1);
      }
    }

    _getMilitaryRank(score) {
      if (score >= 850) {
        return {
          rank: '大元帅',
          comment: '运筹帷幄之中，决胜千里之外！您对近代抗战与解放战争山河地理了如指掌，荣膺最高统帅「中华人民共和国大元帅」军衔！'
        };
      }
      if (score >= 750) {
        return {
          rank: '元帅',
          comment: '雄才大略，横刀立马！您精准洞悉各大战略决战要地，荣膺开国「元帅」军衔！'
        };
      }
      if (score >= 650) {
        return {
          rank: '大将',
          comment: '猛虎掏心，百战百胜！您具备卓越的战役舆图判读能力，荣膺「大将」军衔！'
        };
      }
      if (score >= 520) {
        return {
          rank: '上将',
          comment: '独当一面，纵横疆场！您对近代战争主要战场相当熟悉，荣膺「上将」军衔！'
        };
      }
      if (score >= 380) {
        return {
          rank: '中将',
          comment: '久经沙场，颇具将才！荣膺「中将」军衔，继续磨砺可冲击大元帅！'
        };
      }
      if (score >= 240) {
        return {
          rank: '少将',
          comment: '初露锋芒！荣膺「少将」军衔，多翻阅城池溯源卡片定能更进一步！'
        };
      }
      return {
        rank: '校官',
        comment: '革命尚未成功，同志仍需熟读舆图！'
      };
    }

    closeQuizChallenge() {
      this.quizState.active = false;
      this.viewport.classList.remove('pin-mode');
      this.quizCard.hidden = true;
      this.quizClue.hidden = false;
      this.grpChallenge.innerHTML = '';

      const currPhase = this.allPhases[this.currentPhaseIdx];
      this._renderPolitiesAndNeighbors(currPhase.snapshot);
      this._renderFortsAndFleets(this.periods[currPhase.periodIdx]);
      this._renderCitiesAndMilestones(this.periods[currPhase.periodIdx], currPhase);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 核心模块 5：内置史诗录屏工坊（支持时间线演进、指定人物路径、指定事件推演、自由录制）
    // ═════════════════════════════════════════════════════════════════════════
    openRecorderStudio(preferredMode = null) {
      if (preferredMode) {
        this._switchRecorderTab(preferredMode);
      }
      this.recCard.hidden = false;
    }

    _switchRecorderTab(mode) {
      this.recorderState.mode = mode;
      document.querySelectorAll('#rec-mode-tabs .rec-mode-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
      });
      document.getElementById('rec-pane-timeline').hidden = mode !== 'timeline';
      document.getElementById('rec-pane-person').hidden = mode !== 'person';
      document.getElementById('rec-pane-event').hidden = mode !== 'event';
      document.getElementById('rec-pane-free').hidden = mode !== 'free';
    }

    startVideoRecording(customOpts = null) {
      if (this.recorderState.active) {
        this.stopVideoRecording();
        return;
      }

      const mode = customOpts && customOpts.mode ? customOpts.mode : this.recorderState.mode;
      this.recorderState.mode = mode;

      // 创建 1600×1000 高清离屏录制画布
      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = 1000;
      const ctx = canvas.getContext('2d');

      let stream;
      try {
        stream = canvas.captureStream(30);
      } catch (err) {
        this._showTempNotice('当前浏览器环境不支持 Canvas 视频流捕获，请使用现代 Chrome / Edge / Firefox 浏览器。');
        return;
      }

      const mimeTypes = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4'
      ];
      let selectedMime = '';
      for (const m of mimeTypes) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) {
          selectedMime = m;
          break;
        }
      }

      let mr;
      try {
        mr = selectedMime
          ? new MediaRecorder(stream, { mimeType: selectedMime, videoBitsPerSecond: 6000000 })
          : new MediaRecorder(stream);
      } catch (err) {
        this._showTempNotice('无法启动 MediaRecorder 录屏器：' + err.message);
        return;
      }

      this.recorderState.active = true;
      this.recorderState.canvas = canvas;
      this.recorderState.ctx = ctx;
      this.recorderState.mediaRecorder = mr;
      this.recorderState.chunks = [];
      this.recorderState.startTime = performance.now();
      this.recorderState.subtitleBanner = null;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recorderState.chunks.push(e.data);
        }
      };

      mr.onstop = () => {
        const blob = new Blob(this.recorderState.chunks, {
          type: selectedMime || 'video/webm'
        });
        const ext = (selectedMime || '').includes('mp4') ? 'mp4' : 'webm';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeTag = (this.recorderState.titleTag || '历史演进').replace(/[\\/:*?"<>|\s]+/g, '_');
        a.download = `铁血山河_${safeTag}_1931-1958.${ext}`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1500);
        this._showTempNotice(`🎬 录屏已完成！视频《铁血山河_${safeTag}_1931-1958.${ext}》已自动下载保存。`);
      };

      mr.start(200);

      // 更新 UI 按钮状态
      this.btnRecStart.hidden = true;
      this.btnRecStop.hidden = false;
      this.recLivePill.hidden = false;
      this.recCard.hidden = true; // 自动收起面板以免遮挡视野

      // 启动 30FPS 合成渲染循环
      const renderLoop = (now) => {
        if (!this.recorderState.active) return;
        this._renderCompositeFrame(now);
        const elapsedSec = Math.floor((now - this.recorderState.startTime) / 1000);
        const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const ss = String(elapsedSec % 60).padStart(2, '0');
        this.recLiveStatus.textContent = `🔴 正在录制：${this.recorderState.titleTag} (${mm}:${ss})`;
        this.recorderState.rafId = requestAnimationFrame(renderLoop);
      };
      this.recorderState.rafId = requestAnimationFrame(renderLoop);

      // 根据模式启动自动推演脚本
      if (mode === 'timeline') {
        const sIdx = customOpts && customOpts.startIdx !== undefined ? customOpts.startIdx : Number(this.recTlStart.value);
        const eIdx = customOpts && customOpts.endIdx !== undefined ? customOpts.endIdx : Number(this.recTlEnd.value);
        const speedMs = customOpts && customOpts.speedMs ? customOpts.speedMs : Number(this.recTlSpeed.value || 2600);
        const fromIdx = Math.min(sIdx, eIdx);
        const toIdx = Math.max(sIdx, eIdx);
        this.recorderState.titleTag = `时间线演进_${this.allPhases[fromIdx].year}-${this.allPhases[toIdx].year}`;
        this.closePersonJourney();
        this.resetCameraView(false);

        let cur = fromIdx;
        this.selectPhaseByIndex(cur);
        this.recorderState.stepTimer = setInterval(() => {
          if (!this.recorderState.active) return;
          cur++;
          if (cur > toIdx) {
            setTimeout(() => this.stopVideoRecording(), 1200);
            clearInterval(this.recorderState.stepTimer);
            this.recorderState.stepTimer = null;
            return;
          }
          this.selectPhaseByIndex(cur);
        }, speedMs);
      } else if (mode === 'person') {
        const pName =
          customOpts && customOpts.personName
            ? customOpts.personName
            : this.recPersonSelect.value || '彭德怀';
        const speedMs =
          customOpts && customOpts.speedMs
            ? customOpts.speedMs
            : Number(this.recPersonSpeed.value || 3000);
        const person = this.persons[pName];
        if (!person) {
          this.stopVideoRecording();
          return;
        }
        this.recorderState.titleTag = `${person.name}_一生行迹路径`;
        this.startPersonJourney(pName);

        let stIdx = 0;
        this.recorderState.stepTimer = setInterval(() => {
          if (!this.recorderState.active) return;
          stIdx++;
          if (stIdx >= person.stops.length) {
            setTimeout(() => this.stopVideoRecording(), 1600);
            clearInterval(this.recorderState.stepTimer);
            this.recorderState.stepTimer = null;
            return;
          }
          this.stepPersonJourneyTo(stIdx);
        }, speedMs);
      } else if (mode === 'event') {
        let evObj = customOpts && customOpts.eventObj ? customOpts.eventObj : null;
        if (!evObj) {
          const evIdx = Number(this.recEventSelect.value || 0);
          evObj = this.allEvents[evIdx] || this.allEvents[0];
        }
        const durationMs =
          customOpts && customOpts.durationMs
            ? customOpts.durationMs
            : Number(this.recEventDuration.value || 9000);

        this.recorderState.titleTag = `战役推演_${evObj.name.split('（')[0]}`;
        this.closePersonJourney();

        if (evObj.phaseId) {
          const pIdx = this.allPhases.findIndex((p) => p.id === evObj.phaseId);
          if (pIdx >= 0) this.selectPhaseByIndex(pIdx);
        }
        this.activeHighlight = {
          type: 'event',
          name: evObj.name,
          coord: evObj.coord,
          year: evObj.year,
          month: evObj.month,
          level: evObj.level || '重大战役',
          scale: evObj.scale || '主力决战',
          desc: evObj.desc
        };
        this._drawGenealogyHighlight(evObj.coord);
        this.recorderState.subtitleBanner = {
          kicker: `⚔️ ${evObj.year}年${evObj.month ? evObj.month + '月' : ''} · ${evObj.level || '重大战役'} · 参战规模：${evObj.scale || '主力决战'}`,
          title: evObj.name,
          desc: evObj.desc
        };

        // 先展示全局态势 1.2 秒，再平滑推近聚焦至战役战区
        this.resetCameraView(false);
        setTimeout(() => {
          if (this.recorderState.active && evObj.coord) {
            this.flyToCoord(evObj.coord, 2.45, 1600);
          }
        }, 1100);

        this.recorderState.stepTimer = setTimeout(() => {
          if (this.recorderState.active) {
            this.stopVideoRecording();
          }
        }, durationMs);
      } else {
        this.recorderState.titleTag = '自由交互推演';
      }
    }

    stopVideoRecording() {
      if (!this.recorderState.active) return;
      this.recorderState.active = false;

      if (this.recorderState.stepTimer) {
        clearInterval(this.recorderState.stepTimer);
        clearTimeout(this.recorderState.stepTimer);
        this.recorderState.stepTimer = null;
      }
      if (this.recorderState.rafId) {
        cancelAnimationFrame(this.recorderState.rafId);
        this.recorderState.rafId = null;
      }
      if (
        this.recorderState.mediaRecorder &&
        this.recorderState.mediaRecorder.state !== 'inactive'
      ) {
        this.recorderState.mediaRecorder.stop();
      }

      this.btnRecStart.hidden = false;
      this.btnRecStop.hidden = true;
      this.recLivePill.hidden = true;
    }

    // ─── 将当前地图、动态行军箭矢、人物轨迹弧线与历史 HUD 实时合成绘制到 1600×1000 录屏画布 ───
    _renderCompositeFrame(now) {
      const ctx = this.recorderState.ctx;
      if (!ctx) return;
      const W = 1600;
      const H = 1000;

      // 1. 海洋底色
      ctx.fillStyle = '#cddbd9';
      ctx.fillRect(0, 0, W, H);

      // 计算 SVG (1000×700) 在画布中央可视区 (1600×840，顶部留 64px HUD，底部留 96px 字幕栏) 的等比缩放矩阵
      const mapAreaX = 0;
      const mapAreaY = 64;
      const mapAreaW = W;
      const mapAreaH = H - 64 - 96;
      const fitScale = Math.min(mapAreaW / 1000, mapAreaH / 700);
      const offsetX = mapAreaX + (mapAreaW - 1000 * fitScale) / 2;
      const offsetY = mapAreaY + (mapAreaH - 700 * fitScale) / 2;

      const phase = this.allPhases[this.currentPhaseIdx];
      const period = this.periods[phase.periodIdx];
      const snap = this.snapshots[phase.snapshot];

      ctx.save();
      ctx.beginPath();
      ctx.rect(mapAreaX, mapAreaY, mapAreaW, mapAreaH);
      ctx.clip();

      ctx.translate(offsetX, offsetY);
      ctx.scale(fitScale, fitScale);
      ctx.translate(this.cam.x, this.cam.y);
      ctx.scale(this.cam.k, this.cam.k);

      // 2. 绘制山川地形浮雕底图
      if (this.showTerrain && this.terrainImageReady) {
        try {
          ctx.save();
          ctx.globalAlpha = 0.46;
          ctx.drawImage(this.terrainImage, 0, 0, 1000, 700);
          ctx.restore();
        } catch (_) {
          // 忽略本地 file:// 跨域限制
        }
      }

      // 3. 绘制邻国与政权版图多边形
      if (snap && snap.polities) {
        snap.polities.forEach((pol) => {
          const d = this.projector.geometryToPath(pol.shape);
          if (!d) return;
          const p2d = new Path2D(d);
          if (pol.role === 'neighbor') {
            ctx.fillStyle = '#e8e1d3';
            ctx.fill(p2d);
            ctx.strokeStyle = '#b5a995';
            ctx.lineWidth = 0.7 / this.cam.k;
            ctx.stroke(p2d);
          } else {
            ctx.save();
            ctx.fillStyle = pol.tint || '#4f6d8f';
            ctx.globalAlpha = pol.role === 'main' ? 0.54 : pol.role === 'rival' ? 0.58 : 0.42;
            ctx.fill(p2d);
            ctx.restore();
            ctx.strokeStyle = 'rgba(50, 38, 28, 0.68)';
            ctx.lineWidth = 1.2 / this.cam.k;
            ctx.stroke(p2d);
          }
        });
      }

      // 4. 绘制省界虚线与江河湖泊
      ctx.save();
      ctx.strokeStyle = 'rgba(110, 96, 80, 0.28)';
      ctx.lineWidth = 0.75 / this.cam.k;
      ctx.setLineDash([3 / this.cam.k, 3 / this.cam.k]);
      this.cachedProvincePaths.forEach((d) => ctx.stroke(new Path2D(d)));
      ctx.restore();

      ctx.save();
      ctx.fillStyle = '#b8cac8';
      this.cachedLakePaths.forEach((d) => ctx.fill(new Path2D(d)));
      ctx.strokeStyle = '#5b89a6';
      this.cachedRiverPaths.forEach((rv) => {
        ctx.lineWidth = (rv.rank === 1 ? 1.4 : 0.9) / this.cam.k;
        ctx.stroke(new Path2D(rv.d));
      });
      ctx.restore();

      // 5. 绘制朱砂色虚线残影 (#grp-ghost-diff)
      if (this.showGhostDiff && this.currentGhostDiffPaths.length) {
        ctx.save();
        ctx.strokeStyle = '#d91e18';
        ctx.lineWidth = 2.4 / this.cam.k;
        ctx.setLineDash([7 / this.cam.k, 4.5 / this.cam.k]);
        ctx.lineDashOffset = -((now / 28) % 24) / this.cam.k;
        this.currentGhostDiffPaths.forEach((d) => {
          const p2d = new Path2D(d);
          ctx.fillStyle = 'rgba(201, 42, 42, 0.07)';
          ctx.fill(p2d);
          ctx.stroke(p2d);
        });
        ctx.restore();

        if (this.currentGhostLabel) {
          this._drawCanvasMapLabel(
            ctx,
            this.currentGhostLabel.text,
            this.currentGhostLabel.x,
            this.currentGhostLabel.y,
            3.8,
            '#b81d13',
            '#fffaf4'
          );
        }
      }

      // 6. 绘制政权与邻国名称 (1/3 精致比例)
      if (snap && snap.polities) {
        snap.polities.forEach((pol) => {
          if (!pol.anchor || !pol.title) return;
          const [ax, ay] = this.projector.project(pol.anchor);
          if (pol.role === 'neighbor') {
            this._drawCanvasMapLabel(ctx, pol.title, ax, ay, 3.8, 'rgba(92,80,66,0.75)', 'rgba(245,240,230,0.88)');
          } else {
            this._drawCanvasMapLabel(
              ctx,
              pol.title.replace(/（.*?）/g, ''),
              ax,
              ay,
              5.0,
              '#241c15',
              'rgba(252,249,242,0.92)'
            );
          }
        });
      }

      // 7. 绘制鲜艳战役进军路线与动态流光箭头
      if (this.showRoutes && period && period.campaignRoutes) {
        let routes = period.campaignRoutes.filter((r) => r.phaseId === phase.id);
        if (!routes.length) routes = period.campaignRoutes;

        routes.forEach((rt) => {
          if (!rt.points || rt.points.length < 2) return;
          const d = this._buildSmoothCurvePath(rt.points);
          const p2d = new Path2D(d);
          const color = rt.color || '#ff1e00';

          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          // 浅色衬底
          ctx.strokeStyle = 'rgba(255, 248, 230, 0.9)';
          ctx.lineWidth = 6.2 / this.cam.k;
          ctx.stroke(p2d);
          // 主干色线
          ctx.strokeStyle = color;
          ctx.lineWidth = 3.4 / this.cam.k;
          ctx.stroke(p2d);
          // 动态流光虚线
          ctx.strokeStyle = '#fffdf5';
          ctx.lineWidth = 1.9 / this.cam.k;
          ctx.setLineDash([7 / this.cam.k, 12 / this.cam.k]);
          ctx.lineDashOffset = -((now / 18) % 38) / this.cam.k;
          ctx.stroke(p2d);
          ctx.restore();

          // 绘制沿折线移动的动态箭头与终点箭头
          const projPts = rt.points.map((pt) => this.projector.project(pt));
          const prog = (now % 2600) / 2600;
          this._drawArrowAlongPoints(ctx, projPts, prog, color, 5.2 / this.cam.k);
          this._drawArrowAlongPoints(ctx, projPts, 0.99, color, 5.8 / this.cam.k);
        });
      }

      // 8. 绘制名城与重大战役节点 (1/3 字号比例)
      this.cities.forEach((city) => {
        const [cx, cy] = this.projector.project(city.coord);
        const isCap = city.tier === 'capital';
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, isCap ? 2.1 : 1.5, 0, Math.PI * 2);
        ctx.fillStyle = isCap ? '#c92a2a' : '#2b231d';
        ctx.fill();
        ctx.lineWidth = 0.65;
        ctx.strokeStyle = '#fffdf9';
        ctx.stroke();
        ctx.restore();

        this._drawCanvasMapLabel(
          ctx,
          city.name.split('（')[0],
          cx,
          cy - 3.6,
          isCap ? 4.5 : 4.0,
          isCap ? '#8f1d14' : '#231e19',
          '#fdfaf4'
        );
      });

      if (period && period.milestones) {
        period.milestones.forEach((ms) => {
          const [mx, my] = this.projector.project(ms.coord);
          const isCurr = ms.phaseId === phase.id;
          ctx.save();
          if (isCurr) {
            const pulseR = 2.5 + ((now % 1800) / 1800) * 6.5;
            ctx.beginPath();
            ctx.arc(mx, my, pulseR, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255, 42, 26, ${1 - (now % 1800) / 1800})`;
            ctx.lineWidth = 1.2 / this.cam.k;
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(mx, my, isCurr ? 2.4 : 1.9, 0, Math.PI * 2);
          ctx.fillStyle = ms.level.includes('转折') ? '#d97706' : '#d90429';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 0.7;
          ctx.stroke();
          ctx.restore();

          this._drawCanvasMapLabel(
            ctx,
            `⚔️ ${ms.name}`,
            mx + 4,
            my + 1.3,
            4.1,
            '#9e1b12',
            '#fffdf7',
            'left'
          );
        });
      }

      // 9. 若处于「点人溯事」模式，绘制人物动态行迹弧线与渐进动画
      if (this.activePerson) {
        const stops = this.activePerson.stops;
        const currIdx = this.journeyStopIdx;
        const arcElapsed = now - (this.recorderState.arcAnimStart || 0);
        const segProgress = Math.min(1, arcElapsed / 1400);

        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i].coord;
          const b = stops[i + 1].coord;
          const d = this._buildSmoothCurvePath([a, b]);
          const p2d = new Path2D(d);
          const projA = this.projector.project(a);
          const projB = this.projector.project(b);

          if (i < currIdx - 1) {
            ctx.save();
            ctx.strokeStyle = 'rgba(255,250,240,0.9)';
            ctx.lineWidth = 5.5 / this.cam.k;
            ctx.stroke(p2d);
            ctx.strokeStyle = '#e62e25';
            ctx.lineWidth = 3.0 / this.cam.k;
            ctx.stroke(p2d);
            ctx.restore();
            this._drawArrowAlongPoints(ctx, [projA, projB], 0.95, '#e62e25', 5.0 / this.cam.k);
          } else if (i === currIdx - 1 || (currIdx === 0 && i === 0)) {
            ctx.save();
            ctx.strokeStyle = 'rgba(255,250,240,0.95)';
            ctx.lineWidth = 7.0 / this.cam.k;
            ctx.stroke(p2d);
            ctx.strokeStyle = '#ff1e00';
            ctx.lineWidth = 4.2 / this.cam.k;
            ctx.stroke(p2d);
            ctx.strokeStyle = '#fffdf5';
            ctx.lineWidth = 2.0 / this.cam.k;
            ctx.setLineDash([7 / this.cam.k, 11 / this.cam.k]);
            ctx.lineDashOffset = -((now / 15) % 36) / this.cam.k;
            ctx.stroke(p2d);
            ctx.restore();

            const arrowT = segProgress < 1 ? segProgress : (now % 1800) / 1800;
            this._drawArrowAlongPoints(ctx, [projA, projB], arrowT, '#ffea00', 6.2 / this.cam.k);
          } else {
            ctx.save();
            ctx.strokeStyle = 'rgba(180, 60, 45, 0.42)';
            ctx.lineWidth = 2.0 / this.cam.k;
            ctx.setLineDash([4 / this.cam.k, 4 / this.cam.k]);
            ctx.stroke(p2d);
            ctx.restore();
          }
        }

        stops.forEach((st, i) => {
          const [sx, sy] = this.projector.project(st.coord);
          const isCurr = i === currIdx;
          ctx.save();
          if (isCurr) {
            ctx.beginPath();
            ctx.arc(sx, sy, 6.2 + Math.sin(now / 180) * 1.5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 30, 0, 0.24)';
            ctx.fill();
            ctx.strokeStyle = '#ff1e00';
            ctx.lineWidth = 1.1;
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(sx, sy, isCurr ? 3.5 : 2.6, 0, Math.PI * 2);
          ctx.fillStyle = isCurr ? '#ff1e00' : i < currIdx ? '#c92a2a' : '#fffdf8';
          ctx.fill();
          ctx.strokeStyle = '#1e1b18';
          ctx.lineWidth = 0.8;
          ctx.stroke();
          ctx.restore();

          this._drawCanvasMapLabel(
            ctx,
            `${i + 1}.${st.year}·${st.place.split('（')[0]}`,
            sx + 4.8,
            sy + 1.4,
            4.2,
            '#1e1b18',
            '#fffdf8',
            'left'
          );
        });
      }

      // 10. 若有选中城池/战役高亮靶标
      if (this.activeHighlight && this.activeHighlight.coord) {
        const [hx, hy] = this.projector.project(this.activeHighlight.coord);
        ctx.save();
        ctx.beginPath();
        ctx.arc(hx, hy, 6.5 + Math.sin(now / 160) * 1.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 30, 0, 0.18)';
        ctx.fill();
        ctx.strokeStyle = '#ff1e00';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore(); // 结束地图坐标空间

      // ─── 11. 绘制视频左下角实时政权兵力迷你图例 ───
      if (snap && snap.polities) {
        const mainPols = snap.polities.filter((p) => p.role !== 'neighbor').slice(0, 4);
        const legX = 20;
        const legH = mainPols.length * 28 + 34;
        const legY = H - 96 - legH - 14;
        ctx.save();
        ctx.fillStyle = 'rgba(251, 248, 242, 0.92)';
        ctx.strokeStyle = 'rgba(140, 65, 48, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(legX, legY, 340, legH, 10);
        ctx.fill();
        ctx.stroke();

        ctx.font = 'bold 13px "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#8f1d14';
        ctx.fillText('⚔️ 当前年代政权与兵力态势（含朱砂虚线残影）', legX + 12, legY + 21);

        mainPols.forEach((p, idx) => {
          const py = legY + 42 + idx * 26;
          ctx.fillStyle = p.tint || '#4f6d8f';
          ctx.fillRect(legX + 12, py - 11, 13, 13);
          ctx.fillStyle = '#1e1b18';
          ctx.font = 'bold 13px "Microsoft YaHei", sans-serif';
          const shortTitle = p.title.split('（')[0].slice(0, 13);
          ctx.fillText(shortTitle, legX + 32, py);
          if (p.troops) {
            ctx.fillStyle = '#c92a2a';
            ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
            ctx.fillText(p.troops, legX + 225, py);
          }
        });
        ctx.restore();
      }

      // ─── 12. 绘制视频顶部史诗标题栏 (Top HUD) ───
      ctx.save();
      ctx.fillStyle = '#f6f0e4';
      ctx.fillRect(0, 0, W, 64);
      ctx.strokeStyle = 'rgba(74, 62, 48, 0.3)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 64);
      ctx.lineTo(W, 64);
      ctx.stroke();

      // 朱砂印章
      ctx.fillStyle = '#c92a2a';
      ctx.beginPath();
      ctx.roundRect(18, 12, 40, 40, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 17px "Noto Serif SC", "Microsoft YaHei", serif';
      ctx.fillText('山河', 21, 38);

      ctx.fillStyle = '#1e1b18';
      ctx.font = 'bold 22px "Noto Serif SC", "Microsoft YaHei", serif';
      ctx.fillText('铁血山河 · 中国近代战争与解放战争全史舆图 (1931—1958)', 70, 34);
      ctx.fillStyle = '#63584e';
      ctx.font = '13px "Microsoft YaHei", sans-serif';
      ctx.fillText('动态疆域演进 · 朱砂虚线残影 · 城池战役溯源 · 将帅一生行迹', 70, 53);

      // 右侧当前年代胶囊
      const stageStr = `${phase.dateLabel || phase.year + '年'} · ${phase.label}`;
      ctx.font = 'bold 18px "Noto Serif SC", "Microsoft YaHei", serif';
      const pillW = Math.max(280, ctx.measureText(stageStr).width + 44);
      ctx.fillStyle = '#c92a2a';
      ctx.beginPath();
      ctx.roundRect(W - pillW - 22, 13, pillW, 38, 19);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(stageStr, W - pillW - 2, 38);
      ctx.restore();

      // ─── 13. 绘制视频底部编年/人物行迹/战役推演字幕栏 (Bottom HUD) ───
      ctx.save();
      ctx.fillStyle = '#261e19';
      ctx.fillRect(0, H - 96, W, 96);
      ctx.fillStyle = '#c92a2a';
      ctx.fillRect(0, H - 96, W, 3);

      if (this.activePerson) {
        const p = this.activePerson;
        const st = p.stops[this.journeyStopIdx];
        ctx.fillStyle = '#ffd43b';
        ctx.font = 'bold 16px "Microsoft YaHei", sans-serif';
        ctx.fillText(
          `👣 点人溯事 · ${p.name}（${p.title}） — 第 ${this.journeyStopIdx + 1} / ${p.stops.length} 站：${st.year}年 · ${st.place}`,
          24,
          H - 64
        );
        ctx.fillStyle = '#fffdf8';
        ctx.font = 'bold 15px "Noto Serif SC", "Microsoft YaHei", serif';
        const quoteLine = st.poemTitle ? `${st.poemTitle}：“${st.poemLine}”` : st.poemLine || '';
        ctx.fillText(quoteLine, 24, H - 39);
        ctx.fillStyle = '#e5d9c8';
        ctx.font = '14px "Microsoft YaHei", sans-serif';
        ctx.fillText((st.note || '').slice(0, 92), 24, H - 15);
      } else if (this.recorderState.subtitleBanner) {
        const sb = this.recorderState.subtitleBanner;
        ctx.fillStyle = '#ffd43b';
        ctx.font = 'bold 15px "Microsoft YaHei", sans-serif';
        ctx.fillText(sb.kicker, 24, H - 64);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 19px "Noto Serif SC", "Microsoft YaHei", serif';
        ctx.fillText(`⚔️ ${sb.title}`, 24, H - 38);
        ctx.fillStyle = '#e5d9c8';
        ctx.font = '14px "Microsoft YaHei", sans-serif';
        ctx.fillText((sb.desc || '').slice(0, 95), 24, H - 14);
      } else {
        const rulersStr = (period.rulers || []).map((r) => `${r.name}（${r.title.split('/')[0].trim()}）`).join(' / ');
        ctx.fillStyle = '#ffd43b';
        ctx.font = 'bold 16px "Microsoft YaHei", sans-serif';
        ctx.fillText(
          `📅 ${phase.dateLabel || phase.year + '年'} · ${period.name}（${phase.label}）   👑 最高统帅：${rulersStr}`,
          24,
          H - 62
        );
        ctx.fillStyle = '#fffdf8';
        ctx.font = '14.5px "Microsoft YaHei", sans-serif';
        const capText = snap && snap.caption ? snap.caption : period.overview;
        ctx.fillText(capText.slice(0, 92), 24, H - 36);
        ctx.fillStyle = '#d3c4b1';
        ctx.font = '13.5px "Microsoft YaHei", sans-serif';
        ctx.fillText(`🎖️ 时期元帅与主将：${(period.marshals || '').slice(0, 82)}`, 24, H - 14);
      }
      ctx.restore();
    }

    _drawCanvasMapLabel(ctx, text, x, y, fontSize, fill, stroke, align = 'center') {
      ctx.save();
      ctx.font = `bold ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = fontSize * 0.26;
      ctx.strokeStyle = stroke;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = fill;
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    _drawArrowAlongPoints(ctx, pts, t, color, size) {
      if (!pts || pts.length < 2) return;
      const segs = [];
      let totalLen = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const dx = pts[i + 1][0] - pts[i][0];
        const dy = pts[i + 1][1] - pts[i][1];
        const len = Math.hypot(dx, dy);
        segs.push({ a: pts[i], b: pts[i + 1], len, angle: Math.atan2(dy, dx) });
        totalLen += len;
      }
      if (totalLen <= 0.01) return;
      let targetDist = Math.max(0, Math.min(1, t)) * totalLen;
      let chosen = segs[segs.length - 1];
      let localT = 1;
      for (const s of segs) {
        if (targetDist <= s.len || s.len === 0) {
          chosen = s;
          localT = s.len > 0 ? targetDist / s.len : 0;
          break;
        }
        targetDist -= s.len;
      }
      const ax = chosen.a[0] + (chosen.b[0] - chosen.a[0]) * localT;
      const ay = chosen.a[1] + (chosen.b[1] - chosen.a[1]) * localT;

      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(chosen.angle);
      ctx.beginPath();
      ctx.moveTo(size, 0);
      ctx.lineTo(-size * 0.85, -size * 0.65);
      ctx.lineTo(-size * 0.4, 0);
      ctx.lineTo(-size * 0.85, size * 0.65);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fffdf0';
      ctx.lineWidth = size * 0.22;
      ctx.stroke();
      ctx.restore();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 6. 搜索框联想（人物、名城、重大战役一键直达）
    // ═════════════════════════════════════════════════════════════════════════
    _renderSearchSuggestions(query) {
      const q = (query || '').trim().toLowerCase();
      let html = '';

      const personKeys = Object.keys(this.persons);
      html += `
        <div class="suggest-section-title">
          <span>👣 点人溯事 · 核心统帅名将（点击沿着弧线走完一生）</span>
        </div>
        <div class="suggest-person-pills">
          ${personKeys
            .map((name) => `<span class="person-quick-chip" data-p="${name}">${name}</span>`)
            .join('')}
        </div>
      `;

      const matchedItems = [];
      personKeys.forEach((name) => {
        const p = this.persons[name];
        if (!q || name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)) {
          matchedItems.push({
            type: 'person',
            badge: '点人溯事',
            name: p.name,
            meta: `${p.title.split('·')[0]}（共 ${p.stops.length} 站行迹）`,
            action: () => this.startPersonJourney(p.name)
          });
        }
      });

      this.cities.forEach((c) => {
        const hit =
          !q ||
          c.name.toLowerCase().includes(q) ||
          (c.aliases || []).some((a) => a.toLowerCase().includes(q));
        if (hit) {
          matchedItems.push({
            type: 'city',
            badge: '点地溯源',
            name: c.name,
            meta: c.tagline.split('·')[0],
            action: () => this.openCityProvenance(c)
          });
        }
      });

      this.periods.forEach((p) => {
        (p.milestones || []).forEach((ms) => {
          if (q && (ms.name.toLowerCase().includes(q) || ms.desc.toLowerCase().includes(q))) {
            matchedItems.push({
              type: 'battle',
              badge: ms.level,
              name: `${ms.year}.${ms.month} · ${ms.name}`,
              meta: ms.scale,
              action: () => this.openProvenanceByMilestoneOrFort(ms)
            });
          }
        });
      });

      html += matchedItems
        .slice(0, 14)
        .map(
          (it, idx) => `
          <div class="suggest-item" data-s-idx="${idx}">
            <div class="suggest-item-main">
              <span class="suggest-badge ${it.type}">${it.badge}</span>
              <span class="suggest-name">${it.name}</span>
            </div>
            <span class="suggest-meta">${it.meta}</span>
          </div>
        `
        )
        .join('');

      this.suggestBox.innerHTML = html;
      this.suggestBox.hidden = false;

      this.suggestBox.querySelectorAll('.person-quick-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          this.suggestBox.hidden = true;
          this.startPersonJourney(chip.dataset.p);
        });
      });

      this.suggestBox.querySelectorAll('.suggest-item').forEach((el) => {
        const item = matchedItems[Number(el.dataset.sIdx)];
        el.addEventListener('click', () => {
          this.suggestBox.hidden = true;
          if (item && item.action) item.action();
        });
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 7. 地图相机平移、精准中心缩放、全图归位与平滑飞行
    // ═════════════════════════════════════════════════════════════════════════
    _applyCameraTransform() {
      this.mapCanvas.setAttribute(
        'transform',
        `translate(${this.cam.x.toFixed(2)},${this.cam.y.toFixed(2)}) scale(${this.cam.k.toFixed(3)})`
      );
      const pct = Math.round(this.cam.k * 100);
      if (this.zoomPctLabel) this.zoomPctLabel.textContent = `${pct}%`;
      if (this.navZoomText) this.navZoomText.textContent = `${pct}%`;
      if (this.inpZoomSlider) {
        this.inpZoomSlider.value = String(Math.max(60, Math.min(600, pct)));
      }
    }

    // 以指定 SVG 根视口坐标 (pivotX, pivotY) 为锚点进行精准缩放
    zoomAtSvgPoint(targetK, pivotX = 500, pivotY = 350, smooth = false) {
      const nextK = Math.max(0.6, Math.min(6.0, targetK));
      const ratio = nextK / this.cam.k;
      const targetX = pivotX - (pivotX - this.cam.x) * ratio;
      const targetY = pivotY - (pivotY - this.cam.y) * ratio;

      if (!smooth) {
        this.cam.x = targetX;
        this.cam.y = targetY;
        this.cam.k = nextK;
        this._applyCameraTransform();
      } else {
        this._animateCameraTo(targetX, targetY, nextK, 220);
      }
    }

    zoomByFactor(factor, pivotX = 500, pivotY = 350, smooth = true) {
      this.zoomAtSvgPoint(this.cam.k * factor, pivotX, pivotY, smooth);
    }

    // 恢复 100% 初始全图视野
    resetCameraView(smooth = true) {
      if (!smooth) {
        this.cam = { x: 0, y: 0, k: 1.0 };
        this._applyCameraTransform();
      } else {
        this._animateCameraTo(0, 0, 1.0, 360);
      }
    }

    // 聚焦中国核心战区视野
    focusChinaTheater(smooth = true) {
      const target = { x: -165, y: -45, k: 1.48 };
      if (!smooth) {
        this.cam = target;
        this._applyCameraTransform();
      } else {
        this._animateCameraTo(target.x, target.y, target.k, 380);
      }
    }

    flyToCoord(coord, targetScale = 2.1, duration = 520) {
      if (!coord) return;
      const [px, py] = this.projector.project(coord);
      const k = Math.max(0.8, Math.min(5.0, targetScale));
      const targetX = 500 - px * k;
      const targetY = 350 - py * k;
      this._animateCameraTo(targetX, targetY, k, duration);
    }

    _animateCameraTo(targetX, targetY, targetK, duration = 420) {
      if (this.camAnimFrame) {
        cancelAnimationFrame(this.camAnimFrame);
      }
      const startX = this.cam.x;
      const startY = this.cam.y;
      const startK = this.cam.k;
      const startTime = performance.now();

      const step = (now) => {
        const t = Math.min(1, (now - startTime) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        this.cam.x = startX + (targetX - startX) * ease;
        this.cam.y = startY + (targetY - startY) * ease;
        this.cam.k = startK + (targetK - startK) * ease;
        this._applyCameraTransform();
        if (t < 1) {
          this.camAnimFrame = requestAnimationFrame(step);
        } else {
          this.camAnimFrame = null;
        }
      };
      this.camAnimFrame = requestAnimationFrame(step);
    }

    // 屏幕像素坐标 -> SVG 根 viewBox (1000×700) 坐标（不受 preserveAspectRatio meet 黑边影响）
    _clientToSvgRootCoord(clientX, clientY) {
      const pt = this.svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const ctm = this.svg.getScreenCTM();
      if (!ctm) return { x: 500, y: 350 };
      return pt.matrixTransform(ctm.inverse());
    }

    // 屏幕像素坐标 -> #map-canvas 内部地图坐标
    _clientToSvgMapCoord(clientX, clientY) {
      const pt = this.svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const ctm = this.mapCanvas.getScreenCTM();
      if (!ctm) return { x: 500, y: 350 };
      return pt.matrixTransform(ctm.inverse());
    }

    _showTooltip(e, html) {
      this.tooltip.innerHTML = html;
      this.tooltip.hidden = false;
      this._moveTooltip(e);
    }

    _moveTooltip(e) {
      if (this.tooltip.hidden) return;
      const x = Math.min(window.innerWidth - 330, Math.max(8, e.clientX + 14));
      const y = Math.min(window.innerHeight - 110, Math.max(8, e.clientY + 14));
      this.tooltip.style.left = `${x}px`;
      this.tooltip.style.top = `${y}px`;
    }

    _hideTooltip() {
      this.tooltip.hidden = true;
    }

    _showTempNotice(msg) {
      this.tooltip.innerHTML = `<strong>💡 提示</strong><br/>${msg}`;
      this.tooltip.hidden = false;
      this.tooltip.style.left = '50%';
      this.tooltip.style.top = '68px';
      this.tooltip.style.transform = 'translateX(-50%)';
      setTimeout(() => {
        this.tooltip.hidden = true;
        this.tooltip.style.transform = '';
      }, 3600);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 8. 全局事件绑定
    // ═════════════════════════════════════════════════════════════════════════
    _bindEvents() {
      // 地图拖拽平移（基于精确 SVG 根坐标差值，任何窗口宽高比下 1:1 跟手）
      this.viewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('aside, section, #zoom-controls, #recording-live-pill, button, input, select')) {
          return;
        }
        this.isDragging = true;
        this.hasMoved = false;
        this.dragStartClient = { x: e.clientX, y: e.clientY };
        this.dragStartSvg = this._clientToSvgRootCoord(e.clientX, e.clientY);
        this.viewport.classList.add('dragging');
      });

      window.addEventListener('mousemove', (e) => {
        if (!this.isDragging) return;
        const dxClient = e.clientX - this.dragStartClient.x;
        const dyClient = e.clientY - this.dragStartClient.y;
        if (Math.abs(dxClient) > 3 || Math.abs(dyClient) > 3) this.hasMoved = true;

        const currSvg = this._clientToSvgRootCoord(e.clientX, e.clientY);
        this.cam.x += currSvg.x - this.dragStartSvg.x;
        this.cam.y += currSvg.y - this.dragStartSvg.y;
        this.dragStartSvg = currSvg;
        this._applyCameraTransform();
      });

      window.addEventListener('mouseup', (e) => {
        if (this.isDragging && !this.hasMoved && this.quizState.active) {
          this._handleQuizMapClick(e);
        }
        this.isDragging = false;
        this.viewport.classList.remove('dragging');
      });

      // 滚轮缩放（精准围绕鼠标所在地理位置缩放）
      this.viewport.addEventListener(
        'wheel',
        (e) => {
          if (e.target.closest('aside, section')) return;
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.16 : 0.86;
          const pivot = this._clientToSvgRootCoord(e.clientX, e.clientY);
          this.zoomAtSvgPoint(this.cam.k * factor, pivot.x, pivot.y, false);
        },
        { passive: false }
      );

      // 右下角与顶部导航栏的视图缩放按钮群
      document.getElementById('btn-zoom-in').addEventListener('click', () => {
        this.zoomByFactor(1.25, 500, 350, true);
      });
      document.getElementById('btn-zoom-out').addEventListener('click', () => {
        this.zoomByFactor(0.8, 500, 350, true);
      });
      document.getElementById('btn-zoom-full').addEventListener('click', () => {
        this.resetCameraView(true);
      });
      document.getElementById('btn-zoom-china').addEventListener('click', () => {
        this.focusChinaTheater(true);
      });

      document.getElementById('btn-nav-zoom-in').addEventListener('click', () => {
        this.zoomByFactor(1.25, 500, 350, true);
      });
      document.getElementById('btn-nav-zoom-out').addEventListener('click', () => {
        this.zoomByFactor(0.8, 500, 350, true);
      });
      document.getElementById('btn-reset-view').addEventListener('click', () => {
        this.resetCameraView(true);
      });
      document.getElementById('btn-focus-china').addEventListener('click', () => {
        this.focusChinaTheater(true);
      });

      if (this.inpZoomSlider) {
        this.inpZoomSlider.addEventListener('input', () => {
          const targetK = Number(this.inpZoomSlider.value) / 100;
          this.zoomAtSvgPoint(targetK, 500, 350, false);
        });
      }

      // 时间轴滑块拖拽与上下步进
      this.inpTimeline.addEventListener('input', () => {
        this.selectPhaseByIndex(Number(this.inpTimeline.value));
      });
      document.getElementById('btn-phase-prev').addEventListener('click', () => {
        this.selectPhaseByIndex(this.currentPhaseIdx - 1);
      });
      document.getElementById('btn-phase-next').addEventListener('click', () => {
        this.selectPhaseByIndex(this.currentPhaseIdx + 1);
      });

      // 顶部图层开关
      const btnRoutes = document.getElementById('btn-toggle-routes');
      btnRoutes.addEventListener('click', () => {
        this.showRoutes = !this.showRoutes;
        btnRoutes.classList.toggle('active', this.showRoutes);
        const currPhase = this.allPhases[this.currentPhaseIdx];
        this._renderCampaignRoutes(this.periods[currPhase.periodIdx], currPhase);
      });

      const btnGhost = document.getElementById('btn-toggle-ghost');
      btnGhost.addEventListener('click', () => {
        this.showGhostDiff = !this.showGhostDiff;
        btnGhost.classList.toggle('active', this.showGhostDiff);
        const currPhase = this.allPhases[this.currentPhaseIdx];
        this._renderGhostDiff(this.prevSnapshotKey, currPhase.snapshot);
        this._renderLegendBox(currPhase, this.periods[currPhase.periodIdx]);
      });

      const btnTerrain = document.getElementById('btn-toggle-terrain');
      btnTerrain.addEventListener('click', () => {
        this.showTerrain = !this.showTerrain;
        btnTerrain.classList.toggle('active', this.showTerrain);
        this.grpTerrain.style.display = this.showTerrain ? '' : 'none';
      });

      // 左下角图例折叠开关
      document.getElementById('map-key-toggle').addEventListener('click', () => {
        this.mapKey.classList.toggle('collapsed');
      });

      // 点地溯源卡片关闭与一键录制此战役/城池
      document.getElementById('btn-close-genealogy').addEventListener('click', () => {
        this.genCard.hidden = true;
        this.grpGenealogy.innerHTML = '';
        this.activeHighlight = null;
      });
      document.getElementById('btn-gen-record').addEventListener('click', () => {
        if (this.activeHighlight) {
          this.startVideoRecording({
            mode: 'event',
            eventObj: this.activeHighlight,
            durationMs: 8500
          });
        }
      });

      // 点人溯事按钮绑定（含一键录制此人行迹）
      document.getElementById('btn-jrn-prev').addEventListener('click', () => {
        this.stepPersonJourneyTo(this.journeyStopIdx - 1);
      });
      document.getElementById('btn-jrn-next').addEventListener('click', () => {
        this.stepPersonJourneyTo(this.journeyStopIdx + 1);
      });
      this.btnJrnPlay.addEventListener('click', () => this.toggleJourneyAutoPlay());
      document.getElementById('btn-jrn-record').addEventListener('click', () => {
        if (this.activePerson) {
          this.startVideoRecording({
            mode: 'person',
            personName: this.activePerson.name,
            speedMs: 2800
          });
        }
      });
      document.getElementById('btn-jrn-close').addEventListener('click', () => this.closePersonJourney());
      this.inpJrnStep.addEventListener('input', () => {
        this.stepPersonJourneyTo(Number(this.inpJrnStep.value));
      });

      // 录屏工坊事件绑定
      document.getElementById('btn-open-recorder').addEventListener('click', () => {
        if (this.recCard.hidden) {
          this.openRecorderStudio();
        } else {
          this.recCard.hidden = true;
        }
      });
      document.getElementById('btn-close-recorder').addEventListener('click', () => {
        this.recCard.hidden = true;
      });
      document.querySelectorAll('#rec-mode-tabs .rec-mode-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          this._switchRecorderTab(tab.dataset.mode);
        });
      });
      this.btnRecStart.addEventListener('click', () => this.startVideoRecording());
      this.btnRecStop.addEventListener('click', () => this.stopVideoRecording());
      document.getElementById('btn-rec-stop-inline').addEventListener('click', () => {
        this.stopVideoRecording();
      });

      // 舆图寻址小试按钮绑定
      document.getElementById('btn-start-quiz').addEventListener('click', () => this.startQuizChallenge());
      document.getElementById('btn-close-quiz').addEventListener('click', () => this.closeQuizChallenge());
      this.btnQuizConfirm.addEventListener('click', () => this._confirmQuizAnswer());
      this.btnQuizNext.addEventListener('click', () => this._nextQuizStep());

      // 搜索框交互
      this.inpSearch.addEventListener('focus', () => {
        this._renderSearchSuggestions(this.inpSearch.value);
      });
      this.inpSearch.addEventListener('input', () => {
        this._renderSearchSuggestions(this.inpSearch.value);
      });
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.nav-search-cluster')) {
          this.suggestBox.hidden = true;
        }
      });

      // 键盘快捷键支持
      window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (this.activePerson) {
          if (e.key === 'ArrowLeft') this.stepPersonJourneyTo(this.journeyStopIdx - 1);
          else if (e.key === 'ArrowRight') this.stepPersonJourneyTo(this.journeyStopIdx + 1);
          else if (e.key === ' ') {
            e.preventDefault();
            this.toggleJourneyAutoPlay();
          }
        } else {
          if (e.key === 'ArrowLeft') this.selectPhaseByIndex(this.currentPhaseIdx - 1);
          else if (e.key === 'ArrowRight') this.selectPhaseByIndex(this.currentPhaseIdx + 1);
        }
      });
    }
  }

  // 启动舆图应用
  window.addEventListener('DOMContentLoaded', () => {
    window.warAtlasApp = new WarAtlasController();
  });
})();
