import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import { createCapture, onHidden, stopStream } from '../../lib/capture';
import { meterLevel, sinkIdFor, thresholdPosition } from '../../lib/voiceSettings';
import { audioConstraints, canSelectOutput } from '../../voice/devices';
import { createLevelMeter, LEVEL_FLOOR_DB, type LevelMeter } from '../../voice/levelMeter';
import type { VoicePrefs } from '../../voice/prefs';
import { secondaryButton } from '../styles';

interface MicCapture {
  stream: MediaStream;
  meter: LevelMeter;
}

/**
 * The mic test: **Test microphone** opens the chosen mic (with the processing flags) and drives the
 * **Input level** meter; **Let's check** plays the mic back through the chosen output. The capture
 * restarts when the device or a processing flag changes, and stops on **Stop testing**, unmount and
 * tab hide. Nothing opens the mic without a click.
 */
export function MicTest({
  prefs,
  onStart,
  onError,
  onCaptured,
}: {
  prefs: VoicePrefs;
  /** A test was started or stopped by the user (clears the page's previous alert). */
  onStart: () => void;
  onError: (message: string) => void;
  /** The mic opened: device labels are now visible, so the lists can refresh. */
  onCaptured: () => void;
}) {
  const t = useT();
  const [testing, setTesting] = useState(false);
  const [loopback, setLoopback] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [level, setLevel] = useState(LEVEL_FLOOR_DB);
  const audioRef = useRef<HTMLAudioElement>(null);
  const constraints = JSON.stringify(audioConstraints(prefs));
  const outputId = prefs.audioOutputId;
  const showThreshold = prefs.inputMode === 'voice' && prefs.vadGate;

  const reportBlocked = useEffectEvent(() => {
    onError(t('settings.voice.micBlocked'));
  });
  const reportSinkFailed = useEffectEvent(() => {
    onError(t('voice.messages.switchFailed'));
  });
  const captured = useEffectEvent(() => {
    onCaptured();
  });

  // The capture and its level meter; restarted when the constraints change.
  useEffect(() => {
    if (!testing) return;
    const capture = createCapture<MicCapture>(
      async () => {
        const audio = JSON.parse(constraints) as MediaTrackConstraints;
        const opened = await navigator.mediaDevices.getUserMedia({ audio });
        try {
          const track = opened.getAudioTracks()[0];
          if (track === undefined) throw new Error('No audio track');
          return { stream: opened, meter: await createLevelMeter(track) };
        } catch (err) {
          stopStream(opened);
          throw err;
        }
      },
      (running) => {
        running.meter.stop();
        stopStream(running.stream);
      },
    );
    let frame = 0;
    let latest = LEVEL_FLOOR_DB;
    capture.run().then(
      (running) => {
        if (running === null) return;
        setStream(running.stream);
        captured();
        // ~50 levels a second, drawn at most once per frame.
        running.meter.subscribe((db) => {
          latest = db;
          if (frame !== 0) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            setLevel(meterLevel(latest));
          });
        });
      },
      () => {
        setTesting(false);
        setLoopback(false);
        reportBlocked();
      },
    );
    return () => {
      cancelAnimationFrame(frame);
      capture.stop();
      setStream(null);
      setLevel(LEVEL_FLOOR_DB);
    };
  }, [testing, constraints]);

  // A hidden tab ends the test (the mic indicator must not stay on in the background).
  useEffect(() => {
    if (!testing) return;
    return onHidden(document, () => {
      setTesting(false);
      setLoopback(false);
    });
  }, [testing]);

  // Loopback: the raw mic stream through the chosen output.
  useEffect(() => {
    const audio = audioRef.current;
    if (!loopback || stream === null || audio === null) return;
    let alive = true;
    /** Read through a function: the cleanup may run while the sink or play() is pending. */
    const isAlive = () => alive;
    audio.srcObject = stream;
    void (async () => {
      if (canSelectOutput()) {
        try {
          await audio.setSinkId(sinkIdFor(outputId));
        } catch {
          if (isAlive()) reportSinkFailed();
        }
      }
      if (isAlive()) await audio.play().catch(() => undefined);
    })();
    return () => {
      alive = false;
      audio.pause();
      audio.srcObject = null;
    };
  }, [loopback, stream, outputId]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <button
          type="button"
          data-testid="mic-meter-toggle"
          aria-pressed={testing}
          className={secondaryButton}
          onClick={() => {
            onStart();
            if (testing) setLoopback(false);
            setTesting(!testing);
          }}
        >
          {testing ? t('settings.voice.stopTestMic') : t('settings.voice.testMic')}
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="settings-mic-level" className="text-sm font-medium text-text">
          {t('settings.voice.inputLevel')}
        </label>
        <div className="relative flex items-center">
          <meter
            id="settings-mic-level"
            data-testid="mic-level"
            data-level={level}
            min={LEVEL_FLOOR_DB}
            max={0}
            low={-60}
            high={-6}
            optimum={-30}
            value={level}
            aria-valuetext={t('settings.voice.decibels', { value: level })}
            className={meterClass}
          />
          {showThreshold && (
            <span
              aria-hidden="true"
              data-testid="mic-threshold"
              className="pointer-events-none absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text"
              style={{ left: thresholdPosition(prefs.vadThresholdDb) }}
            />
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div>
          <button
            type="button"
            data-testid="mic-test"
            aria-pressed={loopback}
            aria-describedby="settings-mic-test-hint"
            className={secondaryButton}
            onClick={() => {
              onStart();
              if (loopback) {
                setLoopback(false);
                return;
              }
              setTesting(true);
              setLoopback(true);
            }}
          >
            {loopback ? t('settings.voice.stopLoopback') : t('settings.voice.loopback')}
          </button>
        </div>
        <p id="settings-mic-test-hint" className="text-xs text-muted">
          {t('settings.voice.headphones')}
        </p>
      </div>
      <audio ref={audioRef} hidden />
    </div>
  );
}

/** A slim level bar in both engines (the default `<meter>` look is a tiny bevelled gauge). */
const meterClass =
  'block h-2.5 w-full appearance-none overflow-hidden rounded-full bg-bg ring-1 ring-white/10 ' +
  '[&::-webkit-meter-bar]:h-2.5 [&::-webkit-meter-bar]:rounded-full [&::-webkit-meter-bar]:border-0 ' +
  '[&::-webkit-meter-bar]:bg-bg [&::-webkit-meter-bar]:bg-none ' +
  '[&::-webkit-meter-optimum-value]:bg-success [&::-webkit-meter-optimum-value]:bg-none ' +
  '[&::-webkit-meter-suboptimum-value]:bg-accent [&::-webkit-meter-suboptimum-value]:bg-none ' +
  '[&::-webkit-meter-even-less-good-value]:bg-danger [&::-webkit-meter-even-less-good-value]:bg-none ' +
  '[&::-moz-meter-bar]:bg-success [&::-moz-meter-bar]:bg-none';
