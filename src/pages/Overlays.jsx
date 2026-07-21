// The full-screen rooms: creed, the mirror, and the seed garden.
// Same retro-page language as the project dive (pagev), state-driven —
// URL routing arrives with the ship-time prerender.
import { SURFACE } from "../data/nodes.js";
import { seedQueue } from "../seeds.js";
import { store } from "../store.js";
import { config } from "../../datascape.config.js";

const CREED = store.creed;
const MIRRORS = store.mirrors;
const BRAND_LC = config.siteName.toLowerCase();

function Shell({ crumb, onClose, theme, children, wide }) {
  return (
    <div className={`pagev pagev--${theme}`}>
      <div className="pagev__bar">
        <span className="pagev__crumb">{crumb}</span>
        <button className="pagev__close" onClick={onClose}>esc · surface ↑</button>
      </div>
      <div className={`pagev__scroll ${wide ? "pagev__scroll--wide" : ""}`}>{children}</div>
    </div>
  );
}

export function CreedPage({ onClose, theme }) {
  return (
    <Shell crumb={`${BRAND_LC} / creed`} onClose={onClose} theme={theme}>
      <div className="pagev__meta">borrowed wisdom — kept apart from seeds, which are yours</div>
      <div className="creed__center">
        <div className="creed__ko">{CREED.centerpiece.ko}</div>
        <div className="creed__note">{CREED.centerpiece.note}</div>
      </div>
      <div className="creed__list">
        {CREED.quotes.map((q, i) => (
          <div key={i} className="creed__item">
            <div className="creed__text">“{q.text}”</div>
            {q.attribution && <div className="creed__attr">— {q.attribution}</div>}
          </div>
        ))}
      </div>
      <div className="creed__motto">{CREED.motto}</div>
    </Shell>
  );
}

function Gauge({ g }) {
  return (
    <div className="mirror__gauge">
      <div className="mirror__gauge-head">
        <span>{g.label}</span>
        <span className="mirror__gauge-val">{g.value}</span>
      </div>
      <div className="mirror__track">
        <span className="mirror__fill" style={{ width: `${g.value}%` }} />
      </div>
      <div className="mirror__reading">{g.reading}</div>
      <div className="mirror__limit">limit: {g.limit}</div>
    </div>
  );
}

export function MirrorPage({ onClose, theme }) {
  return (
    <Shell crumb={`${BRAND_LC} / mirrors`} onClose={onClose} theme={theme} wide>
      <div className="mirror__disclaimer">{MIRRORS.disclaimer}</div>
      <div className="pagev__meta" style={{ marginTop: 10 }}>
        {MIRRORS.readBy} · <span className="panel__tier">speculative</span>
      </div>
      <div className="mirror__grid">
        <div>
          <h2 className="mirror__h">the jungian shells</h2>
          {MIRRORS.jungian.map((g) => <Gauge key={g.key} g={g} />)}
        </div>
        <div>
          <h2 className="mirror__h">the dark triad, comparison-shopping edition</h2>
          {MIRRORS.darkTriad.map((g) => <Gauge key={g.key} g={g} />)}
          <h2 className="mirror__h" style={{ marginTop: 26 }}>metaperception</h2>
          <div className="mirror__meta-row">
            <span className="mirror__meta-k">how it presents</span>
            {MIRRORS.metaperception.how_she_presents}
          </div>
          <div className="mirror__meta-row">
            <span className="mirror__meta-k">how the data reads it</span>
            {MIRRORS.metaperception.how_the_data_reads_her}
          </div>
          <div className="mirror__meta-row">
            <span className="mirror__meta-k">the gap</span>
            {MIRRORS.metaperception.the_gap}
          </div>
          <div className="mirror__limit" style={{ marginTop: 8 }}>
            limit: {MIRRORS.metaperception.limit}
          </div>
        </div>
      </div>
      <div className="mirror__essays">{MIRRORS.essaysNote}</div>
    </Shell>
  );
}

export function SeedsPage({ onClose, theme, thoughts, listen }) {
  const queue = SURFACE === "public" ? [] : seedQueue(thoughts, 12);
  return (
    <Shell crumb={`${BRAND_LC} / seeds`} onClose={onClose} theme={theme}>
      <div className="pagev__meta">your own thoughts, worth planting — authored, not borrowed</div>
      {SURFACE === "public" || !queue.length ? (
        <div className="seeds__empty">
          <h1 className="pagev__title">the garden is being planted</h1>
          <p className="pagev__desc">
            seeds are the deep thoughts worth keeping, grown from your conversations.
            the first ones are being chosen — each will live here as its own page.
          </p>
        </div>
      ) : (
        <>
          <div className="pagev__desc" style={{ marginTop: 14 }}>
            the recommender's queue — ranked by depth, resonant words, and feeding
            no build. candidates only: nothing publishes without your yes.
          </div>
          <div className="seeds__queue">
            {queue.map(({ t, i, score }) => (
              <button
                key={i}
                className="seeds__cand"
                onClick={() => { onClose(); listen(i); }}
              >
                <div className="seeds__cand-head">
                  <span>{t.t.toLowerCase()}</span>
                  <span className="seeds__cand-score">{score.toFixed(1)} · {t.m}</span>
                </div>
                {t.q && <div className="seeds__cand-q">“{t.q}”</div>}
              </button>
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}
