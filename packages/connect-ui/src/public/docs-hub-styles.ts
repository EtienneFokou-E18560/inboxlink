/** Docs hub CSS layered on CONNECT_STYLES (Link-stripe IA). */
export const DOCS_HUB_STYLES = /* css */ `
.docs-shell .main {
  align-items: flex-start;
  justify-content: center;
}

.docs-panel {
  width: min(100%, 42rem);
  animation: rise 640ms 60ms ease-out both;
}

.step-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.15rem;
  margin: 0 0 1.75rem;
  padding: 0;
  list-style: none;
  animation: rise 700ms 80ms ease-out both;
}

.step-strip li {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.step-strip a {
  display: inline-flex;
  align-items: center;
  padding: 0.35rem 0.7rem;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.55);
  color: var(--ink);
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
}

.step-strip a:hover {
  border-color: rgba(15, 110, 86, 0.45);
  background: rgba(215, 235, 227, 0.65);
}

.step-strip a:focus-visible {
  outline: 3px solid #7bc9b0;
  outline-offset: 2px;
}

.step-strip .arrow {
  color: var(--muted);
  font-size: 0.75rem;
  user-select: none;
  animation: step-pulse 1.8s ease-in-out infinite;
}

.step-strip li:nth-child(2) .arrow { animation-delay: 0.2s; }
.step-strip li:nth-child(3) .arrow { animation-delay: 0.4s; }

.doc-section {
  margin: 0 0 1.5rem;
  padding: 0 0 1.35rem;
  border-bottom: 1px solid var(--line);
  animation: rise 760ms 100ms ease-out both;
}

.doc-section:last-of-type {
  border-bottom: 0;
  padding-bottom: 0;
}

.doc-section h2 {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 1.25rem;
  letter-spacing: -0.02em;
  margin: 0 0 0.45rem;
}

.doc-section p {
  margin: 0 0 0.75rem;
  color: var(--ink-soft);
  font-size: 0.98rem;
}

.doc-links {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.doc-links a {
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 160ms ease, color 160ms ease;
}

.doc-links a:hover {
  color: var(--accent-hover);
  border-bottom-color: rgba(15, 110, 86, 0.35);
}

.doc-links a:focus-visible {
  outline: 3px solid #7bc9b0;
  outline-offset: 2px;
}

.doc-links .hint {
  display: block;
  margin-top: 0.1rem;
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 400;
}

.docs-footer-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  justify-content: center;
  margin-top: 0.5rem;
  font-size: 0.85rem;
}

.docs-footer-nav a {
  color: var(--muted);
  text-decoration: none;
}

.docs-footer-nav a:hover {
  color: var(--accent);
}

@keyframes step-pulse {
  0%, 100% { opacity: 0.35; transform: translateX(0); }
  50% { opacity: 1; transform: translateX(2px); }
}

@media (prefers-reduced-motion: reduce) {
  .step-strip .arrow { animation: none; }
  .docs-panel, .step-strip, .doc-section { animation: none; }
}
`;
