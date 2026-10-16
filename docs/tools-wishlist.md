# Tools wishlist

Free tools the owner could install on the Ubuntu dev box, for realistic assets, animation, dialog and behaviour. Written 2026-10-16.

**Key for the status marks.** [V] = checked on the official page this session. [S] = secondhand (search snippets, forum posts). [U] = not verified here; from memory or the brief, so check before relying on it. A "not fetched" note means the page was unreachable (404, 403 or a certificate error).

**The one rule for a public repo.** Code and assets that ship in the repo must be licensed for redistribution, not just for use. Licence of the tool and licence of its output are separate questions. Blender (GPL) output carries no obligation. An asset pack's own licence applies to the files we commit.

---

## Corrections to the brief and the graphics plan

- **Quaternius is not CC0.** Its Quaternius Asset License (QAL) v1.0 [V] allows commercial use without credit, but forbids reselling or redistributing the assets themselves, alone or bundled (section 3(a)). Committing its `.glb` or `.fbx` files to this public repo breaks that. Use it only as a style reference, or let the owner decide to buy a licence.
- **Piper voices vary.** The engine is GPL-3.0 [V], and the voices are not all the same licence (see section 4).

---

## 1. Realistic humans

| Tool | What it's for | Licence (code / output) | Sudo? | Install | Disk | Headless |
|---|---|---|---|---|---|---|
| **MPFB2** (MakeHuman plugin for Blender) [V] | Parametric human bodies, with clothes and hair, generated and exported to glTF from Blender | Code: **GPL-3.0** [V]. Assets: `LICENSE.ASSETS.md` contains the **CC0 1.0** text [V], so assets are CC0. Confirm per asset folder before committing. Output: no obligation from the GPL. | No. Blender extension or zip in the user dir (to confirm) | Blender 4.2+ is required [V]; install per the MPFB quick start (static.makehumancommunity.org) [U]. The download is not verified. | [U] a few hundred MB | [U] scripts should run under `blender -b`; test it |
| **MakeHuman 1.x** (standalone) | Same job, GUI app | [U] AGPL-3.0 software, CC0 assets. The official page returned 404 here. | Probably not needed; MPFB2 covers it | [U] download from makehumancommunity.org | [U] | Not useful headless; use MPFB2 |
| **Other character bases** | Clear licence alternatives | Quaternius: QAL, see the corrections above. Kenney: CC0 [U]. | | | | |

**Recommendation:** MPFB2. Generate a few base bodies, store the generator settings (not the exported mesh) in the repo, and export the mesh per build.

---

## 2. Animation

### 2a. Free mocap and animation sources

| Source | Licence | Redistribution risk for this repo | Verdict |
|---|---|---|---|
| **CMU Graphics Lab mocap database** | Official page not reachable here. Secondhand notices [S]: free for research and commercial use in products, but **no reselling of the data itself**, even converted. CMU asks for an acknowledgement ("The data used in this project was obtained from mocap.cs.cmu.edu..."). Some third-party conversions carry other labels (one shows CC BY 4.0 [S]). | Committing raw BVH/FBX to the repo is redistributing the data. Medium-high risk. | Use the clips at build time from the CMU source, or keep only baked, retargeted clips that are clearly derived. Check the current notice on mocap.cs.cmu.edu first. |
| **Mixamo** (Adobe) | Free with an Adobe account [S]. Community reading of the FAQ (2022) [S]: animations may be used in finished products, but **raw animation files may not be distributed**, nor given to customers or non-team members. Datasets may not be published. Adobe's current ToS was not reachable. | **High.** A public repo full of Mixamo `.fbx` or `.glb` is the thing the terms forbid. Also no API, so no headless fetch: a human clicks through the web UI. | **Avoid for committed files.** Fine as a private reference for a human to study. |
| **Quaternius animations** | QAL v1.0 [V]: no redistribution of the assets, alone or bundled. | High, as above. | Avoid committing; reference only. |
| **Kenney** animation packs | CC0 [U] | Low. | Good for stand-in clips. |
| **Synthetic: procedural keyframes in Blender scripts** | Ours (MIT). | None. | Preferred. Agents can author walk, idle, and cover-behind-car clips in Python. |

### 2b. Retargeting tools (headless)

- **Blender itself** (GPL-3.0 [U]; output unencumbered). Rigify is bundled [U]. Retargeting is done by a Python script with `Copy Rotation` constraints or by baking the action. Works headless with `blender -b --python`. **No sudo, no account.** Recommended.
- **Rokoko Blender add-on** [S]. Free for retargeting, but it needs a free Rokoko account sign-in [S]. Its licence was not found [U]. It is a GUI-oriented workflow, so headless use is doubtful [U]. **Owner step** (the sign-up); only worth it if the script route fails.
- Paid add-ons such as Auto-Rig Pro are out of scope (not free).

**Disk:** Blender is already installed. Nothing extra for the script route.

---

## 3. Textures, materials and compression

| Tool | What it's for | Licence (tool / output) | Sudo? | Install | Disk | Headless |
|---|---|---|---|---|---|---|
| **ambientCG** | PBR sets: asphalt, concrete, brick, plaster, metal cladding, roof membrane | CC0 1.0 [V] (docs.ambientcg.com/license, verified 2026-10-15 per graphics plan). Output: CC0. | No | Download by hand or script the page URL. Record each file in `assets/LICENSES.md`. | ~1 to 3 MB per 1K set [U] | Yes, via `curl` |
| **Poly Haven** | Textures, HDRIs for reflections, a few props | CC0 [V] (polyhaven.com/license, 2026-10-15 per graphics plan). | No | Public API or site download [U] | Varies; 1K HDRI about 1 to 2 MB [U] | Yes |
| **Generated textures** | Window sprites, shopfront atlas, decals, noise LUTs from scripts in `tools/textures/` | Ours, MIT. No licence question. | No | Already planned | None | Yes |
| **KTX-Software** (`toktx`, `ktx`) [V] | Compress to KTX2 (Basis / ASTC / ETC1S); used by `KTX2Loader` in three.js | **Apache-2.0** [V] (LICENSE.md). Output: no obligation. | No, if the Linux release tarball is unpacked into `~/.local` [U] | GitHub Releases tarball [V, listed; exact file name not checked]. A `pyktx` Python wrapper exists [V, listed]. Avoid `apt` if the tarball works. | [U] tens of MB unpacked | Yes |
| **glTF-Transform** (`gltf-transform`) | Already in use: meshopt, texture resize, KTX2 | MIT [U, the graphics plan lists it as MIT] | No (npm) | `npm i -D @gltf-transform/cli` in the repo | Small | Yes |
| **meshoptimizer** | Mesh compression (`EXT_meshopt_compression`) | MIT [U] | No | Via glTF-Transform | Small | Yes |

**Atlases.** Packing textures into atlases needs no separate tool. Scripts in `tools/textures/` can use Pillow (pip `--user` or a venv) or ImageMagick (apt, owner step).

---

## 4. Dialog and voice

### 4a. Text-to-speech engines

| Engine | Licence (engine / voices) | Sudo? | Install | Disk | Headless |
|---|---|---|---|---|---|
| **Piper** (`piper-tts` on PyPI) [V] | Engine: **GPL-3.0** [V] in the `OHF-Voice/piper1-gpl` repo. Voices: see the table below; **each voice's licence is separate**. An older `rhasspy/piper` repo was MIT [U]; its status was not verified. | No, if installed in a venv. (Ubuntu's PEP 668 blocks `pip --user` on system Python, so use `python3 -m venv ~/.local/share/piper-venv`.) | `python3 -m venv ...; pip install piper-tts` [V] | Engine ~100 MB with onnxruntime [U]; each voice ~20 to 60 MB [U] | Yes (CLI, reads text on stdin) |
| **eSpeak NG** [V] | GPL-3.0 or later [V]. Voice data: no statement on the page [V]. | Owner (`apt`) [U] | `apt install espeak-ng` [U] | ~20 MB [U] | Yes. Robotic; useful for radio static and as a fallback. |
| **Coqui XTTS-v2** [V] | **Coqui Public Model License (CPML)**, which is non-commercial [V on the licence name; the restriction is the known CPML term, U]. **Avoid.** | n/a | n/a | Several GB [U] | Yes, but licence-blocked |

**Piper voices, checked on their model cards** (`rhasspy/piper-voices`):

| Voice | Licence on the model card | Verdict |
|---|---|---|
| `en_US-ryan-high` | **CC BY-NC-SA 4.0** [V] (dataset block) | **Non-commercial only. Avoid.** |
| `en_US-lessac` (all qualities) | Points to the Blizzard 2013 licence [V]. That licence is research-only and bans commercial use [V]. | **Avoid.** |
| `en_US-amy` | Dataset points to the Mycroft mimic3-voices repo [V]; that repo's sidebar says CC-BY-SA-4.0 [V, repo-level, not per voice]. Amy is believed to be LJSpeech-based (public domain) [U]. | **Probably fine, not confirmed.** Check the per-voice dataset page before shipping. |
| `en_GB-alan` | "See URL" in the dataset block [V]; the URL was not checked. | Unknown. Check before use. |

**Honest gap:** no Piper voice was confirmed as both commercial-OK and redistributable in this session. Shortlist to check next: `amy` (above), plus any voice whose dataset is CC0 or public domain. A voice trained on CC BY or CC BY-SA data needs attribution, and BY-SA's share-alike would reach the voice files we ship.

**Process rule:** before adding any voice, record its model card URL and dataset licence in `assets/LICENSES.md`.

### 4b. Audio processing

| Tool | Licence (tool / output) | Sudo? | Install | Disk | Headless |
|---|---|---|---|---|---|
| **ffmpeg** [V] | LGPL-2.1+ by default; a GPL build (for example with libx264) makes the whole build GPL [V]. Output: no obligation. | Owner (`apt`) | `sudo apt install ffmpeg` [U] | ~100 MB [U] | Yes |
| **sox** | GPL-2.0 [U] | Owner (`apt`) | `sudo apt install sox` [U] | ~5 MB [U] | Yes |

Agents can use the Piper output and `ffmpeg` (once installed) to trim, normalise and convert clips to Ogg or MP3. Without ffmpeg, Python with `soundfile` (pip `--user` or venv) covers WAV work.

### 4c. Dialog text

Written by agents. No tool is needed.

---

## 5. Behaviours and AI

Nothing is needed for the AI itself. Peds, police, and traffic are TypeScript logic, and the README already puts them in the sim worker.

- **recast-navigation-js** [U, from the brief]: MIT, WASM navmesh (recast and detour). Use only if the pedestrian lanes need navmesh pathfinding. Install: `npm i @recast-navigation/core` [U]. Not verified here: the GitHub page returned 404 and the npm page returned 403.
- Rapier (already the physics engine) and Rust-to-WASM (in the stack) cover everything else.

---

## 6. Anything else

- **Git LFS** [U]: MIT, free on GitHub. Install: apt, or the release binary into `~/.local/bin` (no sudo). Worth it if committed binaries (glb, KTX2, audio) pass about 50 to 100 MB. Not needed yet.
- **Blender 5.2.2** (already installed): GPL-3.0 [U]. Its output is unencumbered.
- **Pillow, soundfile, numpy** (pip in a venv): free, for texture and audio scripts.

---

## Recommendation

**Install (owner, this weekend):**
1. **ffmpeg** (`sudo apt install ffmpeg`). Audio conversion. LGPL build by default.
2. **eSpeak NG** (`sudo apt install espeak-ng`). Optional; for radio static and as a fallback voice.

Everything else is installable without sudo, so the owner does not need to do it.

**Agents can install without the owner:**
- **Piper** in a venv (`python3 -m venv ~/.local/share/piper-venv && ~/.local/share/piper-venv/bin/pip install piper-tts`), plus one voice (`amy`, after its licence is checked).
- **MPFB2** into Blender's user extensions directory, once the install route is confirmed.
- **KTX-Software** `toktx` unpacked into `~/.local/bin`, from the GitHub Releases tarball.
- **gltf-transform, meshoptimizer, recast-navigation-js** via npm in the repo.
- **ambientCG and Poly Haven** downloads, with a record in `assets/LICENSES.md`.
- **Blender scripts** for animation and retargeting. No add-on needed.

**Avoid, for licence reasons:**
- **Mixamo** and **Quaternius** files committed to the repo (both forbid redistributing the assets).
- **CMU mocap** raw files committed to the repo (no reselling the data; check the current notice first).
- **Coqui XTTS** (CPML, non-commercial).
- **Piper `ryan-high`** and **`lessac`** voices (non-commercial, or research-only).
- Any asset marked **CC BY-NC** or **CC BY-SA** without a decision on share-alike.
