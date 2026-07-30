// A recovery action for an authentication failure must do more than repeat that auth failed or that
// no valid credential exists. Accept an asserted credential repair/operator action, or an explicit
// move to a route whose authorization is already established.
export const AUTH_RECOVERY_ACTION_RX = new RegExp([
  String.raw`\bre-?auth(?:enticate|entication)?\b`,
  String.raw`\brestor(?:e|es|ed|ing)\b[^.\n]{0,48}\b(?:auth(?:entication)?|login|credential)\b`,
  String.raw`\b(?:provid(?:e|es|ed|ing)|provision(?:s|ed|ing)?|configur(?:e|es|ed|ing)|refresh(?:es|ed|ing)?|renew(?:s|ed|ing)?|replac(?:e|es|ed|ing)|suppl(?:y|ies|ied|ying)|rotat(?:e|es|ed|ing))\b[^.\n]{0,72}\b(?:token|credential|login)\b`,
  String.raw`\bprovid(?:e|es|ed|ing)\b[^.\n]{0,48}\baccess\b[^.\n]{0,72}\b(?:authenticated|authorized|healthy)\b[^.\n]{0,48}\b(?:model|provider|route|executor)\b`,
  String.raw`\b(?:switch|route|use|move|fall back)\b[^.\n]{0,100}\b(?:authenticated|authorized|healthy)\b[^.\n]{0,60}\b(?:model|provider|route|executor)\b`,
  String.raw`\b(?:ask|request|require|need)\b[^.\n]{0,60}\boperator\b[^.\n]{0,60}\b(?:auth|login|credential|token)\b`,
].join('|'), 'i');
