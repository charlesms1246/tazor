'use client';

import { useEffect, useRef, useState } from 'react';
import { Notice } from '../_ui/index.tsx';
import { isPayLink } from './no-link.tsx';

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;
const detectorCtor = (): DetectorCtor | null => (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector ?? null;

/** "Scan QR" for a Tazor payment link, using the rear camera and the browser's BarcodeDetector. */
export function ScanQr() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => setSupported(detectorCtor() !== null && !!navigator.mediaDevices?.getUserMedia), []);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
    (async () => {
      try {
        const Ctor = detectorCtor();
        if (!Ctor) throw new Error('This browser cannot read QR codes.');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) return stop();
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const detector = new Ctor({ formats: ['qr_code'] });
        const tick = async () => {
          if (stopped) return;
          try {
            for (const code of await detector.detect(v)) {
              if (isPayLink(code.rawValue, location.origin)) {
                stop();
                setOpen(false);
                location.assign(code.rawValue.trim());
                return;
              }
              setError('That QR code is not a Tazor payment link for this site.');
            }
          } catch { /* frame not ready */ }
          timer = setTimeout(tick, 250);
        };
        void tick();
      } catch (e) {
        setError(e instanceof Error && e.name === 'NotAllowedError' ? 'Camera permission was denied.' : e instanceof Error ? e.message : String(e));
      }
    })();
    return stop;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);

  if (supported === null) return null;
  if (!supported) return <p className="small muted" data-testid="scan-unsupported">On a phone, your camera app opens Tazor invoice QR codes directly.</p>;
  return (
    <>
      <div className="row">
        <button type="button" className="btn" data-testid="scan-qr" onClick={() => { setError(''); setOpen(true); }}>Scan QR</button>
      </div>
      {open && (
        <>
          <div className="drawer-overlay" onClick={() => setOpen(false)} />
          <div className="scan-modal" role="dialog" aria-modal="true" aria-label="Scan a payment QR code" data-testid="scan-modal">
            <p style={{ margin: 0, fontWeight: 600 }}>Scan the invoice QR code</p>
            <video ref={video} className="scan-video" data-testid="scan-video" muted playsInline />
            {error && <Notice tone="negative" testId="scan-error">{error}</Notice>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" data-testid="scan-cancel" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
