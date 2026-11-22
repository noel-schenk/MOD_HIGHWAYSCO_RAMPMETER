module.exports = function activate(api) {
  const GAME_SCREENS = new Set(['campaign', 'sandbox', 'editor']);
  const TARGET_OCCUPANCY = 0.24;
  const MIN_CYCLE_SEC = 3.5;
  const MAX_CYCLE_SEC = 14.0;
  const GREEN_PHASE_SEC = 1.6;

  let active = api.storage.get('enabled', true);
  let mode = api.storage.get('mode', 'adaptive'); // 'adaptive' | 'fixed'
  let fixedCycleSec = Number(api.storage.get('fixedCycleSec', 6.0)) || 6.0;
  let panelCollapsed = Boolean(api.storage.get('panelCollapsed', false));
  let disabledConnIds = new Set(api.storage.get('disabledConns', []));

  /** @type {Map<number, { conn: any; cycleSec: number; timer: number; color: 'red' | 'green'; mainlineOcc: number; rampQueue: number; released: number }>} */
  const meters = new Map();
  let lastSimTime = api.sim.getTime();
  let lastHudRefresh = 0;

  api.overlay.addStyle(`
    .rm-panel {
      width: 264px;
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
    .rm-list {
      margin-top: 8px;
      max-height: 150px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .rm-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 6px;
      border-radius: 7px;
      background: rgb(28 29 24 / 0.05);
      font-size: 11px;
      cursor: pointer;
    }
    .rm-item-meta {
      font-family: "Highway UI Mono", ui-monospace, monospace;
      color: rgb(28 29 24 / 0.68);
    }
    .rm-badge {
      display: inline-block;
      min-width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 5px;
    }
    .rm-slider {
      width: 100%;
      margin-top: 4px;
    }
    .rm-hint {
      margin-top: 6px;
      font-size: 11px;
      color: rgb(28 29 24 / 0.62);
    }
  `);

  function savePrefs() {
    api.storage.set('enabled', active);
    api.storage.set('mode', mode);
    api.storage.set('fixedCycleSec', fixedCycleSec);
    api.storage.set('disabledConns', [...disabledConnIds]);
    api.storage.set('panelCollapsed', panelCollapsed);
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
        meters.set(conn.connId, {
          conn,
          cycleSec: mode === 'fixed' ? fixedCycleSec : 5.5,
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

      const mainStats = api.sim.getLinkTrafficStats(m.conn.targetLaneId);
      const occ = mainStats ? mainStats.occupancy : 0;
      m.mainlineOcc = occ;

      const rampStats = api.sim.countVehiclesNear(m.conn.x, m.conn.y, 35, {
        maxSpeed: 3.5,
        linkId: m.conn.feederLaneId,
      });
      m.rampQueue = rampStats.count;

      if (mode === 'adaptive') {
        // ALINEA-inspired feedback: higher downstream mainline occupancy increases cycle time.
        const err = occ - TARGET_OCCUPANCY;
        const targetCycle = Math.max(
          MIN_CYCLE_SEC,
          Math.min(MAX_CYCLE_SEC, 5.5 + err * 24),
        );
        m.cycleSec += (targetCycle - m.cycleSec) * Math.min(1, dt * 0.5);
        // Prevent extreme ramp queue starvation when mainline isn't saturated.
        if (m.rampQueue >= 6 && occ < 0.55) {
          m.cycleSec = Math.min(m.cycleSec, 4.5);
        }
      } else {
        m.cycleSec = fixedCycleSec;
      }

      m.timer += dt;
      if (m.timer >= m.cycleSec) {
        m.timer %= m.cycleSec;
      }

      const nextColor = m.timer < GREEN_PHASE_SEC ? 'green' : 'red';
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
      api.ui.refreshUi();
    }
  }

  function renderHud(host) {
    const inGame = GAME_SCREENS.has(api.world.getScreen());
    if (!inGame) return;

    const card = document.createElement('div');
    card.className = 'rm-panel mod-panel';
    const meterList = [...meters.values()];
    const activeCount = meterList.filter((m) => !disabledConnIds.has(m.conn.connId)).length;

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
          <span>Mode</span>
          <div style="display:flex;gap:4px">
            <button type="button" class="rm-btn ${mode === 'adaptive' ? 'on' : ''}" data-act="adaptive">Adaptive</button>
            <button type="button" class="rm-btn ${mode === 'fixed' ? 'on' : ''}" data-act="fixed">Fixed</button>
          </div>
        </div>
        ${
          mode === 'fixed'
            ? `<div class="rm-row" style="flex-direction:column;align-items:stretch;gap:2px">
                <div style="display:flex;justify-content:space-between">
                  <span>Release interval</span>
                  <strong>${fixedCycleSec.toFixed(1)}s</strong>
                </div>
                <input class="rm-slider" type="range" min="3.0" max="14.0" step="0.5" value="${fixedCycleSec}" data-act="slider" />
              </div>`
            : ''
        }
        <div class="rm-list">
          ${
            meterList.length === 0
              ? '<div class="rm-hint">Build a highway on-ramp or lane merge to place ramp meters automatically.</div>'
              : meterList
                  .map((m) => {
                    const enabledHere = active && !disabledConnIds.has(m.conn.connId);
                    const dotColor = !enabledHere
                      ? '#9ca3af'
                      : m.color === 'green'
                        ? '#16a34a'
                        : '#dc2626';
                    const rate = Math.round(60 / Math.max(1, m.cycleSec));
                    return `
                      <div class="rm-item" data-conn="${m.conn.connId}" title="Click to toggle meter #${m.conn.connId}">
                        <span><span class="rm-badge" style="background:${dotColor}"></span>Ramp #${m.conn.connId}</span>
                        <span class="rm-item-meta">Q:${m.rampQueue} · ${Math.round(m.mainlineOcc * 100)}% · ${rate}/m</span>
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
        <div class="rm-hint">Tip: Click any ramp beacon in-world or in the list to toggle it.</div>
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
      mode = 'adaptive';
      savePrefs();
      api.ui.refreshUi();
    });
    card.querySelector('[data-act="fixed"]')?.addEventListener('click', () => {
      mode = 'fixed';
      savePrefs();
      api.ui.refreshUi();
    });
    card.querySelector('[data-act="slider"]')?.addEventListener('input', (e) => {
      fixedCycleSec = Number(e.target.value) || 6.0;
      savePrefs();
      api.ui.refreshUi();
    });
    card.querySelectorAll('[data-conn]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = Number(row.getAttribute('data-conn'));
        if (disabledConnIds.has(id)) disabledConnIds.delete(id);
        else disabledConnIds.add(id);
        savePrefs();
        pushOverrides();
        api.ui.refreshUi();
      });
    });

    host.appendChild(card);
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

  // World-space beacon & stop bar overlay for every detected on-ramp meter
  api.overlay.registerLayer('beacons', ({ ctx, worldToScreen }) => {
    if (!GAME_SCREENS.has(api.world.getScreen()) || meters.size === 0) return;

    for (const [id, m] of meters) {
      const enabledHere = active && !disabledConnIds.has(id);
      const head = worldToScreen(m.conn.x, m.conn.y, (m.conn.z || 0) + 3.6);
      const base = worldToScreen(m.conn.x, m.conn.y, m.conn.z || 0);
      if (head.depth <= 0.25 || base.depth <= 0.25) continue;

      const poleDist = Math.hypot(head.x - base.x, head.y - base.y);
      if (poleDist > 260) continue;

      // Pole
      ctx.strokeStyle = 'rgba(28, 29, 24, 0.85)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();

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
    }
  });

  // Allow clicking directly on a ramp meter beacon in the world to toggle it
  api.input.onPointerDown((e) => {
    if (e.button !== 0 || !GAME_SCREENS.has(api.world.getScreen())) return;
    if ((e.target instanceof Element) && e.target.tagName !== 'CANVAS') return;
    for (const [id, m] of meters) {
      const head = api.world.worldToScreen(m.conn.x, m.conn.y, (m.conn.z || 0) + 3.6);
      if (head.depth <= 0.25) continue;
      if (Math.hypot(e.clientX - head.x, e.clientY - head.y) <= 18) {
        if (disabledConnIds.has(id)) disabledConnIds.delete(id);
        else disabledConnIds.add(id);
        savePrefs();
        pushOverrides();
        api.ui.showToast(`Ramp Meter #${id} ${disabledConnIds.has(id) ? 'paused' : 'active'}`);
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
