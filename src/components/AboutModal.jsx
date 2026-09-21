import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const IRAIL_DOCS = 'https://docs.irail.be/';
const SNCB_NMBS = 'https://www.belgiantrain.be/';

/* ------------------------------------------------------------------
   About — the same panel the train details use, with prose instead of
   a route: the picker's backdrop, the board's blue surface and the
   board's own `.topbar` as its title bar. Nothing new is invented and
   nothing here touches the API.

   Every sentence comes from the TEXT map in App.jsx, so the panel
   follows the language the board is set to.
   ------------------------------------------------------------------ */
export default function AboutModal({ open, t, onClose }) {
  const closeRef = useRef(null);
  const openerRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    // The menu row that opened this has already unmounted, so document
    // .activeElement is usually the body by now. Anything but a real
    // control is ignored and focus goes back to the menu button instead.
    const active = document.activeElement;
    openerRef.current = active && active !== document.body ? active : null;
    const id = requestAnimationFrame(() => closeRef.current?.focus());
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) ?? [])];
      if (!controls.length) return;
      const first = controls[0];
      const last = controls.at(-1);
      if (e.shiftKey && (document.activeElement === first
          || !dialogRef.current.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
      const opener = openerRef.current;
      requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus?.();
        else document.querySelector('.topbar-menu-btn')?.focus?.();
      });
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="about-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <section
        ref={dialogRef}
        className="about-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t.about}
      >
        {/* the board's own title bar, exactly as the details panel uses it */}
        <header className="topbar about-panel__bar">
          <span />
          <div className="topbar-title">{t.about}</div>
          <button
            type="button"
            className="topbar-pick train-close"
            onClick={onClose}
            aria-label={t.close}
            ref={closeRef}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </header>

        <div className="about-panel__body">
          <p className="about-panel__lead">{t.aboutWhat}</p>
          <p>{t.aboutIndependent}</p>
          <p>
            {t.aboutData}{' '}
            <a
              className="about-panel__link"
              href={IRAIL_DOCS}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.aboutIRail}
            </a>
            .
          </p>
          {/* The optional route map adds two more sources, so they are
              named here rather than crowding the map itself, which
              carries only its one "approximate route" label. */}
          <p>{t.aboutMapData}</p>
          <p className="about-panel__note">{t.aboutLive}</p>
          <p>
            {t.aboutOfficial}{' '}
            <a
              className="about-panel__link"
              href={SNCB_NMBS}
              target="_blank"
              rel="noopener noreferrer"
            >
              SNCB/NMBS
            </a>{' '}
            {t.aboutOfficialSuffix}
          </p>
          <p>{t.aboutTrademarks}</p>
        </div>
      </section>
    </div>
  );
}
