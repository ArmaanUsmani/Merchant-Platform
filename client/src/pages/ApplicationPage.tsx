import { useState } from 'react';
import { api, useLive } from '../api';
import { DOC_TYPES, readFile } from '../files';
import { duration } from '../format';

const STEPS = ['Received', 'Documents checked', 'Verification', 'Decision', 'Merchant ID'];
const FIELD_NAME: Record<string, string> = {
  pan: 'PAN', name: 'Name', gstin: 'GSTIN', legalName: 'Legal name', accountNumber: 'Account number', ifsc: 'IFSC', holderName: 'Account holder',
};
const DOC_NAME: Record<string, string> = { PAN_CARD: 'PAN card', GST_CERTIFICATE: 'GST certificate', BANK_PROOF: 'Bank proof' };
const FIELD_RESULT: Record<string, { text: string; tone: string }> = {
  OK: { text: 'Matches the form', tone: 'good' },
  LOW_CONFIDENCE: { text: 'Please double-check', tone: 'warn' },
  MISMATCH: { text: 'Does not match the form', tone: 'bad' },
  UNREADABLE: { text: 'Could not be read', tone: 'bad' },
};

/** Which step of the journey this application is on, and whether it stopped there. */
function progress(state: string): { at: number; stopped: boolean } {
  switch (state) {
    case 'SUBMITTED': return { at: 0, stopped: false };
    case 'NEEDS_INFO': return { at: 1, stopped: false };
    case 'VERIFYING': case 'BANK_RECHECK': return { at: 2, stopped: false };
    case 'IN_REVIEW': return { at: 3, stopped: false };
    case 'REJECTED': return { at: 3, stopped: true };
    case 'APPROVED': return { at: 4, stopped: false };
    case 'MERCHANT_ID_FAILED': return { at: 4, stopped: true };
    default: return { at: 5, stopped: false };   // ONBOARDED: everything done
  }
}

export default function ApplicationPage({ id }: { id: string }) {
  const { data: a, error, refresh } = useLive(() => api(`/applications/${id}`), 1500, [id]);
  const [message, setMessage] = useState('');
  const say = (m: string) => { setMessage(m); setTimeout(() => setMessage(''), 4500); };

  if (error && !a) return <div className="error">{error}</div>;
  if (!a) return <p className="muted">Loading...</p>;
  const { at, stopped } = progress(a.state);
  const t0 = a.audit[0]?.at ?? a.createdAt;
  const cardTone = a.tone === 'good' ? 'good' : a.tone === 'bad' ? 'bad' : a.tone === 'warn' ? 'warn' : 'info';

  return (
    <>
      <p><a href="#/">&larr; All applications</a></p>
      <div className="head">
        <div>
          <h1>{a.business.name}</h1>
          <div className="row"><span className={`badge ${a.tone}`}>{a.label}</span><span className="muted small">for {duration(a.inStateMs)} · application {a.id}</span></div>
        </div>
        {a.merchantId && <div><div className="muted small">Merchant ID</div><b className="mono">{a.merchantId}</b></div>}
      </div>

      <div className={`card ${cardTone}`}>
        <h3>What happens next</h3>
        <p style={{ margin: 0 }}>{a.nextStep}</p>
        {a.payoutsOnHold && <p className="bad" style={{ margin: '8px 0 0' }}><b>Payouts are paused</b> until the new bank account is verified.</p>}
        <div className="steps">
          {STEPS.map((s, i) => <span key={s} className={`step ${i < at ? 'done' : i === at ? (stopped ? 'stop' : 'now') : ''}`}>{i < at ? '✓ ' : ''}{s}</span>)}
        </div>
      </div>

      {a.state === 'NEEDS_INFO' && <NeedsInfo a={a} reload={refresh} say={say} />}
      {a.state === 'IN_REVIEW' && <Review a={a} reload={refresh} say={say} />}
      {a.state === 'MERCHANT_ID_FAILED' && <RetryMerchant a={a} reload={refresh} say={say} />}
      {!['REJECTED', 'SUBMITTED'].includes(a.state) && <BankChange a={a} reload={refresh} say={say} />}

      <div className="card">
        <h2>Verification checks</h2>
        {a.checks.length === 0 ? <p className="muted">Not started yet. The checks only start once the documents are accepted.</p> : (
          <table>
            <thead><tr><th>Check</th><th>Result</th><th>Tries</th><th>Details</th></tr></thead>
            <tbody>{a.checks.map((c: any) => (
              <tr key={c.type}>
                <td><b>{c.name}</b></td>
                <td><span className={`badge ${c.tone}`}>{c.text}</span></td>
                <td>{c.tries}</td>
                <td className="small muted">{c.waivedBy ? <>Waived by <b>{c.waivedBy}</b>: "{c.waivedWhy}"</> : c.reason}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Documents we received</h2>
        {a.documents.length === 0 && <p className="muted">No documents were read yet.</p>}
        {a.documents.map((d: any) => (
          <div className="doc" key={d.type}>
            <b>{DOC_NAME[d.type]}</b> <span className="muted small">{d.fileName}</span>
            {d.blurry ? <p className="bad small" style={{ margin: '6px 0 0' }}>This picture is too blurry to read{d.sharpness != null ? ` (sharpness ${d.sharpness})` : ''}.</p>
              : d.photo ? <p className="warn small" style={{ margin: '6px 0 0' }}>This is a photo or scan{d.sharpness != null ? ` (sharpness ${d.sharpness}, so it is clear enough)` : ''}. The system cannot read text from pictures yet, so a person has to read it.</p> : (
              <table style={{ marginTop: 6 }}>
                <tbody>{d.fields.map((f: any) => (
                  <tr key={f.name}>
                    <td style={{ width: 150 }} className="muted">{FIELD_NAME[f.name] ?? f.name}</td>
                    <td className="mono">{f.value || '(not found)'}</td>
                    <td className="small muted">{Math.round(f.confidence * 100)}% sure</td>
                    <td><span className={`chip ${FIELD_RESULT[f.status].tone}`}>{FIELD_RESULT[f.status].text}</span></td>
                  </tr>))}</tbody>
              </table>
            )}
          </div>
        ))}
        <p className="muted small">Sensitive numbers are shown with only their last 4 characters.</p>
      </div>

      {a.duplicates.length > 0 && (
        <div className="card warn">
          <h2>Possible duplicates</h2>
          {a.duplicates.map((d: any) => <p key={d.appId}><a href={`#/application/${d.appId}`}>{d.appId}</a> "{d.name}" looks like the same business: {d.same.join(', ')}.</p>)}
        </div>
      )}

      <div className="card">
        <h2>Application details</h2>
        <div className="cols small">
          <div>Owner: <b>{a.business.legalName}</b><br />Type: {a.business.type.replace('_', ' ').toLowerCase()}<br />Phone: {a.business.phone}<br />Email: {a.business.email}</div>
          <div>PAN: <span className="mono">{a.pan}</span><br />GSTIN: <span className="mono">{a.gstin}</span><br />Bank account: <span className="mono">{a.bank.account}</span> ({a.bank.ifsc})<br />Account holder: {a.bank.holderName}</div>
        </div>
      </div>

      <div className="card">
        <h2>Timeline</h2>
        <ul className="timeline">
          {a.audit.map((e: any, i: number) => (
            <li key={i}>
              <div className="when">{i === 0 ? 'start' : '+' + duration(e.at - t0)}</div>
              <div>{e.message}<div className="who">{e.actor}</div></div>
            </li>))}
        </ul>
      </div>
      {message && <div className="toast">{message}</div>}
    </>
  );
}

type Props = { a: any; reload: () => void; say: (m: string) => void };

/** Runs an action, shows a short confirmation or the error. */
function useAction(reload: () => void, say: (m: string) => void) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body: unknown, done: string) => {
    setBusy(true); setError('');
    try { await api(path, body); say(done); reload(); return true; } catch (e: any) { setError(e.message); return false; } finally { setBusy(false); }
  };
  return { run, error, busy };
}

function NeedsInfo({ a, reload, say }: Props) {
  const { run, error, busy } = useAction(reload, say);
  const [type, setType] = useState(DOC_TYPES[0].type);
  const [problem, setProblem] = useState('');
  async function sendFile(file?: File) {
    if (!file) return;
    try {
      const f = await readFile(file);
      setProblem('');
      await run(`/applications/${a.id}/fix`, { documents: [{ type, fileName: f.name, file: f }] }, 'Corrected document received. Checking it now.');
    } catch (e: any) { setProblem(e.message); }
  }
  return (
    <div className="card warn">
      <h2>What the merchant needs to fix</h2>
      <ul className="todo">{a.toFix.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
      <p className="muted small" style={{ marginTop: 12 }}>No checks are started until this is fixed, so no provider is called for a bad application.</p>

      <h3 style={{ marginTop: 16 }}>Send a corrected document</h3>
      <div className="row" style={{ marginBottom: 10 }}>
        <select style={{ width: 300 }} value={type} onChange={(e) => setType(e.target.value)}>{DOC_TYPES.map((d) => <option key={d.type} value={d.type}>{d.name}</option>)}</select>
        <input type="file" style={{ width: 'auto', flex: 1 }} accept=".pdf,.png,.jpg,.jpeg,.txt,.json" disabled={busy} onChange={(e) => { sendFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      <p className="muted small">Or, for the demo: <button className="link" disabled={busy} onClick={() => run(`/demo/merchant-fix/${a.id}`, {}, 'Corrected documents received. Checking again.')}>act as the merchant and send correct documents</button>.</p>
      {(error || problem) && <div className="error">{error || problem}</div>}
    </div>
  );
}

function Review({ a, reload, say }: Props) {
  const { run, error, busy } = useAction(reload, say);
  const [reviewer, setReviewer] = useState(localStorage.getItem('reviewer') ?? '');
  const [note, setNote] = useState('');
  const [items, setItems] = useState('');
  const [check, setCheck] = useState(a.review.checksToRetry[0].type);
  const send = (action: string, extra: object, done: string) => {
    localStorage.setItem('reviewer', reviewer);
    run(`/applications/${a.id}/review`, { action, reviewer, note, ...extra }, done).then((ok) => ok && setNote(''));
  };
  return (
    <div className="card warn">
      <h2>Why a person has to look at this</h2>
      <ul className="todo">{a.reviewReasons.map((r: any, i: number) => <li key={i}>{r.text}{!r.canOverride && <b className="bad"> This cannot be overridden by a person.</b>}</li>)}</ul>

      <h3 style={{ marginTop: 18 }}>Your decision</h3>
      <div className="cols">
        <div className="field"><label>Your name</label><input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="For example: Asha" /></div>
        <div className="field"><label>Reason for your decision <span className="hint">(required, it is saved in the timeline)</span></label><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why is this the right decision?" /></div>
      </div>
      <div className="row">
        <button className="primary" disabled={busy || !a.review.canApprove} onClick={() => send('approve', {}, 'Approved. The merchant ID is being created.')}>Approve</button>
        <button className="danger" disabled={busy} onClick={() => send('reject', {}, 'The application was rejected.')}>Reject</button>
      </div>
      {a.review.approveBlockedBecause && <p className="bad small" style={{ marginTop: 8 }}>You cannot approve yet. {a.review.approveBlockedBecause}</p>}
      <p className="muted small">Approving accepts the problems listed above. Rejecting closes the application for good.</p>

      <h3 style={{ marginTop: 16 }}>Or</h3>
      <div className="row" style={{ marginBottom: 12 }}>
        <span>Run this check again:</span>
        <select style={{ width: 200 }} value={check} onChange={(e) => setCheck(e.target.value)}>{a.review.checksToRetry.map((c: any) => <option key={c.type} value={c.type}>{c.name}</option>)}</select>
        <button disabled={busy} onClick={() => send('retry_check', { checkType: check }, 'Running that check again.')}>Run again</button>
      </div>
      <div className="field"><label>Ask the merchant for more <span className="hint">(one item per line)</span></label>
        <textarea rows={2} value={items} onChange={(e) => setItems(e.target.value)} placeholder="Please upload your latest GST certificate" /></div>
      <button disabled={busy || !items.trim()} onClick={() => send('ask_merchant', { items: items.split('\n') }, 'The merchant was asked for more information.')}>Send request to the merchant</button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function RetryMerchant({ a, reload, say }: Props) {
  const { run, error, busy } = useAction(reload, say);
  return (
    <div className="card bad">
      <h2>The merchant ID could not be created</h2>
      <p>The application is approved and that decision is kept. The system tried {a.audit.filter((e: any) => /Creating the merchant ID failed/.test(e.message)).length} times and then stopped, so nothing is lost. Press retry once the merchant platform is working again.</p>
      <button className="primary" disabled={busy} onClick={() => run(`/applications/${a.id}/retry-merchant-id`, { by: 'Operations' }, 'Trying again.')}>Retry creating the merchant ID</button>
      <p className="muted small" style={{ marginTop: 8 }}>In this demo the failing platform is simulated, so retrying also marks the simulated problem as fixed.</p>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function BankChange({ a, reload, say }: Props) {
  const { run, error, busy } = useAction(reload, say);
  const [open, setOpen] = useState(false);
  const [bank, setBank] = useState({ accountNumber: '', ifsc: '', holderName: a.bank.holderName });
  const [proof, setProof] = useState(true);
  const submit = async () => {
    const doc = proof ? { type: 'BANK_PROOF', fileName: 'new_bank_proof.json', fields: { accountNumber: bank.accountNumber, ifsc: bank.ifsc, holderName: bank.holderName } } : undefined;
    if (await run(`/applications/${a.id}/bank`, { bank, proof: doc }, 'Bank details changed. The new account is being verified.')) setOpen(false);
  };
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h3 style={{ margin: 0 }}>The merchant changed their bank account?</h3><span className="muted small">The old bank check no longer applies, so only the bank check is run again. A live merchant keeps accepting payments, but payouts pause.</span></div>
        <button onClick={() => setOpen(!open)}>{open ? 'Close' : 'Change bank details'}</button>
      </div>
      {open && (
        <div style={{ marginTop: 14 }}>
          <div className="cols">
            <div className="field"><label>New account number</label><input className="mono" value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value })} placeholder="For example 918273645501" /></div>
            <div className="field"><label>IFSC code</label><input className="mono" value={bank.ifsc} onChange={(e) => setBank({ ...bank, ifsc: e.target.value })} placeholder="For example ICIC0004321" /></div>
            <div className="field"><label>Name on the account</label><input value={bank.holderName} onChange={(e) => setBank({ ...bank, holderName: e.target.value })} /></div>
          </div>
          <label style={{ fontWeight: 400 }}><input type="checkbox" checked={proof} onChange={(e) => setProof(e.target.checked)} /> The merchant also sent proof (cancelled cheque). <span className="hint">Untick it: a change without proof is sent to a person to confirm.</span></label>
          <p style={{ marginTop: 10 }}><button className="primary" disabled={busy} onClick={submit}>Save the new bank details</button></p>
          {error && <div className="error">{error}</div>}
        </div>
      )}
    </div>
  );
}
