import React, { useEffect, useRef, useState } from "react";
import "./HaloTuner.css";

// Live tuning panel for the speaking halo, shown when the URL has ?tune.
// Look sliders set CSS variables on the halo element (defaults in App.css);
// response sliders mutate App.tsx's haloResponse in place.

export interface HaloResponse {
  noiseFloor: number;
  fullScale: number;
  curve: number;
  attackMs: number;
  releaseMs: number;
}

interface Slider<K extends string> {
  key: K;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

const LOOK_SLIDERS: Slider<string>[] = [
  { key: "--speak-size", label: "Green size", min: 0.8, max: 1.6, step: 0.01 },
  { key: "--speak-swell", label: "Swell with volume", min: 0, max: 0.3, step: 0.01 },
  { key: "--speak-alpha", label: "Green intensity", min: 0, max: 1, step: 0.01 },
  { key: "--speak-lightness", label: "Green lightness", min: 20, max: 80, step: 1, unit: "%" },
  { key: "--speak-hue", label: "Green hue", min: 0, max: 360, step: 1 },
  { key: "--speak-solid", label: "Green solid to", min: 0, max: 100, step: 1, unit: "%" },
  { key: "--speak-fade", label: "Green fades out at", min: 0, max: 100, step: 1, unit: "%" },
  { key: "--listen-alpha", label: "Grey intensity", min: 0, max: 1, step: 0.01 },
  { key: "--listen-fade", label: "Grey fades while speaking", min: 0, max: 1, step: 0.01 },
];

const RESPONSE_SLIDERS: Slider<keyof HaloResponse>[] = [
  { key: "noiseFloor", label: "Noise floor", min: 0, max: 0.1, step: 0.001 },
  { key: "fullScale", label: "Full green at volume", min: 0.01, max: 0.4, step: 0.005 },
  { key: "curve", label: "Curve (<1 = more green)", min: 0.2, max: 3, step: 0.05 },
  { key: "attackMs", label: "Rise time", min: 0, max: 500, step: 5, unit: "ms" },
  { key: "releaseMs", label: "Fade time", min: 0, max: 1500, step: 10, unit: "ms" },
];

// Meter scale for raw volume (RMS).
const METER_MAX_RMS = 0.3;
const STORAGE_KEY = "halo-tuner-v1";

interface Props {
  haloRef: React.RefObject<HTMLDivElement>;
  response: HaloResponse;
  rmsRef: React.MutableRefObject<number>;
  levelRef: React.MutableRefObject<number>;
  feedRms: (rms: number) => void;
  isCalling: boolean;
  simulating: boolean;
  setSimulating: (on: boolean) => void;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

// Speech-like volume: words of varying loudness with syllable modulation,
// short gaps between words and longer pauses between sentences.
function makeSpeechSimulator() {
  let t = 0;
  let segmentEnd = 0;
  let speaking = false;
  let amplitude = 0;
  let wordsLeft = 0;
  return (elapsedMs: number) => {
    t += elapsedMs;
    if (t >= segmentEnd) {
      if (speaking) {
        speaking = false;
        wordsLeft--;
        segmentEnd = t + (wordsLeft > 0 ? rand(60, 180) : rand(700, 1400));
      } else {
        if (wordsLeft <= 0) wordsLeft = Math.round(rand(4, 12));
        speaking = true;
        amplitude = rand(0.04, 0.13);
        segmentEnd = t + rand(150, 450);
      }
    }
    const noise = 0.002 + Math.random() * 0.002;
    if (!speaking) return noise;
    const syllables = 0.55 + 0.45 * Math.abs(Math.sin((t / 1000) * Math.PI * 4.5));
    return amplitude * syllables + noise;
  };
}

function formatValue(value: number, slider: Slider<string>) {
  const decimals = slider.step >= 1 ? 0 : String(slider.step).split(".")[1].length;
  return value.toFixed(decimals) + (slider.unit ?? "");
}

function readStored(): { look?: Record<string, number>; response?: Partial<HaloResponse> } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

const HaloTuner = ({
  haloRef,
  response,
  rmsRef,
  levelRef,
  feedRms,
  isCalling,
  simulating,
  setSimulating,
}: Props) => {
  const [open, setOpen] = useState(true);
  const [look, setLook] = useState<Record<string, number>>({});
  const [resp, setResp] = useState<HaloResponse>({ ...response });
  const [copyStatus, setCopyStatus] = useState("");
  const defaultsRef = useRef<{ look: Record<string, number>; response: HaloResponse }>();
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const rmsBarRef = useRef<HTMLDivElement>(null);
  const levelBarRef = useRef<HTMLDivElement>(null);

  // Snapshot the shipped defaults, then restore any saved values.
  useEffect(() => {
    const halo = haloRef.current;
    if (!halo) return;
    const computed = getComputedStyle(halo);
    const defaultLook: Record<string, number> = {};
    for (const s of LOOK_SLIDERS) {
      defaultLook[s.key] = parseFloat(computed.getPropertyValue(s.key));
    }
    defaultsRef.current = { look: defaultLook, response: { ...response } };

    const stored = readStored();
    setLook({ ...defaultLook, ...stored.look });
    setResp({ ...response, ...stored.response });
  }, [haloRef, response]);

  // Apply look values to the halo element.
  useEffect(() => {
    const halo = haloRef.current;
    if (!halo) return;
    for (const s of LOOK_SLIDERS) {
      if (look[s.key] !== undefined) {
        halo.style.setProperty(s.key, look[s.key] + (s.unit ?? ""));
      }
    }
  }, [haloRef, look]);

  // Apply response values and persist everything.
  useEffect(() => {
    Object.assign(response, resp);
    if (Object.keys(look).length === 0) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ look, response: resp }));
    } catch {
      /* storage unavailable: values just won't persist */
    }
  }, [response, resp, look]);

  // Simulated speech, for tuning without a call.
  useEffect(() => {
    if (!simulating) return;
    const next = makeSpeechSimulator();
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      feedRms(next(now - last));
      last = now;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [simulating, feedRms]);

  // Meters (updated directly, not through React state).
  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      const rmsPct = Math.min(1, rmsRef.current / METER_MAX_RMS) * 100;
      const shown = Math.pow(levelRef.current, response.curve) * 100;
      if (rmsBarRef.current) rmsBarRef.current.style.width = `${rmsPct}%`;
      if (levelBarRef.current) levelBarRef.current.style.width = `${shown}%`;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [rmsRef, levelRef, response]);

  const reset = () => {
    const defaults = defaultsRef.current;
    if (!defaults) return;
    setLook({ ...defaults.look });
    setResp({ ...defaults.response });
    setCopyStatus("");
  };

  const settingsText = [
    "Halo settings",
    "",
    "CSS (.halo in src/App.css):",
    ...LOOK_SLIDERS.map((s) => `  ${s.key}: ${formatValue(look[s.key] ?? 0, s)};`),
    "",
    "JS (haloResponse in src/App.tsx):",
    ...RESPONSE_SLIDERS.map(
      (s) => `  ${s.key}: ${formatValue(resp[s.key], { ...s, unit: "" })},`,
    ),
  ].join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(settingsText);
      setCopyStatus("Copied!");
    } catch {
      outputRef.current?.select();
      setCopyStatus("Select-all done: press Ctrl/Cmd+C");
    }
  };

  const markerLeft = (rms: number) => `${Math.min(1, rms / METER_MAX_RMS) * 100}%`;

  return (
    <div className="halo-tuner" onClick={(e) => e.stopPropagation()}>
      <button className="halo-tuner-toggle" onClick={() => setOpen(!open)}>
        Halo tuner {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="halo-tuner-body">
          <button
            className="halo-tuner-button"
            disabled={isCalling}
            onClick={() => setSimulating(!simulating)}
          >
            {isCalling
              ? "Live call: using real audio"
              : simulating
                ? "Stop simulated speech"
                : "Play simulated speech"}
          </button>

          <div className="halo-tuner-meter">
            <span>Volume</span>
            <div className="halo-tuner-track">
              <div ref={rmsBarRef} className="halo-tuner-fill rms" />
              <div className="halo-tuner-marker" style={{ left: markerLeft(resp.noiseFloor) }} title="Noise floor" />
              <div className="halo-tuner-marker full" style={{ left: markerLeft(resp.fullScale) }} title="Full green" />
            </div>
          </div>
          <div className="halo-tuner-meter">
            <span>Green</span>
            <div className="halo-tuner-track">
              <div ref={levelBarRef} className="halo-tuner-fill level" />
            </div>
          </div>

          <h4>Look</h4>
          {LOOK_SLIDERS.map((s) => (
            <label key={s.key}>
              <span>
                {s.label} <b>{formatValue(look[s.key] ?? 0, s)}</b>
              </span>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={look[s.key] ?? 0}
                onChange={(e) => setLook({ ...look, [s.key]: Number(e.target.value) })}
              />
            </label>
          ))}

          <h4>Response to volume</h4>
          {RESPONSE_SLIDERS.map((s) => (
            <label key={s.key}>
              <span>
                {s.label} <b>{formatValue(resp[s.key], s)}</b>
              </span>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={resp[s.key]}
                onChange={(e) => setResp({ ...resp, [s.key]: Number(e.target.value) })}
              />
            </label>
          ))}

          <div className="halo-tuner-actions">
            <button className="halo-tuner-button" onClick={copy}>
              Copy values
            </button>
            <button className="halo-tuner-button secondary" onClick={reset}>
              Reset
            </button>
          </div>
          {copyStatus && <div className="halo-tuner-status">{copyStatus}</div>}
          <textarea ref={outputRef} readOnly value={settingsText} rows={8} />
        </div>
      )}
    </div>
  );
};

export default HaloTuner;
