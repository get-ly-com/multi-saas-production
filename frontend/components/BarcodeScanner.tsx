import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Modal from '@/components/Modal';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorClass = {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
};

const detectorClass = (): DetectorClass | null =>
  typeof window !== 'undefined' && 'BarcodeDetector' in window ? (window as any).BarcodeDetector : null;

// The camera button next to a scan box. Shows the camera, reads the first barcode it sees
// and hands it back. Uses the browser's own barcode reader, so nothing extra is downloaded.
export function ScanWithCamera({ onCode, label = 'Use camera' }: { onCode: (code: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="always scan-camera" onClick={() => setOpen(true)} title="Scan a barcode with the camera">
        {label}
      </button>
      {/* Drawn at the end of the page so it isn't part of the scan box's form or label */}
      {open && createPortal(
        <BarcodeScanner
          onClose={() => setOpen(false)}
          onCode={(code) => {
            setOpen(false);
            onCode(code);
          }}
        />,
        document.body
      )}
    </>
  );
}

export default function BarcodeScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState('');
  const [ready, setReady] = useState(false);
  const done = useRef(onCode);
  done.current = onCode;

  useEffect(() => {
    const Reader = detectorClass();
    if (!Reader) {
      setProblem("This browser can't read barcodes with the camera. On iPhone and iPad, Safari doesn't support it yet. Type the code in the box instead, or use Chrome on Android or a computer.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setProblem("This browser can't use the camera here. Type the code in the box instead.");
      return;
    }

    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;

    const stop = () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    (async () => {
      try {
        const supported = Reader.getSupportedFormats ? await Reader.getSupportedFormats() : FORMATS;
        const formats = FORMATS.filter((format) => supported.includes(format));
        if (!formats.length) {
          setProblem("This browser can't read the usual barcode types. Type the code in the box instead.");
          return;
        }
        const reader = new Reader({ formats });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped || !video.current) return stop();
        video.current.srcObject = stream;
        await video.current.play();
        setReady(true);

        const look = async () => {
          if (stopped || !video.current) return;
          try {
            if (video.current.readyState >= 2) {
              const found = await reader.detect(video.current);
              const code = found.find((row) => row.rawValue?.trim())?.rawValue.trim();
              if (code && !stopped) {
                stop();
                done.current(code);
                return;
              }
            }
          } catch {
            // A frame that can't be read is skipped
          }
          timer = window.setTimeout(look, 200);
        };
        look();
      } catch (err: any) {
        if (stopped) return;
        const name = err?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setProblem('Get-ly isn’t allowed to use the camera. Allow camera access for this site in your browser settings, then try again. You can also type the code in the box.');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setProblem('No camera was found. Type the code in the box instead.');
        } else if (name === 'NotReadableError') {
          setProblem('The camera is being used by another app. Close it and try again.');
        } else {
          setProblem("The camera couldn't be started. Type the code in the box instead.");
        }
      }
    })();

    // Closing the scanner always turns the camera off
    return stop;
  }, []);

  return (
    <Modal title="Scan a barcode" onClose={onClose}>
      {problem ? <p className="error">{problem}</p> : (
        <>
          <div className="scanner-view">
            <video ref={video} muted playsInline aria-label="Camera view" />
            <div className="scanner-aim" aria-hidden="true" />
          </div>
          <p className="muted">{ready ? 'Hold the barcode inside the box. It is read as soon as it is clear.' : 'Starting the camera…'}</p>
        </>
      )}
      <div className="form-actions">
        <button type="button" className="always" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
