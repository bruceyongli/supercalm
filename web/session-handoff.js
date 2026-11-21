export function sessionHandoffUrl(id, base) {
  const url = new URL('session',base);
  url.username = ''; url.password = '';
  url.searchParams.set('id',id); // never share mint, edit, debug, tracking or view parameters
  return url.href;
}

export function installSessionHandoff(menu, id, signal) {
  if (!menu) return () => {};
  const link = menu.querySelector('[data-copy-session="link"]'), key = menu.querySelector('[data-copy-session="id"]');
  const note = menu.querySelector('[data-copy-result]'), manual = menu.querySelector('[data-copy-manual]');
  key.querySelector('code').textContent = id;
  let base = document.baseURI, lookup, local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(new URL(base).hostname);
  async function copy(which, button) {
    const value = which === 'id' ? id : sessionHandoffUrl(id,base);
    const label = which === 'id' ? 'Session ID' : 'Session link';
    const success = label + ' copied.' + (which === 'link' && local ? ' Local address only; share the ID across devices.' : '');
    manual.hidden = true;
    try {
      // Start in the actual tap handler (Safari's clipboard permission depends on user activation).
      await navigator.clipboard.writeText(value);
      if (!signal.aborted) note.textContent = success;
    } catch {
      if (signal.aborted) return;
      manual.hidden = false; manual.value = value; manual.focus(); manual.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch {}
      if (copied) { manual.hidden = true; button.focus(); }
      note.textContent = copied ? success : 'Select and copy the ' + (which === 'id' ? 'ID' : 'link') + ' below.';
    }
  }
  for (const button of [link,key]) button.onclick = e => { e.stopPropagation(); void copy(button.dataset.copySession,button); };
  manual.onclick = e => { e.stopPropagation(); manual.select(); };
  return function opened() {
    note.textContent = ''; manual.hidden = true;
    if (local && !lookup) {
      link.disabled = true;
      const request = new AbortController(), abort = () => request.abort(), timer = setTimeout(abort,2500);
      signal.addEventListener('abort',abort,{once:true});
      lookup = fetch('api/session-link-base',{signal:request.signal})
        .then(r => r.ok ? r.json() : null).then(data => {
          if (signal.aborted || !data?.base) return;
          const u = new URL(data.base);
          if (/^https?:$/.test(u.protocol) && !u.username && !u.password) { base = u.href; local = false; }
        }).catch(() => {}).finally(() => {
          clearTimeout(timer); signal.removeEventListener('abort',abort); lookup = null;
          if (!signal.aborted) link.disabled = false;
        });
    }
  };
}
