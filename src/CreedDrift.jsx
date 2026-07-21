// Creed — borrowed wisdom drifting between the clusters as ambient text.
// Each short quote is a canvas-textured sprite on a slow orbit; they sit in
// the fog like the dust does, readable only when you drift near them.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { store } from "./store.js";

const CREED = store.creed;

const DRIFTERS = CREED.quotes
  .filter((q) => q.drift)
  .map((q) => (q.driftText || q.text).toLowerCase());
DRIFTERS.push(CREED.motto);

function makeTexture(text, color) {
  const c = document.createElement("canvas");
  const w = 1024, h = 64;
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.fillStyle = color;
  x.font = "26px 'Cascadia Code', Consolas, monospace";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(text.length > 72 ? text.slice(0, 70) + "…" : text, w / 2, h / 2);
  const tx = new THREE.CanvasTexture(c);
  tx.anisotropy = 4;
  return tx;
}

const seeded = (i, s) => {
  const x = Math.sin(i * 137.31 + s * 91.7) * 43758.5453;
  return x - Math.floor(x);
};

export default function CreedDrift({ theme }) {
  const group = useRef();
  const sprites = useMemo(() => {
    const color = theme === "lab" ? "rgba(238,241,238,0.9)" : "rgba(43,43,56,0.9)";
    return DRIFTERS.map((text, i) => {
      const a = (i / DRIFTERS.length) * Math.PI * 2 + seeded(i, 1) * 0.8;
      const r = 8.5 + seeded(i, 2) * 4.5;
      return {
        text,
        texture: makeTexture(text, color),
        pos: [Math.cos(a) * r, (seeded(i, 3) - 0.35) * 7, Math.sin(a) * r],
        bob: seeded(i, 4) * Math.PI * 2,
        w: Math.min(7.5, 0.55 + text.length * 0.088),
      };
    });
  }, [theme]);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.05);
    if (group.current) group.current.rotation.y -= d * 0.006; // counter-drift
    const t = state.clock.elapsedTime;
    group.current?.children.forEach((s, i) => {
      s.position.y = sprites[i].pos[1] + Math.sin(t * 0.22 + sprites[i].bob) * 0.35;
      const target = t < 4 ? 0 : theme === "lab" ? 0.34 : 0.4;
      s.material.opacity += (target - s.material.opacity) * (1 - Math.exp(-1.5 * d));
    });
  });

  return (
    <group ref={group}>
      {sprites.map((s, i) => (
        <sprite key={i} position={s.pos} scale={[s.w, s.w / 16, 1]}>
          <spriteMaterial
            map={s.texture}
            transparent
            opacity={0}
            depthWrite={false}
            fog
          />
        </sprite>
      ))}
    </group>
  );
}
