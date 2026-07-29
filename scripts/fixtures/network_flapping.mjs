// Public semantic oracle for SG-068. A bounded hold can be expressed as "wait for stability",
// "keep work paused", or "one bounded resume after a sustained healthy window". Require both the
// unstable-channel diagnosis and that hold/resume-once policy; neither half alone is sufficient.
export const FLAPPING_CHANNEL_RX = /flap|unstable|sustained|window|circuit/i;
export const BOUNDED_FLAP_RECOVERY_RX = /do not|wait|stability|resume once|(?:keep|remain)[^.\n]{0,24}paused|one bounded resume/i;

export function networkFlapResponseAccepted(text) {
  return FLAPPING_CHANNEL_RX.test(text) && BOUNDED_FLAP_RECOVERY_RX.test(text);
}
