import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ─── Renderer ─────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000005);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 1.5, 9);

// The central light sits at the origin — everything orbits around it.
const CENTER = new THREE.Vector3(0, 0, 0);

// ─── Post-processing: Unreal bloom ────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.35,  // strength
  0.5,   // radius
  0.25   // threshold (only the brighter cores bloom)
);
composer.addPass(bloomPass);

// Motion blur: an afterimage trail whose length is driven by camera speed,
// so it only smears while orbiting and stays crisp when the view is still.
const afterimagePass = new AfterimagePass();
afterimagePass.uniforms['damp'].value = 0.0;
composer.addPass(afterimagePass);

// ─── Chromatic aberration ─────────────────────────────────────────────────────
const chromaticPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    amount:   { value: 0.004 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      float r = texture2D(tDiffuse, vUv + vec2( amount, 0.0)).r;
      float g = texture2D(tDiffuse, vUv                    ).g;
      float b = texture2D(tDiffuse, vUv - vec2( amount, 0.0)).b;
      gl_FragColor = vec4(r, g, b, 1.0);
    }
  `,
});
chromaticPass.enabled = false;
composer.addPass(chromaticPass);

// ─── Vignette ─────────────────────────────────────────────────────────────────
const vignettePass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.9 },
    softness: { value: 0.6 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float softness;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float dist = length(vUv - 0.5);
      float vignette = smoothstep(0.5, 0.5 - softness, dist * strength);
      gl_FragColor = vec4(color.rgb * vignette, color.a);
    }
  `,
});
vignettePass.enabled = false;
composer.addPass(vignettePass);

// ─── Pixelation ───────────────────────────────────────────────────────────────
const pixelationPass = new ShaderPass({
  uniforms: {
    tDiffuse:   { value: null },
    resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    pixelSize:  { value: 3.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float pixelSize;
    varying vec2 vUv;
    void main() {
      vec2 dxy = pixelSize / resolution;
      vec2 coord = dxy * floor(vUv / dxy);
      gl_FragColor = texture2D(tDiffuse, coord);
    }
  `,
});
pixelationPass.enabled = false;
composer.addPass(pixelationPass);

composer.addPass(new OutputPass());

// ─── Orbit controls (light stays locked at the center) ────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CENTER);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;          // keep the central light fixed at screen center
controls.minDistance = 3.5;
controls.maxDistance = 22;
controls.autoRotate = false;         // rest at blue; user drag shifts the hue
controls.rotateSpeed = 0.6;

// ─── Mouse attraction ─────────────────────────────────────────────────────────
// Track the pointer in NDC, project it into the world at the sphere's depth,
// and let the orbs drift weakly toward it.
const ATTRACT_RADIUS = 4.5;                // only orbs within this range are pulled
const raycaster   = new THREE.Raycaster();
const mouseNDC    = new THREE.Vector2(0, 0);
const mouseTarget = new THREE.Vector3();   // raw projected point
const mouseWorld  = new THREE.Vector3();   // smoothed attractor

window.addEventListener('pointermove', e => {
  mouseNDC.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

// ─── Textures ─────────────────────────────────────────────────────────────────
function makeBokehTexture() {
  const sz = 256;
  const c = document.createElement('canvas');
  c.width = c.height = sz;
  const ctx = c.getContext('2d');
  const cx = sz / 2;

  // flat disc: uniform fill across most of the radius with a soft feathered
  // edge and no rings. White so the per-orb material color tints it.
  const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  g.addColorStop(0.00, 'rgba(255,255,255,0.80)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.78)');
  g.addColorStop(0.92, 'rgba(255,255,255,0.45)');
  g.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, sz, sz);

  return new THREE.CanvasTexture(c);
}

function makeGlowTexture(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const cx = size / 2;
  const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  g.addColorStop(0.00, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.07, 'rgba(215,225,255,1.0)');
  g.addColorStop(0.22, 'rgba(110,100,255,0.85)');
  g.addColorStop(0.50, 'rgba( 55, 40,200,0.45)');
  g.addColorStop(0.78, 'rgba( 28, 10,160,0.15)');
  g.addColorStop(1.00, 'rgba(  0,  0,  0,0.00)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

const bokehTex = makeBokehTexture();
const glowTex  = makeGlowTexture(512);
const coreTex  = makeGlowTexture(256);

// ─── Bokeh orbs distributed in a spherical shell around the center ────────────
const N = 260;

const bokehMat = new THREE.MeshBasicMaterial({
  map: bokehTex,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  transparent: true,
  side: THREE.DoubleSide,
});

const meta = [];
const group = new THREE.Group();
scene.add(group);

const INNER_R = 3.0;   // keep a clear gap so the central light reads
const OUTER_R = 8.5;

for (let i = 0; i < N; i++) {
  // uniform point on a sphere, then pushed out to a random shell radius
  const u = Math.random();
  const v = Math.random();
  const theta = 2 * Math.PI * u;
  const phi   = Math.acos(2 * v - 1);
  const r     = INNER_R + Math.pow(Math.random(), 0.7) * (OUTER_R - INNER_R);

  const x = r * Math.sin(phi) * Math.cos(theta);
  const y = r * Math.sin(phi) * Math.sin(theta);
  const z = r * Math.cos(phi);

  // farther orbs are larger & dimmer → depth
  const depth = (r - INNER_R) / (OUTER_R - INNER_R);
  const size  = (0.3 + depth * 0.9 + Math.random() * 0.3) * 0.75;

  const geo = new THREE.PlaneGeometry(size, size);
  const mat = bokehMat.clone();

  // base blue (HSL hue ~0.60–0.67 ≈ 216°–240°); hue is shifted at runtime
  // from the camera's orbit angle so rotating cycles the color.
  const baseHue = 0.62 + Math.random() * 0.05;   // ~223°–241°, deep LED blue
  const sat     = 0.90 + Math.random() * 0.10;   // highly saturated, electric
  const light   = 0.30 + Math.random() * 0.13;   // darker than before
  mat.color = new THREE.Color().setHSL(baseHue, sat, light);
  mat.opacity = 0.35 + (1 - depth) * 0.45 + Math.random() * 0.2;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  group.add(mesh);

  meta.push({
    mesh,
    ox: x, oy: y, oz: z,
    phase:  Math.random() * Math.PI * 2,
    speed:  0.2 + Math.random() * 0.45,
    drift:  0.05 + Math.random() * 0.12,
    baseHue, sat, light,
  });
}

// ─── Central glow sprites (the bright light at the core of the sphere) ─────────
function makeSprite(tex, scale, opacity, color) {
  const m = new THREE.SpriteMaterial({
    map: tex,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity,
    color: new THREE.Color(color),
    depthWrite: false,
  });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(scale);
  s.position.copy(CENTER);
  scene.add(s);
  return s;
}

const outerGlow  = makeSprite(glowTex, 6.0, 0.60, 0x5544ee);
const midGlow    = makeSprite(glowTex, 3.0, 0.80, 0x8877ff);
const innerGlow  = makeSprite(coreTex, 1.3, 0.92, 0xccddff);
const coreSprite = makeSprite(coreTex, 0.5, 1.00, 0xffffff);

// ─── Resize ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.setSize(window.innerWidth, window.innerHeight);
  afterimagePass.setSize(window.innerWidth, window.innerHeight);
  pixelationPass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
});

// ─── Keyboard toggles ─────────────────────────────────────────────────────────
let trailsLocked = false;

window.addEventListener('keydown', e => {
  switch (e.key.toLowerCase()) {
    case 'c':
      chromaticPass.enabled = !chromaticPass.enabled;
      updateHUD();
      break;
    case 'v':
      vignettePass.enabled = !vignettePass.enabled;
      updateHUD();
      break;
    case 'x':
      pixelationPass.enabled = !pixelationPass.enabled;
      updateHUD();
      break;
    case 'z':
      trailsLocked = !trailsLocked;
      updateHUD();
      break;
  }
});

function updateHUD() {
  const hud = document.getElementById('hud');
  if (!hud) return;
  hud.innerHTML = [
    `<span class="${chromaticPass.enabled  ? 'on' : ''}">C  chroma</span>`,
    `<span class="${vignettePass.enabled   ? 'on' : ''}">V  vignette</span>`,
    `<span class="${pixelationPass.enabled ? 'on' : ''}">X  pixel</span>`,
    `<span class="${trailsLocked          ? 'on' : ''}">Z  trails</span>`,
  ].join('');
}

// ─── Hint fade ────────────────────────────────────────────────────────────────
const hint = document.getElementById('hint');
if (hint) setTimeout(() => (hint.style.opacity = '0'), 4000);

// ─── Animate ──────────────────────────────────────────────────────────────────
let clock = 0;
const prevCamPos = new THREE.Vector3().copy(camera.position);

function animate() {
  requestAnimationFrame(animate);
  clock += 0.008;

  // orbit angle → hue offset: a full turn cycles the whole color wheel,
  // while the default front view (azimuth ≈ 0) keeps the orbs blue.
  const hueShift = controls.getAzimuthalAngle() / (Math.PI * 2);

  // project the pointer into the world at the sphere's depth, smoothed
  raycaster.setFromCamera(mouseNDC, camera);
  raycaster.ray.at(camera.position.distanceTo(CENTER), mouseTarget);
  mouseWorld.lerp(mouseTarget, 0.1);

  // gentle 3D float + weak pull toward the pointer + camera-facing billboard
  for (const m of meta) {
    const fx = m.ox + Math.sin(clock * m.speed + m.phase)       * m.drift;
    const fy = m.oy + Math.cos(clock * m.speed * 0.8 + m.phase) * m.drift;
    const fz = m.oz + Math.sin(clock * m.speed * 0.6 + m.phase) * m.drift;

    // weak attraction: only orbs within ATTRACT_RADIUS are pulled; the strength
    // eases to zero at the edge, so distant orbs are completely unaffected.
    const dx = mouseWorld.x - fx;
    const dy = mouseWorld.y - fy;
    const dz = mouseWorld.z - fz;
    let px = fx, py = fy, pz = fz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < ATTRACT_RADIUS) {
      const t = 1 - dist / ATTRACT_RADIUS;   // 1 at the pointer → 0 at the edge
      const pull = 0.65 * t * t;
      px += dx * pull; py += dy * pull; pz += dz * pull;
    }

    m.mesh.position.set(px, py, pz);
    m.mesh.material.color.setHSL(
      ((m.baseHue + hueShift) % 1 + 1) % 1,
      m.sat,
      m.light
    );
    m.mesh.quaternion.copy(camera.quaternion);
  }

  // pulse the central light
  const pulse   = 1 + Math.sin(clock * 1.8)  * 0.07;
  const breathe = 1 + Math.sin(clock * 0.55) * 0.05;
  outerGlow.scale.setScalar(6.0 * breathe);
  midGlow.scale.setScalar(3.0 * pulse);
  innerGlow.scale.setScalar(1.3 * pulse);
  coreSprite.scale.setScalar(0.5 * (1 + Math.sin(clock * 3.2) * 0.06));

  controls.update();

  // motion blur: trail length follows how far the camera moved this frame,
  // then eases back to 0 so a still view renders crisp.
  // When trailsLocked, pin damp to max regardless of camera movement.
  const camSpeed = camera.position.distanceTo(prevCamPos);
  prevCamPos.copy(camera.position);
  const targetDamp = trailsLocked ? 0.88 : Math.min(camSpeed * 4.0, 0.88);
  const damp = afterimagePass.uniforms['damp'];
  damp.value += (targetDamp - damp.value) * 0.25;

  composer.render();
}

animate();
