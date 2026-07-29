// A recovery action for an authentication failure must do more than repeat that auth failed or that
// no valid credential exists. Accept an asserted credential repair/operator action, or an explicit
// move to a route whose authorization is already established.
export const AUTH_RECOVERY_ACTION_RX = new RegExp([
  String.raw`\bre-?auth(?:enticate|entication)?\b`,
  String.raw`\b(?:provide|provision|configure|refresh|renew|replace|supply|rotate)\b[^.\n]{0,72}\b(?:token|credential|login)\b`,
  String.raw`\b(?:switch|route|use|move|fall back)\b[^.\n]{0,100}\b(?:authenticated|authorized|healthy)\b[^.\n]{0,60}\b(?:model|provider|route|executor)\b`,
  String.raw`\b(?:ask|request|require|need)\b[^.\n]{0,60}\boperator\b[^.\n]{0,60}\b(?:auth|login|credential|token)\b`,
].join('|'), 'i');
