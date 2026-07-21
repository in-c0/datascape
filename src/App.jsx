import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import Scene from "./Scene.jsx";
import {
  NODES, TOPOLOGIES, STATUS_GLYPH, sigFormula, SURFACE, remapThoughts,
} from "./data/nodes.js";
import { LAYOUTS } from "./topologies.js";
import { CAMERA_PRESETS, EMPTY_SPEC, normalizeSpec } from "./spec.js";
import { PANELS } from "./panels/registry.jsx";
import { parseCommand, COMMAND_HINT } from "./command.js";
import { matchFeatured, askLive, FEATURED_QUESTIONS } from "./navigator.js";
import { buildStory } from "./story.js";
import { CreedPage, MirrorPage, SeedsPage } from "./pages/Overlays.jsx";
import { store } from "./store.js";
import { config } from "../datascape.config.js";
import { executeViz } from "./viz.js";

const EVIDENCE = store.evidence;
const BRAND = config.siteName.toUpperCase();
const BRAND_LC = config.siteName.toLowerCase();
import "./index.css";

// clustered wears the candy palette; the rest is the dark lab
const THEME_BY_TOPOLOGY = {
  centralized: "lab",
  clustered: "candy",
  strata: "lab",
  semantic: "lab",
};

const clamp01 = (v) => Math.max(0, Math.min(1.02, v));

export default function App() {
  const [topoIdx, setTopoIdx] = useState(0);
  const [hovered, setHovered] = useState(null);
  const [focused, setFocusedState] = useState(null);
  const [openThought, setOpenThoughtState] = useState(null);
  const [page, setPage] = useState(null); // node index whose page is open
  const [action, setAction] = useState("drift");
  const [intro, setIntro] = useState(true);
  const [drift, setDrift] = useState(true);
  // thoughts are already in the store (loaded before render); remap once for
  // the active surface. remapThoughts mutates in place, so init lazily.
  const [thoughts] = useState(() => remapThoughts(store.thoughts));
  const [spec, setSpec] = useState(EMPTY_SPEC);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdText, setCmdText] = useState("");
  const [storyIdx, setStoryIdx] = useState(null);
  const [overlay, setOverlay] = useState(null); // 'creed' | 'mirror' | 'seeds'
  const cameraGoalRef = useRef(null); // {pos:[..], target:[..]} the camera glides to

  const cursorRef = useRef(null);
  const trailRef = useRef(null);
  const telemetry = useRef({});
  const diveRef = useRef(0);
  const labelTimer = useRef(null);
  const interactRef = useRef(-8000); // last interaction, performance.now() ms

  // refs mirroring state, so the window listeners never go stale
  const focusedRef = useRef(null);
  const pageRef = useRef(null);
  const hoveredRef = useRef(null);
  const openThoughtRef = useRef(null);
  const specRef = useRef(EMPTY_SPEC);
  const cmdOpenRef = useRef(false);
  const storyRef = useRef(null);
  const overlayRef = useRef(null);
  const themeRef = useRef("lab");
  focusedRef.current = focused;
  pageRef.current = page;
  hoveredRef.current = hovered;
  openThoughtRef.current = openThought;
  specRef.current = spec;
  cmdOpenRef.current = cmdOpen;
  storyRef.current = storyIdx;
  overlayRef.current = overlay;

  const topology = TOPOLOGIES[topoIdx].key;
  const theme = THEME_BY_TOPOLOGY[topology];
  themeRef.current = theme;

  // focus card and listen-in card share the dock: opening one closes the other
  const setFocused = (i) => {
    diveRef.current = 0;
    setFocusedState(i);
    if (i != null) setOpenThoughtState(null);
  };
  const setOpenThought = (i) => {
    setOpenThoughtState(i);
    if (i != null) {
      setFocusedState(null);
      diveRef.current = 0;
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setIntro(false), 3600);
    return () => clearTimeout(t);
  }, []);

  // the spine: one declarative spec in, the whole dashboard responds.
  // fields left undefined keep their current value; camera/focus/topology
  // are one-shot actions, panels/filters/narration are state.
  const applySpec = (raw) => {
    if (raw.topology) {
      const ti = TOPOLOGIES.findIndex((t) => t.key === raw.topology);
      if (ti >= 0) setTopoIdx(ti);
    }
    if (raw.focus !== undefined) {
      diveRef.current = 0;
      setOpenThoughtState(null);
      setFocusedState(
        raw.focus == null
          ? null
          : (() => {
              const i = NODES.findIndex((n) => n.id === raw.focus);
              return i >= 0 ? i : null;
            })()
      );
    }
    if (raw.listen !== undefined) setOpenThought(raw.listen); // opens the card
    setSpec((prev) => ({
      panels:
        raw.panels !== undefined
          ? raw.panels.filter((k) => PANELS[k]).slice(0, 3)
          : prev.panels,
      instruments:
        raw.instruments !== undefined
          ? normalizeSpec(raw).instruments
          : prev.instruments,
      filters:
        raw.filters !== undefined
          ? {
              era: raw.filters?.era ?? null,
              category: raw.filters?.category ?? null,
              status: raw.filters?.status ?? null,
              korean: raw.filters?.korean ?? null,
            }
          : prev.filters,
      narration:
        raw.narration !== undefined
          ? String(raw.narration).slice(0, 200)
          : prev.narration,
      viz:
        raw.viz !== undefined
          ? raw.viz && typeof raw.viz === "object" ? raw.viz : null
          : prev.viz,
    }));
    if (raw.camera && CAMERA_PRESETS[raw.camera])
      cameraGoalRef.current = { ...CAMERA_PRESETS[raw.camera] };
  };

  const togglePanel = (key) =>
    setSpec((prev) => ({
      ...prev,
      panels: prev.panels.includes(key)
        ? prev.panels.filter((k) => k !== key)
        : [...prev.panels.slice(-2), key],
    }));

  // staged application — the answer arrives like a thought, not a form
  // submit: camera + narration first, then panels materialize in sequence
  const stageTimers = useRef([]);
  const stageSpec = (raw) => {
    stageTimers.current.forEach(clearTimeout);
    stageTimers.current = [];
    const { panels, ...rest } = raw;
    applySpec({ ...rest, ...(panels !== undefined ? { panels: [] } : {}) });
    if (panels !== undefined) {
      panels
        .filter((k) => PANELS[k])
        .slice(0, 3)
        .forEach((p, i) => {
          stageTimers.current.push(
            setTimeout(() => {
              setSpec((prev) => ({
                ...prev,
                panels: [...prev.panels.filter((k) => k !== p), p],
              }));
            }, 340 * (i + 1))
          );
        });
    }
  };

  useEffect(() => {
    if (import.meta.env.DEV) window.__applySpec = applySpec;
  });

  // story mode — a script of specs with dwell times ------------------------
  const story = buildStory(thoughts);
  const stopStory = () => {
    setStoryIdx(null);
    applySpec({ panels: [], filters: {}, narration: "", focus: null, camera: "overview" });
  };
  useEffect(() => {
    if (storyIdx == null) return;
    if (storyIdx >= story.length) {
      stopStory();
      return;
    }
    stageSpec(story[storyIdx].spec);
    const t = setTimeout(
      () => setStoryIdx((i) => (i == null ? null : i + 1)),
      story[storyIdx].dwell * 1000
    );
    return () => clearTimeout(t);
    // story steps re-fire only on index change; thoughts arriving later is fine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyIdx]);

  // the navigator — featured answers, then grammar, then the live tier ------
  const runCommand = async (text) => {
    setCmdOpen(false);
    setCmdText("");
    if (!text.trim()) return;

    const f = matchFeatured(text);
    if (f) {
      if (f.story) setStoryIdx(0);
      else stageSpec(f.spec);
      return;
    }
    const r = parseCommand(text);
    if (r.story) {
      setStoryIdx(0);
      return;
    }
    if (!r.nomatch) {
      stageSpec({
        ...r.spec,
        ...(r.focus !== undefined ? { focus: r.focus } : {}),
        ...(r.topology ? { topology: r.topology } : {}),
      });
      return;
    }
    // free text: ask the live navigator on her machine, if it's awake
    applySpec({ narration: "asking the navigator…" });
    const live = await askLive(text);
    if (live) stageSpec(live.spec);
    else
      applySpec({
        narration: `the live navigator is asleep — try a featured question, or: ${COMMAND_HINT}`,
      });
  };

  // cursor instrument + bead trail ----------------------------------------
  useEffect(() => {
    const pts = [];
    let lastSample = 0;
    const move = (e) => {
      const el = cursorRef.current;
      if (el) el.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      const now = performance.now();
      if (now - lastSample > 28) {
        pts.push({ x: e.clientX, y: e.clientY, t: now });
        lastSample = now;
      }
    };
    const down = () => {
      interactRef.current = performance.now();
      cameraGoalRef.current = null; // the visitor's hand outranks the spec
      setAction("orbit");
    };
    const up = () => setAction(hoveredRef.current != null ? "focus" : "drift");
    const wheel = (e) => {
      interactRef.current = performance.now();
      cameraGoalRef.current = null;
      if (pageRef.current != null) return;
      if (focusedRef.current != null) {
        // dive-to-open: scroll pulls you into the focused thought
        diveRef.current = clamp01(diveRef.current + e.deltaY * 0.0011);
        if (diveRef.current >= 1) {
          const target = focusedRef.current;
          diveRef.current = 0;
          setPage(target);
          setAction("drift");
        } else {
          setAction(e.deltaY > 0 ? "enter" : "surface");
        }
        clearTimeout(labelTimer.current);
        labelTimer.current = setTimeout(
          () => setAction(hoveredRef.current != null ? "focus" : "drift"),
          600
        );
        return;
      }
      setAction("dive");
      clearTimeout(labelTimer.current);
      labelTimer.current = setTimeout(() => setAction("drift"), 450);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("wheel", wheel, { passive: true });

    // trail: dotted beads that fade, drawn on a 2d overlay
    const canvas = trailRef.current;
    const ctx = canvas.getContext("2d");
    let raf;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
    };
    resize();
    window.addEventListener("resize", resize);
    const LIFE = 850;
    const draw = () => {
      const now = performance.now();
      while (pts.length && now - pts[0].t > LIFE) pts.shift();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const col = themeRef.current === "lab" ? "216,255,62" : "43,43,56";
      for (const p of pts) {
        const age = (now - p.t) / LIFE;
        const a = (1 - age) * 0.7;
        const r = 2.6 * (1 - age * 0.55);
        ctx.beginPath();
        ctx.arc(p.x * dpr, p.y * dpr, r * dpr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${col},${a.toFixed(3)})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    setAction(hovered != null ? "focus" : "drift");
  }, [hovered]);

  // keyboard ---------------------------------------------------------------
  useEffect(() => {
    const key = (e) => {
      if (e.target.tagName === "INPUT") return; // the command bar owns its keys
      if (e.key === "/") {
        e.preventDefault();
        setCmdOpen(true);
        return;
      }
      if (e.key >= "1" && e.key <= "4") {
        setTopoIdx(+e.key - 1);
        setFocusedState(null);
        setOpenThoughtState(null);
        setHovered(null);
        diveRef.current = 0;
      }
      if (e.key === "d" || e.key === "D") setDrift((v) => !v);
      if (e.key === "Escape") {
        if (storyRef.current != null) setStoryIdx(null); // engine cleanup below
        else if (pageRef.current != null) setPage(null);
        else if (overlayRef.current != null) setOverlay(null);
        else if (openThoughtRef.current != null) setOpenThoughtState(null);
        else if (focusedRef.current != null) setFocusedState(null);
        else if (specRef.current.panels.length || specRef.current.narration || specRef.current.viz)
          setSpec((prev) => ({ ...prev, panels: [], narration: "", viz: null }));
        diveRef.current = 0;
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // narration types itself out — the system speaks, it doesn't paste
  const [typedNarration, setTypedNarration] = useState("");
  useEffect(() => {
    const full = spec.narration;
    if (!full) {
      setTypedNarration("");
      return;
    }
    setTypedNarration("");
    let i = 0;
    const iv = setInterval(() => {
      i += 2;
      setTypedNarration(full.slice(0, i));
      if (i >= full.length) clearInterval(iv);
    }, 22);
    return () => clearInterval(iv);
  }, [spec.narration]);

  const topo = TOPOLOGIES[topoIdx];
  const pageNode = page != null ? NODES[page] : null;
  const pageNeighbors =
    page != null
      ? LAYOUTS.semantic.neighbors[page].map((j) => ({ j, n: NODES[j] }))
      : [];
  const pageEv = pageNode ? EVIDENCE[pageNode.id] : null;
  // the build story — the actual conversations that fed this project, in order
  const pageStory = (() => {
    if (page == null || !thoughts) return [];
    const linked = thoughts.thoughts
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.pj === page)
      .sort((a, b) => (a.t.m < b.t.m ? -1 : 1));
    if (linked.length <= 7) return linked;
    const longest = [...linked].sort((a, b) => b.t.n - a.t.n)[0];
    const picks = new Set([0, linked.length - 1, linked.indexOf(longest)]);
    for (let k = 1; k <= 4; k++) picks.add(Math.round((k * (linked.length - 1)) / 5));
    return [...picks].sort((a, b) => a - b).map((k) => linked[k]);
  })();

  const focusedNode = focused != null ? NODES[focused] : null;
  const openTh =
    openThought != null && thoughts ? thoughts.thoughts[openThought] : null;

  // a composed instrument materializes when the spec carries a viz clause
  const vizResult = executeViz(spec.viz, thoughts);

  // drift is only allowed with every card and room closed; Scene adds the idle timer
  const rotateOK =
    drift && page == null && overlay == null && focused == null && openThought == null;

  return (
    <div className={`app app--${theme} ${intro ? "app--intro" : ""}`}>
      <Canvas
        gl={{ preserveDrawingBuffer: true }}
        camera={{ position: [0, 6, 26], fov: 42 }}
        onCreated={(state) => {
          state.scene.background = new THREE.Color("#07080a");
          state.scene.fog = new THREE.Fog("#07080a", 14, 34);
          state.raycaster.params.Points.threshold = 0.13;
          if (import.meta.env.DEV) {
            window.__scene = state.scene;
            window.__gl = state.gl;
            window.__cam = state.camera;
            window.__adv = (t) => state.advance(t);
          }
        }}
        dpr={[1, 2]}
      >
        <Scene
          topology={topology}
          theme={theme}
          hovered={hovered}
          setHovered={setHovered}
          focused={focused}
          setFocused={setFocused}
          openThought={openThought}
          setOpenThought={setOpenThought}
          diveRef={diveRef}
          telemetry={telemetry}
          thoughts={thoughts}
          rotateOK={rotateOK}
          interactRef={interactRef}
          filters={spec.filters}
          cameraGoalRef={cameraGoalRef}
          instruments={spec.instruments}
          vizResult={vizResult}
        />
      </Canvas>

      {/* bead trail */}
      <canvas ref={trailRef} className="trail" />

      {/* cursor instrument */}
      <div ref={cursorRef} className="cursor">
        <div className={`cursor__ring ${action !== "drift" ? "cursor__ring--live" : ""}`} />
        <div className="cursor__label">{action}</div>
      </div>

      {/* HUD */}
      <header className="hud hud--tl">
        <div className="hud__brand">{BRAND}</div>
        <div className="hud__sub">a spatial index of thoughts</div>
        <div className="hud__panels">
          {Object.entries(PANELS)
            .filter(([, p]) => !(p.observatoryOnly && SURFACE === "public"))
            .map(([key, p]) => (
              <button
                key={key}
                className={`hud__chip ${spec.panels.includes(key) ? "hud__chip--on" : ""}`}
                onClick={() => togglePanel(key)}
              >
                {p.title}
              </button>
            ))}
          <button
            className={`hud__chip hud__chip--story ${storyIdx != null ? "hud__chip--on" : ""}`}
            onClick={() => (storyIdx == null ? setStoryIdx(0) : stopStory())}
          >
            ▶ story
          </button>
        </div>
      </header>

      {/* panel dock — every open panel is a window over the same data core */}
      {spec.panels.length > 0 && (
        <div className="pdock">
          {spec.panels.map((key) => {
            const P = PANELS[key];
            const C = P.C;
            return (
              <div key={key} className={`card card--${theme} panel`}>
                <div className="card__bar">
                  <span className="card__dots"><i /><i /><i /></span>
                  <span className="card__file">{P.title}</span>
                  <button className="card__x" onClick={() => togglePanel(key)}>×</button>
                </div>
                <div className="card__body">
                  <div className="panel__sub">{P.sub}</div>
                  <C
                    thoughts={thoughts}
                    focused={focused}
                    filters={spec.filters}
                    applySpec={applySpec}
                    listen={setOpenThought}
                    openPage={setOverlay}
                    instruments={spec.instruments}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* narration — the system speaks one mono line at a time */}
      {spec.narration && (
        <div className="narration">
          {typedNarration}
          <span className={`narration__caret ${typedNarration.length >= spec.narration.length ? "narration__caret--rest" : ""}`} />
        </div>
      )}

      {/* story controls */}
      {storyIdx != null && storyIdx < story.length && (
        <div className="storybar">
          <button
            className="storybar__btn"
            onClick={() => setStoryIdx(Math.max(0, storyIdx - 1))}
          >
            ◄
          </button>
          <span className="storybar__pos">{storyIdx + 1} / {story.length}</span>
          <button className="storybar__btn" onClick={() => setStoryIdx(storyIdx + 1)}>
            ►
          </button>
          <button className="storybar__btn storybar__exit" onClick={stopStory}>
            esc · exit
          </button>
        </div>
      )}

      {/* command bar — ask anything; the dashboard is the answer */}
      {cmdOpen && (
        <div className={`cmdbar cmdbar--${theme}`}>
          <div className="cmdbar__row">
            <span className="cmdbar__prompt">/</span>
            <input
              className="cmdbar__input"
              autoFocus
              value={cmdText}
              onChange={(e) => setCmdText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") runCommand(cmdText);
                if (e.key === "Escape") {
                  setCmdOpen(false);
                  setCmdText("");
                }
              }}
              placeholder="ask the field anything…"
              spellCheck={false}
            />
            <span className="cmdbar__hint">{COMMAND_HINT}</span>
          </div>
          <div className="cmdbar__sugg">
            {[FEATURED_QUESTIONS[0], FEATURED_QUESTIONS[3], FEATURED_QUESTIONS[8], FEATURED_QUESTIONS[10]].map((q) => (
              <button key={q} className="cmdbar__q" onClick={() => runCommand(q)}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="hud hud--tr">
        <div className="hud__row">
          {TOPOLOGIES.map((t, i) => (
            <button
              key={t.key}
              className={`hud__btn ${i === topoIdx ? "hud__btn--on" : ""}`}
              onClick={() => {
                setTopoIdx(i);
                setFocusedState(null);
                setOpenThoughtState(null);
                setHovered(null);
                diveRef.current = 0;
              }}
            >
              {i + 1}
            </button>
          ))}
        </div>
        <div className="hud__mode">topology: {topo.label}</div>
        <div className="hud__hint">{topo.hint}</div>
      </div>

      <div className="hud hud--bl">
        <div id="hud-coords" className="hud__mono">LON 0.00 LAT 0.00 R 0.0</div>
        <div className="hud__mono hud__dim">
          {thoughts
            ? `${NODES.length} projects · ${thoughts.meta.thoughts.toLocaleString()} thoughts · ${thoughts.meta.messages.toLocaleString()} messages · ${thoughts.meta.months.length} months`
            : `${NODES.length} projects · loading thoughts…`}
        </div>
        <div className="hud__mono hud__dim">
          drag orbit · scroll dive · click focus · / command · 1-4 topology · d drift
        </div>
      </div>

      <div className="hud hud--br">
        <button
          className={`hud__drift ${drift ? "hud__drift--on" : ""}`}
          onClick={() => setDrift((v) => !v)}
        >
          drift {drift ? "on" : "off"}
        </button>
        <div id="hud-time" className="hud__mono">T+00:00:00</div>
      </div>

      {/* leader line: docked card → its node in the scene */}
      {(focusedNode || openTh) && !pageNode && (
        <svg className="leader">
          <line id="leader-line" className="leader__line" />
          <circle id="leader-dot" className="leader__dot" r="3.5" />
        </svg>
      )}

      {/* focused project card, docked so the close button never moves */}
      {focusedNode && !pageNode && (
        <div className="dock">
          <div id="dock-card" className={`card card--${theme}`}>
            <div className="card__bar">
              <span className="card__dots"><i /><i /><i /></span>
              <span className="card__file">{focusedNode.id}.node</span>
              {SURFACE !== "public" && focusedNode.visibility !== "reveal" && (
                <span className="card__vault">vault</span>
              )}
              <button className="card__x" onClick={() => setFocused(null)}>×</button>
            </div>
            <div className="card__body">
              <div className="card__title">{focusedNode.title}</div>
              <div className="card__meta">
                {STATUS_GLYPH[focusedNode.status]} {focusedNode.status} ·
                [{focusedNode.category}] · {focusedNode.era} · {focusedNode.stack}
              </div>
              <div className="card__desc">{focusedNode.desc}</div>
              {thoughts?.meta?.projects?.[focused]?.count > 0 && (
                <div className="card__prov">
                  built on {thoughts.meta.projects[focused].count} conversations ·
                  longest {thoughts.meta.projects[focused].longest.n} msgs
                </div>
              )}
              <div className="card__sig">{sigFormula(focusedNode)}</div>
              <div className="card__divehint">
                scroll to enter ↓
                <span className="card__divetrack"><span id="dive-bar" className="card__divefill" /></span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* listen-in: one real conversation, quoted — docked likewise */}
      {openTh && !pageNode && (
        <div className="dock">
          <div id="dock-card" className={`card card--${theme} card--listen`}>
            <div className="card__bar">
              <span className="card__dots"><i /><i /><i /></span>
              <span className="card__file">{openTh.m}.thought</span>
              <button className="card__x" onClick={() => setOpenThought(null)}>×</button>
            </div>
            <div className="card__body">
              <div className="card__title">{openTh.t}</div>
              {openTh.tk && <div className="card__hangul">{openTh.tk}</div>}
              <div className="card__meta">
                [{thoughts.meta.clusters[openTh.c]?.label || "misc"}] · {openTh.m} · {openTh.n} msgs
                {openTh.pj != null ? " · fed a project" : ""}
              </div>
              {openTh.q && <div className="card__quote">“{openTh.q}”</div>}
              {openTh.s && (
                <div className="card__prov" style={{ opacity: 0.6 }}>
                  held privately — abstracted by request
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* the rooms: creed, the mirror, the seed garden */}
      {overlay === "creed" && <CreedPage onClose={() => setOverlay(null)} theme={theme} />}
      {overlay === "mirror" && <MirrorPage onClose={() => setOverlay(null)} theme={theme} />}
      {overlay === "seeds" && (
        <SeedsPage
          onClose={() => setOverlay(null)}
          theme={theme}
          thoughts={thoughts}
          listen={setOpenThought}
        />
      )}

      {/* the project page you dove into */}
      {pageNode && (
        <div className={`pagev pagev--${theme}`}>
          <div className="pagev__bar">
            <span className="pagev__crumb">{BRAND_LC} / thoughts / {pageNode.id}</span>
            <button className="pagev__close" onClick={() => { setPage(null); diveRef.current = 0; }}>
              esc · surface ↑
            </button>
          </div>
          <div className="pagev__scroll">
            <div className="pagev__meta">
              {STATUS_GLYPH[pageNode.status]} {pageNode.status} · [{pageNode.category}] · {pageNode.era} · {pageNode.stack}
            </div>
            <h1 className="pagev__title">{pageNode.title}</h1>
            <p className="pagev__desc">{pageNode.desc}</p>

            {/* the proof row — live product first, then the paper trail */}
            <div className="ev__links">
              {pageEv?.url && (
                <a className="ev__link ev__link--live" href={pageEv.url} target="_blank" rel="noreferrer">
                  ● open the live product ↗
                </a>
              )}
              {pageEv?.store && (
                <a className="ev__link" href={pageEv.store} target="_blank" rel="noreferrer">
                  chrome web store ↗
                </a>
              )}
              {pageEv?.remote && (
                <a className="ev__link" href={pageEv.remote} target="_blank" rel="noreferrer">
                  github · {pageEv.repo} ↗
                </a>
              )}
            </div>

            <img
              className="ev__shot"
              src={`/evidence/${pageNode.id}.jpg`}
              alt=""
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />

            {pageEv && (
              <div className="ev__facts">
                {pageEv.commits > 0 && (
                  <span>{pageEv.commits} commits · {pageEv.firstCommit} → {pageEv.lastCommit}</span>
                )}
                {pageEv.ungoverned && <span>working folder — pre-git era</span>}
                {pageEv.langs?.length > 0 && <span>{pageEv.langs.join(" · ")}</span>}
                <span className="ev__sig">{sigFormula(pageNode)}</span>
              </div>
            )}

            {pageStory.length > 0 && (
              <div className="ev__story">
                <div className="ev__story-h">the build story — thoughts that went behind it</div>
                {pageStory.map(({ t, i }, k) => (
                  <button
                    key={i}
                    className="ev__beat"
                    onClick={() => { setPage(null); setOpenThought(i); }}
                  >
                    <span className="ev__beat-m">{t.m}</span>
                    <span className="ev__beat-body">
                      <span className="ev__beat-t">
                        {t.t.toLowerCase()}
                        {k === 0 ? " · the first spark" : ""}
                        {k === pageStory.length - 1 ? " · latest" : ""}
                      </span>
                      {t.q && <span className="ev__beat-q">“{t.q}”</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="pagev__nbrs">
              <span className="pagev__nbrs-label">semantically adjacent:</span>
              {pageNeighbors.map(({ j, n }) => (
                <button
                  key={n.id}
                  className="pagev__nbr"
                  onClick={() => { setPage(j); setFocusedState(j); }}
                >
                  {n.title.toLowerCase()} →
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
