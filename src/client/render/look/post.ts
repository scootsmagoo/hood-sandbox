/**
 * A small post-processing chain: the scene is drawn into a half-float target (multisampled where
 * the canvas is), an optional cheap two-level bloom is built from the bright parts, and one
 * composite pass does the tone mapping (the same ACES curve three.js uses), the colour grade of
 * `gradeLook` (timeOfDay.ts: saturation, contrast, lifted blacks, shadow, mid-tone and highlight
 * tints), a vignette and a little dither. With `levels = 0` it is the single cheap grade pass of
 * the Low tier: no bloom passes at all.
 *
 * It hooks `renderer.render` on the one instance, so nothing outside `look/` changes, and
 * `dispose()` puts the original back. Draw-call counts keep adding up across the passes
 * (`info.autoReset` is turned off and reset by hand once a frame).
 *
 * Cost: one full-size half-float target (8 bytes a pixel), a 1/4 and a 1/16 size chain
 * (about 6 small passes), and one full-screen composite. Low tier keeps only the 1/4 level.
 */
import * as THREE from 'three';
import { newGradeLook, type GradeLook } from '../timeOfDay';
import { GLSL_NOISE } from './glsl';

/** The grade plus the renderer's exposure. */
export interface PostGrade extends GradeLook {
  exposure: number;
}

export function newGrade(): PostGrade {
  return { ...newGradeLook(), exposure: 1 };
}

const FULL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Bright pass and 4x4 box downsample (four bilinear taps), with a soft knee and a Karis-style weight against fireflies. */
const PREFILTER = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
vec3 bright(vec3 c) {
  float l = max(c.r, max(c.g, c.b));
  float knee = 0.5;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  return c * max(soft, l - uThreshold) / max(l, 1e-4);
}
void main() {
  vec3 a = bright(texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb);
  vec3 b = bright(texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb);
  vec3 c = bright(texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb);
  vec3 d = bright(texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb);
  vec3 col = (a + b + c + d) * 0.25;
  gl_FragColor = vec4(min(col, vec3(16.0)), 1.0);
}`;

const DOWN = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 a = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 d = texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  gl_FragColor = vec4((a + b + c + d) * 0.25, 1.0);
}`;

/** 9-tap Gaussian in five bilinear fetches. */
const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
  c += texture2D(tSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloomA;
uniform sampler2D tBloomB;
uniform float uExposure;
uniform float uBloom;
uniform float uBloomB;
uniform float uSat;
uniform float uContrast;
uniform vec3 uShadowTint;
uniform vec3 uMidTint;
uniform vec3 uHighTint;
uniform float uLift;
uniform float uVignette;
varying vec2 vUv;
${GLSL_NOISE}

// three.js's ACESFilmicToneMapping, so the curve matches the default look.
const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  color *= uExposure / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  c += texture2D(tBloomA, vUv).rgb * uBloom + texture2D(tBloomB, vUv).rgb * uBloomB;
  vec3 col = aces(c);
  col = toSrgb(col);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  // an S-curve around mid grey, strength from uContrast
  vec3 s = col * col * (3.0 - 2.0 * col);
  col = mix(col, s, uContrast);
  col *= mix(vec3(1.0), uMidTint, 1.0 - abs(l * 2.0 - 1.0));
  col *= mix(uShadowTint, uHighTint, smoothstep(0.05, 0.75, l));
  col = uLift + col * (1.0 - uLift);
  vec2 q = vUv - 0.5;
  col *= 1.0 - uVignette * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
  col += (gfxH21(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

function passMaterial(frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FULL_VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

type RenderFn = THREE.WebGLRenderer['render'];

export class PostFx {
  readonly grade = newGrade();
  /** Bloom levels to build this frame: 2 (1/4 and 1/16 size), 1 (1/4 only) or 0 (none: the grade pass alone). */
  levels = 2;
  private readonly size = new THREE.Vector2();
  private readonly rtOpts: THREE.RenderTargetOptions;
  private scene: THREE.WebGLRenderTarget;
  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  private c: THREE.WebGLRenderTarget;
  private d: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly prefilterMat: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly compositeMat: THREE.ShaderMaterial;
  private original: RenderFn | null = null;
  private originalRender: RenderFn | null = null;
  private wasAutoReset = true;
  private busy = false;
  private sizeKey = -1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly game: { scene: THREE.Scene; camera: THREE.Camera },
  ) {
    const attrs = renderer.getContext().getContextAttributes();
    const msaa = attrs?.antialias ? 4 : 0;
    this.rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, stencilBuffer: false };
    this.scene = new THREE.WebGLRenderTarget(1, 1, { ...this.rtOpts, samples: msaa });
    const small: THREE.RenderTargetOptions = { ...this.rtOpts, depthBuffer: false };
    this.a = new THREE.WebGLRenderTarget(1, 1, small);
    this.b = new THREE.WebGLRenderTarget(1, 1, small);
    this.c = new THREE.WebGLRenderTarget(1, 1, small);
    this.d = new THREE.WebGLRenderTarget(1, 1, small);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.prefilterMat = passMaterial(PREFILTER, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.0 } });
    this.downMat = passMaterial(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.blurMat = passMaterial(BLUR, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.compositeMat = passMaterial(COMPOSITE, {
      tScene: { value: null },
      tBloomA: { value: null },
      tBloomB: { value: null },
      uExposure: { value: 1 },
      uBloom: { value: 0.4 },
      uBloomB: { value: 0.4 },
      uSat: { value: 1 },
      uContrast: { value: 0 },
      uShadowTint: { value: this.grade.shadowTint },
      uMidTint: { value: this.grade.midTint },
      uHighTint: { value: this.grade.highlightTint },
      uLift: { value: 0 },
      uVignette: { value: 0.2 },
    });
    this.quad = new THREE.Mesh(geo, this.prefilterMat);
    this.quad.frustumCulled = false;
    // nothing here moves: no matrix to compose and no world matrix to recompute in each of the chain's render calls
    this.quad.matrixAutoUpdate = false;
    this.quadScene.matrixAutoUpdate = false;
    this.quadScene.add(this.quad);
  }

  /** Starts drawing through the chain. */
  install(): void {
    if (this.original) return;
    const r = this.renderer;
    this.originalRender = r.render;
    this.original = r.render.bind(r);
    this.wasAutoReset = r.info.autoReset;
    r.info.autoReset = false;
    r.render = (scene: THREE.Scene, camera: THREE.Camera) => {
      if (this.busy || scene !== this.game.scene || camera !== this.game.camera) {
        this.original!(scene, camera);
        return;
      }
      this.render(scene, camera);
    };
  }

  private resize(): void {
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(2, this.size.x);
    const h = Math.max(2, this.size.y);
    const key = w * 100000 + h + this.levels * 1e11;
    if (this.sizeKey === key) return;
    this.sizeKey = key;
    this.scene.setSize(w, h);
    // The bloom targets stay at 2 x 2 for levels that are not built, so Low pays nothing for them.
    const q = (n: number, f: number, on: boolean) => (on ? Math.max(2, Math.floor(n / f)) : 2);
    this.a.setSize(q(w, 4, this.levels > 0), q(h, 4, this.levels > 0));
    this.b.setSize(q(w, 4, this.levels > 0), q(h, 4, this.levels > 0));
    this.c.setSize(q(w, 16, this.levels > 1), q(h, 16, this.levels > 1));
    this.d.setSize(q(w, 16, this.levels > 1), q(h, 16, this.levels > 1));
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.original!(this.quadScene, this.quadCam);
  }

  private render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    this.busy = true;
    try {
      r.info.reset();
      this.resize();
      // The scene, into the half-float target (no tone mapping there: three.js applies it only to the screen).
      r.setRenderTarget(this.scene);
      this.original!(scene, camera);

      const g = this.grade;
      const levels = this.levels;
      const pm = this.prefilterMat.uniforms;
      pm.uThreshold.value = g.bloomThreshold;
      if (levels > 0) {
        // bright pass to 1/4, blur
        pm.tSrc.value = this.scene.texture;
        (pm.uTexel.value as THREE.Vector2).set(1 / this.scene.width, 1 / this.scene.height);
        this.pass(this.prefilterMat, this.a);
        this.blur(this.a, this.b);
      }
      if (levels > 1) {
        const dm = this.downMat.uniforms;
        dm.tSrc.value = this.a.texture;
        (dm.uTexel.value as THREE.Vector2).set(1 / this.a.width, 1 / this.a.height);
        this.pass(this.downMat, this.c);
        this.blur(this.c, this.d);
      }
      const cu = this.compositeMat.uniforms;
      cu.tScene.value = this.scene.texture;
      cu.tBloomA.value = this.a.texture;
      cu.tBloomB.value = (levels > 1 ? this.c : this.a).texture;
      cu.uExposure.value = g.exposure;
      cu.uBloom.value = levels > 0 ? g.bloom * (levels > 1 ? 0.6 : 1.0) : 0;
      cu.uBloomB.value = levels > 1 ? g.bloom * 0.7 : 0;
      cu.uSat.value = g.saturation;
      cu.uContrast.value = g.contrast;
      cu.uVignette.value = g.vignette;
      cu.uLift.value = g.lift;
      this.pass(this.compositeMat, null);
    } finally {
      r.setRenderTarget(null);
      this.busy = false;
    }
  }

  /** Separable blur: `a` into `b` and back, in place of `a`. */
  private blur(a: THREE.WebGLRenderTarget, b: THREE.WebGLRenderTarget): void {
    const u = this.blurMat.uniforms;
    u.tSrc.value = a.texture;
    (u.uDir.value as THREE.Vector2).set(1 / a.width, 0);
    this.pass(this.blurMat, b);
    u.tSrc.value = b.texture;
    (u.uDir.value as THREE.Vector2).set(0, 1 / a.height);
    this.pass(this.blurMat, a);
  }

  dispose(): void {
    if (this.original) {
      this.renderer.render = this.originalRender!;
      this.renderer.info.autoReset = this.wasAutoReset;
      this.original = null;
    }
    this.renderer.setRenderTarget(null);
    for (const t of [this.scene, this.a, this.b, this.c, this.d]) t.dispose();
    this.quad.geometry.dispose();
    for (const m of [this.prefilterMat, this.downMat, this.blurMat, this.compositeMat]) m.dispose();
  }
}
