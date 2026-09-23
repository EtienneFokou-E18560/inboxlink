/** Landing-only CSS layered on CONNECT_STYLES (Vault door layout). */
export const LANDING_STYLES = /* css */ `
.shell-landing {
  max-width: 40rem;
  margin: 0 auto;
  justify-content: center;
  gap: clamp(1.5rem, 4vw, 2.75rem);
}

.shell-landing .brand-hero {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(2.75rem, 9vw, 4.25rem);
  letter-spacing: -0.03em;
  line-height: 1.05;
  margin: 0;
  animation: rise 520ms ease-out both;
}

.shell-landing .brand-hero span {
  color: var(--accent);
}

.shell-landing .promise {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(1.15rem, 3.2vw, 1.45rem);
  line-height: 1.35;
  letter-spacing: -0.02em;
  color: var(--ink-soft);
  animation: rise 640ms 60ms ease-out both;
}

.shell-landing .cta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
  align-items: center;
  animation: rise 720ms 100ms ease-out both;
}

.shell-landing .cta-secondary {
  display: inline-flex;
  align-items: center;
  min-height: 3rem;
  padding: 0.75rem 1.15rem;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.45);
  color: var(--ink);
  text-decoration: none;
  font-weight: 650;
  font-size: 0.98rem;
  transition: background 160ms ease, border-color 160ms ease;
}

.shell-landing .cta-secondary:hover {
  background: rgba(255, 255, 255, 0.75);
  border-color: rgba(12, 31, 46, 0.22);
}

.shell-landing .cta-secondary:focus-visible {
  outline: 3px solid #7bc9b0;
  outline-offset: 3px;
}

.shell-landing .flow {
  margin: 0;
  padding: 1rem 1.15rem;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(12, 31, 46, 0.04);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: clamp(0.72rem, 2.2vw, 0.85rem);
  line-height: 1.65;
  color: var(--ink-soft);
  overflow-x: auto;
  white-space: pre;
  animation: rise 800ms 140ms ease-out both;
}

.shell-landing .landing-footer {
  margin: 0;
  color: var(--muted);
  font-size: 0.82rem;
  animation: rise 860ms 180ms ease-out both;
}

.shell-landing .landing-footer a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
}

.shell-landing .landing-footer a:hover {
  text-decoration: underline;
}

@media (max-width: 480px) {
  .shell-landing .cta-row {
    flex-direction: column;
    align-items: stretch;
  }
  .shell-landing .cta,
  .shell-landing .cta-secondary {
    width: 100%;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .shell-landing .brand-hero,
  .shell-landing .promise,
  .shell-landing .cta-row,
  .shell-landing .flow,
  .shell-landing .landing-footer {
    animation: none;
  }
}
`;
