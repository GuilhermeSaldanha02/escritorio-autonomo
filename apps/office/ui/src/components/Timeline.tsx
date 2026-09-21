import { useOfficeSnapshot } from '../hooks/useOfficeSnapshot';

function timeOf(isoDate: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(isoDate));
}

export default function Timeline() {
  const snapshot = useOfficeSnapshot();
  if (snapshot === null) return <p className="office-loading">Carregando eventos…</p>;

  return (
    <section className="office-timeline" aria-label="Linha do tempo">
      <div className="office-section-heading">
        <div>
          <p className="eyebrow">Auditoria de leitura</p>
          <h2>Linha do tempo</h2>
        </div>
        <span>{snapshot.timeline.length} eventos</span>
      </div>
      <ol>
        {snapshot.timeline.map((event) => (
          <li key={event.id}>
            <time dateTime={event.occurredAt}>{timeOf(event.occurredAt)}</time>
            <div>
              <strong>{event.type}</strong>
              <p>{event.summary}</p>
              {event.untrustedExternal === undefined ? null : <p className="untrusted-text"><span>UNTRUSTED_EXTERNAL</span>{event.untrustedExternal}</p>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
