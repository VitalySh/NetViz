# NetViz — Multi-Layer Overlay & Physical Network Visualizer

**NetViz** renders complex multi-layered networks defined in YAML—solving the "spaghetti graph" problem when combining **physical hardware topologies (L0)** with **deeply stacked logical overlays (L1 → LN)** such as BGP underlays, EVPN/VXLAN fabrics, SD-WAN tunnels, Kubernetes CNIs, and mTLS Service Meshes.

## How NetViz Tames Multi-Layer Complexity

- **Switchable 2D + 3D/2.5D Stacked Planes (plus Coordinated Split View)**:
  - **3D Stacked Planes**: Renders each network layer on its own translucent horizontal plane with **cross-layer coordinate anchoring**—virtual VTEPs, VMs, K8s nodes, and microservices align directly above the physical racks and servers hosting them, connected by vertical dependency pillars.
  - **2D Topology Schematic**: Toggle between **Layer Swimlanes** (vertical architectural elevation bands) and **Host-Anchored** rack clustering.
- **Recursive Cross-Layer Path & Blast-Radius Tracing**:
  - **Downward Underlay Resolution**: Select any high-level service link (e.g., Layer 4 mTLS RPC) to illuminate every intermediate tunnel (K8s CNI → VXLAN → eBGP ECMP) all the way down to the exact physical servers, ToR switches, spines, and optical fibers carrying it.
  - **Upward Blast Radius**: Select any physical switch, server, or fiber link to highlight all dependent overlays and application services across every upper layer.
- **ECMP-Aware Failure Simulation**:
  - Simulate a node or link outage in 1 click to test redundancy: NetViz distinguishes **Degraded** overlays (`1/2 ECMP underlay paths active`) from **Down** outages (`0/2 underlay paths active`).
- **Layer Soloing, Ghosting & Collapsible Containers**:
  - **Solo** any overlay layer while optionally keeping `L0 · Physical` ghosted underneath for hardware context.
  - Fold hierarchical `site`, `rack`, `zone`, or `namespace` containers into compact summary nodes with aggregated link bundles.
- **CLI + Live Local YAML File Watcher**:
  - Watch any `.yaml` file on disk via Server-Sent Events (SSE) for instant hot-reload as you edit, or edit & save directly from the built-in **YAML Source** drawer with live Zod & cross-layer DAG validation.

---

## Quick Start

```bash
# Start NetViz watching the default 5-layer Datacenter + EVPN + K8s + Service Mesh example:
npm start

# Or pass a specific YAML topology file to watch:
npm start -- examples/dc-evpn-k8s-5layer.yaml
npm start -- examples/multi-site-wan-sdwan.yaml --port 4000
```

### Other Commands

```bash
npm run dev      # Start Vite dev server with live YAML watcher API
npm run build    # Type-check & build production bundle
npm run test     # Run Vitest unit suite for YAML parser, ECMP resolver & group folding
```

## Included Example Topologies

- [`examples/dc-evpn-k8s-5layer.yaml`](./examples/dc-evpn-k8s-5layer.yaml) — 5-layer spine-leaf physical Clos → eBGP → EVPN/VXLAN → Cilium WireGuard K8s CNI → Envoy mTLS Service Mesh.
- [`examples/multi-site-wan-sdwan.yaml`](./examples/multi-site-wan-sdwan.yaml) — 4-layer global WAN demonstrating explicit `carriedBy` traffic engineering (Voice RTP pinned to Gold MPLS vs SAP ERP dual-homed over MPLS + DIA Internet).
- [`examples/minimal-starter.yaml`](./examples/minimal-starter.yaml) — Concise 3-layer template demonstrating automatic `hostedOn` underlay path inference.

See [`docs/yaml-schema.md`](./docs/yaml-schema.md) for the complete YAML specification.
