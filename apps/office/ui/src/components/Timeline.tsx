// src/components/Timeline.tsx
import React from "react";
import { useOfficeDataSource } from "../context/OfficeDataContext";
import type { OfficeSnapshot, OfficeEvent } from "../data/types";

const Timeline: React.FC = () => {
  const dataSource = useOfficeDataSource();
  const [events, setEvents] = React.useState<OfficeEvent[]>([]);

  React.useEffect(() => {
    // Initial empty events list; subscribe for future events.
    const unsubscribe = dataSource.subscribe((event) => {
      setEvents((prev) => [...prev, event]);
    });
    return () => {
      unsubscribe();
    };
  }, [dataSource]);

  return (
    <div className="timeline">
      <h2>Timeline</h2>
      {events.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <ul>
          {events.map((e, idx) => (
            <li key={idx}>
              <strong>{e.type}:</strong> {typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default Timeline;
