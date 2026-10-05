// Assistant settings are not coding-agent instructions. Exact, bounded requests work locally even
// when the conversation model is busy; mixed project requests still use the normal confirmation flow.
export function voiceSpeakerControl(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const en = value.toLowerCase().replace(/^(?:(?:okay|ok|alright|well)[\s,]+)+/, '').replace(/[.!?]+$/, '');
  const choice = en.match(/^(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:(?:change|switch)(?: (?:your|the) voice)?(?: to)?|use|try|select|(?:speak|talk|respond) (?:with|in))\s+(?:(?:your|the|a|an)\s+)?(female|woman'?s|male|man'?s|vivian|ryan)(?: voice)?(?:\s+(?:instead of|rather than)\s+(?:(?:your|the|a)\s+)?(?:female|male)(?: voice)?)?(?:\s+please)?$/)?.[1];
  const zh = value.replace(/^(?:好的?|好吧)[，,\s]*/u, '').replace(/[吗吧。！？!?]+$/u, '');
  const chinese = zh.match(/^(?:(?:请|麻烦|可以|能不能|可不可以)(?:你)?)?(?:帮我)?(?:切换到?|换成?|改成|改用|使用|用)(?:你的|一个)?(女声|男声|Vivian|Ryan)(?:而不是(?:男声|女声))?$/iu)?.[1];
  const target = choice || chinese;
  if (!target) return null;
  const voice = /female|woman|vivian|女声/iu.test(target) ? 'Vivian' : 'Ryan';
  return { voice, say: /\p{Script=Han}/u.test(value)
    ? voice === 'Vivian' ? '好，我改用女声。' : '好，我改用男声。'
    : voice === 'Vivian' ? 'Sure, I’m using a female voice now.' : 'Sure, I’m using a male voice now.' };
}
