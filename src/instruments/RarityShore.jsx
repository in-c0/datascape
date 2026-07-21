// The rarity shore — "Rarest aspects. Normal aspects." Her clusters arranged
// along an axis by how much of the corpus they occupy: small obsessions wash
// up on the rare end, the big currents sit at normal. The comparison baseline
// she left literally blank — "how am I compared to (...)?" — so the shore
// renders the blank as a real marker instead of quietly picking a population.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";

const Y = -2.6, SPAN = 11;

export default function RarityShore({ thoughts, theme }) {
  const g = useRef();
  const built = useMemo(() => {
    if (!thoughts) return null;
    const clusters = thoughts.meta.clusters
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.count > 0)
      .sort((a, b) => a.count - b.count);
    const max = clusters[clusters.length - 1].count;
    // position by log share: rarest (smallest) left, normal (largest) right
    const marks = clusters.map((c, k) => ({
      label: c.label,
      count: c.count,
      x: -SPAN / 2 + (Math.log(c.count) / Math.log(max)) * SPAN,
      r: 0.06 + (c.count / max) * 0.3,
      lift: (k % 3) * 0.5, // stagger labels so they don't collide
    }));
    return { marks };
  }, [thoughts]);

  const axis = useMemo(
    () => new Float32Array([-SPAN / 2 - 0.8, 0, 0, SPAN / 2 + 1.6, 0, 0]),
    []
  );

  useFrame((state) => {
    if (g.current) g.current.position.y = Y + Math.sin(state.clock.elapsedTime * 0.25) * 0.06;
  });

  if (!built) return null;
  const ink = theme === "lab" ? "#eef1ee" : "#2b2b38";

  return (
    <group ref={g} name="rarity-shore" position={[0, Y, 6.5]}>
      <lineSegments frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[axis, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={ink} transparent opacity={0.35} depthWrite={false} />
      </lineSegments>
      {built.marks.map((m, i) => (
        <group key={i} position={[m.x, 0, 0]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[m.r, 0.008, 8, 32]} />
            <meshBasicMaterial color={ink} transparent opacity={0.55} />
          </mesh>
          <Html position={[0, 0.35 + m.lift, 0]} center distanceFactor={13} style={{ pointerEvents: "none" }} zIndexRange={[28, 0]}>
            <div className={`inscribe inscribe--${theme} inscribe--dim`}>
              <span className="inscribe__t">{m.label}</span>
              <span className="inscribe__s">{m.count}</span>
            </div>
          </Html>
        </group>
      ))}
      <Html position={[-SPAN / 2 - 0.8, -0.6, 0]} center distanceFactor={12} style={{ pointerEvents: "none" }} zIndexRange={[28, 0]}>
        <div className={`inscribe inscribe--${theme}`}><span className="inscribe__t">rarest</span></div>
      </Html>
      <Html position={[SPAN / 2 + 0.9, -0.6, 0]} center distanceFactor={12} style={{ pointerEvents: "none" }} zIndexRange={[28, 0]}>
        <div className={`inscribe inscribe--${theme}`}><span className="inscribe__t">normal</span></div>
      </Html>
      <Html position={[SPAN / 2 + 1.9, 0.4, 0]} center distanceFactor={12} style={{ pointerEvents: "none" }} zIndexRange={[28, 0]}>
        <div className={`inscribe inscribe--${theme} inscribe--rose`}>
          <span className="inscribe__t">vs (...)</span>
          <span className="inscribe__s">the baseline is deliberately blank — compared to whom is yours to choose</span>
        </div>
      </Html>
    </group>
  );
}
