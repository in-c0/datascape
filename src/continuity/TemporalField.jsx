import {
  formatLocalClock,
  temporalGradient,
  temporalPercent,
  temporalWindowStyle,
} from "./temporal.js";

function Marker({ className, label, value, field }) {
  const left = temporalPercent(value, field);
  if (left == null) return null;
  return (
    <div className={`ct-time-marker ${className || ""}`} style={{ left: `${left}%` }}>
      <span>{label}</span>
    </div>
  );
}

export default function TemporalField({ field }) {
  if (!field) return null;

  const gradient = temporalGradient(field);
  const cloudCover = Number(field.weather?.cloudCover);
  const cloudOpacity = Number.isFinite(cloudCover)
    ? Math.max(0, Math.min(0.28, cloudCover / 360))
    : 0.08;

  return (
    <div className="ct-temporal-field" aria-hidden="true">
      <div
        className="ct-temporal-field__gradient"
        style={gradient ? { background: gradient } : undefined}
      />
      <div
        className="ct-temporal-field__weather"
        style={{ opacity: cloudOpacity }}
      />
      {(field.autonomyWindows || []).map((window) => {
        const style = temporalWindowStyle(window, field);
        if (!style) return null;
        return (
          <div
            className={`ct-autonomy-window ct-autonomy-window--${window.mode || "unattended"}`}
            style={style}
            key={window.id || `${window.start}-${window.end}`}
          >
            <div className="ct-autonomy-window__rule" />
            <div className="ct-autonomy-window__label">
              <strong>{window.label || "Unattended run"}</strong>
              <span>
                {window.scheduled ? "scheduled · " : ""}
                {formatLocalClock(window.start, field.timezone)}–{formatLocalClock(window.end, field.timezone)}
              </span>
            </div>
          </div>
        );
      })}

      <Marker
        className="ct-time-marker--sun"
        label={`sunrise ${formatLocalClock(field.sunrise, field.timezone)}`}
        value={field.sunrise}
        field={field}
      />
      <Marker
        className="ct-time-marker--sun"
        label={`sunset ${formatLocalClock(field.sunset, field.timezone)}`}
        value={field.sunset}
        field={field}
      />
      <Marker
        className="ct-time-marker--now"
        label="NOW"
        value={field.now}
        field={field}
      />

      <div className="ct-environment-caption">
        {field.locationLabel && <span>{field.locationLabel}</span>}
        {field.weather?.summary && <span>{field.weather.summary}</span>}
        {field.timezone && <span>{field.timezone}</span>}
      </div>
    </div>
  );
}
