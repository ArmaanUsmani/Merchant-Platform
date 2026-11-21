import { Application } from './models.js';
import { STATE_INFO } from './views.js';
import { State } from './states.js';

// Numbers for the "how is the process doing" panel. Everything is worked out from the audit timelines.
export async function metrics() {
  const apps: any[] = await Application.find({}, { state: 1, createdAt: 1, audit: 1 }).lean();
  const total = apps.length;

  // An application is an "exception" if it ever needed the merchant or a person.
  const needed = (a: any) => a.audit.some((e: any) => ['NEEDS_INFO', 'IN_REVIEW', 'MERCHANT_ID_FAILED'].includes(e.to));
  const exceptions = apps.filter(needed).length;
  const automatic = apps.filter((a) => a.state === 'ONBOARDED' && !needed(a)).length;

  // Time in each state = time between one state change and the next.
  const spent: Record<string, number[]> = {};
  for (const a of apps) {
    let since = a.createdAt;
    for (const e of a.audit.filter((e: any) => e.to)) {
      (spent[e.from] ??= []).push(e.at - since);
      since = e.at;
    }
  }
  const timeInState = Object.entries(spent).map(([state, list]) => ({
    state, label: STATE_INFO[state as State].label, count: list.length,
    averageMs: Math.round(list.reduce((x, y) => x + y, 0) / list.length),
  }));

  const onboardTimes = apps.filter((a) => a.state === 'ONBOARDED').flatMap((a) => {
    const done = a.audit.find((e: any) => e.to === 'ONBOARDED');
    return done ? [done.at - a.createdAt] : [];
  });

  return {
    total, exceptions, automatic,
    exceptionRate: total ? exceptions / total : 0,
    automaticRate: total ? automatic / total : 0,
    averageOnboardMs: onboardTimes.length ? Math.round(onboardTimes.reduce((x, y) => x + y, 0) / onboardTimes.length) : null,
    timeInState,
  };
}
