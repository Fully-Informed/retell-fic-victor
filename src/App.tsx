import React, { Suspense, lazy, useCallback, useEffect, useState, useRef } from "react";
import "./App.css";
import { RetellWebClient } from "retell-client-js-sdk";
import type { HaloResponse } from "./HaloTuner.tsx";

// Add ?tune to the URL to show sliders for tuning the speaking halo live.
// Loaded on demand, so regular visitors never download it.
const HaloTuner = lazy(() => import("./HaloTuner.tsx"));
const showTuner = new URLSearchParams(window.location.search).has("tune");

const agentId = process.env.REACT_APP_RETELL_AGENTID_VICTOR;

interface RegisterCallResponse {
  call_id: string;
  access_token: string;
  transport?: "livekit" | "gateway";
  ice_servers?: RTCIceServer[];
}

// The green halo follows the agent's output volume. Raw RMS is mapped to a
// 0..1 level: below noiseFloor is silence (grey halo), fullScale and above is
// full green. The level then follows an envelope: it rises quickly when the
// agent speaks (attackMs) and fades out gently (releaseMs), so short gaps
// between words dip the halo instead of switching it off. curve < 1 makes
// quieter speech show more green. The halo's look lives in App.css.
// Mutable so the ?tune panel can adjust it live.
const haloResponse: HaloResponse = {
  noiseFloor: 0,
  fullScale: 0.13,
  curve: 0.75,
  attackMs: 160,
  releaseMs: 240,
};

const retellWebClient = new RetellWebClient();

const App = () => {
  const [isCalling, setIsCalling] = useState(false);
  const [instructionsVisible, setInstructionsVisible] = useState(true);
  const haloRef = useRef<HTMLDivElement>(null);
  const levelRef = useRef(0);
  const rmsRef = useRef(0);
  const lastFrameTimeRef = useRef<number | null>(null);
  const processRmsRef = useRef<(rms: number) => void>();
  const resetHaloRef = useRef<() => void>();
  const [simulatingSpeech, setSimulatingSpeech] = useState(false);

  useEffect(() => {
    // Written straight to a CSS variable: this runs every animation frame, so
    // going through React state would re-render the app ~60 times a second.
    const setHaloLevel = (level: number) => {
      levelRef.current = level;
      const shown = Math.pow(level, haloResponse.curve);
      haloRef.current?.style.setProperty("--level", shown.toFixed(3));
    };

    const resetHalo = () => {
      lastFrameTimeRef.current = null;
      rmsRef.current = 0;
      setHaloLevel(0);
    };

    const processRms = (rms: number) => {
      rmsRef.current = rms;
      const { noiseFloor, fullScale, attackMs, releaseMs } = haloResponse;
      const target = Math.min(
        1,
        Math.max(0, (rms - noiseFloor) / (fullScale - noiseFloor)),
      );

      // Frame-rate independent smoothing (frames aren't always 16ms apart).
      const now = performance.now();
      const elapsed =
        lastFrameTimeRef.current === null ? 16 : now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;
      const timeConstant = target > levelRef.current ? attackMs : releaseMs;
      const smoothing = 1 - Math.exp(-elapsed / Math.max(timeConstant, 1));
      setHaloLevel(levelRef.current + (target - levelRef.current) * smoothing);
    };

    processRmsRef.current = processRms;
    resetHaloRef.current = resetHalo;

    retellWebClient.on("call_started", () => {
      console.log("call started");
      setIsCalling(true);
      setInstructionsVisible(false);
    });

    retellWebClient.on("call_ended", () => {
      console.log("call ended");
      resetHalo();
      setIsCalling(false);
      setInstructionsVisible(true);
    });

    // Fires every animation frame with a snapshot of the agent's audio
    // (requires emitRawAudioSamples: true in startCall).
    retellWebClient.on("audio", (audio: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
      processRms(Math.sqrt(sum / audio.length));
    });

    retellWebClient.on("update", (update) => {
      console.log("Received update", update);
    });

    retellWebClient.on("metadata", (metadata) => {
      console.log("Received metadata", metadata);
    });

    retellWebClient.on("error", (error) => {
      console.error("An error occurred:", error);
      retellWebClient.stopCall();
      resetHalo();
      setIsCalling(false);
    });

    // Cleanup function
    return () => {
      retellWebClient.removeAllListeners();
    };
  }, []);

  // Used by the ?tune panel to preview the halo without a call.
  const feedSimulatedRms = useCallback(
    (rms: number) => processRmsRef.current?.(rms),
    [],
  );

  useEffect(() => {
    if (!simulatingSpeech) resetHaloRef.current?.();
  }, [simulatingSpeech]);

  const showCallState = isCalling || simulatingSpeech;

async function requestMicrophonePermission() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log("Microphone permission granted");
  } catch (err) {
    console.error("Error requesting microphone permission:", err);
  }
}

  const toggleConversation = async () => {
    if (isCalling) {
      retellWebClient.stopCall();
    } else {
      setSimulatingSpeech(false);
      setInstructionsVisible(false);
      try {
        await requestMicrophonePermission();
        const registerCallResponse = await registerCall(agentId);
        if (registerCallResponse.access_token) {
          await retellWebClient.startCall({
            callId: registerCallResponse.call_id,
            accessToken: registerCallResponse.access_token,
            transport: registerCallResponse.transport,
            iceServers: registerCallResponse.ice_servers,
            emitRawAudioSamples: true,
          });
        } else {
          console.error("No access token received");
          setInstructionsVisible(true);
        }
      } catch (error) {
        console.error("Error starting call:", error);
        setInstructionsVisible(true);
      }
    }
  };

  async function registerCall(agentId: string): Promise<RegisterCallResponse> {
    console.log("Registering call for agent ID:", agentId);
    try {
      const response = await fetch("/api/create-web-call", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: agentId,
        }),
      });

      if (!response.ok) {
        throw new Error(`Error: ${response.status}`);
      }

      const data: RegisterCallResponse = await response.json();
      return data;
    } catch (err) {
      console.error("Error registering call:", err);
      throw err;
    }
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    e.currentTarget.classList.add('active');
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove('active');
    toggleConversation();
  }; 

  return (
    <div className={`App ${showTuner ? 'tuning' : ''}`}>
      <header className="App-header">
        <div className="portrait-wrapper">
          <div
            className={`portrait-container ${showCallState ? 'active' : 'inactive'}`}
            onClick={toggleConversation}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            <div ref={haloRef} className={`halo ${showCallState ? 'active' : 'inactive'}`}>
              <div className="halo-listening"></div>
              <div className="halo-speaking"></div>
            </div>
            <img
               src="/Victor_Round.png"
               alt="Victor"
              className="agent-portrait"
            />
          </div>
          <div className={`instructions ${instructionsVisible && !simulatingSpeech ? 'visible' : 'hidden'}`}>
            <p><strong>Click</strong> or <strong>Tap</strong></p>
          </div>
        </div>
      </header>
      {showTuner && (
        <Suspense fallback={null}>
          <HaloTuner
            haloRef={haloRef}
            response={haloResponse}
            rmsRef={rmsRef}
            levelRef={levelRef}
            feedRms={feedSimulatedRms}
            isCalling={isCalling}
            simulating={simulatingSpeech}
            setSimulating={setSimulatingSpeech}
          />
        </Suspense>
      )}
    </div>
  );
};

export default App;