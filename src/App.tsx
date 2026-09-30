import React, { useEffect, useState, useRef } from "react";
import "./App.css";
import { RetellWebClient } from "retell-client-js-sdk";

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
const haloResponse = {
  noiseFloor: 0,
  fullScale: 0.1,
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
  const lastFrameTimeRef = useRef<number | null>(null);

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
      setHaloLevel(0);
    };

    const processRms = (rms: number) => {
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
    <div className="App">
      <header className="App-header">
        <div className="portrait-wrapper">
          <div
            className={`portrait-container ${isCalling ? 'active' : 'inactive'}`}
            onClick={toggleConversation}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            <div ref={haloRef} className={`halo ${isCalling ? 'active' : 'inactive'}`}>
              <div className="halo-listening"></div>
              <div className="halo-speaking"></div>
            </div>
            <img
               src="/Victor_Round.png"
               alt="Victor"
              className="agent-portrait"
            />
          </div>
          <div className={`instructions ${instructionsVisible ? 'visible' : 'hidden'}`}>
            <p><strong>Click</strong> or <strong>Tap</strong></p>
          </div>
        </div>
      </header>
    </div>
  );
};

export default App;