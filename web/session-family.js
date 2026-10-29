// Explicit ownership only. Same project, similar names and nearby timestamps are not parentage.
export const isLiveSession = s => ['starting', 'working', 'waiting'].includes(s?.status);
export const needsSessionAttention = s => !s?.dismissed && !!s?.unread && !!s?.category && s.category !== 'working'
  && (s.status === 'waiting' || (s.status === 'working' && s.pending_input));

export function sessionFamilies(sessions = []) {
  const byId = new Map(sessions.filter(s => s?.id).map(s => [s.id, s]));
  const parents = new Map();
  for (const s of byId.values()) {
    if (s.parent_session_id && s.parent_session_id !== s.id && byId.has(s.parent_session_id)) parents.set(s.id, s.parent_session_id);
  }
  // Bad historical metadata must never make a session disappear or recurse forever.
  const checked = new Set();
  for (const id of byId.keys()) {
    const path = [], positions = new Map();
    let at = id;
    while (at && !checked.has(at)) {
      if (positions.has(at)) {
        for (const cycleId of path.slice(positions.get(at))) parents.delete(cycleId);
        break;
      }
      positions.set(at, path.length); path.push(at); at = parents.get(at);
    }
    for (const item of path) checked.add(item);
  }
  const roots = new Map();
  const rootOf = id => {
    const path = []; let at = id;
    while (parents.has(at) && !roots.has(at)) { path.push(at); at = parents.get(at); }
    const root = roots.get(at) || at;
    roots.set(at, root); for (const item of path) roots.set(item, root);
    return root;
  };
  const families = new Map();
  for (const s of byId.values()) {
    const rootId = rootOf(s.id);
    if (!families.has(rootId)) families.set(rootId, { id: rootId, root: byId.get(rootId), helpers: [] });
    if (s.id !== rootId) families.get(rootId).helpers.push(s);
  }
  return [...families.values()].map(family => {
    const members = [family.root, ...family.helpers];
    const live = members.filter(isLiveSession);
    return { ...family, members, live, last_activity: Math.max(0, ...(live.length ? live : members).map(s => Number(s.last_activity || s.started_at) || 0)) };
  });
}

export function sessionParent(session, sessions = []) {
  return session?.parent_session_id && session.parent_session_id !== session.id
    ? sessions.find(s => s.id === session.parent_session_id) || null : null;
}

export function parentSessionLabel(session, sessions = []) {
  const parent = sessionParent(session, sessions);
  return String(parent?.title || parent?.project || session?.parent_session_id || '').trim().split('\n')[0];
}

// Group adjacent reports without suppressing questions or changing their send/dismiss targets.
export function relatedSessionOrder(sessions, all = sessions) {
  const owners = new Map(sessionFamilies(all).flatMap(f => f.members.map(s => [s.id, f.id])));
  const groups = new Map();
  for (const s of sessions) {
    const owner = owners.get(s.id) || s.id;
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(s);
  }
  return [...groups.values()].flat();
}
