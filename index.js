module.exports = function activate(api) {
  const GAME_SCREENS = new Set(['campaign', 'sandbox', 'editor']);
  const DEFAULTS = {
    mode: 'adaptive',
    fixedCycleSec: 6.0,
    targetOccupancy: 0.24,
    minCycleSec: 3.5,
    maxCycleSec: 14.0,
    greenPhaseSec: 1.6,
    queueFlushThreshold: 6,
  };
  const OVERRIDE_FIELDS = [
    'mode',
    'fixedCycleSec',
    'targetOccupancy',
    'minCycleSec',
    'maxCycleSec',
    'greenPhaseSec',
    'queueFlushThreshold',
  ];

  function clampNum(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let active = Boolean(api.storage.get('enabled', true));
  const storedMode = api.storage.get('mode', DEFAULTS.mode);
  let globalMode = storedMode === 'fixed' ? 'fixed' : 'adaptive';
  let globalFixedCycleSec = clampNum(api.storage.get('fixedCycleSec', DEFAULTS.fixedCycleSec), 3.0, 14.0, DEFAULTS.fixedCycleSec);
  let globalTargetOccupancy = clampNum(api.storage.get('targetOccupancy', DEFAULTS.targetOccupancy), 0.10, 0.50, DEFAULTS.targetOccupancy);
  let globalMinCycleSec = clampNum(api.storage.get('minCycleSec', DEFAULTS.minCycleSec), 2.5, 8.0, DEFAULTS.minCycleSec);
  let globalMaxCycleSec = Math.max(
    globalMinCycleSec + 0.5,
    clampNum(api.storage.get('maxCycleSec', DEFAULTS.maxCycleSec), 6.0, 20.0, DEFAULTS.maxCycleSec),
  );
  let globalGreenPhaseSec = clampNum(api.storage.get('greenPhaseSec', DEFAULTS.greenPhaseSec), 0.8, 4.0, DEFAULTS.greenPhaseSec);
  let globalQueueFlushThreshold = clampInt(api.storage.get('queueFlushThreshold', DEFAULTS.queueFlushThreshold), 0, 15, DEFAULTS.queueFlushThreshold);
  let panelCollapsed = Boolean(api.storage.get('panelCollapsed', false));
  let showGlobalDefaults = Boolean(api.storage.get('showGlobalDefaults', false));
  let disabledConnIds = new Set(
    (Array.isArray(api.storage.get('disabledConns', [])) ? api.storage.get('disabledConns', []) : [])
      .map(Number)
      .filter(Number.isFinite),
  );

  /** @type {Map<number, { name?: string; mode?: 'adaptive' | 'fixed'; fixedCycleSec?: number; targetOccupancy?: number; minCycleSec?: number; maxCycleSec?: number; greenPhaseSec?: number; queueFlushThreshold?: number }>} */
  const meterConfigs = loadMeterConfigs(api.storage.get('meterConfigs', {}));

  /** @type {Map<number, { conn: any; cycleSec: number; timer: number; color: 'red' | 'green'; mainlineOcc: number; rampQueue: number; released: number }>} */
  const meters = new Map();
  let selectedConnId = null;
  let lastSimTime = api.sim.getTime();
  let lastHudRefresh = 0;
  let mountedCard = null;

  function loadMeterConfigs(raw) {
    const map = new Map();
    if (!raw || typeof raw !== 'object') return map;
    for (const [key, entry] of Object.entries(raw)) {
      const id = Number(key);
      if (!Number.isFinite(id) || !entry || typeof entry !== 'object') continue;
      const clean = {};
      if (typeof entry.name === 'string' && entry.name.trim()) {
        clean.name = entry.name.trim().slice(0, 24);
      }
      if (entry.mode === 'adaptive' || entry.mode === 'fixed') {
        clean.mode = entry.mode;
      }
      if (entry.fixedCycleSec !== undefined) {
        clean.fixedCycleSec = clampNum(entry.fixedCycleSec, 3.0, 14.0, DEFAULTS.fixedCycleSec);
      }
      if (entry.targetOccupancy !== undefined) {
        clean.targetOccupancy = clampNum(entry.targetOccupancy, 0.10, 0.50, DEFAULTS.targetOccupancy);
      }
      if (entry.minCycleSec !== undefined) {
        clean.minCycleSec = clampNum(entry.minCycleSec, 2.5, 8.0, DEFAULTS.minCycleSec);
      }
      if (entry.maxCycleSec !== undefined) {
        clean.maxCycleSec = clampNum(entry.maxCycleSec, 6.0, 20.0, DEFAULTS.maxCycleSec);
      }
      if (entry.greenPhaseSec !== undefined) {
        clean.greenPhaseSec = clampNum(entry.greenPhaseSec, 0.8, 4.0, DEFAULTS.greenPhaseSec);
      }
      if (entry.queueFlushThreshold !== undefined) {
        clean.queueFlushThreshold = clampInt(entry.queueFlushThreshold, 0, 15, DEFAULTS.queueFlushThreshold);
      }
      if (Object.keys(clean).length > 0) {
        map.set(id, clean);
      }
    }
    return map;
  }

  function hasParamOverrides(ov) {
    if (!ov) return false;
    return OVERRIDE_FIELDS.some((k) => ov[k] !== undefined);
  }

  function resolveMeterConfig(id) {
    const ov = meterConfigs.get(id);
    const modeOverride = ov && (ov.mode === 'adaptive' || ov.mode === 'fixed') ? ov.mode : null;
    const mode = modeOverride || globalMode;
    const fixedCycleSec = ov && ov.fixedCycleSec !== undefined ? ov.fixedCycleSec : globalFixedCycleSec;
    const targetOccupancy = ov && ov.targetOccupancy !== undefined ? ov.targetOccupancy : globalTargetOccupancy;
    const minCycleSec = ov && ov.minCycleSec !== undefined ? ov.minCycleSec : globalMinCycleSec;
    const rawMaxCycle = ov && ov.maxCycleSec !== undefined ? ov.maxCycleSec : globalMaxCycleSec;
    const maxCycleSec = Math.max(minCycleSec + 0.5, rawMaxCycle);
    const greenPhaseSec = ov && ov.greenPhaseSec !== undefined ? ov.greenPhaseSec : globalGreenPhaseSec;
    const queueFlushThreshold = ov && ov.queueFlushThreshold !== undefined ? ov.queueFlushThreshold : globalQueueFlushThreshold;

    return {
      name: ov && ov.name ? ov.name : '',
      mode,
      modeSource: modeOverride ? 'custom' : 'inherit',
      fixedCycleSec,
      targetOccupancy,
      minCycleSec,
      maxCycleSec,
      greenPhaseSec,
      queueFlushThreshold,
      hasOverrides: hasParamOverrides(ov),
      hasCustomizations: Boolean((ov && ov.name) || hasParamOverrides(ov)),
      overrides: ov || {},
    };
  }

  function formatMeterLabel(id, cfg) {
    return cfg && cfg.name ? cfg.name : `Ramp #${id}`;
  }

  function formatFieldValue(field, val) {
    switch (field) {
      case 'fixedCycleSec':
      case 'minCycleSec':
      case 'maxCycleSec':
      case 'greenPhaseSec':
        return `${Number(val).toFixed(1)}s`;
      case 'targetOccupancy':
        return `${Math.round(Number(val) * 100)}%`;
      case 'queueFlushThreshold':
        return Number(val) <= 0 ? 'Off' : `${Math.round(Number(val))} veh`;
      default:
        return String(val);
    }
  }

  api.overlay.addStyle(`
    .rm-panel {
      width: 284px;
      max-width: calc(100vw - 24px);
      box-sizing: border-box;
      position: relative;
      z-index: 50;
      padding: 10px 12px;
      border-radius: 14px;
      background: rgb(255 255 255 / 0.88);
      backdrop-filter: blur(22px) saturate(1.3);
      box-shadow: 0 10px 30px rgb(20 26 12 / 0.2), inset 0 0 0 1px rgb(255 255 255 / 0.65);
      color: #1c1d18;
      font: 500 12px/1.35 "Highway UI", system-ui, sans-serif;
    }
    .rm-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    .rm-title {
      font-weight: 700;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .rm-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #9ca3af;
    }
    .rm-dot.on {
      background: #16a34a;
      box-shadow: 0 0 0 3px rgb(22 163 74 / 0.2);
    }
    .rm-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 6px;
    }
    .rm-btn {
      border: 1px solid rgb(28 29 24 / 0.16);
      background: rgb(255 255 255 / 0.72);
      color: #1c1d18;
      border-radius: 8px;
      padding: 4px 8px;
      font: 600 11px/1.2 inherit;
      cursor: pointer;
    }
    .rm-btn.on {
      background: #1d5fbf;
      border-color: #1d5fbf;
      color: #fff;
    }
    .rm-btn.xs {
      padding: 2px 6px;
      font-size: 10px;
      border-radius: 6px;
    }
    .rm-btn.danger {
      color: #b91c1c;
      border-color: rgb(185 28 28 / 0.24);
    }
    .rm-list {
      margin-top: 8px;
      max-height: 156px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .rm-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 5px 7px;
      border-radius: 8px;
      background: rgb(28 29 24 / 0.05);
      border: 1px solid transparent;
      font-size: 11px;
      cursor: pointer;
    }
    .rm-item:hover {
      background: rgb(28 29 24 / 0.09);
    }
    .rm-item.selected {
      background: rgb(29 95 191 / 0.11);
      border-color: rgb(29 95 191 / 0.45);
    }
    .rm-item-left {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      flex: 1;
    }
    .rm-item-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .rm-tag {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 4px;
      background: rgb(29 95 191 / 0.14);
      color: #1d5fbf;
      flex-shrink: 0;
    }
    .rm-item-meta {
      font-family: "Highway UI Mono", ui-monospace, monospace;
      color: rgb(28 29 24 / 0.68);
      font-size: 10.5px;
      flex-shrink: 0;
    }
    .rm-badge-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      padding: 0;
      border: none;
      background: transparent;
      border-radius: 50%;
      cursor: pointer;
      flex-shrink: 0;
    }
    .rm-badge-btn:hover {
      background: rgb(28 29 24 / 0.1);
    }
    .rm-badge {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .rm-slider {
      width: 100%;
      margin-top: 2px;
    }
    .rm-slider-row {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 1px;
      margin-top: 6px;
      font-size: 11px;
    }
    .rm-slider-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .rm-slider-label {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .rm-subbox {
      margin-top: 8px;
      padding: 8px 9px;
      border-radius: 10px;
      background: rgb(28 29 24 / 0.045);
      border: 1px solid rgb(28 29 24 / 0.1);
    }
    .rm-subhead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 4px;
    }
    .rm-name-input {
      flex: 1;
      width: 0;
      min-width: 0;
      box-sizing: border-box;
      border: 1px solid rgb(28 29 24 / 0.18);
      background: rgb(255 255 255 / 0.78);
      color: #1c1d18;
      border-radius: 6px;
      padding: 3px 6px;
      font: 600 11px/1.2 inherit;
    }
    .rm-name-input:focus {
      outline: 2px solid rgb(29 95 191 / 0.35);
      border-color: #1d5fbf;
    }
    .rm-reset-link {
      border: none;
      background: transparent;
      color: #1d5fbf;
      font: 700 10px/1 inherit;
      padding: 1px 3px;
      cursor: pointer;
    }
    .rm-hint {
      margin-top: 6px;
      font-size: 10.5px;
      color: rgb(28 29 24 / 0.62);
    }
  `);

  function savePrefs() {
    api.storage.set('enabled', active);
    api.storage.set('mode', globalMode);
    api.storage.set('fixedCycleSec', globalFixedCycleSec);
    api.storage.set('targetOccupancy', globalTargetOccupancy);
    api.storage.set('minCycleSec', globalMinCycleSec);
    api.storage.set('maxCycleSec', globalMaxCycleSec);
    api.storage.set('greenPhaseSec', globalGreenPhaseSec);
    api.storage.set('queueFlushThreshold', globalQueueFlushThreshold);
    api.storage.set('disabledConns', [...disabledConnIds]);
    api.storage.set('panelCollapsed', panelCollapsed);
    api.storage.set('showGlobalDefaults', showGlobalDefaults);

    const serialized = {};
    for (const [id, ov] of meterConfigs) {
      if (ov && Object.keys(ov).length > 0) {
        serialized[String(id)] = ov;
      }
    }
    api.storage.set('meterConfigs', serialized);
  }

  function getOrCreateOverride(id) {
    let ov = meterConfigs.get(id);
    if (!ov) {
      ov = {};
      meterConfigs.set(id, ov);
    }
    return ov;
  }

  function pruneOverrideIfEmpty(id) {
    const ov = meterConfigs.get(id);
    if (ov && Object.keys(ov).length === 0) {
      meterConfigs.delete(id);
    }
  }

  function syncMeterImmediate(id) {
    const m = meters.get(id);
    if (!m) return;
    const cfg = resolveMeterConfig(id);
    if (cfg.mode === 'fixed') {
      m.cycleSec = cfg.fixedCycleSec;
    } else {
      m.cycleSec = Math.max(cfg.minCycleSec, Math.min(cfg.maxCycleSec, m.cycleSec));
    }
    if (m.timer >= m.cycleSec) {
      m.timer %= m.cycleSec;
    }
    const effectiveGreen = Math.min(cfg.greenPhaseSec, Math.max(0.5, m.cycleSec - 0.5));
    const nextColor = m.timer < effectiveGreen ? 'green' : 'red';
    if (nextColor !== m.color) {
      m.color = nextColor;
      pushOverrides();
    }
  }

  function syncAllMetersImmediate() {
    for (const id of meters.keys()) {
      syncMeterImmediate(id);
    }
  }

  function scanMergeRamps() {
    const merges = api.world.findMergeConnectors();
    const seen = new Set();
    for (const conn of merges) {
      seen.add(conn.connId);
      const prev = meters.get(conn.connId);
      if (prev) {
        prev.conn = conn;
      } else {
        const cfg = resolveMeterConfig(conn.connId);
        meters.set(conn.connId, {
          conn,
          cycleSec: cfg.mode === 'fixed' ? cfg.fixedCycleSec : 5.5,
          timer: (conn.connId % 5) * 0.6,
          color: 'red',
          mainlineOcc: 0,
          rampQueue: 0,
          released: 0,
        });
      }
    }
    for (const id of [...meters.keys()]) {
      if (!seen.has(id)) meters.delete(id);
    }
    if (selectedConnId !== null && !meters.has(selectedConnId)) {
      selectedConnId = null;
    }
    pushOverrides();
  }

  function pushOverrides() {
    if (!active || !GAME_SCREENS.has(api.world.getScreen())) {
      api.sim.clearSignalOverrides();
      return;
    }
    const map = {};
    for (const [id, m] of meters) {
      if (!disabledConnIds.has(id)) {
        map[id] = m.color;
      }
    }
    api.sim.setSignalOverrides(map);
  }

  function updateLiveTelemetry() {
    if (!mountedCard || !mountedCard.isConnected) return;
    for (const [id, m] of meters) {
      const enabledHere = active && !disabledConnIds.has(id);
      const dotColor = !enabledHere
        ? '#9ca3af'
        : m.color === 'green'
          ? '#16a34a'
          : '#dc2626';
      const rate = Math.round(60 / Math.max(1, m.cycleSec));

      const dotEl = mountedCard.querySelector(`[data-dot="${id}"]`);
      if (dotEl) dotEl.style.background = dotColor;

      const metaEl = mountedCard.querySelector(`[data-meta="${id}"]`);
      if (metaEl) metaEl.textContent = `Q:${m.rampQueue} · ${Math.round(m.mainlineOcc * 100)}% · ${rate}/m`;
    }
  }

  function stepMeters() {
    const simTime = api.sim.getTime();
    const dt = Math.max(0, Math.min(1.0, simTime - lastSimTime));
    lastSimTime = simTime;

    if (!active || !GAME_SCREENS.has(api.world.getScreen()) || meters.size === 0) {
      return;
    }

    let changed = false;
    for (const [id, m] of meters) {
      if (disabledConnIds.has(id)) continue;

      const cfg = resolveMeterConfig(id);
      const mainStats = api.sim.getLinkTrafficStats(m.conn.targetLaneId);
      const occ = mainStats ? mainStats.occupancy : 0;
      m.mainlineOcc = occ;

      const rampStats = api.sim.countVehiclesNear(m.conn.x, m.conn.y, 35, {
        maxSpeed: 3.5,
        linkId: m.conn.feederLaneId,
      });
      m.rampQueue = rampStats.count;

      if (cfg.mode === 'adaptive') {
        // ALINEA-inspired feedback: higher downstream mainline occupancy increases cycle time.
        const err = occ - cfg.targetOccupancy;
        const targetCycle = Math.max(
          cfg.minCycleSec,
          Math.min(cfg.maxCycleSec, 5.5 + err * 24),
        );
        m.cycleSec += (targetCycle - m.cycleSec) * Math.min(1, dt * 0.5);
        // Prevent extreme ramp queue starvation when mainline isn't saturated.
        if (cfg.queueFlushThreshold > 0 && m.rampQueue >= cfg.queueFlushThreshold && occ < 0.55) {
          m.cycleSec = Math.min(m.cycleSec, Math.max(cfg.minCycleSec, 4.5));
        }
      } else {
        m.cycleSec = cfg.fixedCycleSec;
      }

      m.timer += dt;
      if (m.timer >= m.cycleSec) {
        m.timer %= m.cycleSec;
      }

      const effectiveGreen = Math.min(cfg.greenPhaseSec, Math.max(0.5, m.cycleSec - 0.5));
      const nextColor = m.timer < effectiveGreen ? 'green' : 'red';
      if (nextColor !== m.color) {
        if (nextColor === 'green') m.released++;
        m.color = nextColor;
        changed = true;
      }
    }

    if (changed) {
      pushOverrides();
    }

    const now = performance.now();
    if (now - lastHudRefresh > 450) {
      lastHudRefresh = now;
      updateLiveTelemetry();
    }
  }

  function renderSliderRow({ scope, field, label, min, max, step, value, isCustom }) {
    const valText = formatFieldValue(field, value);
    return `
      <div class="rm-slider-row">
        <div class="rm-slider-head">
          <span class="rm-slider-label">
            <span>${label}</span>
            ${
              isCustom
                ? `<button type="button" class="rm-reset-link" data-reset-field="${field}" title="Reset to global default">↺ default</button>`
                : ''
            }
          </span>
          <strong data-val-for="${scope}:${field}">${valText}</strong>
        </div>
        <input
          class="rm-slider"
          type="range"
          min="${min}"
          max="${max}"
          step="${step}"
          value="${value}"
          data-scope="${scope}"
          data-field="${field}"
        />
      </div>
    `;
  }

  function renderModeSliders(scope, cfg, overrides) {
    const isMeter = scope === 'meter';
    const isCustom = (field) => isMeter && overrides[field] !== undefined;
    const rows = [];

    if (cfg.mode === 'fixed') {
      rows.push(
        renderSliderRow({
          scope,
          field: 'fixedCycleSec',
          label: 'Release interval',
          min: 3.0,
          max: 14.0,
          step: 0.5,
          value: cfg.fixedCycleSec,
          isCustom: isCustom('fixedCycleSec'),
        }),
      );
      rows.push(
        renderSliderRow({
          scope,
          field: 'greenPhaseSec',
          label: 'Green phase',
          min: 0.8,
          max: 4.0,
          step: 0.2,
          value: cfg.greenPhaseSec,
          isCustom: isCustom('greenPhaseSec'),
        }),
      );
    } else {
      rows.push(
        renderSliderRow({
          scope,
          field: 'targetOccupancy',
          label: 'Target occupancy',
          min: 0.10,
          max: 0.50,
          step: 0.02,
          value: cfg.targetOccupancy,
          isCustom: isCustom('targetOccupancy'),
        }),
      );
      rows.push(
        renderSliderRow({
          scope,
          field: 'greenPhaseSec',
          label: 'Green phase',
          min: 0.8,
          max: 4.0,
          step: 0.2,
          value: cfg.greenPhaseSec,
          isCustom: isCustom('greenPhaseSec'),
        }),
      );
      rows.push(
        renderSliderRow({
          scope,
          field: 'minCycleSec',
          label: 'Min cycle',
          min: 2.5,
          max: 8.0,
          step: 0.5,
          value: cfg.minCycleSec,
          isCustom: isCustom('minCycleSec'),
        }),
      );
      rows.push(
        renderSliderRow({
          scope,
          field: 'maxCycleSec',
          label: 'Max cycle',
          min: 6.0,
          max: 20.0,
          step: 0.5,
          value: cfg.maxCycleSec,
          isCustom: isCustom('maxCycleSec'),
        }),
      );
      rows.push(
        renderSliderRow({
          scope,
          field: 'queueFlushThreshold',
          label: 'Queue override',
          min: 0,
          max: 15,
          step: 1,
          value: cfg.queueFlushThreshold,
          isCustom: isCustom('queueFlushThreshold'),
        }),
      );
    }

    return rows.join('');
  }

  function applyFieldValue(scope, field, rawValue) {
    if (scope === 'global') {
      switch (field) {
        case 'fixedCycleSec':
          globalFixedCycleSec = clampNum(rawValue, 3.0, 14.0, DEFAULTS.fixedCycleSec);
          break;
        case 'targetOccupancy':
          globalTargetOccupancy = clampNum(rawValue, 0.10, 0.50, DEFAULTS.targetOccupancy);
          break;
        case 'greenPhaseSec':
          globalGreenPhaseSec = clampNum(rawValue, 0.8, 4.0, DEFAULTS.greenPhaseSec);
          break;
        case 'minCycleSec':
          globalMinCycleSec = clampNum(rawValue, 2.5, 8.0, DEFAULTS.minCycleSec);
          if (globalMaxCycleSec < globalMinCycleSec + 0.5) {
            globalMaxCycleSec = Math.min(20.0, globalMinCycleSec + 0.5);
          }
          break;
        case 'maxCycleSec':
          globalMaxCycleSec = clampNum(rawValue, 6.0, 20.0, DEFAULTS.maxCycleSec);
          if (globalMaxCycleSec < globalMinCycleSec + 0.5) {
            globalMinCycleSec = Math.max(2.5, globalMaxCycleSec - 0.5);
            globalMaxCycleSec = Math.max(globalMinCycleSec + 0.5, globalMaxCycleSec);
          }
          break;
        case 'queueFlushThreshold':
          globalQueueFlushThreshold = clampInt(rawValue, 0, 15, DEFAULTS.queueFlushThreshold);
          break;
      }
      syncAllMetersImmediate();
      savePrefs();
      return;
    }

    if (scope === 'meter' && selectedConnId !== null) {
      const ov = getOrCreateOverride(selectedConnId);
      const curCfg = resolveMeterConfig(selectedConnId);
      switch (field) {
        case 'fixedCycleSec':
          ov.fixedCycleSec = clampNum(rawValue, 3.0, 14.0, DEFAULTS.fixedCycleSec);
          break;
        case 'targetOccupancy':
          ov.targetOccupancy = clampNum(rawValue, 0.10, 0.50, DEFAULTS.targetOccupancy);
          break;
        case 'greenPhaseSec':
          ov.greenPhaseSec = clampNum(rawValue, 0.8, 4.0, DEFAULTS.greenPhaseSec);
          break;
        case 'minCycleSec':
          ov.minCycleSec = clampNum(rawValue, 2.5, 8.0, DEFAULTS.minCycleSec);
          if (curCfg.maxCycleSec < ov.minCycleSec + 0.5) {
            ov.maxCycleSec = Math.min(20.0, ov.minCycleSec + 0.5);
          }
          break;
        case 'maxCycleSec': {
          const nextMax = clampNum(rawValue, 6.0, 20.0, DEFAULTS.maxCycleSec);
          if (nextMax < curCfg.minCycleSec + 0.5) {
            const nextMin = Math.max(2.5, nextMax - 0.5);
            ov.minCycleSec = nextMin;
            ov.maxCycleSec = Math.max(nextMin + 0.5, nextMax);
          } else {
            ov.maxCycleSec = nextMax;
          }
          break;
        }
        case 'queueFlushThreshold':
          ov.queueFlushThreshold = clampInt(rawValue, 0, 15, DEFAULTS.queueFlushThreshold);
          break;
      }
      syncMeterImmediate(selectedConnId);
      savePrefs();
    }
  }

  function renderSelectedConfig(id) {
    const cfg = resolveMeterConfig(id);
    const enabledHere = !disabledConnIds.has(id);
    const modeLabel = cfg.modeSource === 'inherit'
      ? `Following global (${globalMode === 'adaptive' ? 'Adaptive' : 'Fixed'})`
      : `Custom (${cfg.mode === 'adaptive' ? 'Adaptive' : 'Fixed'})`;

    return `
      <div class="rm-subbox">
        <div class="rm-subhead">
          <input
            type="text"
            size="1"
            class="rm-name-input"
            maxlength="24"
            placeholder="Ramp #${id}"
            value="${escapeHtml(cfg.name)}"
            data-act="meter-name"
          />
          <button type="button" class="rm-btn xs ${enabledHere ? 'on' : ''}" data-act="meter-toggle">
            ${enabledHere ? 'Active' : 'Paused'}
          </button>
          ${
            cfg.hasCustomizations
              ? '<button type="button" class="rm-btn xs danger" data-act="meter-reset" title="Reset ramp to global defaults">Reset</button>'
              : ''
          }
          <button type="button" class="rm-btn xs" data-act="meter-close" title="Close ramp editor">×</button>
        </div>
        <div class="rm-row" style="margin-top:4px">
          <span style="font-size:11px">Mode</span>
          <div style="display:flex;gap:3px">
            <button type="button" class="rm-btn xs ${cfg.modeSource === 'inherit' ? 'on' : ''}" data-meter-mode="inherit">Global</button>
            <button type="button" class="rm-btn xs ${cfg.modeSource === 'custom' && cfg.mode === 'adaptive' ? 'on' : ''}" data-meter-mode="adaptive">Adaptive</button>
            <button type="button" class="rm-btn xs ${cfg.modeSource === 'custom' && cfg.mode === 'fixed' ? 'on' : ''}" data-meter-mode="fixed">Fixed</button>
          </div>
        </div>
        <div class="rm-hint" style="margin-top:3px">${modeLabel}</div>
        ${renderModeSliders('meter', cfg, cfg.overrides)}
        <div class="rm-row" style="margin-top:8px;justify-content:flex-end">
          <button type="button" class="rm-btn xs" data-act="apply-all" title="Copy these timing settings to global defaults and all non-custom meters">Apply to All</button>
        </div>
      </div>
    `;
  }

  function renderHud(host) {
    const inGame = GAME_SCREENS.has(api.world.getScreen());
    if (!inGame) {
      mountedCard = null;
      return;
    }

    const prevList = mountedCard && mountedCard.isConnected ? mountedCard.querySelector('.rm-list') : null;
    const prevScrollTop = prevList ? prevList.scrollTop : 0;

    if (selectedConnId !== null && !meters.has(selectedConnId)) {
      selectedConnId = null;
    }

    const card = document.createElement('div');
    card.className = 'rm-panel mod-panel';
    const meterList = [...meters.values()];
    const activeCount = meterList.filter((m) => !disabledConnIds.has(m.conn.connId)).length;

    const globalCfgForSliders = {
      mode: globalMode,
      fixedCycleSec: globalFixedCycleSec,
      targetOccupancy: globalTargetOccupancy,
      minCycleSec: globalMinCycleSec,
      maxCycleSec: globalMaxCycleSec,
      greenPhaseSec: globalGreenPhaseSec,
      queueFlushThreshold: globalQueueFlushThreshold,
    };

    card.innerHTML = `
      <div class="rm-head">
        <span class="rm-title">
          <span class="rm-dot ${active ? 'on' : ''}"></span>
          Ramp Meters (${activeCount}/${meterList.length})
        </span>
        <div style="display:flex;gap:4px">
          <button type="button" class="rm-btn ${active ? 'on' : ''}" data-act="toggle">${active ? 'ON' : 'OFF'}</button>
          <button type="button" class="rm-btn" data-act="collapse">${panelCollapsed ? '+' : '–'}</button>
        </div>
      </div>
      ${
        panelCollapsed
          ? ''
          : `
        <div class="rm-row">
          <span>Default Mode</span>
          <div style="display:flex;gap:4px">
            <button type="button" class="rm-btn ${globalMode === 'adaptive' ? 'on' : ''}" data-act="adaptive">Adaptive</button>
            <button type="button" class="rm-btn ${globalMode === 'fixed' ? 'on' : ''}" data-act="fixed">Fixed</button>
            <button type="button" class="rm-btn ${showGlobalDefaults ? 'on' : ''}" data-act="toggle-defaults" title="Customize global default parameters">⚙</button>
          </div>
        </div>
        ${
          !showGlobalDefaults && globalMode === 'fixed'
            ? renderSliderRow({
                scope: 'global',
                field: 'fixedCycleSec',
                label: 'Default interval',
                min: 3.0,
                max: 14.0,
                step: 0.5,
                value: globalFixedCycleSec,
                isCustom: false,
              })
            : ''
        }
        ${
          showGlobalDefaults
            ? `<div class="rm-subbox">
                <div class="rm-subhead">
                  <strong style="font-size:11px">Global Defaults</strong>
                  <button type="button" class="rm-btn xs" data-act="reset-defaults">Reset</button>
                </div>
                ${renderModeSliders('global', globalCfgForSliders, {})}
              </div>`
            : ''
        }
        <div class="rm-list">
          ${
            meterList.length === 0
              ? '<div class="rm-hint">Build a highway on-ramp or lane merge to place ramp meters automatically.</div>'
              : meterList
                  .map((m) => {
                    const id = m.conn.connId;
                    const cfg = resolveMeterConfig(id);
                    const enabledHere = active && !disabledConnIds.has(id);
                    const dotColor = !enabledHere
                      ? '#9ca3af'
                      : m.color === 'green'
                        ? '#16a34a'
                        : '#dc2626';
                    const rate = Math.round(60 / Math.max(1, m.cycleSec));
                    const isSelected = id === selectedConnId;
                    const modeTag = cfg.hasOverrides
                      ? cfg.mode === 'fixed'
                        ? `${cfg.fixedCycleSec.toFixed(0)}s`
                        : 'CUST'
                      : '';
                    return `
                      <div class="rm-item ${isSelected ? 'selected' : ''}" data-conn="${id}" title="Click to configure ${escapeHtml(formatMeterLabel(id, cfg))}">
                        <span class="rm-item-left">
                          <button type="button" class="rm-badge-btn" data-toggle-conn="${id}" title="Toggle meter #${id} on/off">
                            <span class="rm-badge" data-dot="${id}" style="background:${dotColor}"></span>
                          </button>
                          <span class="rm-item-name">${escapeHtml(formatMeterLabel(id, cfg))}</span>
                          ${modeTag ? `<span class="rm-tag">${modeTag}</span>` : ''}
                        </span>
                        <span class="rm-item-meta" data-meta="${id}">Q:${m.rampQueue} · ${Math.round(m.mainlineOcc * 100)}% · ${rate}/m</span>
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
        ${selectedConnId !== null ? renderSelectedConfig(selectedConnId) : ''}
        <div class="rm-hint">Tip: Click a ramp row to configure, dot/beacon to toggle (Shift+click beacon to select).</div>
      `
      }
    `;

    card.querySelector('[data-act="toggle"]')?.addEventListener('click', () => {
      active = !active;
      savePrefs();
      pushOverrides();
      api.ui.refreshUi();
    });
    card.querySelector('[data-act="collapse"]')?.addEventListener('click', () => {
      panelCollapsed = !panelCollapsed;
      savePrefs();
      api.ui.refreshUi();
    });
    card.querySelector('[data-act="adaptive"]')?.addEventListener('click', () => {
      globalMode = 'adaptive';
      syncAllMetersImmediate();
      savePrefs();
      api.ui.refreshUi();
    });
    card.querySelector('[data-act="fixed"]')?.addEventListener('click', () => {
      globalMode = 'fixed';
      syncAllMetersImmediate();
      savePrefs();
      api.ui.refreshUi();
    });
    card.querySelector('[data-act="toggle-defaults"]')?.addEventListener('click', () => {
      showGlobalDefaults = !showGlobalDefaults;
      savePrefs();
      api.ui.refreshUi();
    });
    card.querySelector('[data-act="reset-defaults"]')?.addEventListener('click', () => {
      globalMode = DEFAULTS.mode;
      globalFixedCycleSec = DEFAULTS.fixedCycleSec;
      globalTargetOccupancy = DEFAULTS.targetOccupancy;
      globalMinCycleSec = DEFAULTS.minCycleSec;
      globalMaxCycleSec = DEFAULTS.maxCycleSec;
      globalGreenPhaseSec = DEFAULTS.greenPhaseSec;
      globalQueueFlushThreshold = DEFAULTS.queueFlushThreshold;
      syncAllMetersImmediate();
      savePrefs();
      api.ui.refreshUi();
    });

    card.querySelectorAll('[data-toggle-conn]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number(btn.getAttribute('data-toggle-conn'));
        if (disabledConnIds.has(id)) disabledConnIds.delete(id);
        else disabledConnIds.add(id);
        savePrefs();
        pushOverrides();
        api.ui.refreshUi();
      });
    });

    card.querySelectorAll('[data-conn]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = Number(row.getAttribute('data-conn'));
        selectedConnId = selectedConnId === id ? null : id;
        api.ui.refreshUi();
      });
    });

    // Selected meter controls
    card.querySelector('[data-act="meter-toggle"]')?.addEventListener('click', () => {
      if (selectedConnId === null) return;
      if (disabledConnIds.has(selectedConnId)) disabledConnIds.delete(selectedConnId);
      else disabledConnIds.add(selectedConnId);
      savePrefs();
      pushOverrides();
      api.ui.refreshUi();
    });

    card.querySelector('[data-act="meter-close"]')?.addEventListener('click', () => {
      selectedConnId = null;
      api.ui.refreshUi();
    });

    card.querySelector('[data-act="meter-reset"]')?.addEventListener('click', () => {
      if (selectedConnId === null) return;
      meterConfigs.delete(selectedConnId);
      syncMeterImmediate(selectedConnId);
      savePrefs();
      api.ui.refreshUi();
    });

    card.querySelector('[data-act="apply-all"]')?.addEventListener('click', () => {
      if (selectedConnId === null) return;
      const cfg = resolveMeterConfig(selectedConnId);
      globalMode = cfg.mode;
      globalFixedCycleSec = cfg.fixedCycleSec;
      globalTargetOccupancy = cfg.targetOccupancy;
      globalMinCycleSec = cfg.minCycleSec;
      globalMaxCycleSec = cfg.maxCycleSec;
      globalGreenPhaseSec = cfg.greenPhaseSec;
      globalQueueFlushThreshold = cfg.queueFlushThreshold;
      for (const [id, ov] of [...meterConfigs.entries()]) {
        for (const field of OVERRIDE_FIELDS) {
          delete ov[field];
        }
        pruneOverrideIfEmpty(id);
      }
      syncAllMetersImmediate();
      savePrefs();
      api.ui.showToast(`Applied ${formatMeterLabel(selectedConnId, cfg)} settings to all meters`);
      api.ui.refreshUi();
    });

    card.querySelectorAll('[data-meter-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (selectedConnId === null) return;
        const targetMode = btn.getAttribute('data-meter-mode');
        if (targetMode === 'inherit') {
          const ov = meterConfigs.get(selectedConnId);
          if (ov) {
            delete ov.mode;
            pruneOverrideIfEmpty(selectedConnId);
          }
        } else if (targetMode === 'adaptive' || targetMode === 'fixed') {
          const ov = getOrCreateOverride(selectedConnId);
          ov.mode = targetMode;
        }
        syncMeterImmediate(selectedConnId);
        savePrefs();
        api.ui.refreshUi();
      });
    });

    const nameInput = card.querySelector('[data-act="meter-name"]');
    if (nameInput) {
      nameInput.addEventListener('input', (e) => {
        if (selectedConnId === null) return;
        const cleanName = e.target.value.trim().slice(0, 24);
        if (cleanName) {
          const ov = getOrCreateOverride(selectedConnId);
          ov.name = cleanName;
        } else {
          const ov = meterConfigs.get(selectedConnId);
          if (ov) {
            delete ov.name;
            pruneOverrideIfEmpty(selectedConnId);
          }
        }
        const rowName = card.querySelector(`[data-conn="${selectedConnId}"] .rm-item-name`);
        if (rowName) rowName.textContent = cleanName || `Ramp #${selectedConnId}`;
        savePrefs();
      });
    }

    card.querySelectorAll('[data-reset-field]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (selectedConnId === null) return;
        const field = btn.getAttribute('data-reset-field');
        const ov = meterConfigs.get(selectedConnId);
        if (ov && field) {
          delete ov[field];
          pruneOverrideIfEmpty(selectedConnId);
          syncMeterImmediate(selectedConnId);
          savePrefs();
          api.ui.refreshUi();
        }
      });
    });

    card.querySelectorAll('input[type="range"][data-field]').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        const scope = slider.getAttribute('data-scope');
        const field = slider.getAttribute('data-field');
        applyFieldValue(scope, field, e.target.value);

        const cfg = scope === 'meter' && selectedConnId !== null
          ? resolveMeterConfig(selectedConnId)
          : {
              fixedCycleSec: globalFixedCycleSec,
              targetOccupancy: globalTargetOccupancy,
              minCycleSec: globalMinCycleSec,
              maxCycleSec: globalMaxCycleSec,
              greenPhaseSec: globalGreenPhaseSec,
              queueFlushThreshold: globalQueueFlushThreshold,
            };
        for (const f of ['fixedCycleSec', 'targetOccupancy', 'minCycleSec', 'maxCycleSec', 'greenPhaseSec', 'queueFlushThreshold']) {
          const valEl = card.querySelector(`[data-val-for="${scope}:${f}"]`);
          if (valEl) valEl.textContent = formatFieldValue(f, cfg[f]);
        }
        updateLiveTelemetry();
      });

      slider.addEventListener('change', () => {
        // Refresh on release so reset-field links, tags, and coupled min/max sliders stay in sync.
        api.ui.refreshUi();
      });
    });

    host.appendChild(card);
    mountedCard = card;

    const nextList = card.querySelector('.rm-list');
    if (nextList && prevScrollTop > 0) {
      nextList.scrollTop = prevScrollTop;
    }
  }

  api.ui.registerTopBarAction({
    id: 'toggle',
    label: 'Ramp Meters',
    title: 'Enable or disable adaptive highway ramp metering',
    isActive: () => active,
    onClick: () => {
      active = !active;
      savePrefs();
      pushOverrides();
      api.ui.showToast(active ? 'Ramp Meters enabled' : 'Ramp Meters disabled');
      api.ui.refreshUi();
    },
  });

  api.ui.registerHudWidget({
    id: 'hud',
    position: 'top-right',
    render: renderHud,
  });

  function getUiExclusionRects(ctx) {
    const elements = new Set();
    if (mountedCard && mountedCard.isConnected) {
      elements.add(mountedCard);
    }
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      for (const el of document.querySelectorAll('.mod-panel')) {
        elements.add(el);
      }
    }
    if (elements.size === 0) return [];

    const canvasRect =
      ctx && ctx.canvas && typeof ctx.canvas.getBoundingClientRect === 'function'
        ? ctx.canvas.getBoundingClientRect()
        : { left: 0, top: 0 };

    const rects = [];
    for (const el of elements) {
      if (typeof el.getBoundingClientRect !== 'function') continue;
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      rects.push({
        left: r.left - canvasRect.left,
        top: r.top - canvasRect.top,
        right: r.right - canvasRect.left,
        bottom: r.bottom - canvasRect.top,
        width: r.width,
        height: r.height,
        viewLeft: r.left,
        viewTop: r.top,
        viewRight: r.right,
        viewBottom: r.bottom,
      });
    }
    return rects;
  }

  // World-space beacon & stop bar overlay for every detected on-ramp meter
  api.overlay.registerLayer('beacons', ({ ctx, width, height, worldToScreen }) => {
    if (!GAME_SCREENS.has(api.world.getScreen()) || meters.size === 0) return;

    // Keep world-space beacons and labels behind HUD panels even when the overlay canvas sits above UI.
    const exclusions = getUiExclusionRects(ctx);
    let clipped = false;
    if (exclusions.length > 0 && typeof ctx.clip === 'function') {
      const clipW = Number.isFinite(width) && width > 0 ? width : 16384;
      const clipH = Number.isFinite(height) && height > 0 ? height : 16384;
      ctx.save();
      for (const r of exclusions) {
        ctx.beginPath();
        ctx.rect(0, 0, clipW, clipH);
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(r.left, r.top, r.width, r.height, 14);
        } else {
          ctx.rect(r.left, r.top, r.width, r.height);
        }
        ctx.clip('evenodd');
      }
      clipped = true;
    }

    try {
      for (const [id, m] of meters) {
        const enabledHere = active && !disabledConnIds.has(id);
        const isSelected = id === selectedConnId;
        const cfg = resolveMeterConfig(id);
        const head = worldToScreen(m.conn.x, m.conn.y, (m.conn.z || 0) + 3.6);
        const base = worldToScreen(m.conn.x, m.conn.y, m.conn.z || 0);
        if (
          head.depth <= 0.25 ||
          base.depth <= 0.25 ||
          !Number.isFinite(head.x) ||
          !Number.isFinite(head.y) ||
          !Number.isFinite(base.x) ||
          !Number.isFinite(base.y)
        ) {
          continue;
        }

        const poleDist = Math.hypot(head.x - base.x, head.y - base.y);
        if (poleDist > 260) continue;

        // Pole
        ctx.strokeStyle = isSelected ? '#1d5fbf' : 'rgba(28, 29, 24, 0.85)';
        ctx.lineWidth = isSelected ? 3 : 2.5;
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(head.x, head.y);
        ctx.stroke();

        // Selection halo
        if (isSelected) {
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.roundRect(head.x - 12, head.y - 19, 24, 30, 7);
          ctx.stroke();
        }

        // Signal housing & live red/green lamp
        ctx.fillStyle = '#181a15';
        ctx.beginPath();
        ctx.roundRect(head.x - 9, head.y - 16, 18, 24, 5);
        ctx.fill();

        const greenOn = enabledHere && m.color === 'green';
        const redOn = enabledHere && m.color !== 'green';

        ctx.fillStyle = redOn ? '#ef4444' : 'rgba(239, 68, 68, 0.22)';
        ctx.beginPath();
        ctx.arc(head.x, head.y - 9, 4.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = greenOn ? '#22c55e' : 'rgba(34, 197, 94, 0.22)';
        ctx.beginPath();
        ctx.arc(head.x, head.y + 1, 4.2, 0, Math.PI * 2);
        ctx.fill();

        // Small blue indicator dot on housing when meter has custom settings
        if (cfg.hasCustomizations) {
          ctx.fillStyle = '#3b82f6';
          ctx.beginPath();
          ctx.arc(head.x - 6, head.y - 13, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }

        if (enabledHere) {
          ctx.fillStyle = 'rgba(20, 22, 17, 0.84)';
          ctx.beginPath();
          ctx.roundRect(head.x + 12, head.y - 12, 46, 17, 5);
          ctx.fill();
          ctx.fillStyle = '#fff7e8';
          ctx.font = '600 10px "Highway UI Mono", ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`Q:${m.rampQueue}`, head.x + 35, head.y - 3);
        }

        if (isSelected) {
          const tag = formatMeterLabel(id, cfg);
          ctx.fillStyle = 'rgba(29, 95, 191, 0.92)';
          ctx.beginPath();
          ctx.roundRect(head.x - 36, head.y - 38, 72, 16, 5);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.font = '600 10px "Highway UI", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(tag.slice(0, 12), head.x, head.y - 30);
        }
      }
    } finally {
      if (clipped) {
        ctx.restore();
      }
    }
  });

  // Click a beacon in-world to toggle it (or Shift+click to select without toggling)
  api.input.onPointerDown((e) => {
    if (e.button !== 0 || !GAME_SCREENS.has(api.world.getScreen())) return;
    if ((e.target instanceof Element) && e.target.tagName !== 'CANVAS') return;
    const exclusions = getUiExclusionRects(null);
    if (exclusions.some((r) => e.clientX >= r.viewLeft && e.clientX <= r.viewRight && e.clientY >= r.viewTop && e.clientY <= r.viewBottom)) {
      return;
    }
    for (const [id, m] of meters) {
      const head = api.world.worldToScreen(m.conn.x, m.conn.y, (m.conn.z || 0) + 3.6);
      if (head.depth <= 0.25 || !Number.isFinite(head.x) || !Number.isFinite(head.y)) continue;
      if (Math.hypot(e.clientX - head.x, e.clientY - head.y) <= 18) {
        selectedConnId = id;
        if (e.shiftKey) {
          const cfg = resolveMeterConfig(id);
          api.ui.showToast(`Selected ${formatMeterLabel(id, cfg)}`);
        } else {
          if (disabledConnIds.has(id)) disabledConnIds.delete(id);
          else disabledConnIds.add(id);
          savePrefs();
          pushOverrides();
          const cfg = resolveMeterConfig(id);
          api.ui.showToast(`${formatMeterLabel(id, cfg)} ${disabledConnIds.has(id) ? 'paused' : 'active'}`);
        }
        api.ui.refreshUi();
        break;
      }
    }
  });

  api.events.on('netChange', scanMergeRamps);
  api.events.on('screenChange', () => {
    scanMergeRamps();
    api.ui.refreshUi();
  });
  api.events.on('tick', stepMeters);

  // Initial scan on activation
  scanMergeRamps();
};
