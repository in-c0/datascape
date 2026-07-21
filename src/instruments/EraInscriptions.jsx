// Era inscriptions — "what changed" written onto the terrain itself, as the
// reels do it: huge display type floating INSIDE the scene, half-occluded by
// the data, not rows in a side panel. One inscription per year, standing
// behind the ridges at that year's z, readable from the terrain camera.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { monthZ } from "../topologies.js";

function topClusters(thoughts, list, k = 2) {
  const counts = new Map();
  for (const t of list) counts.set(t.c, (counts.get(t.c) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([c]) => thoughts.meta.clusters[c]?.label || "misc");
}

function makeTexture(year, sub, color, subColor) {
  const c = document.createElement("canvas");
  c.width = 2048; c.height = 512;
  const x = c.getContext("2d");
  x.fillStyle = color;
  x.font = "700 300px 'Cascadia Code', Consolas, monospace";
  x.textBaseline = "middle";
  x.fillText(year, 40, 210);
  x.fillStyle = subColor;
  x.font = "64px 'Cascadia Code', Consolas, monospace";
  x.fillText(sub, 52, 440);
  const tx = new THREE.CanvasTexture(c);
  tx.anisotropy = 4;
  return tx;
}

export default function EraInscriptions({ thoughts, topology, theme }) {
  const g = useRef();

  const eras = useMemo(() => {
    if (!thoughts) return [];
    const ink = theme === "lab" ? "rgba(238,241,238,0.95)" : "rgba(43,43,56,0.95)";
    const sub = theme === "lab" ? "rgba(74,240,140,0.95)" : "rgba(160,79,117,0.95)";
    return ["2023", "2024", "2025", "2026"].map((y) => {
      const list = thoughts.thoughts.filter((t) => t.m.startsWith(y));
      const labels = topClusters(thoughts, list, 2).join(" · ");
      return {
        y,
        texture: makeTexture(y, labels || "…", ink, sub),
        z: monthZ(`${y}-06`),
      };
    });
  }, [thoughts, theme]);

  const on = topology === "strata";
  useFrame((_, dt) => {
    if (!g.current) return;
    const d = Math.min(dt, 0.05);
    g.current.children.forEach((m) => {
      const t = on ? 0.2 : 0;
      m.material.opacity += (t - m.material.opacity) * (1 - Math.exp(-2.5 * d));
    });
  });

  return (
    <group ref={g} name="era-inscriptions">
      {eras.map((e) => (
        <mesh key={e.y} position={[-9.8, 1.6, e.z]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[7.5, 1.87]} />
          <meshBasicMaterial map={e.texture} transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}
