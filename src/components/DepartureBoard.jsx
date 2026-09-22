import DepartureRow from './DepartureRow.jsx';

export default function DepartureBoard({ departures, layout, viaStops, t, empty, notice, onDismissNotice, onOpen }) {
  return (
    <main className="departure-board">
      {/* A shared link whose departure is gone: one board line above the
          first train, in a row's height, until dismissed or navigated
          away from. Announced by App, not here. */}
      {notice && (
        <div className="departure-board__notice">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16.5" />
            <line x1="12" y1="7.6" x2="12" y2="7.7" />
          </svg>
          <span className="departure-board__notice-text">{notice}</span>
          <button
            type="button"
            className="notice__clear"
            onClick={onDismissNotice}
            aria-label={t.close}
            title={t.close}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
      )}
      {departures.length
        ? departures.map((departure) => (
            <DepartureRow
              key={departure.id}
              departure={departure}
              layout={layout}
              viaStops={viaStops}
              t={t}
              onOpen={onOpen}
            />
          ))
        : empty && <div className="departure-board__empty">{empty}</div>}
    </main>
  );
}
