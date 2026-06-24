import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import GUI from 'lil-gui';

// ─── Renderer ─────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// Filmic tone mapping for a shot-on-a-sensor roll-off instead of flat sRGB.
// OutputPass reads these off the renderer each frame, so changing them live works.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.57;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000005);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 1.5, 9);

// The central light sits at the origin — everything orbits around it.
const CENTER = new THREE.Vector3(0, 0, 0);

// ─── Tunable parameters (wired to lil-gui below) ──────────────────────────────
const params = {
  // Motion blur, turned down from its previous max of 0.88 but still adjustable.
  // `motionBlur` is the maximum afterimage trail length; `motionResponse` is how
  // strongly camera speed drives the trail before clamping to that max.
  motionBlur:     0.25,
  motionResponse: 4.0,
  // When locked, the trail is pinned to `motionBlur` regardless of camera motion.
  trailsLocked:   false,
  // Per-orb "electron" streaks: each orb stretches along its on-screen motion,
  // so the faster you orbit the longer the pinpoint streaks become.
  streaks:        false,
  streakStrength: 60.0,  // how much apparent speed elongates each orb
  streakMax:      9.0,    // hard cap on the stretch factor
  // Color cycling: by default the hue tracks the camera's orbit angle. When
  // `autoHue` is on, the hue instead drifts continuously over time on its own.
  autoHue:        false,
  autoHueSpeed:   0.03,
  // Tone mapping (applied by OutputPass) + animated sensor grain.
  toneMapping:    'ACES Filmic',
  grain:          true,
  grainAmount:    0.185,
};

// Friendly label → three.js tone-mapping constant, for the GUI dropdown.
const TONE_MAPPINGS = {
  'None':        THREE.NoToneMapping,
  'Linear':      THREE.LinearToneMapping,
  'Reinhard':    THREE.ReinhardToneMapping,
  'Cineon':      THREE.CineonToneMapping,
  'ACES Filmic': THREE.ACESFilmicToneMapping,
  'AgX':         THREE.AgXToneMapping,
  'Neutral':     THREE.NeutralToneMapping,
};

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
vignettePass.enabled = true;
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

// ─── Film grain ───────────────────────────────────────────────────────────────
// Applied after tone mapping (in display space) so the grain reads evenly across
// the tonal range. A per-frame `time` seed animates the noise so it shimmers.
const grainPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    amount:   { value: params.grainAmount },
    time:     { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform float time;
    varying vec2 vUv;
    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      // animate the noise field and tie its strength to luminance so shadows
      // stay grainier than highlights — closer to real film.
      float n = rand(vUv + fract(time)) - 0.5;
      float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      color.rgb += n * amount * (1.0 - luma * 0.7);
      gl_FragColor = color;
    }
  `,
});
grainPass.enabled = params.grain;
composer.addPass(grainPass);

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
const _ndc        = new THREE.Vector3();   // scratch for projecting orbs to screen

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
    // streak tracking: previous on-screen (NDC) position, smoothed stretch & roll
    sx: 0, sy: 0, inited: false, stretch: 0, roll: 0,
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
window.addEventListener('keydown', e => {
  switch (e.key.toLowerCase()) {
    case 'c':
      chromaticPass.enabled = !chromaticPass.enabled;
      chromaCtrl.updateDisplay();
      updateHUD();
      break;
    case 'v':
      vignettePass.enabled = !vignettePass.enabled;
      vignetteCtrl.updateDisplay();
      updateHUD();
      break;
    case 'x':
      pixelationPass.enabled = !pixelationPass.enabled;
      pixelCtrl.updateDisplay();
      updateHUD();
      break;
    case 'z':
      grainPass.enabled = !grainPass.enabled;
      grainCtrl.updateDisplay();
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
    `<span class="${grainPass.enabled      ? 'on' : ''}">Z  grain</span>`,
  ].join('');
}

// ─── lil-gui controls ─────────────────────────────────────────────────────────
const gui = new GUI({ title: 'bluelight' });

const fMotion = gui.addFolder('Motion blur');
fMotion.add(params, 'motionBlur', 0.0, 0.95, 0.01).name('amount');
fMotion.add(params, 'motionResponse', 0.0, 12.0, 0.1).name('speed response');
const trailsCtrl = fMotion.add(params, 'trailsLocked').name('lock trails (Z)')
  .onChange(updateHUD);

const fStreaks = gui.addFolder('Electron streaks');
fStreaks.add(params, 'streaks').name('enabled')
  .onChange(v => { if (!v) for (const m of meta) { m.stretch = 0; m.inited = false; } });
fStreaks.add(params, 'streakStrength', 0.0, 200.0, 1.0).name('strength');
fStreaks.add(params, 'streakMax', 0.0, 24.0, 0.5).name('max length');

const fColor = gui.addFolder('Color');
fColor.add(params, 'autoHue').name('time-based hue');
fColor.add(params, 'autoHueSpeed', -0.3, 0.3, 0.005).name('hue speed');

const fBloom = gui.addFolder('Bloom');
fBloom.add(bloomPass, 'strength', 0.0, 2.0, 0.01);
fBloom.add(bloomPass, 'radius', 0.0, 1.5, 0.01);
fBloom.add(bloomPass, 'threshold', 0.0, 1.0, 0.01);

const fChroma = gui.addFolder('Chromatic aberration');
const chromaCtrl = fChroma.add(chromaticPass, 'enabled').name('enabled (C)')
  .onChange(updateHUD);
fChroma.add(chromaticPass.uniforms.amount, 'value', 0.0, 0.02, 0.0005).name('amount');

const fVignette = gui.addFolder('Vignette');
const vignetteCtrl = fVignette.add(vignettePass, 'enabled').name('enabled (V)')
  .onChange(updateHUD);
fVignette.add(vignettePass.uniforms.strength, 'value', 0.0, 2.0, 0.01).name('strength');
fVignette.add(vignettePass.uniforms.softness, 'value', 0.0, 1.0, 0.01).name('softness');

const fPixel = gui.addFolder('Pixelation');
const pixelCtrl = fPixel.add(pixelationPass, 'enabled').name('enabled (X)')
  .onChange(updateHUD);
fPixel.add(pixelationPass.uniforms.pixelSize, 'value', 1.0, 16.0, 1.0).name('pixel size');

const fFilm = gui.addFolder('Tone & grain');
fFilm.add(params, 'toneMapping', Object.keys(TONE_MAPPINGS)).name('tone mapping')
  .onChange(v => { renderer.toneMapping = TONE_MAPPINGS[v]; });
fFilm.add(renderer, 'toneMappingExposure', 0.0, 3.0, 0.01).name('exposure');
const grainCtrl = fFilm.add(grainPass, 'enabled').name('grain (Z)');
fFilm.add(grainPass.uniforms.amount, 'value', 0.0, 0.3, 0.005).name('grain amount');

const fOrbit = gui.addFolder('Camera');
fOrbit.add(controls, 'autoRotate').name('auto-rotate');
fOrbit.add(controls, 'autoRotateSpeed', -5.0, 5.0, 0.1).name('auto-rotate speed');

// Start with every folder collapsed.
gui.folders.forEach(f => f.close());

// ─── Hint fade ────────────────────────────────────────────────────────────────
const hint = document.getElementById('hint');
if (hint) setTimeout(() => (hint.style.opacity = '0'), 4000);

// reflect the initial pass states (e.g. vignette on) in the HUD
updateHUD();

// ─── Animate ──────────────────────────────────────────────────────────────────
let clock = 0;
const prevCamPos = new THREE.Vector3().copy(camera.position);

function animate() {
  requestAnimationFrame(animate);
  clock += 0.008;

  // hue offset: either the camera's orbit angle (a full turn cycles the whole
  // color wheel, front view stays blue) or, when autoHue is on, a continuous
  // time-based drift independent of the camera.
  const hueShift = params.autoHue
    ? clock * params.autoHueSpeed
    : controls.getAzimuthalAngle() / (Math.PI * 2);

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

    // ── electron streaks ──
    // Project the orb to the screen and measure how far it moved since last
    // frame (in NDC). That apparent motion — dominated by camera orbiting —
    // sets the streak's direction (roll) and length (stretch along local X).
    let targetStretch = 0;
    if (params.streaks) {
      _ndc.set(px, py, pz).project(camera);
      if (m.inited) {
        const dx = _ndc.x - m.sx;
        const dy = _ndc.y - m.sy;
        const sp = Math.hypot(dx, dy);
        if (sp > 1e-4) m.roll = Math.atan2(dy, dx);
        targetStretch = Math.min(sp * params.streakStrength, params.streakMax);
      }
      m.sx = _ndc.x; m.sy = _ndc.y; m.inited = true;
    }
    // ease toward the target so streaks grow/shrink smoothly instead of popping
    m.stretch += (targetStretch - m.stretch) * 0.35;

    // billboard to the camera, then roll so local X aligns with the motion
    // direction and stretch along it — a thin, pinpoint streak of light.
    m.mesh.quaternion.copy(camera.quaternion);
    m.mesh.rotateZ(m.roll);
    m.mesh.scale.set(1 + m.stretch, 1, 1);
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
  const targetDamp = params.trailsLocked
    ? params.motionBlur
    : Math.min(camSpeed * params.motionResponse, params.motionBlur);
  const damp = afterimagePass.uniforms['damp'];
  damp.value += (targetDamp - damp.value) * 0.25;

  grainPass.uniforms.time.value = clock;

  composer.render();
}

animate();
