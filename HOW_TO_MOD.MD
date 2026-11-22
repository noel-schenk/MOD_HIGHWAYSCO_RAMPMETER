# Highways & Co. — Modding Guide for AI Agents & Creators

This document is a **complete, self-contained specification** for building mods for **Highways & Co.**
You do **not** need to read any game source code to build a full-featured mod — every API, coordinate convention, file requirement, lifecycle rule, and pattern is documented here.

---

## 1. Repository & Distribution Rules (Mandatory)

To appear in and install cleanly through the in-game **Mod Browser**:

1. **Public GitHub Repository**: Host the mod in a **public** GitHub repository.
2. **Exact Name Prefix**: The repository name **must start with `MOD_HIGHWAYSCO_`** (case-sensitive), followed by `[A-Za-z0-9._-]+`.
   - Valid: `MOD_HIGHWAYSCO_RAMPMETER`, `MOD_HIGHWAYSCO_FPVDRIVING`, `MOD_HIGHWAYSCO_NIGHTMODE`
   - Invalid: `highways-rampmeter`, `mod_highwaysco_test`
3. **Top-Level Package Files** (on your default branch, e.g. `main`):
   - `mod.json` *(required)* — mod metadata and entrypoint declaration
   - `index.js` *(required, or whatever path `"entry"` points to)* — browser-ready JavaScript module (no bundler/TypeScript step needed at runtime)
   - `styles.css` *(optional, referenced by `"styles"` in `mod.json`)*
   - `README.md` *(recommended)*

---

## 2. `mod.json` Manifest Schema

```json
{
  "id": "MOD_HIGHWAYSCO_EXAMPLE",
  "name": "Example Mod",
  "version": "1.0.0",
  "author": "your-github-handle",
  "description": "Concise one-sentence summary shown in the Mod Browser.",
  "apiVersion": 1,
  "entry": "index.js",
  "styles": "styles.css",
  "tags": ["traffic", "camera", "ui"],
  "permissions": ["world", "sim", "camera", "overlay", "ui", "input", "storage"]
}
```

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | Yes | `string` | Unique identifier; best practice is matching the repo name (`MOD_HIGHWAYSCO_*`). |
| `name` | Yes | `string` | Human-readable display name. |
| `version` | Yes | `string` | SemVer (`"1.0.0"`). |
| `author` | Yes | `string` | Author handle / name. |
| `description` | Yes | `string` | Short summary shown in Mod Browser cards. |
| `apiVersion` | Recommended | `number` | Currently `1`. |
| `entry` | No | `string` | Defaults to `"index.js"`. Plain ES5/ES2022 JS (no `import`/`export` ESM statements needed). |
| `styles` | No | `string` | Optional CSS filename auto-injected on activation and removed on deactivation. |
| `tags` | No | `string[]` | Categorization tags. |
| `permissions` | No | `string[]` | Declared capabilities (`world`, `sim`, `camera`, `overlay`, `ui`, `input`, `storage`). |

---

## 3. Entry Script Lifecycle (`index.js`)

Your entry script is invoked by the Mod Runtime with `(api, module, exports)`.
You can export an activation hook via **any** of these styles:

```js
// Style A (Recommended — CommonJS-style export):
module.exports = function activate(api) {
  api.mod.log('Activated!');

  // Register overlays, HUD widgets, signal overrides, events...
  const unsub = api.events.on('frame', (dtMs) => { /* ... */ });

  // Optional cleanup callback (in addition, all API registrations auto-dispose on unload):
  return function deactivate() {
    unsub();
  };
};

// Style B (Named activate):
exports.activate = function (api) { /* ... */ };

// Style C (Top-level imperative code):
// `api` is directly in scope at the top level of index.js.
```

### Automatic Cleanup Guarantee
Every listener (`api.events.on`, `api.input.*`), overlay (`api.overlay.*`), UI widget/button (`api.ui.*`), style (`api.overlay.addStyle`), custom camera (`api.camera.setCustomRig`), input capture (`api.input.setCapture`), and signal override (`api.sim.setSignalOverrides`) created via `api` is **automatically disposed** when the user disables, reloads, or uninstalls your mod. Always still stop any custom `setInterval` / `setTimeout` in your returned cleanup function if you allocate timers manually.

---

## 4. Coordinate System & Units

- **World Space**: Right-handed 3D Cartesian coordinates in **metres**:
  - `+x`: East
  - `+y`: North
  - `+z`: Up (elevation; tunnels `< 0`, ground `= 0`, overpasses/bridges `> 0`)
- **Angles / Heading**: Radians in world XY (`0` = East `+x`, `+PI/2` = North `+y`, `cos(heading), sin(heading)` is forward tangent `(tx, ty)`).
- **Speeds**: `vehicle.v` and `link.speed` are in **metres per second (m/s)**.
  - Multiply by `3.6` for `km/h`, or `2.23694` for `mph`.
- **Screen Coordinates**: CSS pixels from top-left `(0, 0)` of the viewport, Y-down.
- **Behind-camera check**: `worldToScreen(x, y, z)` returns `{ x, y, depth }`. Only draw 2D labels/shapes for points where `depth > 0.2`.

---

## 5. Complete API Reference (`api`)

### 5.1 `api.mod`
```ts
api.apiVersion: number // 1
api.mod: {
  id: string;
  name: string;
  version: string;
  author: string;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
```

### 5.2 `api.world` — Road Network, Geometry & Spatial Queries
```ts
api.world.getScreen(): 'title' | 'levels' | 'campaign' | 'sandbox' | 'maps' | 'editor'
api.world.getLevelInfo(): { screen: string; id: string | null; name: string | null; editable: boolean } | null
api.world.getBounds(): { board: Rect; site: Rect } | null
api.world.getNetwork(): RoadNetwork | null
api.world.getMap(): EditableMap | null

api.world.getLinks(): RoadLink[]
api.world.getLink(linkId: number): RoadLink | null
api.world.getJunctions(): Junction[]
api.world.getJunction(junctionId: number): Junction | null
api.world.getSignals(): Map<number, SignalPlan> | null
```

**Compiled `RoadLink` fields**:
- `id: number` — unique link index
- `kind: 'lane' | 'conn'` — road travel lane vs intersection/merge connector
- `segId: number` — parent road segment ID
- `dir: number` — travel direction (`0` or `1`)
- `laneIndex: number` — lane index within segment
- `junction: number` — junction ID (primarily on `'conn'` links)
- `succ: number[]` — outgoing link IDs
- `speed: number` — link speed limit in m/s
- `rail?: boolean` — `true` for train tracks
- `stopSign?: boolean`
- `turn?: 'through' | 'left' | 'right' | 'uturn'`
- `conflicts: Array<{ other: number; iYield?: boolean; zipper?: boolean; join?: boolean; mLo: number; mHi: number }>`
- `poly: { pts: Float64Array; cum: Float64Array; zs: Float64Array; length: number }`

**Geometric & Traffic Engineering Helpers**:
```ts
// Sample exact 3D point & tangent at distance s (0..link.poly.length) along a link:
api.world.sampleLink(linkId: number, s: number): {
  x: number; y: number; z: number;
  tx: number; ty: number;
  heading: number; // radians
  rise: number;    // dz / ds slope
} | null

// Find nearest road link to world (x, y) (uses optional zHint for multi-level interchanges):
api.world.findNearestLink(x: number, y: number, opts?: {
  kind?: 'lane' | 'conn' | 'any';
  maxDist?: number;
  zHint?: number;
}): { link: RoadLink; s: number; distance: number; point: ModLinkSample; cls: string } | null

// Convenience road surface sampler for driving / placement mods:
api.world.sampleRoadSurface(x: number, y: number, zHint?: number): {
  x: number; y: number; z: number;
  tx: number; ty: number;
  heading: number; rise: number;
  speedLimit: number; linkId: number; s: number; distance: number; cls: string;
} | null

// Automatically detect highway on-ramp / merge connectors suitable for ramp metering:
api.world.findMergeConnectors(): Array<{
  connId: number;       // connector ID to control with setSignalOverrides({ [connId]: 'red'|'green' })
  junctionId: number;
  feederLaneId: number; // incoming ramp lane ID
  targetLaneId: number; // downstream mainline lane ID
  feederCls: string;
  targetCls: string;
  x: number; y: number; z: number; // stop-line world coordinates at end of feeder lane
  tx: number; ty: number; heading: number;
}>

// 3D <-> 2D Screen coordinate projection:
api.world.worldToScreen(x: number, y: number, z?: number): { x: number; y: number; depth: number }
api.world.screenToWorld(sx: number, sy: number, planeZ?: number): { x: number; y: number; z: number } | null
```

### 5.3 `api.sim` — Vehicles, Metrics & Real Signal Control (Worker-Synced)
```ts
api.sim.isRunning(): boolean
api.sim.setRunning(running: boolean): void
api.sim.getSpeed(): number
api.sim.setSpeed(speed: number): void
api.sim.getTime(): number  // simulation clock in seconds
api.sim.getTick(): number  // simulation step counter

api.sim.getVehicles(): Vehicle[]
api.sim.getVehicle(id: number): Vehicle | null
```

**Live `Vehicle` fields**:
- `id: number`
- `x, y, z: number` — current world coordinates (m)
- `px, py, pz: number` — previous tick coordinates
- `heading, pheading, bodyHeading: number` — orientation in radians
- `rise: number`, `len: number` (m), `v: number` (m/s), `acc: number` (m/s^2)
- `link: number` — current `RoadLink` ID
- `s: number` — distance along current link (m)
- `wait: number` — time spent stopped/queued (s)
- `cls: number`, `destZone: number`, `originZone: number`
- `park?: boolean`, `reversing?: boolean`, `diverted?: boolean`, `train?: { cars: number }`

**Signal Control & Ramp Metering (Enforced by the Physics Simulation!)**:
```ts
api.sim.getSignalColor(connId: number): string | null
api.sim.getSignalColors(): Record<number, string>
api.sim.getSignalPhase(junctionId: number): { phase: number } | null

// Override ANY connector link (even un-signalized highway on-ramp merges!):
// Vehicles approaching a connector set to 'red' will brake and stop at the feeder stop bar,
// and proceed smoothly when set to 'green'. Pass null to release control back to default.
api.sim.setSignalOverrides(
  overrides: Record<number, 'red' | 'green' | 'yellow' | 'stop' | 'permissive' | null>
    | Map<number, 'red' | 'green' | 'yellow' | 'stop' | 'permissive' | null>
): void
api.sim.clearSignalOverrides(): void
```

**Traffic Analytics & Simulation Parameters**:
```ts
api.sim.getMetrics(): {
  spawned: number; arrived: number; removedJammed: number;
  noRoute: number; impacts: number; [k: string]: unknown;
} | null

api.sim.getLinkTrafficStats(linkId: number): {
  count: number; stoppedCount: number; avgSpeed: number; occupancy: number; length: number;
} | null

api.sim.countVehiclesNear(x: number, y: number, radius: number, opts?: {
  maxSpeed?: number; linkId?: number;
}): { count: number; stoppedCount: number; avgSpeed: number }

api.sim.getParams(): Record<string, unknown> | null
api.sim.setParams(patch: Record<string, unknown>): void
```

### 5.4 `api.camera` — Overhead & Full 3D First-Person Camera Control
```ts
api.camera.getPose(): { x: number; y: number; zoom: number; rot: number } | null
api.camera.setPose(pose: { x: number; y: number; zoom?: number; rot?: number }): void
api.camera.easeTo(x: number, y: number, zoom?: number, durationMs?: number): void
api.camera.getRig(): CameraState | null

// Drive the real Three.js / Pixi 3D perspective camera anywhere in 3D space (e.g. inside a car!):
api.camera.setCustomRig(spec: {
  eye: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  up?: { x: number; y: number; z: number }; // defaults to { x: 0, y: 0, z: 1 }
  fovDeg?: number;           // default 62 (range 20..110)
  near?: number;             // default 0.3
  far?: number;              // default 1800
  zoom?: number;             // hints LOD scale (e.g. 6..12 near road)
  hiddenVehicleId?: number | null; // optionally hide host car mesh in cockpit view
} | null): void

api.camera.clearCustomRig(): void
api.camera.worldToScreen(x: number, y: number, z?: number): { x: number; y: number; depth: number }
api.camera.screenToWorld(sx: number, sy: number, planeZ?: number): { x: number; y: number; z: number } | null
```

### 5.5 `api.overlay` — High-DPI Canvas 2D World/Screen Drawing & Styles
```ts
// Draw every frame directly in CSS pixels on a hardware-scaled overlay canvas:
const unreg = api.overlay.registerLayer('my-layer', ({
  ctx, width, height, dtMs, worldToScreen, screenToWorld, rig
}) => {
  // Always check p.depth > 0.2 before drawing projected world coordinates!
  const p = worldToScreen(0, 0, 2);
  if (p.depth > 0.2) {
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}, { zIndex: 0 });

const removeCss = api.overlay.addStyle('.my-mod-badge { color: #fff; }');
```

### 5.6 `api.ui` — Native HUD Widgets, Top Bar Pills & Inspector Buttons
```ts
// Render a positioned HUD widget (non-blocking container; buttons/inputs & .mod-panel receive pointer events):
api.ui.registerHudWidget({
  id: 'panel',
  position: 'top-right', // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'custom'
  render: (hostEl) => {
    hostEl.innerHTML = `<div class="mod-panel">...</div>`;
    hostEl.querySelector('button')?.addEventListener('click', ...);
  },
});

// Add a button pill to the top HUD toolbar (in gameplay/sandbox/editor):
api.ui.registerTopBarAction({
  id: 'toggle',
  label: 'My Mod',
  title: 'Toggle mod feature',
  isActive: () => enabled,
  onClick: () => { enabled = !enabled; api.ui.refreshUi(); },
});

// Add an action button inside the selection inspector (e.g. click any car -> "Drive (FPV)"):
api.ui.registerInspectorAction({
  id: 'drive-this-car',
  target: 'vehicle', // currently supports 'vehicle'
  label: 'Drive (FPV)',
  onClick: (selection) => { /* selection = { type: 'vehicle', id: number } */ },
});

api.ui.refreshUi(): void
api.ui.getSelection(): unknown
api.ui.setSelection(selection: unknown): void
api.ui.getScreen(): ScreenName
api.ui.setFocusMode(focusMode: boolean): void
api.ui.showToast(text: string, opts?: { icon?: string; bad?: boolean }): void
```

### 5.7 `api.input` — Keyboard, Pointer & Input Capture
```ts
api.input.isKeyDown('KeyW' | 'w' | 'ArrowUp' | ...): boolean
api.input.onKeyDown((e: KeyboardEvent) => void): () => void
api.input.onKeyUp((e: KeyboardEvent) => void): () => void
api.input.onPointerDown((e: PointerEvent) => void): () => void
api.input.onPointerMove((e: PointerEvent) => void): () => void
api.input.onPointerUp((e: PointerEvent) => void): () => void
api.input.onWheel((e: WheelEvent) => void): () => void

// Suppress built-in WASD camera pan & editor hotkeys while driving (Escape always still passes through!):
api.input.setCapture({ keyboard: true, cameraKeys: true }): void
api.input.clearCapture(): void
```

### 5.8 `api.events`, `api.storage`, and `api.store`
```ts
// Events:
api.events.on('frame', (dtMs: number) => void)
api.events.on('tick', (tickCount: number, simTimeSec: number) => void)
api.events.on('netChange', (rt: RoadNetwork) => void)
api.events.on('screenChange', (nextScreen: string, prevScreen: string) => void)
api.events.on('selectionChange', (nextSel: unknown, prevSel: unknown) => void)

// Scoped persistent settings per mod:
api.storage.get(key: string, fallback?: T): T
api.storage.set(key: string, value: unknown): void
api.storage.remove(key: string): void

// Game Zustand store (advanced):
api.store.getState()
api.store.setState(patch)
api.store.subscribe((state, prev) => void)
```

---

## 6. Best Practices for AI Agents Authoring Mods

1. **Zero-Build Runtime**: Write clean plain JavaScript in `index.js` without TypeScript types or ESM `import`/`export` syntax so GitHub downloads run directly in both Electron and web browsers.
2. **Idempotent Activation & Clean Exit**: Never assume a map is already loaded when `activate(api)` runs — the user might enable your mod on the Title Screen before opening a level. React to `api.events.on('netChange', ...)` and `api.events.on('screenChange', ...)` cleanly.
3. **Never Block Gameplay When Idle**: Skip heavy loops when `api.world.getScreen()` is `'title'`, `'levels'`, or `'maps'`, or when `!api.world.getNetwork()`.
4. **Always Restore Game State**: If your mod calls `api.camera.setCustomRig(...)`, `api.input.setCapture(...)`, or `api.sim.setSignalOverrides(...)`, clear them both on mod toggle-off AND when returning to menus / pressing `Escape`.
5. **Handle `Escape` Gracefully**: Users instinctively press `Escape` to exit driving cameras or close mod modes. Always release `customRig` and `input.setCapture` on `Escape` when a custom camera mode is active.
6. **Project Safety in 3D**: Check `p.depth > 0.25 && Number.isFinite(p.x) && Number.isFinite(p.y)` before rendering 2D labels/shapes from `worldToScreen(x, y, z)`.
7. **Complete Working Examples**:
   - See `../MOD_HIGHWAYSCO_RAMPMETER` for an occupancy-responsive ramp metering signal controller + world gantry overlays + HUD controls.
   - See `../MOD_HIGHWAYSCO_FPVDRIVING` for a full 3D cockpit & free-drive mod built 100% with this public API.
