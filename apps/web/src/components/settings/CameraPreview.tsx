import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import { createCapture, onHidden, stopStream } from '../../lib/capture';
import { videoConstraints } from '../../voice/devices';
import type { VoicePrefs } from '../../voice/prefs';
import { secondaryButton } from '../styles';

/**
 * **Preview camera** / **Stop preview**: the chosen camera at the chosen quality in a muted inline
 * `<video>`. Changing the camera or the quality restarts it; unmount and tab hide stop it.
 */
export function CameraPreview({
  prefs,
  onStart,
  onError,
  onCaptured,
}: {
  prefs: VoicePrefs;
  onStart: () => void;
  onError: (message: string) => void;
  /** The camera opened: device labels are now visible, so the lists can refresh. */
  onCaptured: () => void;
}) {
  const t = useT();
  const [on, setOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const constraints = JSON.stringify(videoConstraints(prefs));

  const reportBlocked = useEffectEvent(() => {
    onError(t('voice.messages.cameraBlocked'));
  });
  const captured = useEffectEvent(() => {
    onCaptured();
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!on || video === null) return;
    const capture = createCapture(
      () => navigator.mediaDevices.getUserMedia({ video: JSON.parse(constraints) as MediaTrackConstraints }),
      stopStream,
    );
    capture.run().then(
      (stream) => {
        if (stream === null) return;
        video.srcObject = stream;
        void video.play().catch(() => undefined);
        captured();
      },
      () => {
        setOn(false);
        reportBlocked();
      },
    );
    return () => {
      capture.stop();
      video.srcObject = null;
    };
  }, [on, constraints]);

  useEffect(() => {
    if (!on) return;
    return onHidden(document, () => {
      setOn(false);
    });
  }, [on]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <button
          type="button"
          data-testid="camera-preview-toggle"
          aria-pressed={on}
          className={secondaryButton}
          onClick={() => {
            onStart();
            setOn(!on);
          }}
        >
          {on ? t('settings.voice.stopPreview') : t('settings.voice.previewCamera')}
        </button>
      </div>
      <video
        ref={videoRef}
        data-testid="camera-preview"
        aria-label={t('settings.voice.cameraPreview')}
        muted
        playsInline
        autoPlay
        hidden={!on}
        // Mirrored, like our own tile in the video stage.
        className="aspect-video w-full max-w-md -scale-x-100 rounded-lg bg-black object-cover ring-1 ring-white/10"
      />
    </div>
  );
}
