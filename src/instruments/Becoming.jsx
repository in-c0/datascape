// The Becoming — "where I am going" vs "where I want to be going".
// Her ruling: those are two different things, and the gap between them is
// the instrument. The past spine is measured from real monthly signals; the
// future is a fan — best/avg/worst splines with cones widened by measured
// volatility, plus exception filaments, because reality is chaotic and a
// clean single line would be a lie. The aspiration path is inferred from
// her own goal statements (sources on the panel), hers to overwrite.
// Lives in the strata terrain, where time already has a z axis.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { monthZ, TIMEBASE } from "../topologies.js";
import { store } from "../store.js";

const BECOMING = store.becoming;
const CORPUS = store.corpus;

const mulberry = (seed) => {
  let t = seed;
  return () => {
    t |= 0; t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const toSegments = (pts) => {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) out.push(...pts[i], ...pts[i + 1]);
  return out;
};

export default function Becoming({ thoughts, topology, theme }) {
  const g = useRef();

  const built = useMemo(() => {
    if (!thoughts) return null;
    // message-level signals: height = her words per month, lateral = the
    // build:wonder balance — the path's direction says whether she's drifting
    // toward making or musing. both measured, both projected with volatility.
    const voice = CORPUS.voice.filter((v) => v.words > 0);
    const maxWords = Math.max(...voice.map((v) => v.words));
    const yOf = (w) => -3.7 + Math.pow(Math.max(w, 0) / maxWords, 0.7) * 4.2 * 0.85;
    const EPS = 1e-4;
    const lbwRaw = voice.map((v) => Math.log((v.build + EPS) / (v.wonder + EPS)));
    const lbwMean = lbwRaw.reduce((a, b) => a + b, 0) / lbwRaw.length;
    const xOf = (lbw) => Math.max(-2.4, Math.min(2.4, (lbw - lbwMean) * 1.35));

    // measured spine: her actual path through (balance, output, time)
    const past = voice.map((v, i) => [xOf(lbwRaw[i]), yOf(v.words), monthZ(v.m)]);

    const fit = (arr) => {
      const n = arr.length;
      const xbar = (n - 1) / 2;
      const ybar = arr.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0;
      arr.forEach((c, i) => { num += (i - xbar) * (c - ybar); den += (i - xbar) ** 2; });
      const slope = num / (den || 1);
      const deltas = arr.slice(1).map((c, i) => c - arr[i]);
      const vol = Math.sqrt(deltas.reduce((a, d) => a + d * d, 0) / (deltas.length || 1));
      return { slope, vol };
    };
    const wTail = voice.slice(-12).map((v) => v.words);
    const bTail = lbwRaw.slice(-12);
    const wFit = fit(wTail);
    const bFit = fit(bTail);

    const lastV = voice[voice.length - 1];
    const z0 = monthZ(lastV.m);
    const w0 = lastV.words;
    const b0 = lbwRaw[lbwRaw.length - 1];
    const H = 12; // months of future
    const fz = (t) => z0 + t * TIMEBASE.dz;

    const line = (dirY, dirX) => {
      const pts = [[xOf(b0), yOf(w0), z0]];
      for (let t = 1; t <= H; t++) {
        const w = w0 + wFit.slope * t + dirY * wFit.vol * Math.sqrt(t);
        const b = b0 + bFit.slope * t + dirX * bFit.vol * Math.sqrt(t) * 0.7;
        pts.push([xOf(b), yOf(w), fz(t)]);
      }
      return pts;
    };
    const avg = line(0, 0);
    const best = line(1, 1);
    const worst = line(-1, -1);

    // scatter cone: 150 seeded random walks in both measured dimensions
    const rand = mulberry(4242);
    const scatter = [];
    for (let i = 0; i < 150; i++) {
      const t = 1 + rand() * (H - 1);
      let w = w0, b = b0;
      for (let s = 1; s <= t; s++) {
        w += wFit.slope + (rand() * 2 - 1) * wFit.vol * 1.2;
        b += bFit.slope + (rand() * 2 - 1) * bFit.vol * 0.9;
      }
      scatter.push(xOf(b) + (rand() - 0.5) * 0.1, yOf(w) + (rand() - 0.5) * 0.15, fz(t));
    }

    // exception filaments — reality is chaotic, enumerate a few
    const exA = []; const exB = []; const exC = [];
    for (let t = 0; t <= H; t++) {
      exA.push([xOf(b0) + 0.22 * t, yOf(w0 + wFit.slope * t) + Math.pow(t / H, 2.4) * 4.2, fz(t)]);
      exB.push([xOf(b0) - 0.1 * t, yOf(Math.max(maxWords * 0.02, w0 * (1 - (t / H) * 0.92))), fz(t)]);
      exC.push([xOf(b0) + Math.sin(t * 0.9) * 0.9 - 0.18 * t, yOf(w0 + wFit.slope * t * 0.4), fz(t)]);
    }

    // the aspiration lane — inferred from her own words: sustained output,
    // build-leaning but never losing the wondering (a balanced +x, rising y)
    const xAsp = 0.9;
    const asp = [];
    for (let t = 0; t <= H; t++)
      asp.push([
        xOf(b0) + (xAsp - xOf(b0)) * (t / H),
        yOf(w0 * (1 + 0.35 * (t / H))),
        fz(t),
      ]);

    // measured readout for the panel
    const recent = voice.slice(-3);
    const readout = {
      wordsPerMonth: Math.round(recent.reduce((a, v) => a + v.words, 0) / recent.length),
      bw: +(recent.reduce((a, v) => a + v.build / Math.max(v.wonder, EPS), 0) / recent.length).toFixed(1),
      wordsTrend: wFit.slope >= 0 ? "rising" : "falling",
      driftDir: bFit.slope >= 0 ? "toward building" : "toward wondering",
    };

    const avgEnd = avg[avg.length - 1];
    const aspEnd = asp[asp.length - 1];
    // the gap, rendered as a dotted bridge
    const gapDots = [];
    for (let i = 0; i <= 22; i++) {
      const f = i / 22;
      gapDots.push(
        avgEnd[0] + (aspEnd[0] - avgEnd[0]) * f,
        avgEnd[1] + (aspEnd[1] - avgEnd[1]) * f,
        avgEnd[2] + (aspEnd[2] - avgEnd[2]) * f
      );
    }
    const gapMid = [(avgEnd[0] + aspEnd[0]) / 2, (avgEnd[1] + aspEnd[1]) / 2 + 0.35, (avgEnd[2] + aspEnd[2]) / 2];

    const seg = (pts) => new Float32Array(toSegments(pts));
    return {
      past: seg(past),
      avg: seg(avg), best: seg(best), worst: seg(worst),
      exA: seg(exA), exB: seg(exB), exC: seg(exC),
      asp: seg(asp),
      scatter: new Float32Array(scatter),
      gapDots: new Float32Array(gapDots),
      avgEnd, aspEnd, gapMid,
      coneAt: [xOf(b0) + 1.1, yOf(w0 + wFit.slope * 8 + wFit.vol * 2.6), fz(8)],
      exATip: exA[exA.length - 1], exBTip: exB[exB.length - 1], exCTip: exC[exC.length - 1],
      axisBuild: [xOf(b0) + 2.7, yOf(w0) - 0.55, z0],
      axisWonder: [xOf(b0) - 2.7, yOf(w0) - 0.55, z0],
      readout,
    };
  }, [thoughts]);

  const on = topology === "strata";
  useFrame((_, dt) => {
    if (!g.current) return;
    const d = Math.min(dt, 0.05);
    const target = on ? 1 : 0;
    g.current.children.forEach((child) => {
      if (child.material) {
        const base = child.userData.baseOpacity ?? 0.5;
        child.material.opacity += (target * base - child.material.opacity) * (1 - Math.exp(-3 * d));
      }
    });
  });

  if (!built) return null;
  const ink = theme === "lab" ? "#eef1ee" : "#2b2b38";
  const lime = theme === "lab" ? "#d8ff3e" : "#2b2b38";
  const rose = "#e3b6c9";

  const Seg = ({ data, color, op, dashedish }) => (
    <lineSegments frustumCulled={false} userData={{ baseOpacity: op }}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[data, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={0} depthWrite={false} />
    </lineSegments>
  );

  const label = (pos, cls, text, sub, df = 10) =>
    on && (
      <Html position={pos} center distanceFactor={df} style={{ pointerEvents: "none" }} zIndexRange={[30, 0]}>
        <div className={`inscribe inscribe--${theme} ${cls || ""}`}>
          <span className="inscribe__t">{text}</span>
          {sub && <span className="inscribe__s">{sub}</span>}
        </div>
      </Html>
    );

  return (
    <group ref={g}>
      <Seg data={built.past} color={ink} op={0.55} />
      <Seg data={built.avg} color={lime} op={0.85} />
      <Seg data={built.best} color={lime} op={0.35} />
      <Seg data={built.worst} color={lime} op={0.35} />
      <Seg data={built.exA} color={ink} op={0.18} />
      <Seg data={built.exB} color={ink} op={0.18} />
      <Seg data={built.exC} color={ink} op={0.18} />
      <Seg data={built.asp} color={rose} op={0.9} />
      <points frustumCulled={false} userData={{ baseOpacity: 0.35 }}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[built.scatter, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.05} sizeAttenuation color={lime} transparent opacity={0} depthWrite={false} />
      </points>
      <points frustumCulled={false} userData={{ baseOpacity: 0.8 }}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[built.gapDots, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.07} sizeAttenuation color={rose} transparent opacity={0} depthWrite={false} />
      </points>

      {label(built.avgEnd, "", BECOMING.projection.endLabel, "measured trend ± volatility", 10)}
      {label(built.aspEnd, "inscribe--rose", BECOMING.aspiration.endLabel, BECOMING.aspiration.note, 10)}
      {label(built.gapMid, "inscribe--gap", BECOMING.gap.label, "inferred — see the becoming panel", 8)}
      {label([built.coneAt[0] - 1.6, built.coneAt[1] + 0.8, built.coneAt[2] - 1.2], "inscribe--dim", BECOMING.projection.coneNote, null, 6)}
      {label(built.exATip, "inscribe--dim", BECOMING.projection.exceptions[0], null, 6)}
      {label(built.exBTip, "inscribe--dim", BECOMING.projection.exceptions[1], null, 6)}
      {label(built.exCTip, "inscribe--dim", BECOMING.projection.exceptions[2], null, 6)}
      {label(built.axisBuild, "inscribe--dim", "→ building", "lateral axis: build:wonder, measured", 7)}
      {label(built.axisWonder, "inscribe--dim", "← wondering", null, 7)}
    </group>
  );
}
