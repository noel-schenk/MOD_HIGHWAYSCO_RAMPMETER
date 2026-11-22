# MOD_HIGHWAYSCO_RAMPMETER

Example **Highways & Co.** mod implementing adaptive **Highway Ramp Metering**.

## Features
- Automatically scans `api.world.findMergeConnectors()` to find highway on-ramps and merge junctions.
- Controls real traffic physics via `api.sim.setSignalOverrides(...)`, causing cars on enabled on-ramps to brake cleanly at the ramp stop bar on red and merge in metered platoons on green.
- Supports **Adaptive (Occupancy)** mode (adjusting green release rate based on downstream mainline congestion) and **Fixed Cycle** mode, both as global defaults and individually per ramp meter.
- Allows per-ramp customization in the HUD panel: click any ramp row to rename it, toggle it on/off, override its mode (`Global` / `Adaptive` / `Fixed`), or tune release interval, green phase, target occupancy, min/max cycle bounds, and queue override threshold (with one-click reset or **Apply to All**).
- Renders live world-space ramp-meter beacons, selection highlights, custom indicators, and queue counters via `api.overlay.registerLayer(...)` plus a compact floating HUD panel via `api.ui.registerHudWidget(...)`.
- Lets players click any ramp beacon directly in the world to toggle individual ramp meters on/off (or `Shift+Click` to select without toggling), or toggle all meters from the top bar.
