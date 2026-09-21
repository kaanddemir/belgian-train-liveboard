import DepartureRow from './DepartureRow.jsx';

export default function DepartureBoard({ departures, layout, viaStops, t, empty, onOpen }) {
  return (
    <main className="departure-board">
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
