# Tech stack research: engines, WebGPU, physics, threads, formats

*Research pass, 14 October 2026. Package versions were checked on npm that day. Anything marked "unverified" could not be confirmed from a primary source.*

## 1. WebGPU support (Oct 2026)

From the gpuweb Implementation Status wiki (edited 2 Oct 2026):

- **Chrome and Edge**
  - Windows, macOS and ChromeOS since version 113.
  - Android 12+ since 121 (ARM, Qualcomm and Intel GPUs).
  - Linux: Intel Gen12+ since 144, NVIDIA under Wayland since 147. **Other Linux GPUs, likely including AMD, are still behind a flag.** The owner's Radeon 8060S is therefore probably flag-only in Chrome on Linux (not tested).
  - Windows on ARM64: behind a flag.
- **Firefox**
  - Windows since 141 (July 2025).
  - macOS on Apple Silicon since 145 on macOS 26, and since 147 on all macOS versions.
  - Linux and Intel Macs: Nightly only.
  - Android: behind a flag.
- **Safari 26** (Sept 2025): on by default on macOS, iOS, iPadOS and visionOS.

**We still need a WebGL2 fallback.** Linux, older iPhones and some Android GPUs don't have WebGPU. The three.js WebGPURenderer, Babylon and PlayCanvas all fall back to WebGL2 on their own.

## 2. Candidate stacks

### three.js r186 (0.186.1)

A three.js forum thread from May 2026, testing r183 with 4,000 meshes and about 8M triangles, measured:

| Renderer | CPU render time | First frame |
|---|---|---|
| WebGLRenderer | 4.5 ms | 32 ms |
| WebGPURenderer, WebGPU backend | 9.7 ms | 167 ms |
| WebGPURenderer, forced WebGL backend | 10.3 ms | 344 ms |

So the extra cost comes from the WebGPURenderer class itself, not from WebGPU. The advice in the thread is to use instancing and batching. TSL (the three.js shading language) does give compute shaders, which are useful for GPU culling, particles and crowds.

- Large-world support is do-it-yourself: no floating origin, no streaming.
- AI agents iterate fastest here, because there is far more example code than for any other option.
- Low risk: proven on Skyrome.

### Babylon.js 9.x (9.0 on 26 Mar 2026; currently 9.30.0)

- WGSL-native shaders, Frame Graph, clustered lighting, geospatial features.
- An experimental `useLargeWorldRendering` option (high-precision matrices plus a floating origin). This is the best built-in large-world support of the JavaScript options.
- Havok WASM (`@babylonjs/havok` 1.3.14; free under MIT, but closed source).
- **No confirmed Havok vehicle controller.** It is a "planned" GitHub issue, #13800.
- The catch: a heavier framework, and we'd have to migrate away from the existing three.js toolkit.

### PlayCanvas engine v2.23.2

- Active and WebGPU-heavy, but the docs still label WebGPU "Beta".
- Strong on Gaussian splats and its editor.
- Fewer large-world and vehicle examples, and less code for agents to learn from.

### Bevy 0.20 (8 Oct 2026)

- Releases come every 3–4 months, and each one breaks the API.
- WebGPU by default, with a WebGL2 build available.
- **Effectively single-threaded on the web.** WASM threads need nightly Rust's `-Zbuild-std` and atomics.
- Release WASM builds are tens of MB before compression (unverified estimate).
- Asset loading over HTTP arrived in 0.17. No hot patching on WASM. The editor is still being built.
- Large worlds rely on community crates such as `big_space`.
- Rust compile times and API churn slow AI agents down.
- The upside: one Rust codebase for client and server (example: wasm-fantasia, which pairs Bevy with SpacetimeDB).
- **High risk for a browser-first game.**

### Godot 4.7 (Jun 2026)

- Web export is WebGL2 and the Compatibility renderer only.
- No C# on the web.
- Single-threaded by default; threads need COOP/COEP headers or a service-worker workaround.
- Limited web audio. wasm64 arrived in 4.7.
- Not suited to a demanding browser open world.

### Unity 6.6 and Unreal

- Unity 6.6 reportedly made WebGPU fully supported for web builds (secondary source), but downloads are big and agents can't drive it as easily as TypeScript.
- Unreal has no official web export. A UE5 WebGPU port has been demoed; no public release has been confirmed.

## 3. Vehicle physics

- **Rapier** (`@dimforge/rapier3d-compat` / `-simd-compat` 0.21.0, 25 Sep 2026)
  - `DynamicRayCastVehicleController` has been in rapier.js since 0.12. It's a port of Bullet's `btRaycastVehicle`, with per-wheel suspension, friction and steering.
  - Usable, but it's a physical raycast car, not an arcade one.
  - Deterministic builds exist. The JS builds are float32.
- **Jolt** (`jolt-physics` 1.1.0, Jul 2026)
  - Exposes the full C++ vehicle stack: WheeledVehicleController, plus motorcycle and tank demos.
  - Multithreaded WASM builds and SIMD. Double precision and cross-platform determinism are available as custom builds.
  - Memory is managed by hand.
  - **The best vehicle model of the lot**, behind a C++-style API.
- **PhysX** (`physx-js-webidl` 2.8.0): it's unclear whether the vehicle SDK is exposed.
- **Havok for the web**: no shipped vehicle controller.

**What GTA-style games do:** a custom raycast vehicle for the player car (tunable grip, drift, assists), and a cheaper model for AI traffic: kinematic cars on lane splines, upgraded to rigid bodies only near the player or on collision. Fully simulating dozens of AI cars is wasted effort.

**Recommendation:** write our own raycast car on Rapier rigid bodies and ray casts. Try Jolt if the handling feels wrong.

## 4. Multithreading

- Web Workers are available everywhere. OffscreenCanvas works in Chrome 69, Firefox 105 and Safari 16.4.
- **SharedArrayBuffer and WASM threads require cross-origin isolation:** `COOP: same-origin` plus `COEP: require-corp` (or `credentialless`).
  - `credentialless` works in Chrome 96+ and Firefox 119+, but **not in Safari**.
  - So with Safari in the mix, every cross-origin asset needs CORP or CORS headers.
- **GitHub Pages can't set headers.**
  - The `coi-serviceworker` workaround reloads the page on the first visit and must be served unbundled from our own origin.
  - **Cloudflare Pages and Workers can set real headers** through a `_headers` file.
- **Physics and AI can run in a worker:** Rapier in a worker, with transforms written to a SharedArrayBuffer `Float32Array`. If the page isn't isolated, fall back to transferable buffers sent with postMessage.
- Cross-origin isolation also blocks embedding third-party ads and iframes.

## 5. Streaming formats and precision

- **Meshes:** glTF with `EXT_meshopt_compression` (meshoptimizer 1.3.0). It decodes faster than Draco and also compresses animation.
- **Textures:** KTX2/Basis.
- **Tiles:** OGC 3D Tiles through NASA-AMMOS `3d-tiles-renderer` 0.5.3, the right container for city tiles with hierarchical LOD.
- **Google Photorealistic 3D Tiles:** the terms forbid caching, extraction and modification, and the meshes can't serve as collision. Don't use them.
- **float32 precision:** the smallest step is about 1 mm at 10 km from the origin and about 4 mm at 40–60 km.
  - The fixes are camera-relative rendering and rebasing physics around the player's area.
  - Our compressed map (about 15 × 20 km) stays within about 2 mm, so this isn't urgent, but rebasing is cheap insurance.

## 6. Recommendation

1. **Client:** TypeScript + Vite + three.js `WebGLRenderer` + Rapier, using the BatchedMesh, InstancedMesh and LOD toolkit proven on Skyrome. Keep the renderer behind an interface so `WebGPURenderer` can be A/B tested each release.
2. **World:** an offline Node pipeline turns OSM and 3DEP data into sector tiles (glTF + meshopt + KTX2). Render camera-relative.
3. **Hot paths:** run physics and traffic in a worker. Move traffic, pathing and vehicle code into a Rust crate compiled to WASM only when profiling demands it; the same crate builds natively or as WASM for a server.
4. **Multiplayer:** an authoritative server. Client prediction for the player's own car only; traffic and police are owned by the server and sent as snapshots. Determinism isn't needed if the server is authoritative.

> In the README we chose a **TypeScript/Node** server sharing the sim code, rather than a Rust server, so there is one language. Rust stays an option for hot paths compiled to WASM, which also run under Node.

## Sources

- https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- https://web.dev/blog/webgpu-supported-major-browsers
- https://discourse.threejs.org/t/webgpurenderer-2x-slower-cpu-and-5-10x-slower-first-frame-than-webglrenderer-on-many-mesh-scenes-r183-same-on-both-backends/91904
- https://threejs.org/manual/en/webgpurenderer
- https://blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0
- https://forum.babylonjs.com/t/new-large-world-rendering-experimental/61114
- https://forum.babylonjs.com/t/havok-vehicle-controller/41961
- https://github.com/playcanvas/engine/releases
- https://bevy.org/news/bevy-0-20/
- https://github.com/scriptogre/wasm-fantasia
- https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html
- https://rapier.rs/javascript3d/classes/DynamicRayCastVehicleController.html
- https://github.com/dimforge/rapier.js/blob/master/CHANGELOG.md
- https://github.com/jrouwe/JoltPhysics.js
- https://www.npmjs.com/package/physx-js-webidl
- https://github.com/gzuidhof/coi-serviceworker
- https://github.com/mdn/browser-compat-data
- https://web.dev/articles/webassembly-threads
- https://github.com/NASA-AMMOS/3DTilesRendererJS
