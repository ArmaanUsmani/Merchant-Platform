import { useState } from 'react';
import { api, useLive } from '../api';
import { DOC_TYPES, readFile } from '../files';

const FIELD_NAME: Record<string, string> = {
  pan: 'PAN', name: 'Name', gstin: 'GSTIN', legalName: 'Legal name', accountNumber: 'Account number', ifsc: 'IFSC', holderName: 'Account holder',
};
const BUSINESS_TYPES = ['PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'PRIVATE_LIMITED', 'PUBLIC_LIMITED'];
const EMPTY = { businessName: '', legalName: '', businessType: 'PROPRIETORSHIP', email: '', phone: '', pan: '', gstin: '', bank: { accountNumber: '', ifsc: '', holderName: '' } };

export default function NewApplication() {
  const examples = useLive(() => api('/examples'), 600_000);
  const scenarios = useLive(() => api('/scenarios'), 600_000);
  const [form, setForm] = useState<any>(structuredClone(EMPTY));
  const [docs, setDocs] = useState<any[]>([]);
  const [docType, setDocType] = useState('PAN_CARD');
  const [scenario, setScenario] = useState('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (key: string, value: string) => setForm({ ...form, [key]: value });
  const setBank = (key: string, value: string) => setForm({ ...form, bank: { ...form.bank, [key]: value } });
  const missingDocs = DOC_TYPES.filter((d) => !docs.some((x) => x.type === d.type));

  function fillWith(id: string) {
    const ex = examples.data?.find((e: any) => e.id === id);
    if (!ex) return;
    setForm(structuredClone(ex.form)); setDocs(structuredClone(ex.documents)); setError('');
  }
  function clearAll() { setForm(structuredClone(EMPTY)); setDocs([]); setError(''); }

  async function addFile(file?: File) {
    if (!file) return;
    try {
      const f = await readFile(file);
      setDocs([...docs.filter((d) => d.type !== docType), { type: docType, fileName: f.name, file: f }]);
      setError('');
      const next = DOC_TYPES.find((d) => d.type !== docType && !docs.some((x) => x.type === d.type));
      if (next) setDocType(next.type);   // move on to the next document that is still missing
    } catch (e: any) { setError(e.message); }
  }

  async function submit() {
    setBusy(true); setError('');
    try {
      const created = await api('/applications', { form, documents: docs, scenario });
      try { localStorage.setItem('lastApplication', JSON.stringify({ form, documents: docs })); } catch { /* too big to remember: fine */ }
      location.hash = `/application/${created.id}`;
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  const last = localStorage.getItem('lastApplication');
  const scenarioHelp = scenarios.data?.find((s: any) => s.id === scenario)?.help;

  return (
    <>
      <div className="head"><div><h1>New application</h1><p className="muted">A merchant fills in their details and sends their documents. We check everything and tell them if something is wrong.</p></div></div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>1. Business details</h2>
          <div className="row small">
            <select style={{ width: 280 }} value="" onChange={(e) => fillWith(e.target.value)}>
              <option value="">For the demo: fill in an example...</option>
              {(examples.data ?? []).map((ex: any) => <option key={ex.id} value={ex.id}>{ex.label}</option>)}
            </select>
            <button className="small" onClick={clearAll}>Clear</button>
          </div>
        </div>
        <div className="cols">
          <div className="field"><label>Shop or business name</label><input value={form.businessName} onChange={(e) => set('businessName', e.target.value)} placeholder="For example: Sharma General Store" /></div>
          <div className="field"><label>Owner's full name <span className="hint">(as on the PAN card)</span></label><input value={form.legalName} onChange={(e) => set('legalName', e.target.value)} placeholder="For example: Rahul Sharma" /></div>
          <div className="field"><label>Type of business</label><select value={form.businessType} onChange={(e) => set('businessType', e.target.value)}>{BUSINESS_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ').toLowerCase()}</option>)}</select></div>
          <div className="field"><label>Phone <span className="hint">(10 digits)</span></label><input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="9876543210" /></div>
          <div className="field"><label>Email</label><input value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="rahul@example.com" /></div>
          <div />
          <div className="field"><label>PAN <span className="hint">(5 letters, 4 digits, 1 letter)</span></label><input className="mono" value={form.pan} onChange={(e) => set('pan', e.target.value)} placeholder="ABCDE1234F" /></div>
          <div className="field"><label>GSTIN <span className="hint">(15 characters)</span></label><input className="mono" value={form.gstin} onChange={(e) => set('gstin', e.target.value)} placeholder="27ABCDE1234F1Z5" /></div>
          <div className="field"><label>Bank account number</label><input className="mono" value={form.bank.accountNumber} onChange={(e) => setBank('accountNumber', e.target.value)} placeholder="123456789012" /></div>
          <div className="field"><label>IFSC code <span className="hint">(like HDFC0001234)</span></label><input className="mono" value={form.bank.ifsc} onChange={(e) => setBank('ifsc', e.target.value)} placeholder="HDFC0001234" /></div>
          <div className="field"><label>Name on the bank account</label><input value={form.bank.holderName} onChange={(e) => setBank('holderName', e.target.value)} placeholder="For example: Rahul Sharma" /></div>
        </div>
        {last && <p className="small" style={{ margin: 0 }}><button className="link" onClick={() => { const l = JSON.parse(last); setForm(l.form); setDocs(l.documents); }}>Use the details of the last application again</button> <span className="muted">(submitting the same business twice shows how duplicates are caught)</span></p>}
      </div>

      <div className="card">
        <h2>2. Documents</h2>
        <p className="muted small">We need three documents. Choose which one you are adding, then pick the file. PDFs with text are read automatically. Photos are checked for sharpness, but a person has to read them. You can also use .txt or .json files. The files in the <b>samples</b> folder are there to try.</p>
        <div className="row" style={{ marginBottom: 12 }}>
          <select style={{ width: 300 }} value={docType} onChange={(e) => setDocType(e.target.value)}>{DOC_TYPES.map((d) => <option key={d.type} value={d.type}>{d.name}</option>)}</select>
          <input type="file" style={{ width: 'auto', flex: 1 }} accept=".pdf,.png,.jpg,.jpeg,.txt,.json" onChange={(e) => { addFile(e.target.files?.[0]); e.target.value = ''; }} />
        </div>

        {docs.length === 0 && <p className="muted">No documents added yet.</p>}
        {docs.map((d) => (
          <div className="doc" key={d.type}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div><b>{DOC_TYPES.find((x) => x.type === d.type)?.name}</b> <span className="muted small">· {d.file ? d.fileName : 'sample data (not a file)'}</span></div>
              <button className="small link" onClick={() => setDocs(docs.filter((x) => x !== d))}>Remove</button>
            </div>
            {d.fields && <div className="small muted" style={{ marginTop: 4 }}>{Object.entries(d.fields).map(([k, v]) => <span key={k} style={{ marginRight: 14 }}>{FIELD_NAME[k] ?? k}: <span className="mono">{String(v)}</span>{d.confidence?.[k] != null ? ` (${Math.round(d.confidence[k] * 100)}% sure)` : ''}</span>)}{d.blurry && <span className="bad"> · simulated blurry photo</span>}</div>}
          </div>
        ))}
        {missingDocs.length > 0 && docs.length > 0 && <p className="small warn">Still to add: {missingDocs.map((d) => d.name).join(', ')}. (You can still submit; the system will ask the merchant for it.)</p>}
      </div>

      <div className="card">
        <h2>3. What should the outside services do? <span className="hint">(for the demo)</span></h2>
        <p className="muted small">The PAN, GST, bank and risk services are simulated. Pick how they should behave to see how the system handles problems.</p>
        <div className="field" style={{ maxWidth: 480 }}>
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>{(scenarios.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        </div>
        {scenarioHelp && <p className="small"><b>What will happen:</b> {scenarioHelp}</p>}
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Submitting...' : 'Submit application'}</button>
      </div>
    </>
  );
}
