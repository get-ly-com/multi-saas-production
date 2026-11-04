import { useEffect, useRef } from 'react';

// A short burst of confetti for real wins only: an invoice paid, inbox zero, setup done.
// Never for routine saves, and never more than once for the same win.
//   celebrate()                         from the middle of the screen
//   celebrate({ from: buttonElement })  from a button that was just clicked
//   <Celebrate when={allDone} />        fires once when `when` turns true
// Nothing is drawn for people who ask their device for less motion.

type Options = { from?: Element | null; x?: number; y?: number; pieces?: number };

const reducedMotion = () =>
  typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const palette = () => {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return [read('--accent', '#5145e5'), read('--good', '#12805c'), read('--warn', '#f0b354'), read('--series-2', '#eb6834'), read('--accent-soft-strong', '#c9c5fb')];
};

let running = false;

export function celebrate(options: Options = {}) {
  if (typeof document === 'undefined' || reducedMotion() || running) return false;
  running = true;

  const width = window.innerWidth;
  const height = window.innerHeight;
  let x = options.x ?? width / 2;
  let y = options.y ?? height * 0.35;
  if (options.from) {
    const box = options.from.getBoundingClientRect();
    x = box.left + box.width / 2;
    y = box.top + box.height / 2;
  }

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.className = 'celebrate-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d');
  if (!context) {
    canvas.remove();
    running = false;
    return false;
  }
  context.scale(ratio, ratio);

  const colours = palette();
  const count = options.pieces ?? 90;
  const pieces = Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const speed = 6 + Math.random() * 7;
    return {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 5,
      spin: Math.random() * Math.PI,
      turn: (Math.random() - 0.5) * 0.3,
      colour: colours[Math.floor(Math.random() * colours.length)],
      round: Math.random() < 0.3
    };
  });

  const started = performance.now();
  const life = 1600;
  const frame = (now: number) => {
    const age = now - started;
    context.clearRect(0, 0, width, height);
    const fade = Math.max(0, 1 - Math.max(0, age - life * 0.6) / (life * 0.4));
    for (const piece of pieces) {
      piece.vy += 0.28;
      piece.vx *= 0.985;
      piece.vy *= 0.985;
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.spin += piece.turn;
      context.save();
      context.globalAlpha = fade;
      context.translate(piece.x, piece.y);
      context.rotate(piece.spin);
      context.fillStyle = piece.colour;
      if (piece.round) {
        context.beginPath();
        context.arc(0, 0, piece.size / 2.4, 0, Math.PI * 2);
        context.fill();
      } else {
        context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
      }
      context.restore();
    }
    if (age < life) requestAnimationFrame(frame);
    else {
      canvas.remove();
      running = false;
    }
  };
  requestAnimationFrame(frame);
  return true;
}

export default function Celebrate({ when, from }: { when: boolean; from?: Element | null }) {
  const done = useRef(false);
  useEffect(() => {
    if (when && !done.current) {
      done.current = true;
      celebrate({ from });
    }
  }, [when]);
  return null;
}
