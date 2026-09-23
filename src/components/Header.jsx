import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// The clock is always Europe/Brussels, whatever the machine's timezone.
const clockFormat = new Intl.DateTimeFormat('nl-BE', {
  timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit', hour12: false,
});

// Every row of the menu, whatever its role, so the arrow keys walk them
// all in the order they are drawn.
const MENU_ITEMS = '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]';

// Native Fullscreen API, with the webkit spelling Safari still needs.
// Returns null when the browser cannot do it at all (an iPhone, notably),
// so the menu simply does not offer an entry that would do nothing.
function useFullscreen() {
  const available = typeof document !== 'undefined'
    && (document.fullscreenEnabled || document.webkitFullscreenEnabled || false);
  const [isFull, setIsFull] = useState(false);

  useEffect(() => {
    if (!available) return undefined;
    const sync = () => setIsFull(Boolean(
      document.fullscreenElement || document.webkitFullscreenElement));
    sync();   // the page may already be fullscreen when the board mounts
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, [available]);

  const toggle = useCallback(() => {
    const el = document.documentElement;
    const open = el.requestFullscreen ?? el.webkitRequestFullscreen;
    const close = document.exitFullscreen ?? document.webkitExitFullscreen;
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    // Both can reject (a denied permission, a gesture the browser did not
    // count); the state is re-read from the event either way.
    Promise.resolve(active ? close?.call(document) : open?.call(el))
      .catch(() => {});
  }, []);

  return available ? { isFull, toggle } : null;
}

export default function Header({
  station, title, onPickStation, pickLabel,
  languages = [], lang, onLanguage, languageLabel,
  fullscreenLabel, fullscreenExitLabel,
  kiosk = false, kioskLabel, onKiosk, kioskExitLabel, onKioskExit,
  boardMode = 'departures', boardLabels = {}, boardPickLabel, onBoard, onBoardMenu,
  menuLabel, aboutLabel, onAbout, legalLabel, onLegal, contactLabel, onContact,
  stationLabel, updatedLabel, updatedAt, fixedNow = null,
}) {
  const fullscreen = useFullscreen();
  const [now, setNow] = useState(() => new Date());
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const wrapRef = useRef(null);
  const menuBtnRef = useRef(null);
  const menuRef = useRef(null);
  // The board menu: the centred title opens it, and it chooses between
  // Departures and Arrivals. It stays in the bar in kiosk mode.
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardPos, setBoardPos] = useState(null);
  const boardBtnRef = useRef(null);
  const boardMenuRef = useRef(null);

  // `fixedNow` is set only by the development mock, for repeatable
  // screenshots; the live board always ticks.
  useEffect(() => {
    if (fixedNow) return undefined;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [fixedNow]);

  const closeMenu = useCallback(({ restoreFocus = true } = {}) => {
    setMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => menuBtnRef.current?.focus());
  }, []);

  // The menu is fixed, so it has to be told where the button is. Measuring
  // beats hard-coding an offset from the bar's edge, and it survives a
  // resize.
  useLayoutEffect(() => {
    if (!menuOpen) return undefined;
    const place = () => {
      const r = menuBtnRef.current?.getBoundingClientRect();
      // The intended trigger-to-menu gap is 6px; it stays here because
      // the fixed menu's position is measured and written at runtime.
      if (r) setMenuPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [menuOpen]);

  // Opening a menu puts focus on its first row, so the arrow keys below
  // have somewhere to start from and a keyboard never lands in a menu it
  // cannot walk.
  useEffect(() => {
    if (!menuOpen || !menuPos) return undefined;
    const id = requestAnimationFrame(
      () => menuRef.current?.querySelector(MENU_ITEMS)?.focus());
    return () => cancelAnimationFrame(id);
  }, [menuOpen, menuPos]);

  // The menu closes on Escape and on a click anywhere else.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    };
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) {
        closeMenu({ restoreFocus: false });
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen, closeMenu]);

  const closeBoard = useCallback(({ restoreFocus = true } = {}) => {
    setBoardOpen(false);
    if (restoreFocus) requestAnimationFrame(() => boardBtnRef.current?.focus());
  }, []);

  // App needs to know, synchronously, that Escape belongs to this menu
  // while it is open — kiosk mode would otherwise take the same key.
  useLayoutEffect(() => {
    onBoardMenu?.(boardOpen);
    return () => onBoardMenu?.(false);
  }, [boardOpen, onBoardMenu]);

  // Centred under the title, measured like the overflow menu is.
  useLayoutEffect(() => {
    if (!boardOpen) return undefined;
    const place = () => {
      const r = boardBtnRef.current?.getBoundingClientRect();
      if (r) setBoardPos({ top: r.bottom + 6, left: r.left + r.width / 2 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [boardOpen]);

  // Focus lands on the board on screen, so Enter keeps it.
  useEffect(() => {
    if (!boardOpen || !boardPos) return undefined;
    const id = requestAnimationFrame(() => (
      boardMenuRef.current?.querySelector('[aria-checked="true"]')
        || boardMenuRef.current?.querySelector(MENU_ITEMS))?.focus());
    return () => cancelAnimationFrame(id);
  }, [boardOpen, boardPos]);

  useEffect(() => {
    if (!boardOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeBoard(); }
    };
    const onDown = (e) => {
      if (!boardBtnRef.current?.contains(e.target) && !boardMenuRef.current?.contains(e.target)) {
        closeBoard({ restoreFocus: false });
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [boardOpen, closeBoard]);

  const onMenuKeyDown = (e) => {
    const items = [...(e.currentTarget.querySelectorAll(MENU_ITEMS) ?? [])];
    const index = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = items[(index + 1 + items.length) % items.length];
    if (e.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
    if (e.key === 'Home') next = items[0];
    if (e.key === 'End') next = items.at(-1);
    if (next) { e.preventDefault(); next.focus(); }
  };

  // One value, two placements: the bar shows it on desktop, the menu shows
  // it once the bar has dropped it. Which of the two is visible is CSS's
  // decision, at the same width that hides the station name.
  const updatedTime = updatedAt ? clockFormat.format(updatedAt) : null;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-clock">{clockFormat.format(fixedNow ?? now)}</span>
        {/* The station name is also a way into the picker, the same action
            as the search button, for anyone who reaches for the name. Kiosk
            hides that button, so there the name is plain text again. */}
        {kiosk ? (
          <span className="topbar-station">{station}</span>
        ) : (
          <button
            type="button"
            className="topbar-station"
            onClick={onPickStation}
            aria-label={`${pickLabel}: ${station}`}
          >
            {station}
          </button>
        )}
      </div>
      {/* The board's title is also its switch: one button that looks like
          the title, with a chevron in a slot reserved on both sides, so the
          words stay on the bar's centre line whatever the chevron does. */}
      <div className="topbar-title topbar-title--board">
        <button
          ref={boardBtnRef}
          type="button"
          className={`topbar-board${boardOpen ? ' is-on' : ''}`}
          onClick={() => (boardOpen ? closeBoard() : setBoardOpen(true))}
          aria-haspopup="menu"
          aria-expanded={boardOpen}
          aria-label={`${boardPickLabel}: ${title}`}
        >
          <span className="topbar-board__label">{title}</span>
          <svg className="topbar-board__chevron" viewBox="0 0 24 24" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {boardOpen && boardPos && (
        <div
          ref={boardMenuRef}
          className="topbar-menu topbar-menu--board"
          role="menu"
          aria-label={boardPickLabel}
          onKeyDown={onMenuKeyDown}
          style={{ top: boardPos.top, left: boardPos.left }}
        >
          {['departures', 'arrivals'].map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={mode === boardMode}
              className="topbar-menu-item topbar-menu-item--row"
              onClick={() => { closeBoard(); onBoard?.(mode); }}
            >
              <svg className="topbar-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
                {mode === boardMode && <polyline points="5 12.5 10 17.5 19 7" />}
              </svg>
              {boardLabels[mode]}
            </button>
          ))}
        </div>
      )}
      <div className="topbar-right">
        {updatedTime && (
          <span className="topbar-updated">{`${updatedLabel} ${updatedTime}`}</span>
        )}
        {/* Search stays in the bar: it is the one control the board is
            actually operated with. Everything else moved into the menu
            beside it, so the title bar reads as a screen, not a toolbar.
            Kiosk mode drops both: the screen is only for reading, and
            leaves one close button, since touch screens have no Escape. */}
        {kiosk && (
          <button
            type="button"
            className="topbar-pick topbar-kiosk-exit"
            onClick={onKioskExit}
            aria-label={kioskExitLabel}
            title={kioskExitLabel}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        )}
        {!kiosk && (<>
        <button
          type="button"
          className="topbar-pick"
          onClick={onPickStation}
          aria-label={pickLabel}
          title={pickLabel}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <line x1="15.8" y1="15.8" x2="20" y2="20" />
          </svg>
        </button>

        <div className="topbar-menuwrap" ref={wrapRef}>
          <button
            ref={menuBtnRef}
            type="button"
            className={`topbar-pick topbar-menu-btn${menuOpen ? ' is-on' : ''}`}
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            aria-label={menuLabel}
            title={menuLabel}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            {/* three dots: the one glyph that promises "more" without
                naming any single thing behind it */}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="5" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="12" cy="19" r="1.7" />
            </svg>
          </button>

          {menuOpen && menuPos && (
            <div
              ref={menuRef}
              className="topbar-menu"
              role="menu"
              aria-label={menuLabel}
              onKeyDown={onMenuKeyDown}
              style={{ top: menuPos.top, right: menuPos.right }}
            >
              {languages.length > 0 && (
                <div className="topbar-menu-group" role="group" aria-label={languageLabel}>
                  <span className="topbar-menu-label" aria-hidden="true">{languageLabel}</span>
                  <div className="topbar-menu-langs">
                    {languages.map((l) => (
                      <button
                        key={l.code}
                        type="button"
                        role="menuitemradio"
                        aria-checked={l.code === lang}
                        className={`topbar-menu-item topbar-menu-item--lang${l.code === lang ? ' is-on' : ''}`}
                        onClick={() => { onLanguage?.(l.code); closeMenu(); }}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {fullscreen && (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={fullscreen.isFull}
                  className={`topbar-menu-item topbar-menu-item--row${fullscreen.isFull ? ' is-on' : ''}`}
                  onClick={() => { fullscreen.toggle(); closeMenu(); }}
                >
                  {/* four corner brackets: outward to expand, inward to leave */}
                  <svg className="topbar-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
                    {fullscreen.isFull ? (
                      <>
                        <polyline points="9 4 9 9 4 9" />
                        <polyline points="15 4 15 9 20 9" />
                        <polyline points="9 20 9 15 4 15" />
                        <polyline points="15 20 15 15 20 15" />
                      </>
                    ) : (
                      <>
                        <polyline points="4 9 4 4 9 4" />
                        <polyline points="20 9 20 4 15 4" />
                        <polyline points="4 15 4 20 9 20" />
                        <polyline points="20 15 20 20 15 20" />
                      </>
                    )}
                  </svg>
                  {fullscreen.isFull ? fullscreenExitLabel : fullscreenLabel}
                </button>
              )}

              <button
                type="button"
                role="menuitem"
                className="topbar-menu-item topbar-menu-item--row"
                onClick={() => { closeMenu({ restoreFocus: false }); onKiosk?.(); }}
              >
                {/* a display on its stand */}
                <svg className="topbar-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3.5" y="4.5" width="17" height="11" rx="1" />
                  <line x1="12" y1="15.5" x2="12" y2="19.5" />
                  <line x1="8" y1="19.5" x2="16" y2="19.5" />
                </svg>
                {kioskLabel}
              </button>

              <button
                type="button"
                role="menuitem"
                className="topbar-menu-item topbar-menu-item--row"
                onClick={() => { closeMenu({ restoreFocus: false }); onAbout?.(); }}
              >
                <svg className="topbar-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="8.5" />
                  <line x1="12" y1="11" x2="12" y2="16.5" />
                  <line x1="12" y1="7.6" x2="12" y2="7.7" />
                </svg>
                {aboutLabel}
              </button>

              <button
                type="button"
                role="menuitem"
                className="topbar-menu-item topbar-menu-item--row"
                onClick={() => { closeMenu({ restoreFocus: false }); onLegal?.(); }}
              >
                <svg className="topbar-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 3.5h7l4 4v13H7z" />
                  <line x1="10" y1="12" x2="15" y2="12" />
                  <line x1="10" y1="15.5" x2="15" y2="15.5" />
                </svg>
                {legalLabel}
              </button>

              <button
                type="button"
                role="menuitem"
                className="topbar-menu-item topbar-menu-item--row"
                onClick={() => { closeMenu({ restoreFocus: false }); onContact?.(); }}
              >
                {/* an envelope */}
                <svg className="topbar-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3.5" y="6" width="17" height="12" rx="1" />
                  <path d="M3.5 7l8.5 6.5 8.5-6.5" />
                </svg>
                {contactLabel}
              </button>

              {/* What the title bar carries on wide screens and drops when
                  it narrows: the station it is showing and the time of the
                  data on it. Plain text, not menu entries — nothing here
                  is pressable, so none of it is a menu item and the arrow
                  keys walk straight past it. */}
              <div className="topbar-menu-info">
                {station && (
                  <p className="topbar-menu-fact">
                    <span className="topbar-menu-fact__label">{stationLabel}</span>
                    <span className="topbar-menu-fact__value">{station}</span>
                  </p>
                )}
                {updatedTime && (
                  <p className="topbar-menu-fact">
                    <span className="topbar-menu-fact__label">{updatedLabel}</span>
                    <span className="topbar-menu-fact__value">{updatedTime}</span>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
        </>)}
      </div>
    </header>
  );
}
