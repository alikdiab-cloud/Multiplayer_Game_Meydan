import { useCallback, useRef, useState } from "react";
import type { GameSoundEvent } from "./gameSoundEvents.js";

const SOUND_STORAGE_KEY = "meydan.sound-enabled.v1";

function readSoundPreference(): boolean {
  try {
    return window.localStorage.getItem(SOUND_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeSoundPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, String(enabled));
  } catch {
    // Audio remains usable for this tab when persistent storage is unavailable.
  }
}

function createContext(): AudioContext {
  if (typeof window.AudioContext !== "function") {
    throw new Error("Audio is unavailable in this browser.");
  }
  return new window.AudioContext();
}

function playTone(context: AudioContext, frequency: number, startAt: number, duration: number, volume: number): void {
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startAt);
  envelope.gain.setValueAtTime(0.0001, startAt);
  envelope.gain.exponentialRampToValueAtTime(volume, startAt + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(envelope);
  envelope.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

export function playGameSound(context: AudioContext, event: GameSoundEvent): void {
  const now = context.currentTime;
  if (event === "move") {
    playTone(context, 660, now, 0.085, 0.035);
    return;
  }
  if (event === "capture") {
    playTone(context, 392, now, 0.12, 0.045);
    playTone(context, 587, now + 0.07, 0.11, 0.035);
    return;
  }
  playTone(context, 523.25, now, 0.16, 0.04);
  playTone(context, 659.25, now + 0.11, 0.16, 0.035);
  playTone(context, 783.99, now + 0.22, 0.22, 0.03);
}

export type GameSounds = {
  enabled: boolean;
  ready: boolean;
  activating: boolean;
  statusMessage: string | null;
  toggle: () => Promise<void>;
  play: (event: GameSoundEvent) => void;
};

/** Web Audio is created or resumed only from the explicit sound-button gesture. */
export function useGameSounds(): GameSounds {
  const [enabled, setEnabled] = useState(readSoundPreference);
  const [ready, setReady] = useState(false);
  const [activating, setActivating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const enabledRef = useRef(enabled);
  const contextRef = useRef<AudioContext | null>(null);
  const activationInFlightRef = useRef(false);

  const setPreference = useCallback((nextEnabled: boolean) => {
    enabledRef.current = nextEnabled;
    setEnabled(nextEnabled);
    writeSoundPreference(nextEnabled);
  }, []);

  const toggle = useCallback(async () => {
    const context = contextRef.current;
    if (enabledRef.current && context?.state === "running") {
      setPreference(false);
      setReady(false);
      setStatusMessage(null);
      void context.suspend().catch(() => undefined);
      return;
    }
    if (activationInFlightRef.current) return;

    activationInFlightRef.current = true;
    setActivating(true);
    try {
      const audioContext = contextRef.current ?? createContext();
      contextRef.current = audioContext;
      audioContext.onstatechange = () => {
        const isRunning = audioContext.state === "running";
        setReady(isRunning);
        if (isRunning) {
          setStatusMessage(null);
        } else if (enabledRef.current) {
          setStatusMessage("Audio is paused by the browser. Activate sound to resume.");
        }
      };
      await audioContext.resume();
      if (audioContext.state !== "running") {
        throw new Error("The browser has paused audio. Activate sound to try again.");
      }
      setPreference(true);
      setReady(true);
      setStatusMessage(null);
    } catch (error) {
      setPreference(false);
      setReady(false);
      setStatusMessage(error instanceof Error
        ? `${error.message} The game remains playable without sound.`
        : "Audio could not start. The game remains playable without sound.");
    } finally {
      activationInFlightRef.current = false;
      setActivating(false);
    }
  }, [setPreference]);

  const play = useCallback((event: GameSoundEvent) => {
    const context = contextRef.current;
    if (!enabledRef.current || context === null || context.state !== "running") return;
    try {
      playGameSound(context, event);
    } catch {
      setReady(false);
      setStatusMessage("Audio could not play. Activate sound to try again.");
    }
  }, []);

  const visibleStatus = statusMessage ?? (enabled && !ready
    ? "Sound is on. Activate it in this tab to allow browser audio."
    : null);

  return { enabled, ready, activating, statusMessage: visibleStatus, toggle, play };
}
