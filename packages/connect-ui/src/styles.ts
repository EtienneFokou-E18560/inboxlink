/** Shared Connect UI stylesheet (inlined — Vercel serves all traffic via the API function). */
export const CONNECT_STYLES = /* css */ `
:root {
  --ink: #0c1f2e;
  --ink-soft: #243b4a;
  --muted: #5a6f7c;
  --paper: #f3f0e8;
  --paper-2: #e7eef2;
  --accent: #0f6e56;
  --accent-hover: #0b5744;
  --danger: #9b2c2c;
  --danger-bg: #fce8e8;
  --warn: #8a5a00;
  --warn-bg: #fff3d6;
  --line: rgba(12, 31, 46, 0.12);
  --shadow: 0 18px 50px rgba(12, 31, 46, 0.12);
  --radius: 18px;
  --font-display: "Fraunces", "Iowan Old Style", "Palatino Linotype", Palatino, serif;
  --font-body: "Figtree", "Avenir Next", "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  min-height: 100%;
}

body {
  font-family: var(--font-body);
  color: var(--ink);
  line-height: 1.55;
  background:
    radial-gradient(1200px 600px at 10% -10%, #d7ebe3 0%, transparent 55%),
    radial-gradient(900px 500px at 100% 0%, #d9e4ef 0%, transparent 50%),
    linear-gradient(165deg, var(--paper) 0%, var(--paper-2) 100%);
  background-attachment: fixed;
}

.shell {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  padding: clamp(1.25rem, 4vw, 2.5rem);
}

.brand {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(1.65rem, 4vw, 2.15rem);
  letter-spacing: -0.02em;
  margin: 0 0 0.35rem;
  animation: rise 520ms ease-out both;
}

.brand span {
  color: var(--accent);
}

.main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem 0 2rem;
}

.panel {
  width: min(100%, 28rem);
  animation: rise 640ms 60ms ease-out both;
}

.kicker {
  margin: 0 0 0.65rem;
  color: var(--muted);
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

h1 {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(1.75rem, 5vw, 2.35rem);
  line-height: 1.15;
  letter-spacing: -0.03em;
  margin: 0 0 0.85rem;
}

.lead {
  margin: 0 0 1.5rem;
  color: var(--ink-soft);
  font-size: 1.05rem;
}

.cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-height: 3rem;
  padding: 0.85rem 1.35rem;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  text-decoration: none;
  font-weight: 650;
  font-size: 1rem;
  border: 0;
  box-shadow: var(--shadow);
  transition: background 160ms ease, transform 160ms ease;
  animation: rise 720ms 120ms ease-out both;
}

.cta:hover { background: var(--accent-hover); }
.cta:active { transform: translateY(1px); }
.cta:focus-visible {
  outline: 3px solid #7bc9b0;
  outline-offset: 3px;
}

.meta {
  margin: 1.25rem 0 0;
  color: var(--muted);
  font-size: 0.92rem;
}

.notice {
  margin: 0 0 1.25rem;
  padding: 0.9rem 1rem;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.55);
  color: var(--ink-soft);
  font-size: 0.95rem;
}

.notice.warn {
  background: var(--warn-bg);
  border-color: rgba(138, 90, 0, 0.25);
  color: var(--warn);
}

.notice.danger {
  background: var(--danger-bg);
  border-color: rgba(155, 44, 44, 0.22);
  color: var(--danger);
}

.footer {
  color: var(--muted);
  font-size: 0.8rem;
  text-align: center;
  animation: rise 800ms 160ms ease-out both;
}

@media (max-width: 480px) {
  .shell { padding: 1rem 1rem 1.5rem; }
  .cta { width: 100%; }
  .panel { width: 100%; }
}

@keyframes rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .brand, .panel, .cta, .footer { animation: none; }
  .cta { transition: none; }
}
`;
