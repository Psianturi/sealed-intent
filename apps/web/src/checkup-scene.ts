// The check-up's 3D view: the account as a living core, each real connection as a node around it.
// Every node stands for something the scan found; nothing on screen is decoration only.
import * as THREE from "three";
import type { Connection, Severity } from "./checkup-core";

export interface Scene {
  scanning(on: boolean): void;
  show(connections: Connection[], score: number): void;
  heal(ids: string[], score: number): Promise<void>;
  destroy(): void;
}

const COLOR: Record<Severity | "core", number> = { danger: 0xff5a4e, caution: 0xffb547, ok: 0x3ee6a8, info: 0x6e8bff, core: 0x6e8bff };
const health = (score: number) => new THREE.Color(score >= 85 ? 0x3ee6d0 : score >= 60 ? 0xffb547 : 0xff6a4e);

function fibonacci(n: number, r: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    out.push(new THREE.Vector3(Math.cos(phi * i) * rad * r, y * r, Math.sin(phi * i) * rad * r));
  }
  return out;
}

/** A soft round dot, so points glow instead of showing squares. */
function dotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function createScene(canvas: HTMLCanvasElement): Scene | undefined {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return undefined;
  }
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0.6, 7.2);
  camera.lookAt(0, 0, 0);
  const world = new THREE.Group();
  scene.add(world);
  const dot = dotTexture();

  // the core: a shell of glowing particles with a faint lattice inside
  const corePts = fibonacci(1800, 1.15);
  const coreGeo = new THREE.BufferGeometry().setFromPoints(corePts);
  const coreMat = new THREE.PointsMaterial({ size: 0.055, map: dot, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: COLOR.core });
  const core = new THREE.Points(coreGeo, coreMat);
  world.add(core);
  const lattice = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.85, 1)), new THREE.LineBasicMaterial({ color: COLOR.core, transparent: true, opacity: 0.22 }));
  world.add(lattice);

  // two orbit rings and a scan ring that sweeps while the chain is read
  const ring = (r: number, tilt: number, opacity: number) => {
    const pts = Array.from({ length: 129 }, (_, i) => new THREE.Vector3(Math.cos((i / 128) * Math.PI * 2) * r, 0, Math.sin((i / 128) * Math.PI * 2) * r));
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x6e8bff, transparent: true, opacity }));
    l.rotation.x = tilt;
    return l;
  };
  world.add(ring(2.35, 1.25, 0.25), ring(2.6, 1.9, 0.12));
  const scanRing = ring(1.5, 0, 0);
  scene.add(scanRing);

  // ambient dust far out
  const dust = new THREE.Points(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 260 }, () => new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8 - 2))), new THREE.PointsMaterial({ size: 0.04, map: dot, transparent: true, opacity: 0.5, depthWrite: false, color: 0x8fa6ff }));
  scene.add(dust);

  interface Node { id: string; mesh: THREE.Sprite; line: THREE.Line; home: THREE.Vector3; severity: Severity; gone?: number; tag?: HTMLElement }
  // names float next to the nodes that matter, so every dot can be read
  const tags = document.createElement("div");
  tags.className = "cp-tags";
  canvas.parentElement?.append(tags);
  const v = new THREE.Vector3();
  let nodes: Node[] = [];
  const target = { core: new THREE.Color(COLOR.core) };
  let scanOn = false;
  let raf = 0;
  const clock = new THREE.Clock();
  let last = 0;

  function clearNodes() {
    for (const n of nodes) {
      n.tag?.remove();
      world.remove(n.mesh, n.line);
      n.line.geometry.dispose();
      (n.mesh.material as THREE.Material).dispose();
      (n.line.material as THREE.Material).dispose();
    }
    nodes = [];
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = w < 520 ? 9 : 7.2;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  function frame() {
    const t = clock.getElapsedTime();
    const dt = Math.min(t - last, 0.05);
    last = t;
    world.rotation.y += calm ? 0 : 0.0016;
    core.rotation.y -= calm ? 0 : 0.0022;
    lattice.rotation.x += calm ? 0 : 0.0012;
    coreMat.color.lerp(target.core, 0.04);
    (lattice.material as THREE.LineBasicMaterial).color.lerp(target.core, 0.04);
    const pulse = 1 + Math.sin(t * 1.6) * (scanOn ? 0.05 : 0.018);
    core.scale.setScalar(pulse);
    const sm = scanRing.material as THREE.LineBasicMaterial;
    sm.opacity += ((scanOn ? 0.9 : 0) - sm.opacity) * 0.08;
    scanRing.position.y = Math.sin(t * 2.2) * 1.3;
    scanRing.scale.setScalar(Math.sqrt(Math.max(0.05, 1 - (scanRing.position.y / 1.45) ** 2)) * 1.05);
    for (const n of nodes) {
      const bob = calm ? 0 : Math.sin(t * 1.3 + n.home.x * 3) * 0.05;
      if (n.gone !== undefined) {
        n.gone = Math.min(1, n.gone + dt * 0.7);
        const out = n.home.clone().multiplyScalar(1 + n.gone * 1.6);
        n.mesh.position.copy(out);
        (n.mesh.material as THREE.SpriteMaterial).opacity = 1 - n.gone;
        (n.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, 0.6 - n.gone * 1.5);
      } else n.mesh.position.set(n.home.x, n.home.y + bob, n.home.z);
      if (n.tag) {
        n.mesh.getWorldPosition(v).project(camera);
        const shown = v.z < 1 && (n.gone ?? 0) < 0.6;
        n.tag.style.opacity = shown ? String(1 - (n.gone ?? 0)) : "0";
        const x = ((v.x + 1) / 2) * canvas.clientWidth;
        // a name that would run off the right edge goes on the left of its node
        const left = x + 12 + n.tag.offsetWidth > canvas.clientWidth - 8 ? x - 12 - n.tag.offsetWidth : x + 12;
        n.tag.style.transform = `translate(${Math.max(4, left)}px, ${((1 - v.y) / 2) * canvas.clientHeight - 9}px)`;
      }
      const pos = n.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      pos.setXYZ(1, n.mesh.position.x, n.mesh.position.y, n.mesh.position.z);
      pos.needsUpdate = true;
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  frame();

  return {
    scanning(on) {
      scanOn = on;
      if (on) target.core.set(COLOR.core);
    },
    show(connections, score) {
      clearNodes();
      const shown = connections.slice(0, 60);
      const homes = fibonacci(Math.max(shown.length, 1), 2.2);
      shown.forEach((c, i) => {
        const color = COLOR[c.severity];
        const mesh = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        const big = c.severity === "danger" ? 0.42 : c.severity === "caution" ? 0.32 : 0.24;
        mesh.scale.setScalar(big);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), homes[i]!.clone()]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: c.severity === "danger" ? 0.6 : 0.28 }));
        world.add(mesh, line);
        let tag: HTMLElement | undefined;
        if (c.severity !== "info") {
          tag = document.createElement("span");
          tag.className = `cp-tagname ${c.severity}`;
          tag.textContent = c.label.length > 26 ? `${c.label.slice(0, 12)}…${c.label.slice(-10)}` : c.label;
          tags.append(tag);
        }
        nodes.push({ id: c.id, mesh, line, home: homes[i]!, severity: c.severity, tag });
      });
      target.core = health(score);
    },
    async heal(ids, score) {
      for (const n of nodes.filter((x) => ids.includes(x.id))) {
        (n.line.material as THREE.LineBasicMaterial).color.set(0xffffff);
        (n.mesh.material as THREE.SpriteMaterial).color.set(0xffffff);
        n.gone = 0;
        await new Promise((r) => setTimeout(r, calm ? 0 : 220));
      }
      target.core = health(score);
      await new Promise((r) => setTimeout(r, calm ? 0 : 1600));
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      clearNodes();
      tags.remove();
      renderer.dispose();
    },
  };
}
