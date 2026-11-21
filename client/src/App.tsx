import { useEffect, useState } from 'react';
import Applications from './pages/Applications';
import NewApplication from './pages/NewApplication';
import ApplicationPage from './pages/ApplicationPage';

// Three screens, chosen by the part of the address after the "#".
export default function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => { setRoute(location.hash.slice(1) || '/'); window.scrollTo(0, 0); };
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);

  const detail = route.match(/^\/application\/(.+)$/);
  return (
    <>
      <header className="topbar">
        <div className="brand">Merchant Onboarding</div>
        <nav>
          <a href="#/" className={route === '/' ? 'on' : ''}>Applications</a>
          <a href="#/new" className={route === '/new' ? 'on' : ''}>New application</a>
        </nav>
      </header>
      <main className="page">
        {detail ? <ApplicationPage id={detail[1]} key={detail[1]} /> : route === '/new' ? <NewApplication /> : <Applications />}
      </main>
    </>
  );
}
