import { useState } from 'react';
import { api, useLive } from '../api';
import { duration, percent } from '../format';

const GROUPS = [
  { id: 'attention', title: 'Needs my attention', help: 'A person must decide or fix something' },
  { id: 'merchant', title: 'Waiting for the merchant', help: 'The merchant has to send something' },
  { id: 'progress', title: 'In progress', help: 'Running by itself, nothing to do' },
  { id: 'done', title: 'Finished', help: 'Active merchants and rejections' },
  { id: 'all', title: 'All applications', help: 'Everything' },
];

export default function Applications() {
  const [group, setGroup] = useState('all');
  const list = useLive(() => api(`/applications?group=${group}`), 2000, [group]);
  const stats = useLive(() => api('/metrics'), 3000);
  const rows: any[] = list.data?.rows ?? [];
  const counts = list.data?.counts ?? {};
  const m = stats.data;

  async function reset() {
    if (!window.confirm('Delete every application and start with an empty list? (This is demo data.)')) return;
    await api('/demo/reset', {});
    list.refresh();
  }

  return (
    <>
      <div className="head">
        <div>
          <h1>Applications</h1>
          <p className="muted">Every merchant who applied, and what has to happen next. This page updates by itself.</p>
        </div>
        <a className="button primary" href="#/new" style={{ textDecoration: 'none' }}>+ New application</a>
      </div>

      <div className="tiles">
        {GROUPS.map((g) => (
          <button key={g.id} className={`tile ${group === g.id ? 'on' : ''} ${g.id === 'attention' && counts.attention ? 'hot' : ''}`} onClick={() => setGroup(g.id)}>
            <b>{counts[g.id] ?? 0}</b>
            {g.title}<br /><span>{g.help}</span>
          </button>
        ))}
      </div>

      <div className="card">
        <table>
          <thead><tr><th>Business</th><th>Status</th><th>Checks</th><th>Time in this status</th><th>Merchant ID</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => (location.hash = `/application/${a.id}`)}>
                <td><b>{a.name}</b><div className="muted small">{a.legalName} · {a.id}</div></td>
                <td>
                  <span className={`badge ${a.tone}`}>{a.label}</span>
                  {a.toFix > 0 && a.state === 'NEEDS_INFO' && <div className="small muted">{a.toFix} item{a.toFix > 1 ? 's' : ''} to fix</div>}
                  {a.duplicates > 0 && <div className="small warn">Possible duplicate</div>}
                </td>
                <td><div className="chips">{a.checks.length === 0 ? <span className="muted small">not started</span> : a.checks.map((c: any) => <span key={c.name} className={`chip ${c.tone}`} title={c.text}>{c.name.split(' ')[0]}: {c.text.split(' ')[0]}</span>)}</div></td>
                <td>{duration(a.inStateMs)}</td>
                <td className="mono">{a.merchantId ?? '-'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="empty">{group === 'all' ? <>No applications yet. <a href="#/new">Create the first one</a>; it only takes a minute.</> : 'Nothing here right now.'}</td></tr>}
          </tbody>
        </table>
      </div>

      {m && m.total > 0 && (
        <div className="card">
          <h2>How is the process doing?</h2>
          <div className="tiles" style={{ marginBottom: 0 }}>
            <div className="tile" style={{ cursor: 'default' }}><b>{m.total}</b><span>applications so far</span></div>
            <div className="tile" style={{ cursor: 'default' }}><b className="good">{percent(m.automaticRate)}</b><span>finished with no help from a person</span></div>
            <div className="tile" style={{ cursor: 'default' }}><b className="warn">{percent(m.exceptionRate)}</b><span>needed the merchant or a person</span></div>
            <div className="tile" style={{ cursor: 'default' }}><b>{m.averageOnboardMs == null ? '-' : duration(m.averageOnboardMs)}</b><span>average time to become a merchant</span></div>
          </div>
          {m.timeInState.length > 0 && (
            <>
              <h3 style={{ marginTop: 18 }}>Average time spent in each status</h3>
              <table><tbody>{m.timeInState.map((t: any) => <tr key={t.state}><td>{t.label}</td><td className="muted small">{t.count} time{t.count > 1 ? 's' : ''}</td><td className="right">{duration(t.averageMs)}</td></tr>)}</tbody></table>
            </>
          )}
        </div>
      )}

      <div className="card">
        <details>
          <summary>How does this work?</summary>
          <ol style={{ marginTop: 12 }}>
            <li><b>The merchant applies</b> with their details and three documents (PAN card, GST certificate, bank proof).</li>
            <li><b>We read the documents</b> and compare them with the form. If something is missing, blurry or does not match, the merchant is asked to fix it.</li>
            <li><b>Four checks run</b> with outside services: PAN, GST, bank account and risk. They answer a few seconds later, on their own.</li>
            <li><b>If every check passes</b>, the application is approved and a merchant ID is created. <b>If not</b>, a person reviews it and decides.</li>
          </ol>
          <p className="muted small">The outside services and the merchant ID system are simulated here. On the "New application" page you can choose how they behave, to see what happens when things go wrong.</p>
        </details>
      </div>
      <div className="footer">Demo with made-up data · <button className="link small" onClick={reset}>Delete all applications</button></div>
    </>
  );
}
