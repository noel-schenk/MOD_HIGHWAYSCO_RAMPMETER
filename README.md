# MOD_HIGHWAYSCO_RAMPMETER

Example **Highways & Co.** mod implementing adaptive **Highway Ramp Metering**.

## Features
- Automatically scans `api.world.findMergeConnectors()` to find highway on-ramps and merge junctions.
- Controls real traffic physics via `api.sim.setSignalOverrides(...)`, causing cars on enabled on-ramps to brake cleanly at the ramp stop bar on red and merge in metered platoons on green.
- Supports **Adaptive (Occupancy)** mode (adjusting green release rate from 4–16 veh/min based on downstream mainline congestion) and **Fixed Cycle** mode.
- Renders live world-space ramp-meter beacons, stop bars, and queue counters via `api.overlay.registerLayer(...)` plus a compact floating HUD panel via `api.ui.registerHudWidget(...)`.
- Lets players click any ramp beacon directly in the world to toggle individual ramp meters on/off, or toggle all meters from the top bar.
